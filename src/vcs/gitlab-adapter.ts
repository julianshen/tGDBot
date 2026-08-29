import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { parseBotMarker } from "../review/comment-marker.js";
import { INLINE_COMMENT_MARKER } from "../review/comment-format.js";
import type { RelatedWorkItem, RelatedWorkReference } from "../review/related-work.js";
import type { GitLabRepositoryRef, RepositoryRef } from "../target/types.js";
import { computeContentDigest, computeRepositoryDigest, parseChildMarker, verifyChildMarkerBinding } from "../conversation/markers.js";
import type { BotIdentity, ConversationItemIdentity, ReviewIdentity } from "../conversation/types.js";
import { resolveGitLabRelatedWork } from "./gitlab-related-work.js";
import {
  validateInlinePublishInputs,
  validateInlinePublishOutcomes,
  validateConversationItemIdentity,
} from "./adapter.js";
import { compareOrderKeys, isCommitSha } from "./adapter.js";
import type {
  BotComment,
  InlineReviewComment,
  InlinePublishOutcome,
  PullRequestInfo,
  ReviewLocator,
  RuleFileContent,
  VcsAdapter,
} from "./adapter.js";
import {
  validateConversationAnchor,
  validateOpenReviewPageToken,
  validateReviewDiscoveryCursor,
  validateReviewEventCursor,
  validateReviewEventPageToken,
  validateReviewThreadPageToken,
  type ChildMarkerLookup,
  type ConversationAdapter,
  type GeneralReplyInput,
  type OpenReviewPage,
  type OpenReviewPageToken,
  type ReviewDiscoveryCursor,
  type ReviewEventCursor,
  type ReviewActivityEvent,
  type ReviewReaction,
  type ReviewEventPage,
  type ReviewEventPageToken,
  type ReviewThreadPage,
  type ReviewThreadPageToken,
  type ReviewThreadSnapshot,
  type ReviewThreadSummary,
  type ThreadReplyInput,
} from "./conversation-adapter.js";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const RULE_FILE_FETCH_CONCURRENCY = 4;
const REACTION_FETCH_CONCURRENCY = 4;
const SHA_RE = /^[0-9a-f]{40}$/i;
const HTTP_DIAGNOSTIC_RE =
  /(?:^|\r?\n)(?:HTTP ([1-5]\d{2})|glab: [^\r\n]* \(HTTP ([1-5]\d{2})\))\r?(?=\n|$)/;

export type ExecGlab = (
  args: readonly string[],
  stdin?: string,
  options?: { readonly timeoutMs?: number },
) => Promise<string>;

export class GlabCommandError extends Error {
  readonly code?: string;
  readonly exitCode?: number;
  readonly httpStatus?: number;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      code?: string;
      exitCode?: number;
      httpStatus?: number;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GlabCommandError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
    this.stderr = options.stderr ?? "";
  }
}

export class GlabOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GlabOutputError";
  }
}

export class ConcurrentGitLabMutationError extends Error {
  constructor(message = "GitLab changed during a stable snapshot scan") {
    super(message);
    this.name = "ConcurrentGitLabMutationError";
  }
}

function commandHost(args: readonly string[]): string {
  const hostnameIndex = args.indexOf("--hostname");
  if (hostnameIndex >= 0 && args[hostnameIndex + 1]) {
    return args[hostnameIndex + 1]!;
  }
  const repoIndex = args.indexOf("--repo");
  if (repoIndex >= 0 && args[repoIndex + 1]) {
    try {
      return new URL(args[repoIndex + 1]!).hostname;
    } catch {
      // The adapter supplies normalized URLs. Retain a safe default if an
      // injected caller invokes this lower-level executor directly.
    }
  }
  return "gitlab.com";
}

function numericExitCode(error: NodeJS.ErrnoException): number | undefined {
  return typeof error.code === "number" ? error.code : undefined;
}

function apiHttpStatus(args: readonly string[], stderr: string): number | undefined {
  if (args[0] !== "api") return undefined;
  const match = HTTP_DIAGNOSTIC_RE.exec(stderr);
  const status = match?.[1] ?? match?.[2];
  return status === undefined ? undefined : Number(status);
}

export const realExecGlab: ExecGlab = (args, stdin, options) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let processFinished = false;
    let processStdout = "";
    let stdinFinished = stdin === undefined;
    let stdinFailure: GlabCommandError | undefined;
    const resolveOnce = (stdout: string): void => {
      if (settled) return;
      settled = true;
      resolve(stdout);
    };
    const rejectOnce = (error: GlabCommandError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishSuccessfulProcess = (): void => {
      if (!processFinished || !stdinFinished) return;
      if (stdinFailure !== undefined) {
        rejectOnce(stdinFailure);
      } else {
        resolveOnce(processStdout);
      }
    };
    const captureStdinFailure = (cause?: unknown): void => {
      stdinFailure ??= new GlabCommandError(
        `Unable to write input to glab for ${commandHost(args)}; the process closed stdin early.`,
        { cause },
      );
      stdinFinished = true;
      finishSuccessfulProcess();
    };
    const child = execFile(
      "glab",
      [...args],
      {
        maxBuffer: MAX_BUFFER_BYTES,
        ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        env: {
          ...process.env,
          GLAB_PROMPT_DISABLED: "true",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          processStdout = stdout;
          processFinished = true;
          finishSuccessfulProcess();
          return;
        }

        const processError = error as NodeJS.ErrnoException;
        const host = commandHost(args);
        if (processError.code === "ENOENT") {
          rejectOnce(
            new GlabCommandError(
              `Unable to run glab. Install the GitLab CLI, then authenticate with glab auth login --hostname ${host}.`,
              { cause: error, stderr },
            ),
          );
          return;
        }
        if (processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          rejectOnce(
            new GlabCommandError(
              "glab output exceeded the 10 MiB safety limit; narrow the requested output or reduce the merge request diff.",
              {
                cause: error,
                code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                exitCode: numericExitCode(processError),
                stderr,
              },
            ),
          );
          return;
        }

        rejectOnce(
          new GlabCommandError(
            `glab command failed for ${host}; verify authentication, permissions, and host configuration.`,
            {
              cause: error,
              exitCode: numericExitCode(processError),
              httpStatus: apiHttpStatus(args, stderr),
              stderr,
            },
          ),
        );
      },
    );
    if (stdin !== undefined) {
      if (child.stdin === null) {
        stdinFailure = new GlabCommandError(
          `Unable to write input to glab for ${commandHost(args)} because stdin is unavailable.`,
        );
        stdinFinished = true;
        finishSuccessfulProcess();
      } else {
        child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
          captureStdinFailure(cause);
        });
        try {
          child.stdin.end(stdin, (error?: Error | null) => {
            if (error) {
              captureStdinFailure(error);
              return;
            }
            stdinFinished = true;
            finishSuccessfulProcess();
          });
        } catch (cause) {
          captureStdinFailure(cause);
        }
      }
    }
  });

export function projectEndpoint(repo: GitLabRepositoryRef, suffix: string): string {
  const projectPath = [...repo.namespace, repo.repo].join("/");
  return `projects/${encodeURIComponent(projectPath)}/${suffix}`;
}

export function decodeNdjsonRecords<T>(stdout: string): T[] {
  const records: T[] = [];
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (cause) {
      throw new GlabOutputError(
        `Malformed NDJSON record from glab at line ${index + 1}`,
        { cause },
      );
    }
  }
  return records;
}

interface GlabMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

interface GlabTreeEntry {
  id: string;
  name: string;
  type: string;
  path: string;
  mode: string;
}

interface GlabNote {
  id: number;
  body: string;
  author: { username: string };
}

interface GlabMergeRequestVersion {
  base_commit_sha: string;
  head_commit_sha: string;
  start_commit_sha: string;
}

interface GlabDiscussion {
  id: string;
  notes: Array<{
    body: string;
    author: { username: string };
    resolved: boolean;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  object: Record<string, unknown>,
  field: string,
  options: { sha?: boolean } = {},
): string {
  const value = object[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (options.sha === true && !SHA_RE.test(value))
  ) {
    throw new GlabOutputError(`Invalid glab MR response: malformed ${field}`);
  }
  return value;
}

function description(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  throw new GlabOutputError("Invalid glab MR response: malformed description");
}

function parseMergeRequest(stdout: string): GlabMergeRequest {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new GlabOutputError("Invalid glab MR response: malformed JSON", { cause });
  }
  if (!isRecord(value)) {
    throw new GlabOutputError("Invalid glab MR response: expected an object");
  }
  if (!Number.isSafeInteger(value.iid) || (value.iid as number) <= 0) {
    throw new GlabOutputError("Invalid glab MR response: malformed iid");
  }
  const diffRefs = value.diff_refs;
  if (!isRecord(diffRefs)) {
    throw new GlabOutputError("Invalid glab MR response: malformed diff_refs");
  }
  return {
    iid: value.iid as number,
    title: requiredString(value, "title"),
    description: description(value.description),
    web_url: requiredString(value, "web_url"),
    source_branch: requiredString(value, "source_branch"),
    target_branch: requiredString(value, "target_branch"),
    diff_refs: {
      base_sha: requiredString(diffRefs, "base_sha", { sha: true }),
      head_sha: requiredString(diffRefs, "head_sha", { sha: true }),
      start_sha: requiredString(diffRefs, "start_sha", { sha: true }),
    },
  };
}

