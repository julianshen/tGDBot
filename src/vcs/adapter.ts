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
   * Posts findings as INLINE review comments anchored to lines of the diff
   * (GitHub: `POST /pulls/{n}/reviews` with `event: COMMENT`).
   *
   * `comments` MUST already be filtered to lines that are part of the diff — see
   * review/diff-anchors. GitHub rejects the WHOLE request with 422 if even one
   * anchor is invalid, which would lose every finding in the review.
   *
   * Callers must treat a rejection as recoverable, not fatal: the review()
   * flow falls back to putting every finding in the summary comment, so a
   * finding is only ever relocated, never lost.
   */
  createInlineReview(
    id: string,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<void>;
  /**
   * Design-review #10 (stale-comment accumulation): RESOLVES (collapses, never
   * deletes) every still-unresolved inline review thread that THIS BOT started
   * on the PR — the previous runs' comments, which a new run is about to
   * supersede. Inline review comments are append-only (there is no upsert for
   * them, unlike the summary comment), so without this every past head SHA's
   * comments pile up uncollapsed forever. Resolving keeps them as history but
   * folds them out of the way.
   *
   * Returns how many threads were resolved. Only threads whose FIRST comment
   * was authored by the bot's own verified identity are touched — a human's
   * thread (even one discussing a bot comment) is never resolved by the tool.
   *
   * Callers must treat a rejection as non-fatal: this is cosmetic cleanup, and
   * a failure here must never abort or degrade the review being posted.
   */
  resolveStaleReviewThreads(id: string): Promise<number>;

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

export interface InlineReviewComment {
  /** Repo-relative path on the NEW side of the diff. */
  path: string;
  /**
   * NEW-file line number; must lie inside a diff hunk. For a multi-line range
   * (ADR-007's committable suggestions) this is the LAST line, per GitHub's API.
   */
  line: number;
  /** First line of a multi-line range; omitted for a single-line comment. */
  startLine?: number;
  body: string;
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
  /**
   * Canonical web URL of the PR/MR (e.g. https://github.com/owner/repo/pull/42).
   * Carries the RESOLVED owner/repo identity: adapters infer the repo from
   * ambient context (`gh`'s git-remote / GH_REPO inference), so review() logs
   * this URL at the start of every run — making a mis-inferred target visible
   * instead of silently reviewing the wrong repo. Optional so a minimal future
   * adapter (or an old test double) without it still works; the log then falls
   * back to the bare PR number.
   */
  url?: string;
}

export interface BotComment {
  id: string;
  body: string;
  lastReviewedSha: string; // parsed from the HTML marker
  /**
   * The review-config hash recorded in the marker (see dedup.ts's
   * computeReviewConfigHash), or "" for a legacy marker that predates
   * config-aware dedup. decideDedup uses it to re-review when the config
   * changed even though the head SHA didn't.
   */
  reviewedConfig: string;
}
