import { execFile } from "node:child_process";
import { INLINE_COMMENT_MARKER } from "../review/comment-format.js";
import type {
  BotComment,
  InlineReviewComment,
  PullRequestInfo,
  PullRequestSnapshot,
  RepositoryRef,
  RepositoryScopedVcsAdapter,
  RuleFileContent,
  VcsAdapter,
} from "./adapter.js";

/**
 * Seam for shelling out to the `gh` CLI. GitHubAdapter accepts an ExecGh
 * implementation via its constructor (defaulting to `realExecGh`) so unit
 * tests can inject a mock/stub and never spawn a real `gh` process — per
 * SPEC.md's Testing Strategy ("VCS adapters: mock `gh`/`glab` CLI
 * invocations, no real network/CLI calls in unit tests").
 *
 * `stdin`, when provided, is piped to the child process (used for
 * `--body-file -` / `--input -` invocations so comment bodies never have to
 * be embedded in a shell-quoted argument).
 */
export type ExecGh = (args: string[], stdin?: string) => Promise<string>;

/**
 * Real implementation: shells out to the actual `gh` CLI via `execFile` (no
 * shell interpolation). `child_process.execFile`'s promisified form doesn't
 * support piping stdin, so this wraps the callback form directly and writes
 * `stdin` to the child process before awaiting completion.
 */
export const realExecGh: ExecGh = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
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

// Detects the *presence* of our marker prefix, regardless of whether the SHA
// that follows is well-formed. Used to distinguish "the bot posted a marker
// comment (possibly with a malformed SHA)" from "this isn't our comment at
// all" — see findBotComment.
const BOT_MARKER_PREFIX_RE = /<!-- tgd-review-agent:sha=/;

// Matches the bot's own HTML marker comment, e.g.
// `<!-- tgd-review-agent:sha=abc1234 -->` or, since config-aware dedup,
// `<!-- tgd-review-agent:sha=abc1234 cfg=1a2b3c4d5e6f -->`. Capture group 1 is
// lastReviewedSha; group 2 (optional) is the review-config hash, absent on a
// legacy marker. A comment can match BOT_MARKER_PREFIX_RE without matching this
// (malformed SHA) — that's still treated as "the bot's marker comment", just
// with an empty lastReviewedSha/reviewedConfig (see findBotComment).
//
// The `\s*$` anchor is load-bearing (hardening, CodeRabbit review): buildBody
// (cli.ts) always appends this marker as the LAST thing in the comment body, so
// the AUTHORITATIVE marker is the trailing one. Without the anchor, `exec`
// returns the FIRST marker-shaped match anywhere in the body — so a review
// finding that quoted a marker-shaped string earlier in the comment could be
// parsed as the reviewed SHA/config, causing an incorrect skip. (Finding text
// is already sanitized to defang `<!--`/`-->`, so this is defense-in-depth on
// top of that — but anchoring makes the parse correct by construction rather
// than resting on the sanitizer.)
const BOT_MARKER_RE = /<!-- tgd-review-agent:sha=([0-9a-f]{7,40})(?: cfg=([0-9a-z]+))? -->\s*$/;

interface GhPrViewJson {
  headRefOid: string;
  baseRefOid: string;
  headRefName?: string;
  baseRefName?: string;
  title: string;
  body?: string | null;
  url?: string;
}

interface GhIssueComment {
  id: number | string;
  body: string;
  user: { login: string };
}

