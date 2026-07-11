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

// Matches the bot's own HTML marker comment, e.g.
// `<!-- tgd-review-agent:sha=abc1234 -->`. Capture group 1 is lastReviewedSha.
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
   * repos/{owner}/{repo}/issues/{id}/comments` and returns the first comment
   * whose body matches the bot marker regex (with lastReviewedSha extracted
   * from the capture group), or `null` if no comment matches.
   */
  async findBotComment(id: string): Promise<BotComment | null> {
    const out = await this.execGh(["api", `repos/{owner}/{repo}/issues/${id}/comments`]);
    const comments = JSON.parse(out) as GhIssueComment[];
    for (const comment of comments) {
      const match = BOT_MARKER_RE.exec(comment.body);
      if (match) {
        return {
          id: String(comment.id),
          body: comment.body,
          lastReviewedSha: match[1] ?? "",
        };
      }
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