function parseTreeEntries(stdout: string): GlabTreeEntry[] {
  return decodeNdjsonRecords<unknown>(stdout).map((value) => {
    if (!isRecord(value)) {
      throw new GlabOutputError("Invalid glab repository tree response: expected an object");
    }
    for (const field of ["id", "name", "type", "path", "mode"] as const) {
      if (typeof value[field] !== "string" || value[field].length === 0) {
        throw new GlabOutputError(
          `Invalid glab repository tree response: malformed ${field}`,
        );
      }
    }
    return value as unknown as GlabTreeEntry;
  });
}

function parseUsername(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new GlabOutputError("Invalid glab user response: malformed JSON", { cause });
  }
  if (!isRecord(value) || typeof value.username !== "string" || value.username.length === 0) {
    throw new GlabOutputError("Invalid glab user response: malformed username");
  }
  return value.username;
}

function parseNotes(stdout: string): GlabNote[] {
  return decodeNdjsonRecords<unknown>(stdout).map((value) => {
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.id) ||
      (value.id as number) <= 0 ||
      typeof value.body !== "string" ||
      !isRecord(value.author) ||
      typeof value.author.username !== "string" ||
      value.author.username.length === 0
    ) {
      throw new GlabOutputError("Invalid glab note response");
    }
    return value as unknown as GlabNote;
  });
}

// GitLab documents discussion IDs as opaque strings. Restrict endpoint
// interpolation to RFC 3986 unreserved characters, then encode even that
// validated value below so the safety property survives future allowlist edits.
const OPAQUE_DISCUSSION_ID_RE = /^[A-Za-z0-9._~-]+$/u;

function parseDiscussions(stdout: string): GlabDiscussion[] {
  return decodeNdjsonRecords<unknown>(stdout).map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      !OPAQUE_DISCUSSION_ID_RE.test(value.id) ||
      value.id.includes("..") ||
      !Array.isArray(value.notes)
    ) {
      throw new GlabOutputError("Invalid glab discussion response");
    }
    const notes = value.notes.map((note) => {
      if (
        !isRecord(note) ||
        typeof note.body !== "string" ||
        !isRecord(note.author) ||
        typeof note.author.username !== "string" ||
        note.author.username.length === 0 ||
        typeof note.resolved !== "boolean"
      ) {
        throw new GlabOutputError("Invalid glab discussion response");
      }
      return {
        body: note.body,
        author: { username: note.author.username },
        resolved: note.resolved,
      };
    });
    return { id: value.id, notes };
  });
}

function parseWrittenNote(
  stdout: string,
  expectedBody: string,
  expectedId?: number,
): BotComment {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new GlabOutputError("Invalid glab note response: malformed JSON", { cause });
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) <= 0 ||
    typeof value.body !== "string" ||
    value.body !== expectedBody ||
    (expectedId !== undefined && value.id !== expectedId)
  ) {
    throw new GlabOutputError("Invalid glab note response: malformed or mismatched note id/body");
  }
  const body = value.body as string;
  return {
    id: String(value.id),
    body,
    ...(parseBotMarker(body) ?? { lastReviewedSha: "", reviewedConfig: "" }),
  };
}

function parseNewestMergeRequestVersion(stdout: string): GlabMergeRequestVersion {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new GlabOutputError("Invalid glab MR versions response: malformed JSON", { cause });
  }
  if (!Array.isArray(value)) {
    throw new GlabOutputError("Invalid glab MR versions response: expected an array");
  }
  const entry = value[0];
  if (entry === undefined) {
    throw new GlabOutputError("Invalid glab MR versions response: no versions");
  }
  if (!isRecord(entry)) {
    throw new GlabOutputError("Invalid glab MR versions response: expected an object");
  }
  return {
    base_commit_sha: requiredString(entry, "base_commit_sha", { sha: true }),
    head_commit_sha: requiredString(entry, "head_commit_sha", { sha: true }),
    start_commit_sha: requiredString(entry, "start_commit_sha", { sha: true }),
  };
}

function validateWrittenDiscussion(
  stdout: string,
  expectedBody: string,
): { readonly discussionId: string; readonly noteId: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new GlabOutputError(
      "Invalid glab discussion response: malformed JSON",
      { cause },
    );
  }
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !Array.isArray(value.notes) ||
    value.notes.length === 0 ||
    !value.notes.every((note) =>
      isRecord(note) &&
      Number.isSafeInteger(note.id) &&
      (note.id as number) > 0 &&
      typeof note.body === "string"
    ) ||
    !value.notes.some((note) => isRecord(note) && note.body === expectedBody)
  ) {
    throw new GlabOutputError("Invalid glab discussion response");
  }
  const matchingNote = value.notes.find(
    (note) => isRecord(note) && note.body === expectedBody,
  ) as { id: number; body: string };
  return { discussionId: value.id, noteId: String(matchingNote.id) };
}

function validatedNoteId(id: string): number {
  if (!/^[1-9]\d*$/u.test(id)) {
    throw new GlabOutputError("Invalid existing GitLab note id");
  }
  const value = Number(id);
  if (!Number.isSafeInteger(value)) {
    throw new GlabOutputError("Invalid existing GitLab note id");
  }
  return value;
}

function resolveMergeRequestLocator(locator: ReviewLocator): {
  repo: GitLabRepositoryRef;
  iid: string;
} {
  if (locator.kind !== "repository") {
    throw new Error("GitLabAdapter requires a GitLab repository locator");
  }
  if (locator.repo.provider !== "gitlab") {
    throw new Error("GitLabAdapter cannot use a GitHub repository locator");
  }
  if (!Number.isSafeInteger(locator.number) || locator.number <= 0) {
    throw new Error("Review locator number must be a positive integer");
  }
  return { repo: locator.repo, iid: String(locator.number) };
}

export function classifyGlabWriteFailure(
  error: GlabCommandError,
): "continue" | "stop" {
  return error.httpStatus === 400 ||
    error.httpStatus === 409 ||
    error.httpStatus === 422
    ? "continue"
    : "stop";
}

function sanitizedWriteFailureReason(error: GlabCommandError): string {
  return error.httpStatus === undefined
    ? "GitLab could not post the inline discussion"
    : `GitLab rejected the inline discussion (HTTP ${error.httpStatus})`;
}

function unsupportedPositionReason(): string {
  return "GitLab cannot address this diff position";
}

function validLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function supportedInlinePosition(comment: InlineReviewComment): boolean {
  const { position } = comment;
  if (
    position.sameHunk !== true ||
    position.oldPath.length === 0 ||
    position.newPath.length === 0
  ) {
    return false;
  }
  for (const endpoint of [position.start, position.end]) {
    if (!validLine(endpoint.newLine)) return false;
    if (endpoint.type === "old" && !validLine(endpoint.oldLine)) return false;
    if (
      endpoint.type === "new" &&
      endpoint.oldLine !== undefined &&
      !validLine(endpoint.oldLine)
    ) {
      return false;
    }
  }
  return true;
}

function lineRangeEndpoint(
  pathHash: string,
  endpoint: InlineReviewComment["position"]["start"],
): Record<string, string | number> {
  return {
    line_code: `${pathHash}_${endpoint.oldLine ?? ""}_${endpoint.newLine}`,
    type: endpoint.type,
    ...(endpoint.oldLine === undefined ? {} : { old_line: endpoint.oldLine }),
    new_line: endpoint.newLine,
  };
}