interface GhUser {
  login: string;
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

function isRepositoryRef(value: string | RepositoryRef): value is RepositoryRef {
  return typeof value !== "string";
}

function resolvePullLocator(
  repoOrId: string | RepositoryRef,
  number?: number,
): { repo?: RepositoryRef; id: string } {
  if (isRepositoryRef(repoOrId)) {
    if (!Number.isSafeInteger(number) || (number ?? 0) <= 0) {
      throw new Error("A positive pull-request number is required with an explicit repository");
    }
    return { repo: repoOrId, id: String(number) };
  }
  return { id: repoOrId };
}

function repoFlag(repo?: RepositoryRef): string[] {
  // `gh pr` documents `--repo [HOST/]OWNER/REPO` as the explicit selector:
  // https://cli.github.com/manual/gh_pr_view
  return repo ? ["--repo", `${repo.owner}/${repo.repo}`] : [];
}

function apiRepo(repo?: RepositoryRef): string {
  // `gh api` documents that {owner}/{repo} placeholders use ambient context;
  // canonical-URL runs therefore render the REST path explicitly instead:
  // https://cli.github.com/manual/gh_api
  return repo ? `repos/${repo.owner}/${repo.repo}` : "repos/{owner}/{repo}";
}

/**
 * GitHubAdapter: VcsAdapter implementation backed by the `gh` CLI.
 *
 * Canonical-URL calls accept a RepositoryRef and use `--repo owner/repo`,
 * explicit REST paths, and explicit GraphQL variables. Legacy one-argument
 * calls retain ambient gh context for backward compatibility until their
 * documented migration path is retired.
 */
export class GitHubAdapter implements VcsAdapter, RepositoryScopedVcsAdapter {
  constructor(private readonly execGh: ExecGh = realExecGh) {}

  // Caches the resolved bot login (the currently-authenticated `gh` identity)
  // across calls within an adapter instance, so `gh api user` is only ever
  // invoked once per process — not once per comment-list fetch. Caching the
  // in-flight Promise (not just the resolved value) also collapses
  // concurrent callers onto a single `gh api user` invocation.
  private botLoginPromise: Promise<string> | null = null;

  /**
   * Resolves the identity `gh` is currently authenticated as, via
   * `gh api user`. This tool is run from an environment authenticated as a real
   * user (a developer's terminal, or CI you provide a token for), so `gh api
   * user` resolves that user's login — the identity findBotComment matches
   * against so a spoofed marker from another author can't trick dedup.
   */
  private getBotLogin(): Promise<string> {
    if (!this.botLoginPromise) {
      this.botLoginPromise = this.execGh(["api", "user"]).then((out) => {
        const parsed = JSON.parse(out) as GhUser;
        return parsed.login;
      });
    }
    return this.botLoginPromise;
  }

  /**
   * AC-2.1: parses `gh pr view <id> --json headRefOid,baseRefOid,title,body,url`
   * output into a PullRequestInfo with the correct headSha/baseSha/title/
   * description/url. `url` (the PR's canonical web URL) is what surfaces the
   * owner/repo `gh` actually resolved from its ambient context — review() logs
   * it so a mis-inferred repo target is visible, not silent.
   */
  async getPullRequest(id: string): Promise<PullRequestInfo>;
  async getPullRequest(repo: RepositoryRef, number: number): Promise<PullRequestSnapshot>;
  async getPullRequest(
    repoOrId: string | RepositoryRef,
    number?: number,
  ): Promise<PullRequestInfo | PullRequestSnapshot> {
    const { repo, id } = resolvePullLocator(repoOrId, number);
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
        number: Number(id),
        headSha: parsed.headRefOid,
        baseSha: parsed.baseRefOid,
        headRef: parsed.headRefName,
        baseRef: parsed.baseRefName,
        title: parsed.title,
        description: parsed.body ?? "",
        url: parsed.url ?? `https://github.com/${repo.owner}/${repo.repo}/pull/${id}`,
      };
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

  async getDiff(id: string): Promise<string>;
  async getDiff(repo: RepositoryRef, number: number): Promise<string>;
  async getDiff(repoOrId: string | RepositoryRef, number?: number): Promise<string> {
    const { repo, id } = resolvePullLocator(repoOrId, number);
    return this.execGh(["pr", "diff", id, ...repoFlag(repo)]);
  }

