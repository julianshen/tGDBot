import { execFile } from "node:child_process";
import type { BotComment, PullRequestInfo, VcsAdapter } from "./adapter.js";

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
// `<!-- tgd-review-agent:sha=abc1234 -->`. Capture group 1 is lastReviewedSha.
// A comment can match BOT_MARKER_PREFIX_RE without matching this (malformed
// SHA) — that's still treated as "the bot's marker comment", just with an
// empty lastReviewedSha (see findBotComment).
const BOT_MARKER_RE = /<!-- tgd-review-agent:sha=([0-9a-f]{7,40}) -->/;

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
   * Resolves the identity `gh` is currently authenticated as, via
   * `gh api user`. This works whether auth is via `GITHUB_TOKEN` in Actions
   * (resolves to `github-actions[bot]`) or a PAT (resolves to a real user
   * login) — see security fix for findBotComment below.
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
}
