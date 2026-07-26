import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { parseBotMarker } from "../review/comment-marker.js";
import { INLINE_COMMENT_MARKER } from "../review/comment-format.js";
import type { GitLabRepositoryRef } from "../target/types.js";
import {
  validateInlinePublishInputs,
  validateInlinePublishOutcomes,
} from "./adapter.js";
import type {
  BotComment,
  InlineReviewComment,
  InlinePublishOutcome,
  PullRequestInfo,
  ReviewLocator,
  RuleFileContent,
  VcsAdapter,
} from "./adapter.js";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const RULE_FILE_FETCH_CONCURRENCY = 4;
const SHA_RE = /^[0-9a-f]{40}$/i;
const HTTP_DIAGNOSTIC_RE =
  /(?:^|\r?\n)(?:HTTP ([1-5]\d{2})|glab: [^\r\n]* \(HTTP ([1-5]\d{2})\))\r?(?=\n|$)/;

export type ExecGlab = (
  args: readonly string[],
  stdin?: string,
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

export const realExecGlab: ExecGlab = (args, stdin) =>
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

function validateWrittenDiscussion(stdout: string, expectedBody: string): void {
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

export class GitLabAdapter implements VcsAdapter {
  constructor(private readonly execGlab: ExecGlab = realExecGlab) {}

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
        validateWrittenDiscussion(stdout, comment.body);
        outcomes.push({ clientId: comment.clientId, status: "posted" });
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
    return validateInlinePublishOutcomes(comments, outcomes);
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
}
