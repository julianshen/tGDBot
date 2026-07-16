import { execFile } from "node:child_process";
import type { BotComment, InlineReviewComment, PullRequestInfo, RuleFileContent, VcsAdapter } from "./adapter.js";

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
  title: string;
  body: string;
}

interface GhIssueComment {
  id: number | string;
  body: string;
  user: { login: string };
}

interface GhUser {
  login: string;
}

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

// `gh api user` under a GitHub Actions GITHUB_TOKEN (an installation /
// "integration" token) rejects with HTTP 403 "Resource not accessible by
// integration": the /user endpoint requires user-to-server auth, which an
// installation token is not. getBotLogin uses this to fall back to the Actions
// bot identity instead of aborting the whole review. Same stderr-message
// convention as isNotFoundError above.
function isForbiddenError(err: unknown): boolean {
  return err instanceof Error && /HTTP 403/.test(err.message);
}

// The comment author for the default GitHub Actions GITHUB_TOKEN. When
// `gh api user` is inaccessible (403), the comments this tool posts are authored
// by this identity, so it is what findBotComment must match against.
// Overridable via TGD_REVIEW_BOT_LOGIN for a GitHub App posting under a
// different bot slug.
const ACTIONS_BOT_LOGIN = "github-actions[bot]";

/**
 * GitHubAdapter: VcsAdapter implementation backed by the `gh` CLI.
 *
 * Owner/repo resolution: every `gh pr ...` / `gh api repos/{owner}/{repo}/...`
 * invocation relies on `gh`'s own repo-context inference (current git
 * remote, or `GH_REPO`/`GITHUB_REPOSITORY` env vars in CI) rather than a
 * hardcoded `--repo owner/repo` flag, per TASKS.md Task 2's "Owner/repo
 * resolution" note.
 */
export class GitHubAdapter implements VcsAdapter {
  constructor(private readonly execGh: ExecGh = realExecGh) {}

  // Caches the resolved bot login (the currently-authenticated `gh` identity)
  // across calls within an adapter instance, so `gh api user` is only ever
  // invoked once per process — not once per comment-list fetch. Caching the
  // in-flight Promise (not just the resolved value) also collapses
  // concurrent callers onto a single `gh api user` invocation.
  private botLoginPromise: Promise<string> | null = null;

  /**
   * Resolves the identity `gh` is currently authenticated as.
   *
   * A PAT can query `gh api user` and resolves to its real user login. A GitHub
   * Actions GITHUB_TOKEN, however, CANNOT: the /user endpoint requires
   * user-to-server auth, so `gh api user` rejects with HTTP 403 "Resource not
   * accessible by integration" — the exact failure that aborted every CI review
   * before this fix (the shipped workflow authenticates via GITHUB_TOKEN). In
   * that environment the comments this tool posts are authored by
   * `github-actions[bot]`, so we fall back to that identity (overridable via
   * TGD_REVIEW_BOT_LOGIN for a GitHub App posting under a different slug) rather
   * than failing the whole review before it starts.
   *
   * This keeps the anti-spoofing guarantee findBotComment relies on intact: an
   * outside user cannot post a comment authored by `github-actions[bot]` (only
   * the Actions token can), so matching that login is exactly as unforgeable as
   * matching a resolved PAT identity. Only a 403 triggers the fallback; any
   * other failure (network, real auth error, malformed response) still
   * propagates.
   */
  private getBotLogin(): Promise<string> {
    if (!this.botLoginPromise) {
      this.botLoginPromise = this.execGh(["api", "user"])
        .then((out) => (JSON.parse(out) as GhUser).login)
        .catch((err: unknown) => {
          if (isForbiddenError(err)) {
            return process.env.TGD_REVIEW_BOT_LOGIN?.trim() || ACTIONS_BOT_LOGIN;
          }
          throw err;
        });
    }
    return this.botLoginPromise;
  }

  /**
   * AC-2.1: parses `gh pr view <id> --json headRefOid,baseRefOid,title,body`
   * output into a PullRequestInfo with the correct headSha/baseSha/title/description.
   */
  async getPullRequest(id: string): Promise<PullRequestInfo> {
    const out = await this.execGh([
      "pr",
      "view",
      id,
      "--json",
      "headRefOid,baseRefOid,title,body",
    ]);
    const parsed = JSON.parse(out) as GhPrViewJson;
    return {
      id,
      headSha: parsed.headRefOid,
      baseSha: parsed.baseRefOid,
      title: parsed.title,
      description: parsed.body,
    };
  }

  async getDiff(id: string): Promise<string> {
    return this.execGh(["pr", "diff", id]);
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
  async findBotComment(id: string): Promise<BotComment | null> {
    const botLogin = await this.getBotLogin();
    const out = await this.execGh([
      "api",
      "-X",
      "GET",
      "--paginate",
      "-f",
      "per_page=100",
      `repos/{owner}/{repo}/issues/${id}/comments`,
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
  async upsertComment(id: string, body: string, existing: BotComment | null): Promise<void> {
    if (existing === null) {
      await this.execGh(["pr", "comment", id, "--body-file", "-"], body);
    } else {
      await this.execGh(
        ["api", `repos/{owner}/{repo}/issues/comments/${existing.id}`, "-X", "PATCH", "--input", "-"],
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
  ): Promise<void> {
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
      ["api", `repos/{owner}/{repo}/pulls/${id}/reviews`, "-X", "POST", "--input", "-"],
      JSON.stringify(payload),
    );
  }

  /**
   * ADR-002 / CLI-native fix: fetches every `*.md` rule file under
   * `rulesDir` AS IT EXISTS ON THE BASE BRANCH (`baseSha`), via GitHub's
   * Contents API (`gh api repos/{owner}/{repo}/contents/{path}?ref={sha}`)
   * rather than any local git checkout/worktree — this is what lets the CLI
   * enforce the "rules come from the base branch, not the PR's own
   * checkout" trust boundary anywhere `gh` is authenticated (a developer's
   * own terminal, any CI system), not just inside a GitHub Actions workflow
   * with local git worktree support.
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
  async getRuleFilesFromBase(baseSha: string, rulesDir: string): Promise<RuleFileContent[]> {
    let entries: GhContentsEntry[];
    try {
      const out = await this.execGh(["api", `repos/{owner}/{repo}/contents/${rulesDir}?ref=${baseSha}`]);
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
        const out = await this.execGh(["api", `repos/{owner}/{repo}/contents/${entry.path}?ref=${baseSha}`]);
        const parsed = JSON.parse(out) as GhContentsFileResponse;
        return { path: entry.name, content: Buffer.from(parsed.content, "base64").toString("utf-8") };
      }),
    );
  }
}
