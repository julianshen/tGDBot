// VcsAdapter: provider-agnostic interface for fetching PR metadata/diff/comments
// and posting a review comment. Implemented by GitHubAdapter (this task, `gh`-backed)
// and, in a later phase, a GitLabAdapter (`glab`-backed) — see SPEC.md's Data Models
// section and TASKS.md's Task 2 Context & Goal ("VcsAdapter provider-agnostic so a
// GitLabAdapter is addable later without touching Tasks 3-9").
export interface VcsAdapter {
  getPullRequest(id: string): Promise<PullRequestInfo>;
  getDiff(id: string): Promise<string>;
  findBotComment(id: string): Promise<BotComment | null>;
  upsertComment(id: string, body: string, existing: BotComment | null): Promise<void>;
  /**
   * ADR-002: fetches every `*.md` rule file under `rulesDir` AS IT EXISTS ON
   * THE PR's BASE BRANCH (`baseSha`), via the VCS provider's own API (e.g.
   * GitHub's Contents API through `gh api`, or a future GitLabAdapter's
   * `glab api`) — never via a local git checkout/worktree. This is what
   * makes it safe to call `loadRules()` against the result without a PR
   * being able to plant its own trusted rule file (see ADR-002's threat
   * model): the base branch is a commit the PR author does not control.
   *
   * `rulesDir` is a REPO-RELATIVE path (e.g. `.tgd-review/rules`), not a
   * local filesystem path — there may be no local checkout at all when this
   * is called (a developer running the CLI from an unrelated directory, or
   * a CI runner that never checked out the base branch).
   *
   * Must NEVER throw when `rulesDir` doesn't exist on the base branch (the
   * provider API 404s) — that means "zero user rules", the same semantics
   * `loadRules()` already has for a missing local directory — and instead
   * resolve to `[]`. Genuine errors (auth failure, network error, malformed
   * API response) should still propagate/reject.
   */
  getRuleFilesFromBase(baseSha: string, rulesDir: string): Promise<RuleFileContent[]>;
}

export interface RuleFileContent {
  path: string; // relative path within the rules directory, e.g. "security-review.md"
  content: string; // raw file content
}

export interface PullRequestInfo {
  id: string; // PR/MR number
  headSha: string;
  baseSha: string;
  title: string;
  description: string;
}

export interface BotComment {
  id: string;
  body: string;
  lastReviewedSha: string; // parsed from the HTML marker
}
