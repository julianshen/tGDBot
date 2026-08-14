import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { INLINE_COMMENT_MARKER } from "../review/comment-format.js";
import {
  deriveInlineChildId,
  formatInlineRecoveryMarker,
  parseBotMarker,
  validateInlineRecoveryState,
  type InlineRecoveryChild,
  type InlineRecoveryState,
} from "../review/comment-marker.js";
import { AmbiguousInlinePublishError, validateConversationItemIdentity, validateInlinePublishInputs } from "./adapter.js";
import type {
  BotComment,
  InlineReviewComment,
  InlinePublishOutcome,
  PullRequestInfo,
  ReviewLocator,
  RuleFileContent,
  VcsAdapter,
} from "./adapter.js";
import type { GitHubRepositoryRef, RepositoryRef } from "../target/types.js";
import type { RelatedWorkItem, RelatedWorkReference } from "../review/related-work.js";
import { resolveGitHubRelatedWork } from "./github-related-work.js";
import { computeContentDigest, computeRepositoryDigest, parseChildMarker, verifyChildMarkerBinding } from "../conversation/markers.js";
import type { BotIdentity, ConversationItemIdentity, ReviewIdentity } from "../conversation/types.js";
import {
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
  type ReviewEventPage,
  type ReviewEventPageToken,
  type ReviewThreadPage,
  type ReviewThreadPageToken,
  type ReviewThreadSnapshot,
  type ThreadReplyInput,
} from "./conversation-adapter.js";

/**
 * Seam for shelling out to the `gh` CLI. GitHubAdapter accepts an ExecGh
 * implementation via its constructor (defaulting to `realExecGh`) so unit
 * tests can inject a mock/stub and never spawn a real `gh` process — per
 * SPEC.md's Testing Strategy ("VCS adapters: mock `gh`/`glab` CLI
 * invocations, no real network/CLI calls in unit tests").
 *
 * `stdin`, when provided, is piped to the child process (used for
 * `--body-file -` / `--input -` invocations so comment bodies never have to
 * be embedded in a shell-quoted argument). `options.timeoutMs` bounds focused
 * metadata lookups without changing existing callers' process behavior.
 */
export type ExecGh = (
  args: string[],
  stdin?: string,
  options?: { timeoutMs?: number },
) => Promise<string>;

/**
 * Real implementation: shells out to the actual `gh` CLI via `execFile` (no
 * shell interpolation). `child_process.execFile`'s promisified form doesn't
 * support piping stdin, so this wraps the callback form directly and writes
 * `stdin` to the child process before awaiting completion.
 */
export const realExecGh: ExecGh = (args, stdin, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        maxBuffer: 10 * 1024 * 1024,
        ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });

export class GitHubThreadSnapshotTooLargeError extends Error {
  readonly code = "GITHUB_THREAD_SNAPSHOT_TOO_LARGE";
  constructor() {
    super("GitHub review thread exceeds the 10,000-comment atomic snapshot limit");
    this.name = "GitHubThreadSnapshotTooLargeError";
  }
}

export class GitHubLookupResourceLimitError extends Error {
  constructor(message = "GitHub targeted lookup exceeded its bounded resource limit") {
    super(message);
    this.name = "GitHubLookupResourceLimitError";
  }
}

export class ConcurrentGitHubMutationError extends Error {
  constructor(message = "GitHub changed during a stable snapshot scan") {
    super(message);
    this.name = "ConcurrentGitHubMutationError";
  }
}

const MAX_THREAD_SNAPSHOT_COMMENTS = 10_000;
const MAX_TARGET_THREAD_PAGES = 1_000;
const MAX_TARGET_COMMENT_PAGES = 1_000;
const MAX_STABLE_SCAN_ATTEMPTS = 3;

interface GhPrViewJson {
  headRefOid: string;
  baseRefOid: string;
  headRefName?: string;
  baseRefName?: string;
  title: string;
  body?: string | null;
  url?: string;
}

function validatedIssueCommentId(id: string): number {
  if (!/^[1-9]\d*$/u.test(id)) {
    throw new Error("Invalid existing GitHub comment id");
  }
  const value = Number(id);
  if (!Number.isSafeInteger(value)) {
    throw new Error("Invalid existing GitHub comment id");
  }
  return value;
}

interface GhUser {
  login: string;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/u;
const SHA_RE = /^[0-9a-f]{40,64}$/u;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid GitHub ${label} response`);
  return value as Record<string, unknown>;
}

function textField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid GitHub ${label}`);
  return value;
}

function canonicalGitHubRepository(repo: GitHubRepositoryRef): GitHubRepositoryRef {
  const owner = repo.owner.toLowerCase();
  const name = repo.repo.toLowerCase();
  return { provider: "github", host: "github.com", owner, repo: name, canonicalUrl: `https://github.com/${owner}/${name}` };
}

function sameGitHubRepository(left: GitHubRepositoryRef, right: GitHubRepositoryRef): boolean {
  return canonicalGitHubRepository(left).canonicalUrl === canonicalGitHubRepository(right).canonicalUrl;
}

function sameGitHubBinding(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
}

function boundGitHubCommentUrl(url: string, review: ReviewIdentity): string {
  if (url.length < review.url.length || !sameGitHubBinding(url.slice(0, review.url.length), review.url)) {
    throw new Error("Invalid GitHub comment URL binding");
  }
  const suffix = url.slice(review.url.length);
  if (suffix !== "" && !suffix.startsWith("#")) throw new Error("Invalid GitHub comment URL binding");
  return `${review.url}${suffix}`;
}

function providerId(value: unknown, label: string): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) throw new Error(`Invalid GitHub ${label}`);
  return id;
}

function timestamp(value: unknown, label: string): string {
  const result = textField(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result)) {
    throw new Error(`Invalid GitHub ${label}`);
  }
  const epoch = Date.parse(result);
  if (!Number.isFinite(epoch)) throw new Error(`Invalid GitHub ${label}`);
  return new Date(epoch).toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalInlineBody(body: string): string {
  return body.replace(/\r\n?/gu, "\n");
}

function orderKey(at: string, type: string, id: string, revision = ""): string {
  return `${at}|${type}|${id.padStart(32, "0")}|${revision}`;
}

function eventBoundaryToken(event: ReviewActivityEvent): string {
  return event.kind === "thread-resolution"
    ? `r:${event.threadId}:${event.resolved ? "1" : "0"}:${event.outdated ? "1" : "0"}`
    : event.revisionId;
}

function parseSlurpedArray(raw: string, label: string): Record<string, unknown>[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (cause) { throw new Error(`Invalid GitHub ${label} JSON`, { cause }); }
  if (!Array.isArray(value)) throw new Error(`Invalid GitHub ${label} response`);
  const flat = value.length > 0 && Array.isArray(value[0]) ? (value as unknown[][]).flat() : value;
  return flat.map((entry) => object(entry, label));
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
    const value = object(JSON.parse(opaque), "cursor high-water");
    const at = timestamp(value.at, "cursor high-water timestamp");
    if (!Array.isArray(value.seen) || value.seen.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("Invalid GitHub cursor seen set");
    if (value.cutoff !== undefined && (typeof value.cutoff !== "string" || value.cutoff.length === 0)) throw new Error("Invalid GitHub cursor cutoff");
    return { at, seen: value.seen as string[], ...(typeof value.cutoff === "string" ? { cutoff: value.cutoff } : {}) };
  } catch (cause) {
    throw new Error("Invalid GitHub cursor high-water state", { cause });
  }
}

function encodeHighWater(at: string, seen: readonly string[], cutoff?: string): string {
  const unique = cutoff ? [] : [...new Set(seen)].sort();
  let encoded = JSON.stringify({ at, seen: unique, ...(cutoff ? { cutoff } : {}) });
  if (Buffer.byteLength(encoded, "utf8") > 3_900) {
    const overlap = new Date(Date.parse(at) - 1).toISOString();
    encoded = JSON.stringify({ at: overlap, seen: [] });
  }
  return encoded;
}

type TieContinuationPayload = Omit<TieContinuation, "checksum">;

function tieContinuationChecksum(value: TieContinuationPayload): string {
  return digest(JSON.stringify(value));
}

function encodeTieContinuation(value: TieContinuationPayload): string {
  const encoded = JSON.stringify({ ...value, checksum: tieContinuationChecksum(value) });
  if (Buffer.byteLength(encoded, "utf8") > 3_900) throw new Error("GitHub continuation token exceeds safe bound");
  return encoded;
}

function decodeTieContinuation(opaque: string): TieContinuation {
  try {
    const value = object(JSON.parse(opaque), "tie continuation");
    const keys = Object.keys(value).sort();
    if (keys.join("\0") !== ["checksum", "count", "cursor", "cutoff", "emittedRank", "v", "witness"].sort().join("\0")) throw new Error("Invalid GitHub continuation properties");
    if (value.v !== 1 || (value.cursor !== null && typeof value.cursor !== "string") || typeof value.cutoff !== "string" || value.cutoff.length === 0 ||
      typeof value.witness !== "string" || !/^[0-9a-f]{64}$/u.test(value.witness) || !Number.isSafeInteger(value.count) || (value.count as number) < 0 ||
      !Number.isSafeInteger(value.emittedRank) || (value.emittedRank as number) <= 0 || (value.emittedRank as number) > (value.count as number) ||
      typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/u.test(value.checksum)) {
      throw new Error("Invalid GitHub tie continuation");
    }
    if (value.cursor !== null) decodeHighWater(value.cursor);
    const parsed = value as unknown as TieContinuation;
    const { checksum, ...payload } = parsed;
    if (checksum !== tieContinuationChecksum(payload)) throw new Error("Invalid GitHub continuation checksum");
    return parsed;
  } catch (cause) {
    throw new Error(cause instanceof Error && /checksum/iu.test(cause.message)
      ? "Invalid GitHub tie continuation checksum"
      : "Invalid GitHub tie continuation state", { cause });
  }
}