function downgradeGitLabRangeSuggestion(body: string): string {
  return body
    .replace(
      "<summary>📝 Committable suggestion</summary>",
      "<summary>💡 Proposed fix (not committable)</summary>",
    )
    .replace(/^(`{3,})suggestion\s*$/m, (_match, fence: string) => `${fence}text`);
}

const CONVERSATION_SHA_RE = /^[0-9a-f]{40,64}$/iu;
const USERNAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,254}$/u;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const MAX_STABLE_SCAN_ATTEMPTS = 3;
const MAX_TARGET_PAGES = 10_000;
const MAX_THREAD_SNAPSHOT_NOTES = 10_000;

function conversationRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GlabOutputError(`Invalid glab ${label} response`);
  return value;
}

function conversationText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GlabOutputError(`Invalid glab ${label}`);
  }
  return value;
}

function conversationProviderId(value: unknown, label: string): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) throw new GlabOutputError(`Invalid glab ${label}`);
  return id;
}

function conversationTimestamp(value: unknown, label: string): string {
  const result = conversationText(value, label);
  if (!TIMESTAMP_RE.test(result)) throw new GlabOutputError(`Invalid glab ${label}`);
  const epoch = Date.parse(result);
  if (!Number.isFinite(epoch)) throw new GlabOutputError(`Invalid glab ${label}`);
  return new Date(epoch).toISOString();
}

function conversationDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function conversationOrderKey(at: string, type: string, id: string, revision = ""): string {
  return `${at}|${type}|${id.padStart(32, "0")}|${revision}`;
}

function eventBoundaryToken(event: ReviewActivityEvent): string {
  return event.kind === "thread-resolution"
    ? `r:${event.threadId}:${event.resolved ? "1" : "0"}:${event.outdated ? "1" : "0"}`
    : event.revisionId;
}

function parseNdjsonPage(stdout: string, label: string): Record<string, unknown>[] {
  return decodeNdjsonRecords<unknown>(stdout).flatMap((entry) => {
    const rows = Array.isArray(entry) ? entry : [entry];
    return rows.map((row) => conversationRecord(row, label));
  });
}

interface InclusiveHighWater { readonly at: string; readonly seen: readonly string[]; readonly cutoff?: string }
interface StableScanResult<T> {
  readonly witness: string;
  readonly count: number;
  readonly candidates: readonly T[];
  readonly cutoffRank?: number;
}
interface TieContinuation {
  readonly v: 1;
  readonly cursor: string | null;
  readonly cutoff: string;
  readonly witness: string;
  readonly count: number;
  readonly emittedRank: number;
  readonly checksum: string;
}

function decodeHighWater(opaque: string): InclusiveHighWater {
  try {
    const value = conversationRecord(JSON.parse(opaque), "cursor high-water");
    const at = conversationTimestamp(value.at, "cursor high-water timestamp");
    if (!Array.isArray(value.seen) || value.seen.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new Error("Invalid GitLab cursor seen set");
    }
    if (value.cutoff !== undefined && (typeof value.cutoff !== "string" || value.cutoff.length === 0)) {
      throw new Error("Invalid GitLab cursor cutoff");
    }
    return { at, seen: value.seen as string[], ...(typeof value.cutoff === "string" ? { cutoff: value.cutoff } : {}) };
  } catch (cause) {
    throw new Error("Invalid GitLab cursor high-water state", { cause });
  }
}

function encodeHighWater(at: string, seen: readonly string[], cutoff?: string): string {
  const unique = cutoff ? [] : [...new Set(seen)].sort();
  let encoded = JSON.stringify({ at, seen: unique, ...(cutoff ? { cutoff } : {}) });
  if (Buffer.byteLength(encoded, "utf8") > 3_900) {
    encoded = JSON.stringify({ at: new Date(Date.parse(at) - 1).toISOString(), seen: [] });
  }
  return encoded;
}

type TieContinuationPayload = Omit<TieContinuation, "checksum">;

function tieContinuationChecksum(value: TieContinuationPayload): string {
  return conversationDigest(JSON.stringify(value));
}

function encodeTieContinuation(value: TieContinuationPayload): string {
  const encoded = JSON.stringify({ ...value, checksum: tieContinuationChecksum(value) });
  if (Buffer.byteLength(encoded, "utf8") > 3_900) throw new Error("GitLab continuation token exceeds safe bound");
  return encoded;
}

function decodeTieContinuation(opaque: string): TieContinuation {
  try {
    const value = conversationRecord(JSON.parse(opaque), "tie continuation");
    const keys = Object.keys(value).sort();
    if (keys.join("\0") !== ["checksum", "count", "cursor", "cutoff", "emittedRank", "v", "witness"].sort().join("\0")) {
      throw new Error("Invalid GitLab continuation properties");
    }
    if (
      value.v !== 1 ||
      (value.cursor !== null && typeof value.cursor !== "string") ||
      typeof value.cutoff !== "string" ||
      value.cutoff.length === 0 ||
      typeof value.witness !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.witness) ||
      !Number.isSafeInteger(value.count) ||
      (value.count as number) < 0 ||
      !Number.isSafeInteger(value.emittedRank) ||
      (value.emittedRank as number) <= 0 ||
      (value.emittedRank as number) > (value.count as number) ||
      typeof value.checksum !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.checksum)
    ) {
      throw new Error("Invalid GitLab tie continuation");
    }
    if (value.cursor !== null) decodeHighWater(value.cursor);
    const parsed = value as unknown as TieContinuation;
    const { checksum, ...payload } = parsed;
    if (checksum !== tieContinuationChecksum(payload)) throw new Error("Invalid GitLab continuation checksum");
    return parsed;
  } catch (cause) {
    throw new Error(
      cause instanceof Error && /checksum/iu.test(cause.message)
        ? "Invalid GitLab tie continuation checksum"
        : "Invalid GitLab tie continuation state",
      { cause },
    );
  }
}

function addWitnessEntry(hash: ReturnType<typeof createHash>, parts: readonly string[]): void {
  for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}:`).update(part);
  hash.update("\n");
}

function canonicalInlineBody(body: string): string {
  return body.replace(/\r\n?/gu, "\n");
}

function conversationUsername(value: unknown, label: string): string {
  const username = conversationText(value, label);
  if (!USERNAME_RE.test(username)) throw new GlabOutputError(`Invalid glab ${label}`);
  return username.toLowerCase();
}

function conversationSha(value: unknown, label: string): string {
  const sha = conversationText(value, label).toLowerCase();
  if (!CONVERSATION_SHA_RE.test(sha)) throw new GlabOutputError(`Invalid glab ${label}`);
  return sha;
}

function conversationDiscussionId(value: unknown): string {
  const id = conversationProviderId(value, "discussion id");
  if (!OPAQUE_DISCUSSION_ID_RE.test(id) || id.includes("..")) throw new GlabOutputError("Invalid glab discussion id");
  return id;
}

interface ConversationMergeRequest {
  readonly id: string;
  readonly iid: number;
  readonly title: string;
  readonly webUrl: string;
  readonly updatedAt: string;
  readonly headSha: string;
}

interface ConversationNote {
  readonly id: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly type: string | null;
  readonly system: boolean;
  readonly resolved?: boolean;
  readonly outdated?: boolean;
  readonly reactions: readonly Omit<ReviewReaction, "authorIsBot">[];
  readonly position?: {
    readonly file: string;
    readonly line?: number;
    readonly side?: "old" | "new";
    readonly headSha?: string;
    readonly positionType: string;
  };
}

interface ConversationDiscussion {
  readonly id: string;
  readonly individualNote: boolean;
  readonly outdated?: boolean;
  readonly notes: readonly ConversationNote[];
}

function parseConversationMergeRequest(stdout: string): ConversationMergeRequest {
  const value = conversationRecord((() => {
    try { return JSON.parse(stdout); } catch (cause) { throw new GlabOutputError("Invalid glab MR response: malformed JSON", { cause }); }
  })(), "merge request");
  const diffRefs = isRecord(value.diff_refs) ? value.diff_refs : undefined;
  const headSha = value.sha ?? diffRefs?.head_sha;
  if (!Number.isSafeInteger(value.iid) || (value.iid as number) <= 0) throw new GlabOutputError("Invalid glab MR response: malformed iid");
  return {
    id: conversationProviderId(value.id, "merge request id"),
    iid: value.iid as number,
    title: conversationText(value.title, "merge request title"),
    webUrl: conversationText(value.web_url, "merge request URL"),
    updatedAt: conversationTimestamp(value.updated_at, "merge request updated timestamp"),
    headSha: conversationSha(headSha, "merge request head SHA"),
  };
}

function parseConversationNote(value: unknown): ConversationNote {
  const row = conversationRecord(value, "note");
  const author = conversationRecord(row.author, "note author");
  const type = row.type === undefined || row.type === null ? null : conversationText(row.type, "note type");
  const position = parseConversationPosition(row.position);
  const outdatedFlag = conversationOutdatedFlag(row);
  const awards = row.award_emoji === undefined || row.award_emoji === null
    ? []
    : Array.isArray(row.award_emoji)
      ? row.award_emoji
      : (() => { throw new GlabOutputError("Invalid glab note award emoji"); })();
  const reactions = parseConversationReactions(awards);
  return {
    id: conversationProviderId(row.id, "note id"),
    body: typeof row.body === "string" ? row.body : (() => { throw new GlabOutputError("Invalid glab note body"); })(),
    author: conversationUsername(author.username, "note author username"),
    createdAt: conversationTimestamp(row.created_at, "note created timestamp"),
    updatedAt: conversationTimestamp(row.updated_at, "note updated timestamp"),
    type,
    system: row.system === true,
    reactions,
    ...(typeof row.resolved === "boolean" ? { resolved: row.resolved } : {}),
    ...(outdatedFlag === undefined ? {} : { outdated: outdatedFlag }),
    ...(position ? { position } : {}),
  };
}

function parseConversationReactions(values: readonly unknown[]): readonly Omit<ReviewReaction, "authorIsBot">[] {
  return values.flatMap((value): Array<Omit<ReviewReaction, "authorIsBot">> => {
    const award = conversationRecord(value, "note award emoji");
    if (award.name !== "thumbsup" && award.name !== "+1") return [];
    const user = conversationRecord(award.user, "note award emoji user");
    return [{
      id: conversationProviderId(award.id, "note award emoji id"),
      content: "thumbs-up",
      authorLogin: conversationUsername(user.username, "note award emoji username"),
      createdAt: conversationTimestamp(award.created_at, "note award emoji timestamp"),
    }];
  });
}

function parseConversationPosition(value: unknown): ConversationNote["position"] | undefined {
  if (value === undefined || value === null) return undefined;
  const position = conversationRecord(value, "note position");
  const chosenPath = typeof position.new_path === "string" && position.new_path.length > 0
    ? position.new_path
    : position.old_path;
  const file = conversationText(chosenPath, "note path");
  const positionType = typeof position.position_type === "string" ? position.position_type : "text";
  const rawLine = position.new_line ?? position.old_line;
  const line = rawLine == null ? undefined : Number(rawLine);
  if (positionType !== "file" && line !== undefined && (!Number.isSafeInteger(line) || line <= 0)) {
    throw new GlabOutputError("Invalid glab note line");
  }
  if (positionType === "file" && line !== undefined) throw new GlabOutputError("Invalid glab file-level note line");
  const side = positionType === "file"
    ? (typeof position.new_path === "string" && position.new_path.length > 0 ? "new" as const : "old" as const)
    : position.new_line != null ? "new" as const : position.old_line != null ? "old" as const : undefined;
  return {
    file,
    ...(positionType === "file" || line === undefined ? {} : { line }),
    ...(side ? { side } : {}),
    ...(position.head_sha === undefined || position.head_sha === null ? {} : { headSha: conversationSha(position.head_sha, "note head SHA") }),
    positionType,
  };
}

function parseConversationDiscussion(value: unknown): ConversationDiscussion {
  const row = conversationRecord(value, "discussion");
  if (!Array.isArray(row.notes) || row.notes.length === 0) throw new GlabOutputError("Invalid glab discussion response");
  const outdatedFlag = conversationOutdatedFlag(row);
  return {
    id: conversationDiscussionId(row.id),
    individualNote: row.individual_note === true,
    ...(outdatedFlag === undefined ? {} : { outdated: outdatedFlag }),
    notes: row.notes.map(parseConversationNote),
  };
}

function conversationOutdatedFlag(row: Record<string, unknown>): boolean | undefined {
  if (typeof row.outdated === "boolean") return row.outdated;
  if (typeof row.stale === "boolean") return row.stale;
  if (typeof row.active === "boolean") return row.active === false;
  return undefined;
}

function isGeneralNote(note: ConversationNote): boolean {
  return !note.system && note.type === null;
}

export class GitLabAdapter implements VcsAdapter, ConversationAdapter {
  constructor(
    private readonly execGlab: ExecGlab = realExecGlab,
    private readonly repository?: GitLabRepositoryRef,
  ) {}

  resolveRelatedWork(
    references: readonly RelatedWorkReference[],
  ): Promise<readonly RelatedWorkItem[]> {
    return resolveGitLabRelatedWork(references, this.execGlab);
  }

  private readonly usernamePromises = new Map<string, Promise<string>>();

  private getUsername(repo: GitLabRepositoryRef): Promise<string> {
    const authority = `${repo.host.toLowerCase()}${repo.port === undefined ? "" : `:${repo.port}`}`;
    let promise = this.usernamePromises.get(authority);
    if (!promise) {
      const lookup = this.execGlab([
        "api", "user", "--hostname", repo.host,
      ]).then(parseUsername);
      promise = lookup.catch((error: unknown) => {
        if (this.usernamePromises.get(authority) === promise) {
          this.usernamePromises.delete(authority);
        }
        throw error;
      });
      this.usernamePromises.set(authority, promise);
    }
    return promise;
  }

  async getPullRequest(locator: ReviewLocator): Promise<PullRequestInfo> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const stdout = await this.execGlab([
      "api",
      "--method",
      "GET",
      "--hostname",
      repo.host,
      projectEndpoint(repo, `merge_requests/${iid}`),
    ]);
    const mr = parseMergeRequest(stdout);
    return {
      id: String(mr.iid),
      headSha: mr.diff_refs.head_sha,
      baseSha: mr.diff_refs.base_sha,
      startSha: mr.diff_refs.start_sha,
      headRef: mr.source_branch,
      baseRef: mr.target_branch,
      title: mr.title,
      description: mr.description ?? "",
      url: mr.web_url,
    };
  }

  async getDiff(locator: ReviewLocator): Promise<string> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    return this.execGlab(["mr", "diff", iid, "--repo", repo.canonicalUrl]);
  }

  async findBotComment(locator: ReviewLocator): Promise<BotComment | null> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const username = await this.getUsername(repo);
    const stdout = await this.execGlab([
      "api", "--method", "GET", "--paginate", "--output", "ndjson",
      "--hostname", repo.host,
      projectEndpoint(repo, `merge_requests/${iid}/notes`),
      "--field", "per_page=100",
    ]);
    for (const note of parseNotes(stdout)) {
      if (note.author.username !== username) continue;
      const marker = parseBotMarker(note.body);
      if (marker === null) continue;
      return { id: String(note.id), body: note.body, ...marker };
    }
    return null;
  }

  async upsertComment(
    locator: ReviewLocator,
    body: string,
    existing: BotComment | null,
  ): Promise<BotComment> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const baseEndpoint = projectEndpoint(repo, `merge_requests/${iid}/notes`);
    const noteId = existing === null ? undefined : validatedNoteId(existing.id);
    const stdout = await this.execGlab([
      "api", "--method", existing === null ? "POST" : "PUT",
      "--hostname", repo.host,
      noteId === undefined ? baseEndpoint : `${baseEndpoint}/${noteId}`,
      "--input", "-",
    ], JSON.stringify({ body }));
    return parseWrittenNote(stdout, body, noteId);
  }

  async createInlineReview(
    locator: ReviewLocator,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<InlinePublishOutcome[]> {
    validateInlinePublishInputs(comments);
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const metadata = await this.getPullRequest(locator);
    const versionsStdout = await this.execGlab([
      "api",
      "--method",
      "GET",
      "--hostname",
      repo.host,
      projectEndpoint(repo, `merge_requests/${iid}/versions`),
    ]);
    const version = parseNewestMergeRequestVersion(versionsStdout);
    if (metadata.startSha === undefined) {
      throw new GlabOutputError("Invalid glab MR metadata: missing start SHA");
    }
    if (metadata.headSha !== headSha) {
      throw new GlabOutputError("GitLab merge request head changed before inline review");
    }
    if (
      metadata.baseSha !== version.base_commit_sha ||
      metadata.headSha !== version.head_commit_sha ||
      metadata.startSha !== version.start_commit_sha
    ) {
      throw new GlabOutputError(
        "GitLab merge request metadata does not match its newest diff version",
      );
    }

    const outcomes: InlinePublishOutcome[] = [];
    const discussionEndpoint = projectEndpoint(
      repo,
      `merge_requests/${iid}/discussions`,
    );
    for (let index = 0; index < comments.length; index += 1) {
      const comment = comments[index]!;
      if (!supportedInlinePosition(comment)) {
        outcomes.push({
          clientId: comment.clientId,
          status: "failed",
          reason: unsupportedPositionReason(),
        });
        continue;
      }

      const { position } = comment;
      const isRange =
        position.start.newLine !== position.end.newLine ||
        position.start.oldLine !== position.end.oldLine ||
        position.start.type !== position.end.type;
      const pathHash = createHash("sha1").update(position.newPath).digest("hex");
      const payload = {
        // GitLab suggestion fences need provider-specific offsets to replace a
        // range. Until the neutral contract carries those offsets, keep the
        // proposed fix visible but non-committable instead of risking a
        // one-line replacement for a multi-line finding.
        body: isRange ? downgradeGitLabRangeSuggestion(comment.body) : comment.body,
        position: {
          base_sha: version.base_commit_sha,
          start_sha: version.start_commit_sha,
          head_sha: version.head_commit_sha,
          position_type: "text",
          old_path: position.oldPath,
          new_path: position.newPath,
          ...(position.end.oldLine === undefined
            ? {}
            : { old_line: position.end.oldLine }),
          new_line: position.end.newLine,
          ...(isRange
            ? {
                line_range: {
                  start: lineRangeEndpoint(pathHash, position.start),
                  end: lineRangeEndpoint(pathHash, position.end),
                },
              }
            : {}),
        },
      };

      try {
        const stdout = await this.execGlab([
          "api",
          "--method",
          "POST",
          "--hostname",
          repo.host,
          discussionEndpoint,
          "--input",
          "-",
        ], JSON.stringify(payload));
        const written = validateWrittenDiscussion(stdout, payload.body);
        outcomes.push({
          clientId: comment.clientId,
          status: "posted",
          identity: validateConversationItemIdentity({
            provider: "gitlab",
            commentId: written.noteId,
            threadId: written.discussionId,
            url: `${repo.canonicalUrl}/-/merge_requests/${iid}#note_${written.noteId}`,
          }, { repo, reviewNumber: Number(iid) }),
        });
      } catch (error) {
        if (error instanceof GlabOutputError) {
          const reason = "GitLab returned an invalid inline discussion response";
          outcomes.push({ clientId: comment.clientId, status: "failed", reason });
          for (const remaining of comments.slice(index + 1)) {
            outcomes.push({
              clientId: remaining.clientId,
              status: "failed",
              reason,
            });
          }
          break;
        }
        if (!(error instanceof GlabCommandError)) throw error;
        const reason = sanitizedWriteFailureReason(error);
        outcomes.push({ clientId: comment.clientId, status: "failed", reason });
        if (classifyGlabWriteFailure(error) === "stop") {
          for (const remaining of comments.slice(index + 1)) {
            outcomes.push({
              clientId: remaining.clientId,
              status: "failed",
              reason,
            });
          }
          break;
        }
      }
    }
    return validateInlinePublishOutcomes(comments, outcomes, { repo, reviewNumber: Number(iid) });
  }

  async resolveStaleReviewThreads(locator: ReviewLocator): Promise<number> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const username = await this.getUsername(repo);
    const baseEndpoint = projectEndpoint(
      repo,
      `merge_requests/${iid}/discussions`,
    );
    const stdout = await this.execGlab([
      "api", "--method", "GET", "--paginate", "--output", "ndjson",
      "--hostname", repo.host,
      baseEndpoint,
      "--field", "per_page=100",
    ]);
    const stale = parseDiscussions(stdout).filter((discussion) => {
      const firstNote = discussion.notes[0];
      return firstNote?.resolved === false &&
        firstNote.author.username === username &&
        firstNote.body.includes(INLINE_COMMENT_MARKER);
    });

    let resolved = 0;
    for (const discussion of stale) {
      try {
        await this.execGlab([
          "api", "--method", "PUT", "--hostname", repo.host,
          `${baseEndpoint}/${encodeURIComponent(discussion.id)}`,
          "--input", "-",
        ], JSON.stringify({ resolved: true }));
        resolved += 1;
      } catch (error) {
        let reason = "unexpected cleanup failure";
        if (error instanceof GlabCommandError) {
          void classifyGlabWriteFailure(error);
          reason = sanitizedWriteFailureReason(error);
        }
        console.warn(
          `GitLabAdapter: could not resolve a stale review discussion ` +
            `(${reason}); continuing with the remaining discussions`,
        );
      }
    }
    return resolved;
  }

  async getMergeBaseSha(
    locator: ReviewLocator,
    baseSha: string,
    headSha: string,
  ): Promise<string | undefined> {
    const { repo } = resolveMergeRequestLocator(locator);
    try {
      const out = await this.execGlab([
        "api",
        "--method",
        "GET",
        "--hostname",
        repo.host,
        projectEndpoint(repo, "repository/merge_base"),
        "--raw-field",
        `refs[]=${baseSha}`,
        "--raw-field",
        `refs[]=${headSha}`,
      ]);
      const parsed = JSON.parse(out) as { id?: unknown };
      return isCommitSha(parsed.id) ? parsed.id : undefined;
    } catch {
      // GitLab also reports it as `diff_refs.start_sha` on the merge request
      // itself, which the caller prefers; this is the fallback for callers that
      // do not have it.
      return undefined;
    }
  }

  async getFileAtRef(
    locator: ReviewLocator,
    ref: string,
    path: string,
  ): Promise<string | undefined> {
    const { repo } = resolveMergeRequestLocator(locator);
    try {
      // GitLab's files endpoint takes the path fully URL-encoded, separators
      // included — unlike GitHub's, which keeps them as path structure.
      return await this.execGlab([
        "api",
        "--method",
        "GET",
        "--hostname",
        repo.host,
        projectEndpoint(repo, `repository/files/${encodeURIComponent(path)}/raw`),
        "--raw-field",
        `ref=${ref}`,
      ]);
    } catch (error) {
      // Absent is an answer; anything else is a failure the caller must see.
      if (error instanceof GlabCommandError && error.httpStatus === 404) return undefined;
      throw error;
    }
  }

  async getRuleFilesFromBase(
    locator: ReviewLocator,
    baseSha: string,
    rulesDir: string,
  ): Promise<RuleFileContent[]> {
    const { repo } = resolveMergeRequestLocator(locator);
    let stdout: string;
    try {
      stdout = await this.execGlab([
        "api",
        "--method",
        "GET",
        "--paginate",
        "--output",
        "ndjson",
        "--hostname",
        repo.host,
        projectEndpoint(repo, "repository/tree"),
        "--raw-field",
        `path=${rulesDir}`,
        "--raw-field",
        `ref=${baseSha}`,
        "--field",
        "per_page=100",
      ]);
    } catch (error) {
      if (error instanceof GlabCommandError && error.httpStatus === 404) {
        return [];
      }
      throw error;
    }

    const normalizedDir = rulesDir.replace(/\/+$/u, "");
    const prefix = `${normalizedDir}/`;
    const selected = parseTreeEntries(stdout)
      .filter((entry) => {
        if (entry.type !== "blob" || entry.mode === "120000") return false;
        if (!entry.path.startsWith(prefix)) return false;
        const relativePath = entry.path.slice(prefix.length);
        return relativePath.endsWith(".md") && !relativePath.includes("/");
      })
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

    const files = new Array<RuleFileContent>(selected.length);
    let nextIndex = 0;
    const fetchNext = async (): Promise<void> => {
      while (nextIndex < selected.length) {
        const index = nextIndex;
        nextIndex += 1;
        const entry = selected[index]!;
        const content = await this.execGlab([
          "api",
          "--method",
          "GET",
          "--hostname",
          repo.host,
          projectEndpoint(repo, `repository/files/${encodeURIComponent(entry.path)}/raw`),
          "--raw-field",
          `ref=${baseSha}`,
        ]);
        files[index] = { path: entry.path.slice(prefix.length), content };
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(RULE_FILE_FETCH_CONCURRENCY, selected.length) },
        fetchNext,
      ),
    );
    return files;
  }

  async getAuthenticatedBotIdentity(): Promise<BotIdentity> {
    if (!this.repository) throw new Error("GitLab conversation identity requires an explicit canonical repository");
    const login = conversationUsername(await this.getUsername(this.repository), "authenticated username");
    return { provider: "gitlab", login, mention: `@${login}` };
  }

  private requireRepository(binding: { provider: string; repositoryDigest: string }): GitLabRepositoryRef {
    if (binding.provider !== "gitlab") throw new Error("GitLab repository provider binding mismatch");
    if (!this.repository) throw new Error("GitLab repository activity requires an explicit canonical repository");
    if (binding.repositoryDigest !== computeRepositoryDigest("gitlab", this.repository.canonicalUrl)) {
      throw new Error("GitLab repository digest binding mismatch");
    }
    return this.repository;
  }

  private repositoryForReview(review: ReviewIdentity): GitLabRepositoryRef {
    if (review.provider !== "gitlab" || !Number.isSafeInteger(review.reviewNumber) || review.reviewNumber <= 0) {
      throw new Error("Invalid GitLab review binding");
    }
    const repo = this.requireRepository(review);
    if (review.url !== `${repo.canonicalUrl}/-/merge_requests/${review.reviewNumber}`) {
      throw new Error("Invalid GitLab review URL binding");
    }
    conversationProviderId(review.reviewId, "review id");
    return repo;
  }

  private async scanStablePages<T>(scan: () => Promise<StableScanResult<T>>): Promise<StableScanResult<T>> {
    for (let attempt = 0; attempt < MAX_STABLE_SCAN_ATTEMPTS; attempt += 1) {
      const first = await scan();
      const second = await scan();
      if (first.count === second.count && first.witness === second.witness) return second;
    }
    throw new ConcurrentGitLabMutationError();
  }

  async resolveReviewIdentity(repository: RepositoryRef, reviewNumber: number): Promise<ReviewIdentity> {
    if (repository.provider !== "gitlab") throw new Error("GitLab review identity requires a GitLab repository");
    if (!Number.isSafeInteger(reviewNumber) || reviewNumber <= 0) throw new Error("Invalid GitLab review binding");
    if (this.repository && this.repository.canonicalUrl !== repository.canonicalUrl) {
      throw new Error("GitLab configured repository binding mismatch");
    }
    const repo = repository;
    const mr = parseConversationMergeRequest(await this.execGlab([
      "api", "--method", "GET", "--hostname", repo.host,
      projectEndpoint(repo, `merge_requests/${reviewNumber}`),
    ]));
    const url = `${repo.canonicalUrl}/-/merge_requests/${reviewNumber}`;
    if (mr.iid !== reviewNumber || mr.webUrl !== url) {
      throw new GlabOutputError("GitLab merge request identity binding mismatch");
    }
    return {
      provider: "gitlab",
      repositoryDigest: computeRepositoryDigest("gitlab", repo.canonicalUrl),
      reviewNumber,
      reviewId: mr.id,
      url,
    };
  }

  private async fetchConversationMergeRequest(review: ReviewIdentity): Promise<ConversationMergeRequest> {
    const repo = this.repositoryForReview(review);
    const mr = parseConversationMergeRequest(await this.execGlab([
      "api", "--method", "GET", "--hostname", repo.host,
      projectEndpoint(repo, `merge_requests/${review.reviewNumber}`),
    ]));
    if (mr.id !== review.reviewId || mr.iid !== review.reviewNumber || mr.webUrl !== review.url) {
      throw new GlabOutputError("GitLab merge request identity binding mismatch");
    }
    return mr;
  }

  private async fetchDiscussion(review: ReviewIdentity, threadId: string): Promise<ConversationDiscussion> {
    const repo = this.repositoryForReview(review);
    const id = conversationDiscussionId(threadId);
    const raw = await this.execGlab([
      "api", "--method", "GET", "--hostname", repo.host,
      projectEndpoint(repo, `merge_requests/${review.reviewNumber}/discussions/${encodeURIComponent(id)}`),
    ]);
    let value: unknown;
    try { value = JSON.parse(raw); } catch (cause) { throw new GlabOutputError("Invalid glab discussion response: malformed JSON", { cause }); }
    const discussion = parseConversationDiscussion(value);
    if (discussion.id !== id) throw new GlabOutputError("GitLab discussion identity binding mismatch");
    return discussion;
  }

  async listOpenReviews(
    repositoryBinding: { provider: "github" | "gitlab"; repositoryDigest: string },
    after?: ReviewDiscoveryCursor,
    pageToken?: OpenReviewPageToken,
  ): Promise<OpenReviewPage> {
    const repo = this.requireRepository(repositoryBinding);
    const binding = { provider: "gitlab" as const, repositoryDigest: repositoryBinding.repositoryDigest };
    const cursor = after === undefined ? undefined : validateReviewDiscoveryCursor(after, binding);
    const continuation = pageToken === undefined ? undefined : decodeTieContinuation(validateOpenReviewPageToken(pageToken, binding).opaque);
    if (continuation && continuation.cursor !== (cursor?.opaque ?? null)) throw new Error("GitLab open review continuation cursor binding mismatch");
    const boundary = continuation?.cursor === null ? undefined : continuation ? decodeHighWater(continuation.cursor) : cursor ? decodeHighWater(cursor.opaque) : undefined;
    const cutoff = continuation?.cutoff;
    const snapshot = await this.scanStablePages(async () => {
      const candidates: OpenReviewPage["reviews"][number][] = [];
      const hash = createHash("sha256");
      let count = 0;
      let cutoffRank = 0;
      let previousStable = -1;
      for (let page = 1; page <= MAX_TARGET_PAGES; page += 1) {
        const rows = parseNdjsonPage(await this.execGlab([
          "api", "--method", "GET", "--output", "ndjson",
          "--hostname", repo.host,
          projectEndpoint(repo, "merge_requests"),
          "--field", "state=all",
          "--field", "order_by=created_at",
          "--field", "sort=asc",
          "--field", "per_page=100",
          "--field", `page=${page}`,
        ]), "merge requests");
        if (rows.length > 100) throw new GlabOutputError("GitLab merge request page exceeds requested bound");
        for (const row of rows) {
          const databaseId = conversationProviderId(row.id, "merge request database id");
          const stable = Number(databaseId);
          if (!Number.isSafeInteger(stable) || stable <= previousStable) throw new GlabOutputError("GitLab merge request stable ordering is nonmonotonic or duplicated");
          previousStable = stable;
          const number = Number(row.iid);
          const state = row.state;
          if (!Number.isSafeInteger(number) || number <= 0 || (state !== "opened" && state !== "closed" && state !== "merged" && state !== "locked")) {
            throw new GlabOutputError("Invalid GitLab merge request binding");
          }
          const url = conversationText(row.web_url, "merge request URL");
          if (url !== `${repo.canonicalUrl}/-/merge_requests/${number}`) throw new GlabOutputError("Invalid GitLab merge request URL binding");
          const headSha = conversationSha(row.sha ?? (isRecord(row.diff_refs) ? row.diff_refs.head_sha : undefined), "merge request head SHA");
          const updatedAt = conversationTimestamp(row.updated_at, "merge request updated timestamp");
          const title = conversationText(row.title, "merge request title");
          addWitnessEntry(hash, [databaseId, databaseId, String(number), String(state), url, headSha, updatedAt, title]);
          count += 1;
          const item = {
            identity: { ...binding, reviewNumber: number, reviewId: databaseId, url },
            title, headSha, updatedAt,
            orderKey: `${updatedAt}|${number.toString().padStart(16, "0")}|${databaseId.padStart(32, "0")}`,
          };
          const afterBoundary = !boundary || updatedAt > boundary.at || (updatedAt === boundary.at && (!boundary.cutoff || item.orderKey > boundary.cutoff));
          if (state === "opened" && afterBoundary && cutoff && item.orderKey <= cutoff) cutoffRank += 1;
          if (state === "opened" && afterBoundary && (!cutoff || item.orderKey > cutoff)) {
            candidates.push(item);
            candidates.sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey));
            if (candidates.length > 101) candidates.pop();
          }
        }
        if (rows.length < 100) break;
        if (page === MAX_TARGET_PAGES) throw new GlabOutputError("GitLab merge request scan exceeded safe page bound");
      }
      return { witness: hash.digest("hex"), count, candidates, cutoffRank };
    });
    if (continuation && (continuation.witness !== snapshot.witness || continuation.count !== snapshot.count)) {
      throw new ConcurrentGitLabMutationError("GitLab changed during an open review continuation");
    }
    if (continuation && snapshot.cutoffRank !== continuation.emittedRank) throw new Error("GitLab open review continuation cutoff rank mismatch");
    const reviews = snapshot.candidates.slice(0, 100);
    if (new Set(reviews.map((item) => item.identity.reviewId)).size !== reviews.length || new Set(reviews.map((item) => item.identity.reviewNumber)).size !== reviews.length) {
      throw new GlabOutputError("Duplicate GitLab merge request identity");
    }
    const priorAt = boundary?.at ?? new Date(0).toISOString();
    const highAt = reviews.at(-1)?.updatedAt ?? priorAt;
    const highSeen = reviews.filter((item) => item.updatedAt === highAt).map((item) => item.identity.reviewId);
    const hasMore = snapshot.candidates.length > 100;
    const stableCursor = hasMore
      ? { scope: "open-review-discovery" as const, ...binding, opaque: cursor?.opaque ?? encodeHighWater(new Date(0).toISOString(), []), orderKey: cursor?.orderKey ?? new Date(0).toISOString() }
      : reviews.length === 0 && cursor
        ? cursor
        : { scope: "open-review-discovery" as const, ...binding, opaque: encodeHighWater(highAt, highSeen, reviews.at(-1)?.orderKey), orderKey: highAt };
    return {
      reviews,
      nextCursor: stableCursor,
      ...(hasMore ? { nextPageToken: { scope: "open-review-page" as const, ...binding,
        opaque: encodeTieContinuation({ v: 1, cursor: cursor?.opaque ?? null, cutoff: reviews.at(-1)!.orderKey, witness: snapshot.witness, count: snapshot.count,
          emittedRank: (continuation?.emittedRank ?? 0) + reviews.length }) } } : {}),
    };
  }

  async listReviewEvents(review: ReviewIdentity, after?: ReviewEventCursor, pageToken?: ReviewEventPageToken): Promise<ReviewEventPage> {
    const binding = { provider: "gitlab" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const cursor = after === undefined ? undefined : validateReviewEventCursor(after, binding);
    const continuation = pageToken === undefined ? undefined : decodeTieContinuation(validateReviewEventPageToken(pageToken, binding).opaque);
    if (continuation && continuation.cursor !== (cursor?.opaque ?? null)) throw new Error("GitLab review event continuation cursor binding mismatch");
    const boundary = continuation?.cursor === null ? undefined : continuation ? decodeHighWater(continuation.cursor) : cursor ? decodeHighWater(cursor.opaque) : undefined;
    const bot = (await this.getAuthenticatedBotIdentity()).login;
    const snapshot = await this.scanStablePages(() => this.scanReviewEventsOnce(review, boundary, continuation?.cutoff, bot));
    if (continuation && (continuation.witness !== snapshot.witness || continuation.count !== snapshot.count)) {
      throw new ConcurrentGitLabMutationError("GitLab changed during a review event continuation");
    }
    if (continuation && snapshot.cutoffRank !== continuation.emittedRank) throw new Error("GitLab review event continuation cutoff rank mismatch");
    const events = snapshot.candidates.slice(0, 100);
    const highAt = events.at(-1)?.updatedAt ?? boundary?.at ?? new Date(0).toISOString();
    const highSeen = events.filter((event) => event.updatedAt === highAt).map(eventBoundaryToken);
    const hasMore = snapshot.candidates.length > 100;
    const stableCursor = hasMore
      ? { scope: "review-events" as const, ...binding, opaque: cursor?.opaque ?? encodeHighWater(new Date(0).toISOString(), []), orderKey: cursor?.orderKey ?? new Date(0).toISOString() }
      : events.length === 0 && cursor
        ? cursor
        : { scope: "review-events" as const, ...binding, opaque: encodeHighWater(highAt, highSeen, events.at(-1)?.orderKey), orderKey: highAt };
    return {
      events,
      nextCursor: stableCursor,
      ...(hasMore ? { nextPageToken: { scope: "review-event-page" as const, ...binding,
        opaque: encodeTieContinuation({ v: 1, cursor: cursor?.opaque ?? null, cutoff: events.at(-1)!.orderKey, witness: snapshot.witness, count: snapshot.count,
          emittedRank: (continuation?.emittedRank ?? 0) + events.length }) } } : {}),
    };
  }

  private async paginateNdjson(
    repo: GitLabRepositoryRef,
    suffix: string,
    perPage: number,
    label: string,
    maxRows?: number,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_TARGET_PAGES; page += 1) {
      const query = suffix.endsWith("/notes")
        ? [
          "--field", "sort=asc",
          "--field", "order_by=created_at",
          "--field", `per_page=${perPage}`,
          "--field", `page=${page}`,
        ]
        : [
          "--field", `per_page=${perPage}`,
          "--field", `page=${page}`,
        ];
      const batch = parseNdjsonPage(await this.execGlab([
        "api", "--method", "GET", "--output", "ndjson",
        "--hostname", repo.host,
        projectEndpoint(repo, suffix),
        ...query,
      ]), label);
      if (batch.length > perPage) throw new GlabOutputError(`GitLab ${label} page exceeds requested bound`);
      rows.push(...batch);
      if (maxRows !== undefined && rows.length >= maxRows) return rows.slice(0, maxRows);
      if (batch.length < perPage) break;
      if (page === MAX_TARGET_PAGES) throw new GlabOutputError(`GitLab ${label} scan exceeded safe page bound`);
    }
    return rows;
  }

  private async scanReviewEventsOnce(
    review: ReviewIdentity,
    boundary: InclusiveHighWater | undefined,
    cutoff: string | undefined,
    bot: string,
  ): Promise<StableScanResult<ReviewActivityEvent>> {
    const repo = this.repositoryForReview(review);
    const binding = { provider: "gitlab" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const mr = await this.fetchConversationMergeRequest(review);
    const hash = createHash("sha256");
    let count = 0;
    let cutoffRank = 0;
    const events: ReviewActivityEvent[] = [];
    const keep = (event: ReviewActivityEvent): void => {
      const afterBoundary = !boundary || event.updatedAt > boundary.at ||
        (event.updatedAt === boundary.at && (boundary.cutoff ? event.orderKey > boundary.cutoff : !boundary.seen.includes(eventBoundaryToken(event))));
      if (afterBoundary && cutoff && event.orderKey <= cutoff) { cutoffRank += 1; return; }
      if (afterBoundary && (!cutoff || event.orderKey > cutoff)) {
        events.push(event);
        events.sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey));
        if (events.length > 101) events.pop();
      }
    };
    const seenNoteIds = new Set<string>();
    for (const row of await this.paginateNdjson(repo, `merge_requests/${review.reviewNumber}/notes`, 50, "notes")) {
      const note = parseConversationNote(row);
      if (seenNoteIds.has(note.id)) throw new GlabOutputError("GitLab note stable ordering is nonmonotonic or duplicated");
      seenNoteIds.add(note.id);
      const revisionId = conversationDigest(`${note.id}\0${note.updatedAt}\0${note.body}`);
      addWitnessEntry(hash, ["note", note.id, revisionId, conversationDigest(JSON.stringify(row))]);
      count += 1;
      if (!isGeneralNote(note)) continue;
      const edited = note.updatedAt !== note.createdAt;
      keep({
        ...binding,
        kind: edited ? "comment-edit" : "general-comment",
        eventId: `mr-note:${note.id}`,
        revisionId,
        ...(edited ? { editedRevisionId: revisionId } : {}),
        orderKey: conversationOrderKey(note.updatedAt, "general-comment", note.id, revisionId),
        authorLogin: note.author,
        authorIsBot: note.author === bot,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        body: note.body,
        url: `${review.url}#note_${note.id}`,
        commentId: note.id,
      } as ReviewActivityEvent);
    }
    const seenDiscussionIds = new Set<string>();
    for (const row of await this.paginateNdjson(repo, `merge_requests/${review.reviewNumber}/discussions`, 100, "discussions")) {
      const discussion = parseConversationDiscussion(row);
      if (seenDiscussionIds.has(discussion.id)) throw new GlabOutputError("Duplicate GitLab discussion identity");
      seenDiscussionIds.add(discussion.id);
      const thread = this.normalizeDiscussion(review, discussion, mr, bot);
      addWitnessEntry(hash, ["thread", discussion.id, conversationDigest(JSON.stringify(row)), thread?.resolutionObservedAt ?? "", mr.headSha]);
      count += 1 + discussion.notes.filter((note) => !note.system).length;
      if (!thread) continue;
      for (const event of thread.events) keep(event);
      keep(thread.resolution);
    }
    events.sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey));
    return { candidates: events, witness: hash.digest("hex"), count, cutoffRank };
  }

  private normalizeDiscussion(
    review: ReviewIdentity,
    discussion: ConversationDiscussion,
    mr: ConversationMergeRequest,
    bot = "",
  ): { readonly events: readonly ReviewActivityEvent[]; readonly resolution: ReviewActivityEvent; readonly summary: ReviewThreadSummary; readonly resolutionObservedAt: string } | undefined {
    if (discussion.individualNote) return undefined;
    const binding = { provider: "gitlab" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const root = discussion.notes[0]!;
    if (discussion.notes.length > MAX_THREAD_SNAPSHOT_NOTES) throw new GlabOutputError("GitLab review thread exceeds the 10,000-note atomic snapshot limit");
    const placement = this.discussionPlacement(root, mr.headSha, discussion.outdated);
    const resolvedFlag = root.resolved === true;
    const outdated = placement?.outdated === true;
    const updatedAt = discussion.notes.flatMap((note) => [note.updatedAt, ...note.reactions.map((reaction) => reaction.createdAt)]).sort().at(-1)!;
    const resolutionObservedAt = mr.updatedAt;
    const summary: ReviewThreadSummary = {
      ...binding,
      threadId: discussion.id,
      rootCommentId: root.id,
      url: `${review.url}#note_${root.id}`,
      resolved: resolvedFlag,
      outdated,
      updatedAt,
      orderKey: conversationOrderKey(updatedAt, "thread", discussion.id),
      ...(placement ? { placement } : {}),
    };
    const events = discussion.notes.filter((note) => !note.system).map((note, index): ReviewActivityEvent => {
      const edited = note.updatedAt !== note.createdAt;
      const reactions = note.reactions.map((reaction): ReviewReaction => ({
        ...reaction,
        authorIsBot: reaction.authorLogin === bot,
      }));
      const activityUpdatedAt = [note.updatedAt, ...reactions.map((reaction) => reaction.createdAt)].sort().at(-1)!;
      const revisionId = conversationDigest(`${note.id}\0${note.updatedAt}\0${note.body}\0${JSON.stringify(reactions)}`);
      return {
        ...binding,
        kind: edited ? "comment-edit" : "thread-comment",
        eventId: `discussion-note:${note.id}`,
        revisionId,
        ...(edited ? { editedRevisionId: revisionId } : {}),
        orderKey: conversationOrderKey(activityUpdatedAt, "thread-comment", note.id, revisionId),
        authorLogin: note.author,
        authorIsBot: note.author === bot,
        createdAt: note.createdAt,
        updatedAt: activityUpdatedAt,
        body: note.body,
        url: `${review.url}#note_${note.id}`,
        commentId: note.id,
        ...(reactions.length === 0 ? {} : { reactions }),
        threadId: discussion.id,
        ...(index === 0 ? {} : { parentCommentId: root.id }),
        ...(placement ? { placement } : {}),
      } as ReviewActivityEvent;
    });
    const revisionId = conversationDigest(`${discussion.id}\0resolved=${String(resolvedFlag)}\0outdated=${String(outdated)}`);
    const resolution: ReviewActivityEvent = {
      ...binding,
      kind: "thread-resolution",
      eventId: `thread-resolution:${discussion.id}`,
      revisionId,
      orderKey: conversationOrderKey(resolutionObservedAt, "thread-resolution", discussion.id, revisionId),
      createdAt: root.createdAt,
      updatedAt: resolutionObservedAt,
      body: "",
      url: summary.url,
      threadId: discussion.id,
      resolved: resolvedFlag,
      outdated,
      ...(placement ? { placement } : {}),
    };
    return { events, resolution, summary, resolutionObservedAt };
  }

  private discussionPlacement(
    root: ConversationNote,
    currentHeadSha: string,
    discussionOutdated?: boolean,
  ): ReviewThreadSummary["placement"] | undefined {
    if (!root.position) return undefined;
    const originalHeadSha = root.position.headSha;
    // Outdated means the provider marked the anchor stale, not that HEAD moved.
    const outdated = root.outdated === true || discussionOutdated === true;
    return validateConversationAnchor({
      file: root.position.file,
      ...(root.position.line === undefined ? {} : { line: root.position.line }),
      ...(root.position.side === undefined ? {} : { side: root.position.side }),
      ...(originalHeadSha === undefined ? {} : { originalHeadSha, currentHeadSha }),
      outdated,
    });
  }

  async listReviewThreads(review: ReviewIdentity, pageToken?: ReviewThreadPageToken): Promise<ReviewThreadPage> {
    const repo = this.repositoryForReview(review);
    const binding = { provider: "gitlab" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const opaque = pageToken === undefined ? "1" : validateReviewThreadPageToken(pageToken, binding).opaque;
    if (!/^[1-9]\d*$/u.test(opaque)) throw new Error("Invalid GitLab thread page token");
    const page = Number(opaque);
    if (!Number.isSafeInteger(page)) throw new Error("Invalid GitLab thread page token");
    const mr = await this.fetchConversationMergeRequest(review);
    const rows = parseNdjsonPage(await this.execGlab([
      "api", "--method", "GET", "--output", "ndjson",
      "--hostname", repo.host,
      projectEndpoint(repo, `merge_requests/${review.reviewNumber}/discussions`),
      "--field", "per_page=100",
      "--field", `page=${page}`,
    ]), "discussions");
    if (rows.length > 100) throw new GlabOutputError("GitLab discussion page exceeds requested bound");
    const threads = rows
      .map(parseConversationDiscussion)
      .map((discussion) => this.normalizeDiscussion(review, discussion, mr)?.summary)
      .filter((summary): summary is ReviewThreadSummary => summary !== undefined)
      .sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey));
    return {
      threads,
      ...(rows.length === 100 ? { nextPageToken: { scope: "review-thread-page" as const, ...binding, opaque: String(page + 1) } } : {}),
    };
  }

  async getReviewThread(review: ReviewIdentity, threadId: string): Promise<ReviewThreadSnapshot> {
    const mr = await this.fetchConversationMergeRequest(review);
    const bot = (await this.getAuthenticatedBotIdentity()).login;
    const fetched = await this.fetchDiscussion(review, threadId);
    const notes = new Array<ConversationNote>(fetched.notes.length);
    let nextNote = 0;
    const normalizeNext = async (): Promise<void> => {
      while (nextNote < fetched.notes.length) {
        const index = nextNote;
        nextNote += 1;
        const note = fetched.notes[index]!;
        notes[index] = note.system || note.author !== bot
          ? note
          : { ...note, reactions: await this.fetchNoteThumbsUpReactions(review, note.id) };
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(REACTION_FETCH_CONCURRENCY, fetched.notes.length) },
      normalizeNext,
    ));
    const discussion: ConversationDiscussion = {
      ...fetched,
      notes,
    };
    const normalized = this.normalizeDiscussion(review, discussion, mr, bot);
    if (!normalized) throw new Error("GitLab review thread not found in target review");
    return { ...normalized.summary, events: [...normalized.events].sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey)) };
  }

  private async fetchNoteThumbsUpReactions(
    review: ReviewIdentity,
    noteId: string,
  ): Promise<readonly Omit<ReviewReaction, "authorIsBot">[]> {
    const repo = this.repositoryForReview(review);
    const rows = await this.paginateNdjson(
      repo,
      `merge_requests/${review.reviewNumber}/notes/${encodeURIComponent(conversationProviderId(noteId, "note id"))}/award_emoji`,
      100,
      "note award emoji",
      100,
    );
    return parseConversationReactions(rows);
  }

  private validateReplyInput(review: ReviewIdentity, input: GeneralReplyInput): void {
    if (input.provider !== review.provider || input.repositoryDigest !== review.repositoryDigest || input.reviewNumber !== review.reviewNumber) {
      throw new Error("GitLab reply input binding mismatch");
    }
    if (typeof input.body !== "string" || input.body.length === 0) throw new Error("GitLab reply body must not be empty");
  }

  private async writeConversationNote(
    review: ReviewIdentity,
    body: string,
    suffix: string,
    threadId?: string,
  ): Promise<ConversationItemIdentity> {
    const repo = this.repositoryForReview(review);
    const bot = (await this.getAuthenticatedBotIdentity()).login;
    let value: unknown;
    try {
      value = JSON.parse(await this.execGlab([
        "api", "--method", "POST", "--hostname", repo.host,
        projectEndpoint(repo, suffix),
        "--input", "-",
      ], JSON.stringify({ body })));
    } catch (cause) {
      throw new Error("Invalid GitLab reply write response", { cause });
    }
    const row = conversationRecord(value, "reply write");
    const id = conversationProviderId(row.id, "reply id");
    if (row.body !== body || conversationUsername(conversationRecord(row.author, "reply author").username, "reply author username") !== bot) {
      throw new Error("GitLab reply response body/author mismatch");
    }
    return validateConversationItemIdentity({
      provider: "gitlab",
      commentId: id,
      ...(threadId ? { threadId } : {}),
      url: `${review.url}#note_${id}`,
    }, { repo, reviewNumber: review.reviewNumber });
  }

  async resolveReviewThread(review: ReviewIdentity, threadId: string): Promise<void> {
    const repo = this.repositoryForReview(review);
    const id = conversationDiscussionId(threadId);
    await this.execGlab([
      "api", "--method", "PUT", "--hostname", repo.host,
      projectEndpoint(repo, `merge_requests/${review.reviewNumber}/discussions/${encodeURIComponent(id)}`),
      "--input", "-",
    ], JSON.stringify({ resolved: true }));
  }

  async postGeneralReply(review: ReviewIdentity, input: GeneralReplyInput): Promise<ConversationItemIdentity> {
    this.validateReplyInput(review, input);
    this.repositoryForReview(review);
    return this.writeConversationNote(review, input.body, `merge_requests/${review.reviewNumber}/notes`);
  }

  async postThreadReply(review: ReviewIdentity, input: ThreadReplyInput): Promise<ConversationItemIdentity> {
    this.validateReplyInput(review, input);
    conversationDiscussionId(input.threadId);
    if (!input.parentCommentId) throw new Error("GitLab thread replies require parentCommentId");
    const parent = conversationProviderId(input.parentCommentId, "reply parent comment id");
    let discussion: ConversationDiscussion;
    try {
      discussion = await this.fetchDiscussion(review, input.threadId);
    } catch (cause) {
      throw new Error("GitLab reply parent does not belong to addressed thread", { cause });
    }
    if (discussion.individualNote || !discussion.notes.some((note) => note.id === parent)) {
      throw new Error("GitLab reply parent does not belong to addressed thread");
    }
    return this.writeConversationNote(
      review,
      input.body,
      `merge_requests/${review.reviewNumber}/discussions/${encodeURIComponent(input.threadId)}/notes`,
      input.threadId,
    );
  }

  async findBotChildMarker(review: ReviewIdentity, marker: ChildMarkerLookup): Promise<ConversationItemIdentity | null> {
    if (marker.provider !== review.provider || marker.repositoryDigest !== review.repositoryDigest || marker.reviewNumber !== review.reviewNumber) {
      throw new Error("GitLab child marker lookup binding mismatch");
    }
    const repo = this.repositoryForReview(review);
    const bot = (await this.getAuthenticatedBotIdentity()).login;
    const matches: ConversationItemIdentity[] = [];
    const expected = {
      kind: marker.kind,
      parentId: marker.parentId,
      childId: marker.childId,
      repositoryDigest: marker.repositoryDigest,
      reviewNumber: marker.reviewNumber,
      contentDigest: marker.contentDigest,
    };
    for (const row of await this.paginateNdjson(repo, `merge_requests/${review.reviewNumber}/discussions`, 100, "discussions")) {
      const discussion = parseConversationDiscussion(row);
      for (const note of discussion.notes) {
        if (note.author !== bot) continue;
        const candidate = note.body.split(/\r?\n/u).at(-1) ?? "";
        if (!verifyChildMarkerBinding(candidate, expected)) continue;
        const canonicalBody = canonicalInlineBody(note.body);
        const suffix = `\n${candidate}`;
        if (!canonicalBody.endsWith(suffix)) throw new Error("Authenticated GitLab child marker is not a separable terminal suffix");
        let visibleBody = canonicalBody.slice(0, -suffix.length);
        const inlineSuffix = `\n${INLINE_COMMENT_MARKER}`;
        if (visibleBody.endsWith(inlineSuffix)) visibleBody = visibleBody.slice(0, -inlineSuffix.length);
        if (computeContentDigest(visibleBody) !== marker.contentDigest) throw new Error("Authenticated GitLab child marker visible body digest mismatch");
        matches.push(validateConversationItemIdentity({
          provider: "gitlab",
          commentId: note.id,
          ...(discussion.individualNote ? {} : { threadId: discussion.id }),
          url: `${review.url}#note_${note.id}`,
        }, { repo, reviewNumber: review.reviewNumber }));
        if (matches.length > 1) throw new Error("Multiple authenticated GitLab child marker matches");
      }
    }
    return matches[0] ?? null;
  }

  async findPublishedMarker(locator: ReviewLocator, marker: string): Promise<ConversationItemIdentity | null> {
    if (typeof marker !== "string" || marker.length === 0 || marker.length > 2_048) {
      throw new Error("Invalid publication marker");
    }
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const parsed = parseChildMarker(marker);
    if (parsed !== null && this.repository !== undefined) {
      const mr = parseConversationMergeRequest(await this.execGlab([
        "api", "--method", "GET", "--hostname", repo.host,
        projectEndpoint(repo, `merge_requests/${iid}`),
      ]));
      return this.findBotChildMarker({
        provider: "gitlab",
        repositoryDigest: computeRepositoryDigest("gitlab", repo.canonicalUrl),
        reviewNumber: Number(iid),
        reviewId: mr.id,
        url: mr.webUrl,
      }, {
        provider: "gitlab",
        repositoryDigest: parsed.repositoryDigest,
        reviewNumber: parsed.reviewNumber,
        kind: parsed.kind,
        parentId: parsed.parentId,
        childId: parsed.childId,
        contentDigest: parsed.contentDigest,
      });
    }
    const username = await this.getUsername(repo);
    const matches: ConversationItemIdentity[] = [];
    const binding = { repo, reviewNumber: Number(iid) };
    for (const row of await this.paginateNdjson(repo, `merge_requests/${iid}/discussions`, 100, "discussions")) {
      const discussion = parseConversationDiscussion(row);
      for (const note of discussion.notes) {
        if (note.author !== username) continue;
        const lastLine = note.body.split(/\r?\n/u).at(-1) ?? "";
        if (lastLine !== marker && !note.body.includes(marker)) continue;
        matches.push(validateConversationItemIdentity({
          provider: "gitlab",
          commentId: note.id,
          ...(discussion.individualNote ? {} : { threadId: discussion.id }),
          url: `${repo.canonicalUrl}/-/merge_requests/${iid}#note_${note.id}`,
        }, binding));
        if (matches.length > 1) throw new Error("Multiple authenticated GitLab publication marker matches");
      }
    }
    return matches[0] ?? null;
  }
}
