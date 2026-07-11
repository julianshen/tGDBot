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