  /**
   * AC-2.2 / AC-2.3: lists PR comments via `gh api
   * repos/{owner}/{repo}/issues/{id}/comments` (paginated — `--paginate -f
   * per_page=100` — since the default 30/page could put the bot's own prior
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
   * this call passes `-f per_page=100` for pagination, omitting `-X GET`
   * makes `gh` issue a POST to the issue-comments endpoint, which GitHub
   * interprets as "create a comment" and rejects with HTTP 422 (`"body"
   * wasn't supplied`) — confirmed empirically:
   *   `gh api --paginate -f per_page=100 repos/{owner}/{repo}/issues/{id}/comments`
   *     → 422 "body" wasn't supplied
   *   `gh api --method GET --paginate -f per_page=100 repos/{owner}/{repo}/issues/{id}/comments`
   *     → correct paginated comments array
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
  async findBotComment(id: string): Promise<BotComment | null>;
  async findBotComment(repo: RepositoryRef, number: number): Promise<BotComment | null>;
  async findBotComment(
    repoOrId: string | RepositoryRef,
    number?: number,
  ): Promise<BotComment | null> {
    const { repo, id } = resolvePullLocator(repoOrId, number);
    const botLogin = await this.getBotLogin();
    const out = await this.execGh([
      "api",
      "-X",
      "GET",
      "--paginate",
      "-f",
      "per_page=100",
      `${apiRepo(repo)}/issues/${id}/comments`,
    ]);
    const comments = JSON.parse(out) as GhIssueComment[];
    for (const comment of comments) {
      if (comment.user?.login !== botLogin) continue;
      if (!BOT_MARKER_PREFIX_RE.test(comment.body)) continue;
      const match = BOT_MARKER_RE.exec(comment.body);
      return {
        id: String(comment.id),
        body: comment.body,
        lastReviewedSha: match?.[1] ?? "",
        reviewedConfig: match?.[2] ?? "",
      };
    }
    return null;
  }

  /**
   * AC-2.4: when `existing` is null, creates a new comment via
   * `gh pr comment <id> --body-file -` (body piped via stdin) — never edits.
   *
   * AC-2.5: when `existing` is a BotComment, edits that EXACT comment by id
   * via `gh api repos/{owner}/{repo}/issues/comments/{existing.id} -X PATCH
   * --input -` (JSON body piped via stdin) — never creates a second comment,
   * and never relies on `--edit-last` (which could target a human's comment
   * posted after the bot's).
   */
  async upsertComment(id: string, body: string, existing: BotComment | null): Promise<void>;
  async upsertComment(
    repo: RepositoryRef,
    number: number,
    body: string,
    existing: BotComment | null,
  ): Promise<void>;
  async upsertComment(
    repoOrId: string | RepositoryRef,
    numberOrBody: number | string,
    bodyOrExisting: string | BotComment | null,
    maybeExisting?: BotComment | null,
  ): Promise<void> {
    const explicit = isRepositoryRef(repoOrId);
    const { repo, id } = resolvePullLocator(
      repoOrId,
      explicit ? (numberOrBody as number) : undefined,
    );
    const body = explicit ? (bodyOrExisting as string) : (numberOrBody as string);
    const existing = explicit ? (maybeExisting ?? null) : (bodyOrExisting as BotComment | null);
    if (existing === null) {
      await this.execGh(["pr", "comment", id, ...repoFlag(repo), "--body-file", "-"], body);
    } else {
      await this.execGh(
        ["api", `${apiRepo(repo)}/issues/comments/${existing.id}`, "-X", "PATCH", "--input", "-"],
        JSON.stringify({ body }),
      );
    }
  }