function addWitnessEntry(hash: ReturnType<typeof createHash>, parts: readonly string[]): void {
  for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}:`).update(part);
  hash.update("\n");
}

// `gh repo view --json nameWithOwner` response — the resolved "owner/name" of
// the ambient repo context. Needed because `gh api graphql` does NOT do the
// REST-path `{owner}/{repo}` placeholder substitution; GraphQL variables must
// carry the real values.
interface GhRepoViewJson {
  nameWithOwner: string;
}

// The slice of the reviewThreads GraphQL response resolveStaleReviewThreads
// reads. Thread resolution is GraphQL-only (REST has no resolve; deleting
// would destroy history), which is why this method alone speaks GraphQL.
interface GhReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: {
            id: string;
            isResolved: boolean;
            comments?: { nodes?: { author?: { login?: string } | null; body?: string }[] };
          }[];
        };
      };
    };
  };
}

const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$cursor:String){" +
  "repository(owner:$owner,name:$name){pullRequest(number:$number){" +
  "reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}" +
  "nodes{id isResolved comments(first:1){nodes{author{login} body}}}}}}}";

const RESOLVE_THREAD_MUTATION =
  "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id}}}";

// One entry of a GitHub Contents API directory listing
// (`gh api repos/{owner}/{repo}/contents/{path}?ref={sha}` when `path` is a
// directory returns an array of these; when `path` is a file it returns a
// single object of roughly this same shape plus `content`/`encoding` — see
// GhContentsFileResponse below).
interface GhContentsEntry {
  name: string;
  path: string;
  type: string; // "file" | "dir" | "symlink" | "submodule"
  sha: string;
}

// The Contents API's single-file response shape (used both for the
// "path is a file, not a directory" case above and for the per-file content
// fetch below). `content` is base64-encoded (GitHub inserts a newline every
// 60 chars — Node's Buffer.from(..., "base64") ignores embedded whitespace,
// confirmed against a real `gh api .../contents/<file>` response).
interface GhContentsFileResponse {
  content: string;
  encoding: string;
}

// `gh api`'s non-zero-exit rejection carries the HTTP status in its
// stderr-derived error message (e.g. `gh: Not Found (HTTP 404)`), appended
// by Node's execFile to the rejected Error's `.message` — confirmed
// empirically against a real `gh api` 404 response (there is no structured
// "status code" field on the rejection itself). Used by
// getRuleFilesFromBase to distinguish "rulesDir doesn't exist on the base
// branch" (return [], per ADR-002's existing "no rules dir = zero user
// rules" semantics) from a genuine error, which must still propagate.
function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /HTTP 404/.test(err.message);
}

function resolvePullLocator(locator: ReviewLocator): {
  repo?: GitHubRepositoryRef;
  id: string;
} {
  if (!Number.isSafeInteger(locator.number) || locator.number <= 0) {
    throw new Error("Review locator number must be a positive integer");
  }
  if (locator.kind === "repository") {
    if (locator.repo.provider !== "github") {
      throw new Error("GitHubAdapter cannot use a GitLab repository locator");
    }
    return { repo: locator.repo, id: String(locator.number) };
  }
  return { id: String(locator.number) };
}

function repoFlag(repo?: GitHubRepositoryRef): string[] {
  // `gh pr` documents `--repo [HOST/]OWNER/REPO` as the explicit selector:
  // https://cli.github.com/manual/gh_pr_view
  return repo ? ["--repo", `${repo.host}/${repo.owner}/${repo.repo}`] : [];
}

function apiRepo(repo?: GitHubRepositoryRef): string {
  // `gh api` documents that {owner}/{repo} placeholders use ambient context;
  // canonical-URL runs therefore render the REST path explicitly instead:
  // https://cli.github.com/manual/gh_api
  return repo ? `repos/${repo.owner}/${repo.repo}` : "repos/{owner}/{repo}";
}

function apiHost(repo?: GitHubRepositoryRef): string[] {
  return repo ? ["--hostname", repo.host] : [];
}

/**
 * GitHubAdapter: VcsAdapter implementation backed by the `gh` CLI.
 *
 * Repository locators use `--repo host/owner/repo`, explicit REST paths, and
 * explicit GraphQL variables. Ambient locators retain `gh`'s repository
 * inference and reproduce the existing ambient command arguments.
 */
export class GitHubAdapter implements VcsAdapter, ConversationAdapter {
  constructor(
    private readonly execGh: ExecGh = realExecGh,
    private readonly repository?: GitHubRepositoryRef,
  ) {}

  resolveRelatedWork(references: readonly RelatedWorkReference[]): Promise<readonly RelatedWorkItem[]> {
    return resolveGitHubRelatedWork(references, this.execGh);
  }

  // Caches the resolved bot login (the currently-authenticated `gh` identity)
  // across calls within an adapter instance, so `gh api user` is only ever
  // invoked once per process — not once per comment-list fetch. Caching the
  // in-flight Promise (not just the resolved value) also collapses
  // concurrent callers onto a single `gh api user` invocation.
  private readonly botLoginPromises = new Map<string, Promise<string>>();

  /**
   * Resolves the identity `gh` is currently authenticated as, via
   * `gh api user`. This tool is run from an environment authenticated as a real
   * user (a developer's terminal, or CI you provide a token for), so `gh api
   * user` resolves that user's login — the identity findBotComment matches
   * against so a spoofed marker from another author can't trick dedup.
   */
  private getBotLogin(repo?: GitHubRepositoryRef): Promise<string> {
    const cacheKey = repo?.host ?? "";
    let promise = this.botLoginPromises.get(cacheKey);
    if (!promise) {
      promise = this.execGh(["api", "user", ...apiHost(repo)]).then((out) => {
        const parsed = object(JSON.parse(out) as GhUser, "authenticated user");
        const login = textField(parsed.login, "authenticated user login").toLowerCase();
        if (!LOGIN_RE.test(login)) throw new Error("Invalid GitHub authenticated user login");
        return login;
      }).catch((error: unknown) => {
        this.botLoginPromises.delete(cacheKey);
        throw error;
      });
      this.botLoginPromises.set(cacheKey, promise);
    }
    return promise;
  }

  async getAuthenticatedBotIdentity(): Promise<BotIdentity> {
    const login = await this.getBotLogin(this.repository);
    return { provider: "github", login, mention: `@${login}` };
  }

  private requireRepository(binding: { provider: string; repositoryDigest: string }): GitHubRepositoryRef {
    if (binding.provider !== "github") throw new Error("GitHub repository provider binding mismatch");
    if (!this.repository) throw new Error("GitHub repository activity requires an explicit canonical repository");
    const canonical = canonicalGitHubRepository(this.repository);
    const expected = new Set([
      computeRepositoryDigest("github", this.repository.canonicalUrl),
      computeRepositoryDigest("github", canonical.canonicalUrl),
    ]);
    if (!expected.has(binding.repositoryDigest)) throw new Error("GitHub repository digest binding mismatch");
    return this.repository;
  }

  private repositoryForReview(review: ReviewIdentity): GitHubRepositoryRef {
    if (review.provider !== "github" || !Number.isSafeInteger(review.reviewNumber) || review.reviewNumber <= 0) {
      throw new Error("Invalid GitHub review binding");
    }
    let url: URL;
    try { url = new URL(review.url); } catch { throw new Error("Invalid GitHub review URL"); }
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/u.exec(url.pathname);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !match || Number(match[3]) !== review.reviewNumber) {
      throw new Error("Invalid GitHub review URL binding");
    }
    const repo = canonicalGitHubRepository({
      provider: "github", host: "github.com", owner: match[1]!, repo: match[2]!,
      canonicalUrl: `https://github.com/${match[1]}/${match[2]}`,
    });
    if (url.hostname.toLowerCase() !== repo.host || computeRepositoryDigest("github", repo.canonicalUrl) !== review.repositoryDigest) {
      throw new Error("GitHub review repository binding mismatch");
    }
    if (this.repository && !sameGitHubRepository(this.repository, repo)) throw new Error("GitHub configured repository binding mismatch");
    providerId(review.reviewId, "review id");
    return repo;
  }

  async resolveReviewIdentity(repository: RepositoryRef, reviewNumber: number): Promise<ReviewIdentity> {
    if (repository.provider !== "github") throw new Error("GitHub review identity requires a GitHub repository");
    if (!Number.isSafeInteger(reviewNumber) || reviewNumber <= 0) throw new Error("Invalid GitHub review binding");
    if (this.repository && !sameGitHubRepository(this.repository, repository)) {
      throw new Error("GitHub configured repository binding mismatch");
    }
    const repo = repository;
    const canonical = canonicalGitHubRepository(repo);
    const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id url}}}";
    const parsed = object(JSON.parse(await this.execGh(["api", "graphql", ...apiHost(repo), "-f", `query=${query}`, "-F", `owner=${repo.owner}`, "-F", `name=${repo.repo}`, "-F", `number=${reviewNumber}`])), "pull request identity");
    const pull = object(object(object(parsed.data, "GraphQL data").repository, "GraphQL repository").pullRequest, "GraphQL pull request");
    const url = textField(pull.url, "GraphQL pull request URL");
    if (!sameGitHubBinding(url, `${canonical.canonicalUrl}/pull/${reviewNumber}`) &&
      !sameGitHubBinding(url, `${repo.canonicalUrl}/pull/${reviewNumber}`)) {
      throw new Error("GitHub GraphQL pull request URL binding mismatch");
    }
    return {
      provider: "github",
      repositoryDigest: computeRepositoryDigest("github", canonical.canonicalUrl),
      reviewNumber,
      reviewId: providerId(pull.id, "GraphQL pull request id"),
      url: `${canonical.canonicalUrl}/pull/${reviewNumber}`,
    };
  }

  private async scanStablePages<T>(scan: () => Promise<StableScanResult<T>>): Promise<StableScanResult<T>> {
    for (let attempt = 0; attempt < MAX_STABLE_SCAN_ATTEMPTS; attempt += 1) {
      const first = await scan();
      const second = await scan();
      if (first.count === second.count && first.witness === second.witness) return second;
    }
    throw new ConcurrentGitHubMutationError();
  }

  async listOpenReviews(
    repositoryBinding: { provider: "github" | "gitlab"; repositoryDigest: string },
    after?: ReviewDiscoveryCursor,
    pageToken?: OpenReviewPageToken,
  ): Promise<OpenReviewPage> {
    const repo = this.requireRepository(repositoryBinding);
    const binding = { provider: "github" as const, repositoryDigest: repositoryBinding.repositoryDigest };
    const cursor = after === undefined ? undefined : validateReviewDiscoveryCursor(after, binding);
    const continuation = pageToken === undefined ? undefined : decodeTieContinuation(validateOpenReviewPageToken(pageToken, binding).opaque);
    if (continuation && continuation.cursor !== (cursor?.opaque ?? null)) throw new Error("GitHub open review continuation cursor binding mismatch");
    const boundary = continuation?.cursor === null ? undefined : continuation ? decodeHighWater(continuation.cursor) : cursor ? decodeHighWater(cursor.opaque) : undefined;
    const cutoff = continuation?.cutoff;
    const snapshot = await this.scanStablePages(async () => {
      const candidates: OpenReviewPage["reviews"][number][] = [];
      const hash = createHash("sha256");
      let count = 0;
      let cutoffRank = 0;
      let previousStable = -1;
      for (let page = 1; page <= 10_000; page += 1) {
        const rows = parseSlurpedArray(await this.execGh([
          "api", "-X", "GET", `${apiRepo(repo)}/pulls`, ...apiHost(repo),
          "-f", "state=all", "-f", "sort=created", "-f", "direction=asc",
          "-f", "per_page=100", "-f", `page=${page}`,
        ]), "pull requests");
        if (rows.length > 100) throw new Error("GitHub pull request page exceeds requested bound");
        for (const row of rows) {
          const databaseId = providerId(row.id, "pull request database id");
          const stable = Number(databaseId);
          if (!Number.isSafeInteger(stable) || stable <= previousStable) throw new Error("GitHub pull request stable ordering is nonmonotonic or duplicated");
          previousStable = stable;
          const id = providerId(row.node_id, "pull request node id");
          const number = Number(row.number);
          const state = row.state;
          if (!Number.isSafeInteger(number) || number <= 0 || (state !== "open" && state !== "closed")) throw new Error("Invalid GitHub pull request binding");
          const url = textField(row.html_url, "pull request URL");
          if (url !== `${repo.canonicalUrl}/pull/${number}`) throw new Error("Invalid GitHub pull request URL binding");
          const headSha = textField(object(row.head, "pull request head").sha, "pull request head SHA");
          if (!SHA_RE.test(headSha)) throw new Error("Invalid GitHub pull request head SHA");
          const updatedAt = timestamp(row.updated_at, "pull request updated timestamp");
          const title = textField(row.title, "pull request title");
          addWitnessEntry(hash, [databaseId, id, String(number), state, url, headSha, updatedAt, title]);
          count += 1;
          const item = { identity: { ...binding, reviewNumber: number, reviewId: id, url }, title, headSha, updatedAt,
            orderKey: `${updatedAt}|${number.toString().padStart(16, "0")}|${databaseId.padStart(32, "0")}` };
          const afterBoundary = !boundary || updatedAt > boundary.at || (updatedAt === boundary.at && (!boundary.cutoff || item.orderKey > boundary.cutoff));
          if (state === "open" && afterBoundary && cutoff && item.orderKey <= cutoff) cutoffRank += 1;
          if (state === "open" && afterBoundary && (!cutoff || item.orderKey > cutoff)) {
            candidates.push(item);
            candidates.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
            if (candidates.length > 101) candidates.pop();
          }
        }
        if (rows.length < 100) break;
        if (page === 10_000) throw new Error("GitHub pull request scan exceeded safe page bound");
      }
      return { witness: hash.digest("hex"), count, candidates, cutoffRank };
    });
    if (continuation && (continuation.witness !== snapshot.witness || continuation.count !== snapshot.count)) throw new ConcurrentGitHubMutationError("GitHub changed during an open review continuation");
    if (continuation && snapshot.cutoffRank !== continuation.emittedRank) throw new Error("GitHub open review continuation cutoff rank mismatch");
    const reviews = snapshot.candidates.slice(0, 100);
    if (new Set(reviews.map((item) => item.identity.reviewId)).size !== reviews.length || new Set(reviews.map((item) => item.identity.reviewNumber)).size !== reviews.length) throw new Error("Duplicate GitHub pull request identity");
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

  private async reviewCommentStreamPage(review: ReviewIdentity, stream: "issue" | "inline", page: number): Promise<Record<string, unknown>[]> {
    const repo = this.repositoryForReview(review);
    const path = stream === "issue" ? `${apiRepo(repo)}/issues/${review.reviewNumber}/comments` : `${apiRepo(repo)}/pulls/${review.reviewNumber}/comments`;
    const raw = await this.execGh(["api", "-X", "GET", "-f", "per_page=50", "-f", `page=${page}`, path, ...apiHost(repo)]);
    return parseSlurpedArray(raw, stream === "issue" ? "issue comments" : "review comments");
  }

  private async *restCommentPages(repo: GitHubRepositoryRef | undefined, path: string, label: string): AsyncGenerator<Record<string, unknown>[]> {
    for (let page = 1; page <= MAX_TARGET_COMMENT_PAGES; page += 1) {
      const raw = await this.execGh(["api", "-X", "GET", "-f", "per_page=50", "-f", `page=${page}`, path, ...apiHost(repo)]);
      const rows = parseSlurpedArray(raw, label);
      yield rows;
      if (rows.length < 50) return;
    }
    throw new GitHubLookupResourceLimitError(`GitHub ${label} pagination exceeded its bounded resource limit`);
  }

  private async threadMetadataForCommentIds(review: ReviewIdentity, ids: ReadonlySet<string>): Promise<Map<string, ReturnType<GitHubAdapter["normalizeThread"]>>> {
    const result = new Map<string, ReturnType<GitHubAdapter["normalizeThread"]>>();
    if (ids.size === 0) return result;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_TARGET_THREAD_PAGES) throw new GitHubLookupResourceLimitError();
      if (cursor && seen.has(cursor)) throw new Error("GitHub review thread mapping repeated cursor");
      if (cursor) seen.add(cursor);
      const response = await this.reviewThreadsResponse(review, cursor);
      const connection = this.threadConnection(response, review);
      const pull = object(object(object(response.data, "GraphQL data").repository, "GraphQL repository").pullRequest, "GraphQL pull request");
      const nodes = Array.isArray(connection.nodes) ? connection.nodes.map((node) => object(node, "review thread")) : (() => { throw new Error("Invalid GitHub review thread nodes"); })();
      for (const node of nodes) {
        const normalized = this.normalizeThread(review, node, pull.headRefOid, pull.updatedAt);
        for (const comment of normalized.nodes) {
          const id = providerId(comment.databaseId, "review thread comment id");
          if (ids.has(id)) result.set(id, normalized);
        }
        const comments = object(node.comments, "review thread comments");
        const info = object(comments.pageInfo, "review thread comment page info");
        if (typeof info.hasNextPage !== "boolean") throw new Error("Invalid GitHub review thread comment page info");
        const missing = new Set([...ids].filter((id) => !result.has(id)));
        if (info.hasNextPage && missing.size > 0) {
          const found = await this.findIdsInRemainingThreadComments(review, normalized.threadId, textField(info.endCursor, "review thread comment end cursor"), missing);
          for (const id of found) result.set(id, normalized);
        }
      }
      const info = object(connection.pageInfo, "review thread page info");
      if (typeof info.hasNextPage !== "boolean") throw new Error("Invalid GitHub review thread page info");
      const next = info.hasNextPage ? textField(info.endCursor, "review thread end cursor") : undefined;
      if (next !== undefined && next === cursor) throw new Error("GitHub review thread mapping nonadvancing cursor");
      cursor = result.size === ids.size ? undefined : next;
    } while (cursor);
    if (result.size !== ids.size) throw new Error("GitHub review comment is missing its GraphQL thread binding");
    return result;
  }

  private async findIdsInRemainingThreadComments(review: ReviewIdentity, threadId: string, cursor: string, wanted: ReadonlySet<string>): Promise<Set<string>> {
    const repo = this.repositoryForReview(review);
    const query = "query($threadId:ID!,$cursor:String!){node(id:$threadId){... on PullRequestReviewThread{id pullRequest{id number url repository{nameWithOwner}} comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{databaseId}}}}}";
    const found = new Set<string>();
    const seen = new Set<string>();
    let next: string | undefined = cursor;
    let pages = 0;
    while (next && found.size < wanted.size) {
      pages += 1;
      if (pages > MAX_TARGET_COMMENT_PAGES) throw new GitHubLookupResourceLimitError();
      if (seen.has(next)) throw new Error("GitHub targeted thread comment pagination repeated cursor");
      seen.add(next);
      const raw = await this.execGh(["api", "graphql", ...apiHost(repo), "-f", `query=${query}`, "-F", `threadId=${threadId}`, "-f", `cursor=${next}`]);
      const root = object(JSON.parse(raw) as unknown, "targeted thread comment page");
      const node = object(object(root.data, "targeted thread GraphQL data").node, "targeted thread GraphQL node");
      const pull = object(node.pullRequest, "targeted thread pull request");
      if (node.id !== threadId || pull.id !== review.reviewId || pull.number !== review.reviewNumber || !sameGitHubBinding(pull.url, review.url) || !sameGitHubBinding(object(pull.repository, "targeted thread repository").nameWithOwner, `${repo.owner}/${repo.repo}`)) throw new Error("GitHub targeted thread review binding mismatch");
      const comments = object(node.comments, "targeted thread comments");
      if (!Array.isArray(comments.nodes)) throw new Error("Invalid GitHub targeted thread comment nodes");
      for (const entry of comments.nodes) {
        const id = providerId(object(entry, "targeted thread comment").databaseId, "targeted thread comment id");
        if (wanted.has(id)) found.add(id);
      }
      const info = object(comments.pageInfo, "targeted thread comment page info");
      if (typeof info.hasNextPage !== "boolean") throw new Error("Invalid GitHub targeted thread comment page info");
      const candidate = info.hasNextPage ? textField(info.endCursor, "targeted thread comment end cursor") : undefined;
      if (candidate !== undefined && candidate === next) throw new Error("GitHub targeted thread comment pagination nonadvancing cursor");
      next = candidate;
    }
    return found;
  }

  async listReviewEvents(review: ReviewIdentity, after?: ReviewEventCursor, pageToken?: ReviewEventPageToken): Promise<ReviewEventPage> {
    return this.listReviewEventsStable(review, after, pageToken);
  }

  private async listReviewEventsStable(review: ReviewIdentity, after?: ReviewEventCursor, pageToken?: ReviewEventPageToken): Promise<ReviewEventPage> {
    const binding = { provider: "github" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const cursor = after === undefined ? undefined : validateReviewEventCursor(after, binding);
    const continuation = pageToken === undefined ? undefined : decodeTieContinuation(validateReviewEventPageToken(pageToken, binding).opaque);
    if (continuation && continuation.cursor !== (cursor?.opaque ?? null)) throw new Error("GitHub review event continuation cursor binding mismatch");
    const boundary = continuation?.cursor === null ? undefined : continuation ? decodeHighWater(continuation.cursor) : cursor ? decodeHighWater(cursor.opaque) : undefined;
    const bot = await this.getBotLogin(this.repositoryForReview(review));
    const snapshot = await this.scanStablePages(() => this.scanReviewEventsOnce(review, boundary, continuation?.cutoff, bot));
    if (continuation && (continuation.witness !== snapshot.witness || continuation.count !== snapshot.count)) throw new ConcurrentGitHubMutationError("GitHub changed during a review event continuation");
    if (continuation && snapshot.cutoffRank !== continuation.emittedRank) throw new Error("GitHub review event continuation cutoff rank mismatch");
    const events = snapshot.candidates.slice(0, 100);
    const highAt = events.at(-1)?.updatedAt ?? boundary?.at ?? new Date(0).toISOString();
    const highSeen = events.filter((event) => event.updatedAt === highAt).map(eventBoundaryToken);
    const hasMore = snapshot.candidates.length > 100;
    const stableCursor = hasMore
      ? { scope: "review-events" as const, ...binding, opaque: cursor?.opaque ?? encodeHighWater(new Date(0).toISOString(), []), orderKey: cursor?.orderKey ?? new Date(0).toISOString() }
      : events.length === 0 && cursor
        ? cursor
        : { scope: "review-events" as const, ...binding, opaque: encodeHighWater(highAt, highSeen, events.at(-1)?.orderKey), orderKey: highAt };
    return { events, nextCursor: stableCursor,
      ...(hasMore ? { nextPageToken: { scope: "review-event-page" as const, ...binding,
        opaque: encodeTieContinuation({ v: 1, cursor: cursor?.opaque ?? null, cutoff: events.at(-1)!.orderKey, witness: snapshot.witness, count: snapshot.count,
          emittedRank: (continuation?.emittedRank ?? 0) + events.length }) } } : {}) };
  }

  private async scanReviewEventsOnce(review: ReviewIdentity, boundary: InclusiveHighWater | undefined, cutoff: string | undefined, bot: string): Promise<StableScanResult<ReviewActivityEvent>> {
    const repo = this.repositoryForReview(review);
    const binding = { provider: "github" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const hash = createHash("sha256");
    let count = 0;
    let cutoffRank = 0;
    type RawCandidate = { row: Record<string, unknown>; inline: boolean; orderKey: string; updatedAt: string; revisionId: string };
    const rawCandidates: RawCandidate[] = [];
    const keepRaw = (candidate: RawCandidate): void => {
      if (boundary && (candidate.updatedAt < boundary.at || (candidate.updatedAt === boundary.at && (boundary.cutoff ? candidate.orderKey <= boundary.cutoff : boundary.seen.includes(candidate.revisionId))))) return;
      if (cutoff && candidate.orderKey <= cutoff) { cutoffRank += 1; return; }
      rawCandidates.push(candidate);
      rawCandidates.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
      if (rawCandidates.length > 101) rawCandidates.pop();
    };
    for (const stream of ["issue", "inline"] as const) {
      let previousId = 0;
      const seenIds = new Set<string>();
      for (let page = 1; page <= 10_000; page += 1) {
        const rows = await this.reviewCommentStreamPage(review, stream, page);
        for (const row of rows) {
          const id = providerId(row.id, "comment id");
          const numericId = Number(id);
          if (!Number.isSafeInteger(numericId) || numericId <= previousId || seenIds.has(id)) throw new Error("GitHub comment stable ordering is nonmonotonic or duplicated");
          previousId = numericId;
          seenIds.add(id);
          const body = typeof row.body === "string" ? row.body : (() => { throw new Error("Invalid GitHub comment body"); })();
          const updatedAt = timestamp(row.updated_at, "comment updated timestamp");
          const revisionId = digest(`${id}\0${updatedAt}\0${body}`);
          const type = stream === "inline" ? "review-comment" : "issue-comment";
          addWitnessEntry(hash, [stream, id, revisionId, digest(JSON.stringify(row))]);
          count += 1;
          keepRaw({ row, inline: stream === "inline", updatedAt, revisionId, orderKey: orderKey(updatedAt, type, id, revisionId) });
        }
        if (rows.length < 50) break;
        if (page === 10_000) throw new Error("GitHub comment scan exceeded safe page bound");
      }
    }
    const inlineIds = new Set(rawCandidates.filter((candidate) => candidate.inline).map((candidate) => providerId(candidate.row.id, "review comment id")));
    const threadMetadata = await this.threadMetadataForCommentIds(review, inlineIds);
    const events = rawCandidates.map((candidate): ReviewActivityEvent => {
      const row = candidate.row;
      const id = providerId(row.id, "comment id");
      const body = row.body as string;
      const authorLogin = textField(object(row.user, "comment author").login, "comment author login").toLowerCase();
      if (!LOGIN_RE.test(authorLogin)) throw new Error("Invalid GitHub comment author login");
      const createdAt = timestamp(row.created_at, "comment created timestamp");
      const url = textField(row.html_url, "comment URL");
      const expectedFragment = candidate.inline ? `#discussion_r${id}` : `#issuecomment-${id}`;
      if (!sameGitHubBinding(url, `${review.url}${expectedFragment}`)) throw new Error("Invalid GitHub comment URL binding");
      const edited = candidate.updatedAt !== createdAt;
      if (!candidate.inline) return { ...binding, kind: edited ? "comment-edit" : "general-comment", eventId: `issue-comment:${id}`, revisionId: candidate.revisionId,
        ...(edited ? { editedRevisionId: candidate.revisionId } : {}), orderKey: candidate.orderKey, authorLogin, authorIsBot: authorLogin === bot,
        createdAt, updatedAt: candidate.updatedAt, body, url: boundGitHubCommentUrl(url, review), commentId: id } as ReviewActivityEvent;
      if (!sameGitHubBinding(row.pull_request_url, `https://api.github.com/${apiRepo(repo)}/pulls/${review.reviewNumber}`)) throw new Error("Invalid GitHub review comment pull request binding");
      const metadata = threadMetadata.get(id);
      if (!metadata) throw new Error("GitHub review comment is missing its GraphQL thread binding");
      const file = textField(row.path, "review comment path");
      const lineValue = row.line ?? row.original_line;
      const line = lineValue == null ? undefined : Number(lineValue);
      if (file !== metadata.placement.file || line !== metadata.placement.line) throw new Error("GitHub review comment placement differs from its thread binding");
      const restSide = row.side === "LEFT" ? "old" as const : row.side === "RIGHT" ? "new" as const : undefined;
      const placement = metadata.placement.side === undefined && restSide !== undefined ? { ...metadata.placement, side: restSide } : metadata.placement;
      const parent = row.in_reply_to_id == null ? undefined : providerId(row.in_reply_to_id, "parent comment id");
      return { ...binding, kind: edited ? "comment-edit" : "thread-comment", eventId: `review-comment:${id}`, revisionId: candidate.revisionId,
        ...(edited ? { editedRevisionId: candidate.revisionId } : {}), orderKey: candidate.orderKey, authorLogin, authorIsBot: authorLogin === bot,
        createdAt, updatedAt: candidate.updatedAt, body, url, commentId: id, threadId: metadata.threadId, ...(parent ? { parentCommentId: parent } : {}), placement } as ReviewActivityEvent;
    });
    const seenThreadIds = new Set<string>();
    let threadCursor: string | undefined;
    do {
      const response = await this.reviewThreadsResponse(review, threadCursor);
      const connection = this.threadConnection(response, review);
      const pull = object(object(object(response.data, "GraphQL data").repository, "GraphQL repository").pullRequest, "GraphQL pull request");
      const nodes = Array.isArray(connection.nodes) ? connection.nodes.map((node) => object(node, "review thread")) : (() => { throw new Error("Invalid GitHub review thread nodes"); })();
      for (const node of nodes) {
        const thread = this.normalizeThread(review, node, pull.headRefOid, pull.updatedAt);
        if (seenThreadIds.has(thread.threadId)) throw new Error("Duplicate GitHub review thread identity");
        seenThreadIds.add(thread.threadId);
        addWitnessEntry(hash, ["thread", thread.threadId, digest(JSON.stringify(node)), thread.resolutionObservedAt, thread.placement.currentHeadSha ?? ""]);
        count += 1;
        const root = thread.nodes[0]!;
        const createdAt = timestamp(root.createdAt, "review thread resolution created timestamp");
        const updatedAt = thread.resolutionObservedAt;
        const revisionId = digest(`${thread.threadId}\0resolved=${String(thread.resolved)}\0outdated=${String(thread.outdated)}`);
        const event: ReviewActivityEvent = { ...binding, kind: "thread-resolution", eventId: `thread-resolution:${thread.threadId}`, revisionId,
          orderKey: orderKey(updatedAt, "thread-resolution", thread.threadId, revisionId), createdAt, updatedAt, body: "", url: thread.url,
          threadId: thread.threadId, resolved: thread.resolved, outdated: thread.outdated, placement: thread.placement };
        const afterBoundary = !boundary || event.updatedAt > boundary.at || (event.updatedAt === boundary.at && (boundary.cutoff ? event.orderKey > boundary.cutoff : !boundary.seen.includes(eventBoundaryToken(event))));
        if (afterBoundary && cutoff && event.orderKey <= cutoff) cutoffRank += 1;
        if (afterBoundary && (!cutoff || event.orderKey > cutoff)) {
          events.push(event);
          events.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
          if (events.length > 101) events.pop();
        }
      }
      const info = object(connection.pageInfo, "review thread page info");
      const next = info.hasNextPage === true ? textField(info.endCursor, "review thread end cursor") : undefined;
      if (next !== undefined && next === threadCursor) throw new Error("GitHub review thread scan nonadvancing cursor");
      threadCursor = next;
    } while (threadCursor);
    events.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    return { candidates: events, witness: hash.digest("hex"), count, cutoffRank };
  }

  private async reviewThreadsResponse(review: ReviewIdentity, cursor?: string): Promise<Record<string, unknown>> {
    const repo = this.repositoryForReview(review);
    const query = "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){id url headRefOid updatedAt reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated subjectType diffSide path line originalLine comments(first:1){pageInfo{hasNextPage endCursor} nodes{databaseId body author{login} createdAt updatedAt url commit{oid} originalCommit{oid} replyTo{databaseId}}}}}}}}";
    const args = ["api", "graphql", ...apiHost(repo), "-f", `query=${query}`, "-F", `owner=${repo.owner}`, "-F", `name=${repo.repo}`, "-F", `number=${review.reviewNumber}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    let parsed: unknown;
    try { parsed = JSON.parse(await this.execGh(args)); } catch (cause) { throw new Error("Invalid GitHub review threads JSON", { cause }); }
    return object(parsed, "review threads");
  }

  private threadConnection(response: Record<string, unknown>, review: ReviewIdentity): Record<string, unknown> {
    const data = object(response.data, "GraphQL data");
    const repository = object(data.repository, "GraphQL repository");
    const pull = object(repository.pullRequest, "GraphQL pull request");
    if (pull.id !== review.reviewId || !sameGitHubBinding(pull.url, review.url)) throw new Error("GitHub GraphQL review binding mismatch");
    return object(pull.reviewThreads, "GraphQL review threads");
  }

  private normalizeThread(review: ReviewIdentity, row: Record<string, unknown>, currentHead?: unknown, observedAt?: unknown) {
    const binding = { provider: "github" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const threadId = providerId(row.id, "review thread id");
    if (typeof row.isResolved !== "boolean" || typeof row.isOutdated !== "boolean") throw new Error("Invalid GitHub review thread state");
    const comments = object(row.comments, "review thread comments");
    const nodes = Array.isArray(comments.nodes) ? comments.nodes.map((node) => object(node, "review thread comment")) : (() => { throw new Error("Invalid GitHub review thread comments"); })();
    if (nodes.length === 0) throw new Error("Invalid GitHub empty review thread");
    const root = nodes[0]!;
    const rootCommentId = providerId(root.databaseId, "review thread root comment id");
    const url = textField(root.url, "review thread URL");
    if (!sameGitHubBinding(url, `${review.url}#discussion_r${rootCommentId}`)) throw new Error("Invalid GitHub review thread URL binding");
    const updatedAt = nodes.map((node) => timestamp(node.updatedAt, "review thread updated timestamp")).sort().at(-1)!;
    const subjectType = row.subjectType ?? "LINE";
    if (subjectType !== "LINE" && subjectType !== "FILE") throw new Error("Invalid GitHub review thread subject type");
    const file = textField(row.path, "review thread path");
    const rawLine = row.line ?? row.originalLine;
    const line = rawLine == null ? undefined : Number(rawLine);
    if (subjectType === "LINE" && (!Number.isSafeInteger(line) || (line as number) <= 0)) throw new Error("Invalid GitHub review thread line");
    if (subjectType === "FILE" && line !== undefined) throw new Error("Invalid GitHub file-level review thread line");
    const diffSide = row.diffSide;
    if (diffSide !== undefined && diffSide !== null && diffSide !== "LEFT" && diffSide !== "RIGHT") throw new Error("Invalid GitHub review thread diff side");
    const original = object(root.originalCommit ?? root.commit, "review thread original commit");
    const originalHeadSha = textField(original.oid, "review thread original head");
    const currentHeadSha = textField(currentHead ?? object(root.commit, "review thread commit").oid, "review thread current head");
    if (!SHA_RE.test(originalHeadSha) || !SHA_RE.test(currentHeadSha)) throw new Error("Invalid GitHub review thread head");
    const placement = { file, ...(line === undefined ? {} : { line }), ...(diffSide == null ? {} : { side: diffSide === "LEFT" ? "old" as const : "new" as const }), originalHeadSha, currentHeadSha, outdated: row.isOutdated as boolean };
    const resolutionObservedAt = observedAt === undefined ? updatedAt : timestamp(observedAt, "pull request observed timestamp");
    return { ...binding, threadId, rootCommentId, url, resolved: row.isResolved as boolean, outdated: row.isOutdated as boolean, updatedAt, resolutionObservedAt, orderKey: orderKey(updatedAt, "thread", threadId), placement, nodes, comments };
  }

  private async remainingThreadComments(review: ReviewIdentity, threadId: string, cursor: string): Promise<Record<string, unknown>[]> {
    const repo = this.repositoryForReview(review);
    const query = "query($threadId:ID!,$cursor:String!){node(id:$threadId){... on PullRequestReviewThread{id pullRequest{id number url headRefOid repository{nameWithOwner}} comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{databaseId body author{login} createdAt updatedAt url commit{oid} originalCommit{oid} replyTo{databaseId}}}}}}";
    const result: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let next: string | undefined = cursor;
    let pages = 0;
    while (next) {
      pages += 1;
      if (pages > MAX_TARGET_COMMENT_PAGES) throw new GitHubLookupResourceLimitError();
      if (seen.has(next)) throw new Error("GitHub thread comment pagination repeated cursor");
      seen.add(next);
      const raw = await this.execGh(["api", "graphql", ...apiHost(repo), "-f", `query=${query}`, "-F", `threadId=${threadId}`, "-f", `cursor=${next}`]);
      const root = object(JSON.parse(raw) as unknown, "thread comment page");
      const node = object(object(root.data, "thread comment GraphQL data").node, "thread comment GraphQL node");
      const pull = object(node.pullRequest, "thread comment pull request");
      if (node.id !== threadId || pull.id !== review.reviewId || pull.number !== review.reviewNumber || !sameGitHubBinding(pull.url, review.url) || !sameGitHubBinding(object(pull.repository, "thread comment repository").nameWithOwner, `${repo.owner}/${repo.repo}`)) {
        throw new Error("GitHub addressed thread review binding mismatch");
      }
      const comments = object(node.comments, "thread comment connection");
      if (!Array.isArray(comments.nodes)) throw new Error("Invalid GitHub thread comment nodes");
      result.push(...comments.nodes.map((entry) => object(entry, "thread comment")));
      if (result.length > MAX_THREAD_SNAPSHOT_COMMENTS) throw new GitHubThreadSnapshotTooLargeError();
      const info = object(comments.pageInfo, "thread comment page info");
      if (typeof info.hasNextPage !== "boolean") throw new Error("Invalid GitHub thread comment page info");
      next = info.hasNextPage ? textField(info.endCursor, "thread comment end cursor") : undefined;
    }
    return result;
  }

  async listReviewThreads(review: ReviewIdentity, pageToken?: ReviewThreadPageToken): Promise<ReviewThreadPage> {
    const binding = { provider: "github" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber };
    const cursor = pageToken === undefined ? undefined : validateReviewThreadPageToken(pageToken, binding).opaque;
    const response = await this.reviewThreadsResponse(review, cursor);
    const connection = this.threadConnection(response, review);
    const nodes = Array.isArray(connection.nodes) ? connection.nodes.map((node) => object(node, "review thread")) : (() => { throw new Error("Invalid GitHub review thread nodes"); })();
    const pull = object(object(object(response.data, "GraphQL data").repository, "GraphQL repository").pullRequest, "GraphQL pull request");
    const threads = (await Promise.all(nodes.map(async (node) => {
      const comments = object(node.comments, "review thread comments");
      const info = object(comments.pageInfo, "review thread comment page info");
      if (typeof info.hasNextPage !== "boolean") throw new Error("Invalid GitHub review thread comment page info");
      if (info.hasNextPage) {
        const more = await this.remainingThreadComments(review, providerId(node.id, "review thread id"), textField(info.endCursor, "review thread comment end cursor"));
        if (!Array.isArray(comments.nodes)) throw new Error("Invalid GitHub review thread comment nodes");
        comments.nodes.push(...more);
        info.hasNextPage = false;
        info.endCursor = null;
      }
      const normalized = this.normalizeThread(review, node, pull.headRefOid, pull.updatedAt);
      const { nodes: _nodes, comments: _comments, ...summary } = normalized;
      void _nodes;
      void _comments;
      return summary;
    }))).sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    const pageInfo = object(connection.pageInfo, "review thread page info");
    if (typeof pageInfo.hasNextPage !== "boolean") throw new Error("Invalid GitHub review thread page info");
    const next = pageInfo.hasNextPage ? textField(pageInfo.endCursor, "review thread end cursor") : undefined;
    return { threads, ...(next ? { nextPageToken: { scope: "review-thread-page", ...binding, opaque: next } } : {}) };
  }

  async getReviewThread(review: ReviewIdentity, threadId: string): Promise<ReviewThreadSnapshot> {
    providerId(threadId, "review thread id");
    let cursor: string | undefined;
    let found: ReturnType<GitHubAdapter["normalizeThread"]> | undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_TARGET_THREAD_PAGES) throw new GitHubLookupResourceLimitError();
      if (cursor && seen.has(cursor)) throw new Error("GitHub review thread pagination repeated cursor");
      if (cursor) seen.add(cursor);
      const response = await this.reviewThreadsResponse(review, cursor);
      const connection = this.threadConnection(response, review);
      const pull = object(object(object(response.data, "GraphQL data").repository, "GraphQL repository").pullRequest, "GraphQL pull request");
      const nodes = Array.isArray(connection.nodes) ? connection.nodes.map((node) => object(node, "review thread")) : [];
      const match = nodes.find((node) => node.id === threadId);
      if (match) found = this.normalizeThread(review, match, pull.headRefOid, pull.updatedAt);
      const info = object(connection.pageInfo, "review thread page info");
      cursor = info.hasNextPage === true ? textField(info.endCursor, "review thread end cursor") : undefined;
    } while (!found && cursor);
    if (!found) throw new Error("GitHub review thread not found in target review");
    const firstPageInfo = object(found.comments.pageInfo, "review thread comment page info");
    if (typeof firstPageInfo.hasNextPage !== "boolean") throw new Error("Invalid GitHub review thread comment page info");
    if (firstPageInfo.hasNextPage) {
      const next = textField(firstPageInfo.endCursor, "review thread comment end cursor");
      found.nodes.push(...await this.remainingThreadComments(review, threadId, next));
    }
    if (found.nodes.length > MAX_THREAD_SNAPSHOT_COMMENTS) throw new GitHubThreadSnapshotTooLargeError();
    const bot = await this.getBotLogin(this.repositoryForReview(review));
    const events = found.nodes.map((node, index): ReviewActivityEvent => {
      const commentId = providerId(node.databaseId, "review thread comment id");
      const authorLogin = textField(object(node.author, "review thread comment author").login, "review thread comment author login").toLowerCase();
      const createdAt = timestamp(node.createdAt, "review thread comment created timestamp");
      const updatedAt = timestamp(node.updatedAt, "review thread comment updated timestamp");
      const body = typeof node.body === "string" ? node.body : (() => { throw new Error("Invalid GitHub review thread comment body"); })();
      const revisionId = digest(`${commentId}\0${updatedAt}\0${body}`);
      const eventUrl = textField(node.url, "review thread comment URL");
      if (!sameGitHubBinding(eventUrl, `${review.url}#discussion_r${commentId}`)) throw new Error("Invalid GitHub review thread comment URL binding");
      if (!LOGIN_RE.test(authorLogin)) throw new Error("Invalid GitHub review thread comment author login");
      return { provider: "github" as const, repositoryDigest: review.repositoryDigest, reviewNumber: review.reviewNumber,
        kind: updatedAt === createdAt ? "thread-comment" as const : "comment-edit" as const,
        eventId: `review-comment:${commentId}`, revisionId, ...(updatedAt === createdAt ? {} : { editedRevisionId: revisionId }),
        orderKey: orderKey(updatedAt, "review-comment", commentId, revisionId), authorLogin, authorIsBot: authorLogin === bot,
        createdAt, updatedAt, body, url: eventUrl, commentId,
        threadId: found!.threadId, ...(index === 0 ? {} : { parentCommentId: providerId(object(node.replyTo ?? {}, "review thread reply").databaseId ?? found!.rootCommentId, "review thread parent id") }), placement: found!.placement } as ReviewActivityEvent;
    }).sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    const { nodes: _nodes, comments: _comments, ...summary } = found;
    void _nodes;
    void _comments;
    return { ...summary, events };
  }

  private async writeConversationComment(
    review: ReviewIdentity,
    body: string,
    path: string,
    threadId?: string,
    parentCommentId?: string,
  ): Promise<ConversationItemIdentity> {
    if (typeof body !== "string" || body.length === 0) throw new Error("GitHub reply body must not be empty");
    const repo = this.repositoryForReview(review);
    const bot = await this.getBotLogin(repo);
    let value: unknown;
    try {
      value = JSON.parse(await this.execGh(["api", path, ...apiHost(repo), "-X", "POST", "--input", "-"], JSON.stringify({ body })));
    } catch (cause) {
      throw new Error("Invalid GitHub reply write response", { cause });
    }
    const row = object(value, "reply write");
    const id = providerId(row.id, "reply id");
    if (row.body !== body || textField(object(row.user, "reply author").login, "reply author login").toLowerCase() !== bot) {
      throw new Error("GitHub reply response body/author mismatch");
    }
    if (threadId && !sameGitHubBinding(row.pull_request_url, `https://api.github.com/${apiRepo(repo)}/pulls/${review.reviewNumber}`)) {
      throw new Error("GitHub thread reply review binding mismatch");
    }
    if (parentCommentId !== undefined && providerId(row.in_reply_to_id, "reply parent id") !== parentCommentId) {
      throw new Error("GitHub thread reply parent mismatch");
    }
    return validateConversationItemIdentity({ provider: "github", commentId: id, ...(threadId ? { threadId } : {}), url: boundGitHubCommentUrl(textField(row.html_url, "reply URL"), review) }, { repo, reviewNumber: review.reviewNumber });
  }

  async postGeneralReply(review: ReviewIdentity, input: GeneralReplyInput): Promise<ConversationItemIdentity> {
    this.validateReplyInput(review, input);
    const repo = this.repositoryForReview(review);
    return this.writeConversationComment(review, input.body, `${apiRepo(repo)}/issues/${review.reviewNumber}/comments`);
  }

  async postThreadReply(review: ReviewIdentity, input: ThreadReplyInput): Promise<ConversationItemIdentity> {
    this.validateReplyInput(review, input);
    providerId(input.threadId, "reply thread id");
    if (!input.parentCommentId) throw new Error("GitHub thread replies require parentCommentId");
    const parent = providerId(input.parentCommentId, "reply parent comment id");
    const repo = this.repositoryForReview(review);
    let metadata: Map<string, ReturnType<GitHubAdapter["normalizeThread"]>>;
    try {
      metadata = await this.threadMetadataForCommentIds(review, new Set([parent]));
    } catch (cause) {
      throw new Error("GitHub reply parent does not belong to addressed thread", { cause });
    }
    const thread = metadata.get(parent);
    if (thread?.threadId !== input.threadId) throw new Error("GitHub reply parent does not belong to addressed thread");
    const root = thread.rootCommentId;
    return this.writeConversationComment(review, input.body, `${apiRepo(repo)}/pulls/${review.reviewNumber}/comments/${root}/replies`, input.threadId, root);
  }

  private validateReplyInput(review: ReviewIdentity, input: GeneralReplyInput): void {
    if (input.provider !== review.provider || input.repositoryDigest !== review.repositoryDigest || input.reviewNumber !== review.reviewNumber) {
      throw new Error("GitHub reply input binding mismatch");
    }
  }

  async findBotChildMarker(review: ReviewIdentity, marker: ChildMarkerLookup): Promise<ConversationItemIdentity | null> {
    if (marker.provider !== review.provider || marker.repositoryDigest !== review.repositoryDigest || marker.reviewNumber !== review.reviewNumber) {
      throw new Error("GitHub child marker lookup binding mismatch");
    }
    const repo = this.repositoryForReview(review);
    const bot = await this.getBotLogin(repo);
    const matches: ConversationItemIdentity[] = [];
    const expected = { kind: marker.kind, parentId: marker.parentId, childId: marker.childId, repositoryDigest: marker.repositoryDigest, reviewNumber: marker.reviewNumber, contentDigest: marker.contentDigest };
    for (const stream of ["issue", "inline"] as const) {
      let page = 1;
      let rows: Record<string, unknown>[];
      do {
        if (page > MAX_TARGET_COMMENT_PAGES) throw new GitHubLookupResourceLimitError("GitHub marker pagination exceeded its bounded resource limit");
        rows = await this.reviewCommentStreamPage(review, stream, page);
        const matchingRows: Record<string, unknown>[] = [];
        for (const row of rows) {
        const author = textField(object(row.user, "marker comment author").login, "marker comment author login").toLowerCase();
        if (author !== bot || typeof row.body !== "string") continue;
        const candidate = row.body.split(/\r?\n/u).at(-1) ?? "";
        if (!verifyChildMarkerBinding(candidate, expected)) continue;
          const canonicalBody = canonicalInlineBody(row.body);
          const suffix = `\n${candidate}`;
          if (!canonicalBody.endsWith(suffix)) throw new Error("Authenticated GitHub child marker is not a separable terminal suffix");
          let visibleBody = canonicalBody.slice(0, -suffix.length);
          const inlineSuffix = `\n${INLINE_COMMENT_MARKER}`;
          if (visibleBody.endsWith(inlineSuffix)) visibleBody = visibleBody.slice(0, -inlineSuffix.length);
          if (computeContentDigest(visibleBody) !== marker.contentDigest) throw new Error("Authenticated GitHub child marker visible body digest mismatch");
          matchingRows.push(row);
        }
        const inlineMetadata = stream === "inline" ? await this.threadMetadataForCommentIds(review, new Set(matchingRows.map((row) => providerId(row.id, "marker comment id")))) : undefined;
        for (const row of matchingRows) {
        const id = providerId(row.id, "marker comment id");
        if (stream === "inline" && !sameGitHubBinding(row.pull_request_url, `https://api.github.com/${apiRepo(repo)}/pulls/${review.reviewNumber}`)) throw new Error("GitHub marker review binding mismatch");
        const threadId = stream === "inline" ? inlineMetadata!.get(id)?.threadId : undefined;
        if (stream === "inline" && !threadId) throw new Error("GitHub marker comment is missing its GraphQL thread binding");
        matches.push(validateConversationItemIdentity({ provider: "github", commentId: id,
          ...(threadId ? { threadId } : {}),
          url: boundGitHubCommentUrl(textField(row.html_url, "marker comment URL"), review) }, { repo, reviewNumber: review.reviewNumber }));
          if (matches.length > 1) throw new Error("Multiple authenticated GitHub child marker matches");
        }
        page += 1;
      } while (rows.length === 50);
      }
    return matches[0] ?? null;
  }

  async findPublishedMarker(locator: ReviewLocator, marker: string): Promise<ConversationItemIdentity | null> {
    if (typeof marker !== "string" || marker.length === 0 || marker.length > 2_048) {
      throw new Error("Invalid publication marker");
    }
    const { repo, id } = resolvePullLocator(locator);
    const parsed = parseChildMarker(marker);
    if (parsed !== null && repo !== undefined) {
      const review = await this.resolveReviewIdentity(repo, Number(id));
      return this.findBotChildMarker(review, {
        provider: "github",
        repositoryDigest: review.repositoryDigest,
        reviewNumber: review.reviewNumber,
        kind: parsed.kind,
        parentId: parsed.parentId,
        childId: parsed.childId,
        contentDigest: parsed.contentDigest,
      });
    }
    const bot = await this.getBotLogin(repo);
    const matches: ConversationItemIdentity[] = [];
    const binding = repo === undefined
      ? undefined
      : { repo, reviewNumber: Number(id) };
    for (const stream of ["issue", "inline"] as const) {
      const path = stream === "issue"
        ? `${apiRepo(repo)}/issues/${id}/comments`
        : `${apiRepo(repo)}/pulls/${id}/comments`;
      for await (const rows of this.restCommentPages(repo, path, `${stream} publication markers`)) {
        for (const row of rows) {
          const author = typeof row.user === "object" && row.user !== null
            ? (row.user as { login?: unknown }).login
            : undefined;
          if (typeof author !== "string" || author.toLowerCase() !== bot || typeof row.body !== "string") continue;
          const lastLine = canonicalInlineBody(row.body).split("\n").at(-1) ?? "";
          if (lastLine !== marker && !row.body.includes(marker)) continue;
          const identity = {
            provider: "github" as const,
            commentId: providerId(row.id, "publication marker comment id"),
            url: textField(row.html_url, "publication marker URL"),
          };
          matches.push(binding === undefined ? identity : validateConversationItemIdentity(identity, {
            repo: canonicalGitHubRepository(binding.repo),
            reviewNumber: binding.reviewNumber,
          }));
          if (matches.length > 1) throw new Error("Multiple authenticated GitHub publication marker matches");
        }
      }
    }
    return matches[0] ?? null;
  }

  /**
   * AC-2.1: parses `gh pr view <id> --json headRefOid,baseRefOid,title,body,url`
   * output into a PullRequestInfo with the correct headSha/baseSha/title/
   * description/url. `url` (the PR's canonical web URL) is what surfaces the
   * owner/repo `gh` actually resolved from its ambient context — review() logs
   * it so a mis-inferred repo target is visible, not silent.
   */
  async getPullRequest(locator: ReviewLocator): Promise<PullRequestInfo> {
    const { repo, id } = resolvePullLocator(locator);
    const fields = repo
      ? "headRefOid,baseRefOid,headRefName,baseRefName,title,body,url"
      : "headRefOid,baseRefOid,title,body,url";
    const out = await this.execGh([
      "pr",
      "view",
      id,
      ...repoFlag(repo),
      "--json",
      fields,
    ]);
    const parsed = JSON.parse(out) as GhPrViewJson;
    if (repo) {
      if (typeof parsed.headRefName !== "string" || typeof parsed.baseRefName !== "string") {
        throw new Error("invalid response from gh pr view: missing base/head ref names");
      }
      return {
        id,
        headSha: parsed.headRefOid,
        baseSha: parsed.baseRefOid,
        title: parsed.title,
        description: parsed.body ?? "",
        url: parsed.url ?? `https://github.com/${repo.owner}/${repo.repo}/pull/${id}`,
      };
    }
    // The explicit-repo branch above can rebuild this URL from the locator; an
    // ambient locator has no owner/repo, so this response is the only place the
    // resolved identity exists. Conversation state and every published marker
    // bind to that identity, so an absent url is a fatal response defect here
    // rather than an undefined that fails confusingly further downstream.
    if (typeof parsed.url !== "string" || parsed.url.length === 0) {
      throw new Error("invalid response from gh pr view: missing url");
    }
    return {
      id,
      headSha: parsed.headRefOid,
      baseSha: parsed.baseRefOid,
      title: parsed.title,
      description: parsed.body ?? "",
      url: parsed.url,
    };
  }

  async getDiff(locator: ReviewLocator): Promise<string> {
    const { repo, id } = resolvePullLocator(locator);
    return this.execGh(["pr", "diff", id, ...repoFlag(repo)]);
  }

  /**
   * AC-2.2 / AC-2.3: lists PR comments via `gh api
   * repos/{owner}/{repo}/issues/{id}/comments` in explicit bounded 50-item
   * pages (since the default 30/page could put the bot's own prior
   * comment on page 2+, causing upsertComment to CREATE a duplicate instead
   * of editing it) and returns the first comment that is BOTH authored by
   * the bot's own verified identity (via getBotLogin(), never trusted from
   * the comment body itself — see security fix below) AND contains our
   * marker prefix, or `null` if no such comment exists.
   *
   * Bug fix (found via a real end-to-end run against `hmchangw/chat` PR
   * #491 — see git history): `-X GET` is REQUIRED here, explicitly. `gh
   * api`'s documented default method is GET for a path like this one, but
   * that default silently flips to POST the moment ANY `-f`/`-F` parameter
   * is present on the invocation — regardless of the target endpoint. Since
   * this call passes `-f per_page=50` and `-f page=N`, omitting `-X GET`
   * makes `gh` issue a POST to the issue-comments endpoint, which GitHub
   * interprets as "create a comment" and rejects with HTTP 422 (`"body"
   * wasn't supplied`). Explicit GET keeps every bounded page a read.
   * Without the explicit method flag, findBotComment fails on EVERY
   * `review` invocation (it runs before dedup/rule-loading/dispatch), so
   * this is a load-bearing flag, not decoration — do not remove it as
   * "redundant with the GET default".
   *
   * Security fix: a comment is only ever treated as "the bot's" if
   * `comment.user.login` matches the tool's own authenticated identity.
   * Without this check, anyone can post a fake
   * `<!-- tgd-review-agent:sha=<currentHeadSha> -->` comment on a public PR
   * to trick decideDedup() into permanently skipping review of their own PR.
   *
   * Correctness fix: marker *detection* (BOT_MARKER_PREFIX_RE — does this
   * comment look like our marker at all) is separated from SHA
   * *extraction/validation* (BOT_MARKER_RE — is the SHA after the prefix
   * well-formed). If the bot's own comment has the marker prefix but a
   * malformed SHA, it is still returned as a BotComment with
   * `lastReviewedSha: ""` rather than being skipped entirely — an empty
   * lastReviewedSha already flows safely through dedup.ts's decideDedup
   * (treated as "no prior review", never as "skip"), whereas returning
   * `null` here would cause upsertComment to CREATE a second comment
   * instead of editing the existing (malformed) one.
   */
  async findBotComment(locator: ReviewLocator): Promise<BotComment | null> {
    const { repo, id } = resolvePullLocator(locator);
    const botLogin = await this.getBotLogin(repo);
    for await (const comments of this.restCommentPages(repo, `${apiRepo(repo)}/issues/${id}/comments`, "review summary comments")) {
      for (const comment of comments) {
      const author = typeof comment.user === "object" && comment.user !== null ? (comment.user as { login?: unknown }).login : undefined;
      if (typeof author !== "string" || author.toLowerCase() !== botLogin || typeof comment.body !== "string") continue;
      const marker = parseBotMarker(comment.body);
      if (marker === null) continue;
      return {
        id: providerId(comment.id, "review summary comment id"),
        body: comment.body,
        ...marker,
      };
      }
    }
    return null;
  }

  /**
   * AC-2.4: when `existing` is null, creates a new comment via the issue
   * comments API with JSON piped through stdin. Unlike `gh pr comment`, this
   * returns the authoritative created comment ID needed for a later exact edit.
   *
   * AC-2.5: when `existing` is a BotComment, edits that EXACT comment by id
   * via `gh api repos/{owner}/{repo}/issues/comments/{existing.id} -X PATCH
   * --input -` (JSON body piped via stdin) — never creates a second comment,
   * and never relies on `--edit-last` (which could target a human's comment
   * posted after the bot's). Both paths validate and return the provider's
   * response identity and body.
   */
  async upsertComment(
    locator: ReviewLocator,
    body: string,
    existing: BotComment | null,
  ): Promise<BotComment> {
    const { repo, id } = resolvePullLocator(locator);
    const expectedId = existing === null ? undefined : validatedIssueCommentId(existing.id);
    const out = await this.execGh(
      existing === null
        ? ["api", `${apiRepo(repo)}/issues/${id}/comments`, ...apiHost(repo), "-X", "POST", "--input", "-"]
        : ["api", `${apiRepo(repo)}/issues/comments/${expectedId}`, ...apiHost(repo), "-X", "PATCH", "--input", "-"],
      JSON.stringify({ body }),
    );
    let value: unknown;
    try {
      value = JSON.parse(out);
    } catch (cause) {
      throw new Error("Invalid GitHub comment write response: malformed JSON", { cause });
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !Number.isSafeInteger((value as { id?: unknown }).id) ||
      ((value as { id: number }).id <= 0) ||
      typeof (value as { body?: unknown }).body !== "string" ||
      (value as { body: string }).body !== body ||
      (expectedId !== undefined && (value as { id: number }).id !== expectedId)
    ) {
      throw new Error("Invalid GitHub comment write response: malformed or mismatched id/body");
    }
    const writtenBody = (value as { body: string }).body;
    return {
      id: String((value as { id: number }).id),
      body: writtenBody,
      ...(parseBotMarker(writtenBody) ?? { lastReviewedSha: "", reviewedConfig: "" }),
    };
  }

  /**
   * GitHub inline publishing is intentionally disabled until an authenticated
   * marker lookup can recover a trustworthy identity for every created comment.
   * The atomic review endpoint cannot correlate its response with client IDs;
   * writing anyway would make summary fallback and retries duplicate comments.
   */
  async prepareInlineReviewRecovery(
    locator: ReviewLocator,
    headSha: string,
    comments: readonly InlineReviewComment[],
    runIdentity: string,
  ): Promise<InlineRecoveryState> {
    validateInlinePublishInputs(comments as InlineReviewComment[]);
    if (!SHA_RE.test(headSha) || typeof runIdentity !== "string" || runIdentity.length === 0 || runIdentity.length > 512) throw new Error("Invalid GitHub inline recovery identity");
    const resolved = resolvePullLocator(locator);
    const repo: GitHubRepositoryRef = resolved.repo ?? this.repository ?? await this.getRepoOwnerAndName().then(({ owner, name }): GitHubRepositoryRef => ({ provider: "github", host: "github.com", owner, repo: name, canonicalUrl: `https://github.com/${owner}/${name}` }));
    const repositoryDigest = computeRepositoryDigest("github", repo.canonicalUrl);
    const reviewNumber = Number(resolved.id);
    const parentId = `act_${digest(`${runIdentity}\0${repositoryDigest}\0${reviewNumber}\0${headSha}`).slice(0, 32)}`;
    const children: InlineRecoveryChild[] = comments.map((comment) => {
      const contentDigest = computeContentDigest(canonicalInlineBody(comment.body));
      const placementDigest = digest(JSON.stringify({ path: comment.path, line: comment.line, startLine: comment.startLine ?? null, side: "RIGHT", startSide: comment.startLine === undefined ? null : "RIGHT" }));
      const childId = deriveInlineChildId(parentId, comment.clientId, contentDigest, placementDigest);
      const child = { clientId: comment.clientId, kind: "finding" as const, parentId, childId, repositoryDigest, reviewNumber, contentDigest, headSha, placementDigest };
      return { ...child, marker: formatInlineRecoveryMarker(child) };
    });
    return { children, noFallbackBody: "" };
  }

  async createInlineReview(
    locator: ReviewLocator,
    headSha: string,
    comments: InlineReviewComment[],
    recovery?: InlineRecoveryState,
  ): Promise<InlinePublishOutcome[]> {
    validateInlinePublishInputs(comments);
    if (comments.length === 0) return [];
    if (!SHA_RE.test(headSha)) throw new Error("Invalid GitHub inline review head SHA");
    const resolved = resolvePullLocator(locator);
    const repo: GitHubRepositoryRef = resolved.repo ?? this.repository ?? await this.getRepoOwnerAndName().then(({ owner, name }): GitHubRepositoryRef => ({
      provider: "github" as const, host: "github.com" as const, owner, repo: name,
      canonicalUrl: `https://github.com/${owner}/${name}`,
    }));
    const bot = await this.getBotLogin(repo);
    const prepared = validateInlineRecoveryState(recovery ?? await this.prepareInlineReviewRecovery(locator, headSha, comments, "legacy-inline-publication"));
    if (prepared.children.length !== comments.length || prepared.children.some((child, index) => {
      const comment = comments[index]!;
      const placementDigest = digest(JSON.stringify({ path: comment.path, line: comment.line, startLine: comment.startLine ?? null, side: "RIGHT", startSide: comment.startLine === undefined ? null : "RIGHT" }));
      const exactMarker = formatInlineRecoveryMarker(child);
      return child.clientId !== comment.clientId || child.headSha !== headSha || child.reviewNumber !== Number(resolved.id) || child.repositoryDigest !== computeRepositoryDigest("github", repo.canonicalUrl) || child.contentDigest !== computeContentDigest(canonicalInlineBody(comment.body)) || child.placementDigest !== placementDigest || child.marker !== exactMarker;
    })) {
      throw new Error("GitHub inline recovery manifest does not match publication inputs");
    }
    const markers = prepared.children.map((child) => child.marker);
    const recover = async (): Promise<Array<ConversationItemIdentity | null>> => {
      const rows: Record<string, unknown>[] = [];
      const markerSet = new Set(markers);
      for await (const pageRows of this.restCommentPages(repo, `${apiRepo(repo)}/pulls/${resolved.id}/comments`, "inline review recovery comments")) {
        for (const row of pageRows) {
          if (typeof row.body === "string" && markerSet.has(canonicalInlineBody(row.body).split("\n").at(-1) ?? "")) rows.push(row);
        }
      }
      const matchedRows = markers.map((marker) => {
        const expected = comments[markers.indexOf(marker)]!;
        const expectedBody = `${canonicalInlineBody(expected.body)}\n${INLINE_COMMENT_MARKER}\n${marker}`;
        const candidates = rows.filter((row) => {
          const login = typeof row.user === "object" && row.user !== null ? (row.user as { login?: unknown }).login : undefined;
          return typeof login === "string" && login.toLowerCase() === bot && typeof row.body === "string" && canonicalInlineBody(row.body).split("\n").at(-1) === marker;
        });
        const matches = candidates.filter((row) => canonicalInlineBody(row.body as string) === expectedBody);
        if (candidates.length !== matches.length) throw new AmbiguousInlinePublishError("Authenticated inline marker body was edited or copied");
        if (matches.length > 1) throw new AmbiguousInlinePublishError("Multiple authenticated comments matched one inline publication marker");
        const row = matches[0];
        if (!row) return null;
        providerId(row.id, "inline recovery comment id");
        if (!sameGitHubBinding(row.pull_request_url, `https://api.github.com/${apiRepo(repo)}/pulls/${resolved.id}`)) throw new AmbiguousInlinePublishError("Recovered inline comment belongs to another review");
        if (row.path !== expected.path || row.line !== expected.line || row.side !== "RIGHT" || (row.start_line ?? null) !== (expected.startLine ?? null) || (row.start_side ?? null) !== (expected.startLine === undefined ? null : "RIGHT")) throw new AmbiguousInlinePublishError("Recovered inline comment placement mismatch");
        if (row.commit_id !== headSha) throw new AmbiguousInlinePublishError("Recovered inline comment head mismatch");
        return row;
      });
      if (matchedRows.every((row) => row === null)) return matchedRows as null[];
      const review = await this.resolveReviewIdentity(repo, Number(resolved.id));
      const threads = await this.threadMetadataForCommentIds(review, new Set(matchedRows.filter((row): row is Record<string, unknown> => row !== null).map((row) => providerId(row.id, "inline recovery comment id"))));
      return matchedRows.map((row, index) => {
        if (!row) return null;
        const id = providerId(row.id, "inline recovery comment id");
        const metadata = threads.get(id);
        const expected = comments[index]!;
        if (!metadata || metadata.placement.file !== expected.path || metadata.placement.line !== expected.line || metadata.placement.currentHeadSha !== headSha) {
          throw new AmbiguousInlinePublishError("Recovered inline comment GraphQL binding mismatch");
        }
        const threadId = metadata.threadId;
        if (!threadId) throw new AmbiguousInlinePublishError("Recovered inline comment has no GraphQL thread identity");
        return validateConversationItemIdentity({ provider: "github", commentId: id, threadId,
          url: boundGitHubCommentUrl(textField(row.html_url, "inline recovery comment URL"), review) }, {
          repo: canonicalGitHubRepository(repo), reviewNumber: Number(resolved.id),
        });
      });
    };
    const existing = await recover();
    if (existing.every((identity) => identity !== null)) {
      return comments.map((comment, index) => ({ clientId: comment.clientId, status: "posted", identity: existing[index]! }));
    }
    if (existing.some((identity) => identity !== null)) throw new AmbiguousInlinePublishError("Partial inline marker set exists before atomic review write");
    const payload = {
      commit_id: headSha,
      event: "COMMENT",
      body: "tGD inline review",
      comments: comments.map((comment, index) => ({
        path: comment.path, line: comment.line, side: "RIGHT",
        ...(comment.startLine === undefined ? {} : { start_line: comment.startLine, start_side: "RIGHT" }),
        body: `${canonicalInlineBody(comment.body)}\n${INLINE_COMMENT_MARKER}\n${markers[index]}`,
      })),
    };
    try {
      await this.execGh(["api", `${apiRepo(repo)}/pulls/${resolved.id}/reviews`, ...apiHost(repo), "-X", "POST", "--input", "-"], JSON.stringify(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /HTTP (4\d\d)/u.exec(message)?.[1];
      if (status && !["408", "409", "425", "429"].includes(status)) {
        return comments.map(({ clientId }) => ({ clientId, status: "failed", reason: `GitHub rejected the atomic inline review (HTTP ${status})` }));
      }
      // Response loss is indistinguishable from acceptance. Recovery below is
      // authoritative; if incomplete, the typed error prevents fallback writes.
    }
    let recovered: Array<ConversationItemIdentity | null>;
    try { recovered = await recover(); } catch (cause) {
      if (cause instanceof AmbiguousInlinePublishError) throw cause;
      throw new AmbiguousInlinePublishError("Could not recover identities after atomic inline review write");
    }
    if (!recovered.every((identity) => identity !== null)) throw new AmbiguousInlinePublishError();
    return comments.map((comment, index) => ({ clientId: comment.clientId, status: "posted", identity: recovered[index]! }));
  }

  async recoverInlineReview(locator: ReviewLocator, recovery: InlineRecoveryState): Promise<"complete" | "none" | "ambiguous"> {
    let validated: InlineRecoveryState;
    try {
      validated = validateInlineRecoveryState(recovery);
    } catch (cause) {
      throw new Error("Invalid GitHub inline recovery manifest", { cause });
    }
    const resolved = resolvePullLocator(locator);
    const reviewNumber = Number(resolved.id);
    if (validated.children.some((child) => child.reviewNumber !== reviewNumber)) {
      throw new Error("GitHub inline recovery review mismatch");
    }
    const repo: GitHubRepositoryRef = resolved.repo ?? this.repository ?? await this.getRepoOwnerAndName().then(({ owner, name }): GitHubRepositoryRef => ({ provider: "github", host: "github.com", owner, repo: name, canonicalUrl: `https://github.com/${owner}/${name}` }));
    const expectedRepo = computeRepositoryDigest("github", repo.canonicalUrl);
    if (validated.children.some((child) => child.repositoryDigest !== expectedRepo)) {
      throw new Error("GitHub inline recovery repository mismatch");
    }
    const bot = await this.getBotLogin(repo);
    const counts = new Map(validated.children.map((child) => [child.marker, 0]));
    for await (const rows of this.restCommentPages(repo, `${apiRepo(repo)}/pulls/${resolved.id}/comments`, "inline recovery comments")) {
      for (const row of rows) {
      const login = typeof row.user === "object" && row.user !== null ? (row.user as { login?: unknown }).login : undefined;
      if (typeof login !== "string" || login.toLowerCase() !== bot || typeof row.body !== "string") continue;
      const marker = row.body.split(/\r?\n/u).at(-1) ?? "";
      if (!counts.has(marker)) continue;
      if (!sameGitHubBinding(row.pull_request_url, `https://api.github.com/${apiRepo(repo)}/pulls/${resolved.id}`)) return "ambiguous";
      const child = validated.children.find((candidate) => candidate.marker === marker)!;
      const canonicalBody = canonicalInlineBody(row.body);
      const suffix = `\n${INLINE_COMMENT_MARKER}\n${marker}`;
      if (!canonicalBody.endsWith(suffix) || computeContentDigest(canonicalBody.slice(0, -suffix.length)) !== child.contentDigest) return "ambiguous";
      const placementDigest = digest(JSON.stringify({ path: row.path, line: row.line, startLine: row.start_line ?? null, side: row.side, startSide: row.start_side ?? null }));
      if (placementDigest !== child.placementDigest || row.commit_id !== child.headSha) return "ambiguous";
      counts.set(marker, counts.get(marker)! + 1);
      }
    }
    if ([...counts.values()].some((count) => count > 1)) return "ambiguous";
    if ([...counts.values()].every((count) => count === 1)) return "complete";
    if ([...counts.values()].every((count) => count === 0)) return "none";
    return "ambiguous";
  }

  // Caches the resolved "owner/name" (same promise-caching pattern as
  // getBotLogin): resolveStaleReviewThreads may page + mutate several times,
  // and `gh repo view` only needs to run once per process.
  private repoNameWithOwnerPromise: Promise<{ owner: string; name: string }> | null = null;

  private getRepoOwnerAndName(): Promise<{ owner: string; name: string }> {
    if (!this.repoNameWithOwnerPromise) {
      this.repoNameWithOwnerPromise = this.execGh(["repo", "view", "--json", "nameWithOwner"]).then(
        (out) => {
          const parsed = JSON.parse(out) as GhRepoViewJson;
          // Gemini review: guard the shape before .indexOf — an unexpected
          // `gh repo view` response should fail with a message naming the
          // cause, not a bare TypeError.
          if (!parsed || typeof parsed.nameWithOwner !== "string") {
            throw new Error(`invalid response from gh repo view: ${out.slice(0, 200)}`);
          }
          const slash = parsed.nameWithOwner.indexOf("/");
          if (slash <= 0 || slash === parsed.nameWithOwner.length - 1) {
            throw new Error(
              `could not parse repo nameWithOwner from gh repo view: "${parsed.nameWithOwner}"`,
            );
          }
          return {
            owner: parsed.nameWithOwner.slice(0, slash),
            name: parsed.nameWithOwner.slice(slash + 1),
          };
        },
      );
    }
    return this.repoNameWithOwnerPromise;
  }

  /**
   * Design-review #10: resolves (collapses) every still-unresolved inline
   * review thread whose FIRST comment the bot itself authored. GraphQL-only
   * territory — REST cannot resolve a thread, and deleting comments would
   * destroy review history, so this is the one method that goes through
   * `gh api graphql` (which needs an explicit owner/name, hence
   * getRepoOwnerAndName — the REST `{owner}/{repo}` placeholder magic does not
   * apply to GraphQL).
   *
   * A human's thread is never touched: authorship is checked against the
   * bot's own verified identity (getBotLogin), the same anti-spoofing
   * discipline findBotComment uses. Mutations run sequentially — resolving is
   * cosmetic cleanup, so gentle pacing beats hammering the API concurrently.
   */
  async resolveStaleReviewThreads(locator: ReviewLocator): Promise<number> {
    const { repo, id } = resolvePullLocator(locator);
    const [botLogin, { owner, name }] = await Promise.all([
      this.getBotLogin(repo),
      repo
        ? Promise.resolve({ owner: repo.owner, name: repo.repo })
        : this.getRepoOwnerAndName(),
    ]);

    const staleThreadIds: string[] = [];
    let cursor: string | null = null;
    do {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${id}`,
        ...(cursor !== null ? ["-f", `cursor=${cursor}`] : []),
        ...apiHost(repo),
      ];
      const out = await this.execGh(args);
      const parsed = JSON.parse(out) as GhReviewThreadsResponse;
      // Gemini review: a GraphQL-level failure comes back as an `errors`
      // payload with no data — which the optional chaining below would treat
      // as "zero threads" and silently return 0. Throw instead, so the
      // caller's non-fatal warn actually surfaces the failure.
      if (!parsed.data?.repository?.pullRequest) {
        throw new Error(`GraphQL reviewThreads response missing expected data: ${out.slice(0, 200)}`);
      }
      const threads = parsed.data.repository.pullRequest.reviewThreads;
      for (const node of threads?.nodes ?? []) {
        if (node.isResolved) continue;
        const firstComment = node.comments?.nodes?.[0];
        if (firstComment?.author?.login?.toLowerCase() !== botLogin) continue;
        // Codex review (PR #6): author identity alone is NOT enough. A
        // developer running the CLI under their personal gh login also writes
        // MANUAL review comments as that same identity — those must never be
        // auto-resolved. Only threads whose first comment carries the tool's
        // own inline marker (appended by renderInlineComment, unforgeable from
        // finding content because sanitizeText defangs `<!--`) are stale.
        // Comments posted by pre-marker versions of the tool are deliberately
        // left alone: under-resolving is safe, over-resolving is not.
        if (!firstComment.body?.includes(INLINE_COMMENT_MARKER)) continue;
        staleThreadIds.push(node.id);
      }
      const pageInfo = threads?.pageInfo;
      cursor = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
    } while (cursor !== null);

    // Each mutation is individually guarded (Gemini review): one thread
    // failing to resolve (deleted comment, race with a human resolving it,
    // a transient API error) must not abandon the REST of the cleanup — and
    // this whole method is already best-effort for its caller. The count
    // returned is what actually resolved, not what was attempted.
    let resolved = 0;
    for (const threadId of staleThreadIds) {
      try {
        await this.execGh([
          "api",
          "graphql",
          "-f",
          `query=${RESOLVE_THREAD_MUTATION}`,
          "-f",
          `threadId=${threadId}`,
          ...apiHost(repo),
        ]);
        resolved += 1;
      } catch (err) {
        console.warn(
          `GitHubAdapter: could not resolve stale review thread ${threadId} ` +
            `(${(err as Error).message}); continuing with the remaining threads`,
        );
      }
    }
    return resolved;
  }

  /**
   * ADR-002 / CLI-native fix: fetches every `*.md` rule file under
   * `rulesDir` AS IT EXISTS ON THE BASE BRANCH (`baseSha`), via GitHub's
   * Contents API (`gh api repos/{owner}/{repo}/contents/{path}?ref={sha}`)
   * rather than any local git checkout/worktree — this is what lets the CLI
   * enforce the "rules come from the base branch, not the PR's own
   * checkout" trust boundary anywhere `gh` is authenticated (a developer's
   * own terminal, or any CI system), with no local git worktree ceremony
   * required.
   *
   * Lists `rulesDir` as a directory first; a 404 (directory doesn't exist
   * on the base branch) resolves to `[]` — the same "no rules dir = zero
   * user rules" semantics `loadRules()` already has for the local-
   * filesystem case — rather than throwing. Any other failure (auth error,
   * network error, malformed JSON) propagates.
   *
   * v1 limitation: only fetches files directly inside `rulesDir` (a flat
   * listing) — entries with `type !== "file"` (subdirectories, submodules,
   * symlinks) are skipped rather than recursed into. Recursing would need
   * either the `?recursive=1` git-trees API (a different endpoint/shape) or
   * one extra `gh api` round trip per nested directory; neither is
   * necessary for v1's flat `.tgd-review/rules/*.md` layout.
   */
  async getRuleFilesFromBase(
    locator: ReviewLocator,
    baseSha: string,
    rulesDir: string,
  ): Promise<RuleFileContent[]> {
    const { repo } = resolvePullLocator(locator);
    let entries: GhContentsEntry[];
    try {
      const out = await this.execGh([
        "api", `${apiRepo(repo)}/contents/${rulesDir}?ref=${baseSha}`, ...apiHost(repo),
      ]);
      const parsed = JSON.parse(out) as unknown;
      // The Contents API returns a single object (not an array) when the
      // given path resolves to a FILE rather than a directory. rulesDir is
      // expected to be a directory; treat that shape the same as "doesn't
      // exist" (zero user rules) rather than throwing.
      entries = Array.isArray(parsed) ? (parsed as GhContentsEntry[]) : [];
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }

    const mdFileEntries = entries.filter((entry) => entry.type === "file" && entry.name.endsWith(".md"));

    // Fetched concurrently, mirroring loader.ts's own concurrent-read
    // pattern for local rule files — one bad/slow file's fetch doesn't need
    // to block the others, and Promise.all still surfaces (propagates) the
    // first genuine rejection, per this method's error-handling contract.
    return Promise.all(
      mdFileEntries.map(async (entry) => {
        const out = await this.execGh([
          "api", `${apiRepo(repo)}/contents/${entry.path}?ref=${baseSha}`, ...apiHost(repo),
        ]);
        const parsed = JSON.parse(out) as GhContentsFileResponse;
        return { path: entry.name, content: Buffer.from(parsed.content, "base64").toString("utf-8") };
      }),
    );
  }
}
