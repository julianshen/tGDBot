// Dedup decision logic: pure, synchronous, no I/O. Decides whether a review
// run should post/edit a comment or skip because the PR's head SHA was
// already reviewed. See SPEC.md's Boundaries "Always" bullet: a missing or
// malformed marker is always treated as "no prior review" (safe default —
// re-review, never silently skip).
import type { BotComment, PullRequestInfo } from "../vcs/adapter.js";

export type DedupDecision = "skip-no-new-commits" | "review";

export function decideDedup(pr: PullRequestInfo, botComment: BotComment | null): DedupDecision {
  if (!botComment) return "review";
  if (!botComment.lastReviewedSha) return "review"; // malformed marker → safe default
  return botComment.lastReviewedSha === pr.headSha ? "skip-no-new-commits" : "review";
}

export function formatMarker(headSha: string): string {
  return `<!-- tgd-review-agent:sha=${headSha} -->`;
}