  /**
   * Posts the findings as inline review comments in ONE review
   * (`POST /pulls/{n}/reviews`, `event: COMMENT`).
   *
   * Why one request and not one comment each: a single review groups the
   * comments into a coherent unit in the GitHub UI and generates one
   * notification instead of N. The cost is all-or-nothing — GitHub 422s the
   * entire request if any single anchor is off the diff — which is exactly why
   * `comments` must come from the diff-anchors filter, and why review() treats a
   * rejection as "fall back to the summary comment", never as a lost finding.
   *
   * `side: RIGHT` pins each comment to the NEW file, which is the side our
   * anchors are computed against; `commit_id` pins the review to the head SHA we
   * actually reviewed, so the comments don't drift onto a newer commit.
   *
   * The payload goes over stdin (`--input -`), never argv: bodies are multi-line
   * markdown, and there is no shell involved (execFile with an array).
   */
  async createInlineReview(
    id: string,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<void>;
  async createInlineReview(
    repo: RepositoryRef,
    number: number,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<void>;
  async createInlineReview(
    repoOrId: string | RepositoryRef,
    numberOrHeadSha: number | string,
    headShaOrComments: string | InlineReviewComment[],
    maybeComments?: InlineReviewComment[],
  ): Promise<void> {
    const explicit = isRepositoryRef(repoOrId);
    const { repo, id } = resolvePullLocator(
      repoOrId,
      explicit ? (numberOrHeadSha as number) : undefined,
    );
    const headSha = explicit ? (headShaOrComments as string) : (numberOrHeadSha as string);
    const comments = explicit
      ? (maybeComments ?? [])
      : (headShaOrComments as InlineReviewComment[]);
    if (comments.length === 0) return;

    const payload = {
      commit_id: headSha,
      event: "COMMENT",
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT",
        // ADR-007: a multi-line committable suggestion spans start_line..line.
        // GitHub requires start_side alongside start_line, and start_line < line.
        ...(typeof c.startLine === "number" && c.startLine < c.line
          ? { start_line: c.startLine, start_side: "RIGHT" }
          : {}),
        body: c.body,
      })),
    };

    await this.execGh(
      ["api", `${apiRepo(repo)}/pulls/${id}/reviews`, "-X", "POST", "--input", "-"],
      JSON.stringify(payload),
    );
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
  async resolveStaleReviewThreads(id: string): Promise<number>;
  async resolveStaleReviewThreads(repo: RepositoryRef, number: number): Promise<number>;
  async resolveStaleReviewThreads(
    repoOrId: string | RepositoryRef,
    number?: number,
  ): Promise<number> {
    const { repo, id } = resolvePullLocator(repoOrId, number);
    const [botLogin, { owner, name }] = await Promise.all([
      this.getBotLogin(),
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
        if (firstComment?.author?.login !== botLogin) continue;
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
  async getRuleFilesFromBase(baseSha: string, rulesDir: string): Promise<RuleFileContent[]>;
  async getRuleFilesFromBase(
    repo: RepositoryRef,
    baseSha: string,
    rulesDir: string,
  ): Promise<RuleFileContent[]>;
  async getRuleFilesFromBase(
    repoOrBaseSha: RepositoryRef | string,
    baseShaOrRulesDir: string,
    maybeRulesDir?: string,
  ): Promise<RuleFileContent[]> {
    const explicit = isRepositoryRef(repoOrBaseSha);
    const repo = explicit ? repoOrBaseSha : undefined;
    const baseSha = explicit ? baseShaOrRulesDir : repoOrBaseSha;
    const rulesDir = explicit ? (maybeRulesDir as string) : baseShaOrRulesDir;
    let entries: GhContentsEntry[];
    try {
      const out = await this.execGh(["api", `${apiRepo(repo)}/contents/${rulesDir}?ref=${baseSha}`]);
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
        const out = await this.execGh(["api", `${apiRepo(repo)}/contents/${entry.path}?ref=${baseSha}`]);
        const parsed = JSON.parse(out) as GhContentsFileResponse;
        return { path: entry.name, content: Buffer.from(parsed.content, "base64").toString("utf-8") };
      }),
    );
  }
}
