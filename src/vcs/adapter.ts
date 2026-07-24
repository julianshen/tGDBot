import type {
  RepositoryRef as ProviderNeutralRepositoryRef,
} from "../target/types.js";
import type { DiffPositionRange } from "../review/diff-anchors.js";

export type ReviewLocator =
  | {
      readonly kind: "ambient";
      readonly provider: "github";
      readonly number: number;
    }
  | {
      readonly kind: "repository";
      readonly repo: ProviderNeutralRepositoryRef;
      readonly number: number;
    };

// Provider-neutral interface for fetching review metadata, diffs, rules, and
// comments, then publishing the review through `gh` or `glab`.
export interface VcsAdapter {
  getPullRequest(locator: ReviewLocator): Promise<PullRequestInfo>;
  getDiff(locator: ReviewLocator): Promise<string>;
  findBotComment(locator: ReviewLocator): Promise<BotComment | null>;
  /**
   * Creates or updates the summary and returns the exact provider-confirmed
   * comment identity. Callers use that returned identity for subsequent edits;
   * implementations must validate both the response ID and body.
   */
  upsertComment(
    locator: ReviewLocator,
    body: string,
    existing: BotComment | null,
  ): Promise<BotComment>;
  /**
   * Posts findings as inline review comments anchored to lines of the diff.
   *
   * `comments` MUST already be filtered to lines that are part of the diff — see
   * review/diff-anchors. Providers impose different batch/position constraints,
   * and the adapter reports one outcome for every requested comment.
   *
   * Callers must treat a rejection as recoverable, not fatal: the review()
   * flow falls back to putting every finding in the summary comment, so a
   * finding is only ever relocated, never lost.
   */
  createInlineReview(
    locator: ReviewLocator,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<InlinePublishOutcome[]>;
  /**
   * Design-review #10 (stale-comment accumulation): RESOLVES (collapses, never
   * deletes) every still-unresolved inline review thread that THIS BOT started
   * on the review — the previous runs' comments, which a new run is about to
   * supersede. Inline review comments are append-only (there is no upsert for
   * them, unlike the summary comment), so without this every past head SHA's
   * comments pile up uncollapsed forever. Resolving keeps them as history but
   * folds them out of the way.
   *
   * Returns how many threads were resolved. Only threads whose FIRST comment
   * was BOTH authored by the bot's own verified identity AND carries the
   * tool's inline marker (see comment-format.ts's INLINE_COMMENT_MARKER) are
   * touched. The marker is what distinguishes the tool's comments from MANUAL
   * comments the same account wrote (a developer running the CLI under their
   * personal `gh` login reviews by hand as that identity too — Codex review,
   * PR #6); the author check is what stops another user from forging the
   * marker. A human's thread is never resolved by the tool.
   *
   * Callers must treat a rejection as non-fatal: this is cosmetic cleanup, and
   * a failure here must never abort or degrade the review being posted.
   */
  resolveStaleReviewThreads(locator: ReviewLocator): Promise<number>;

  /**
   * ADR-002: fetches every `*.md` rule file under `rulesDir` AS IT EXISTS ON
   * THE REVIEW's BASE BRANCH (`baseSha`), via the VCS provider's own API (e.g.
   * GitHub's Contents API through `gh api`, or GitLab's repository API through
   * `glab api`) — never via a local git checkout/worktree. This is what
   * makes it safe to call `loadRules()` against the result without a review
   * being able to plant its own trusted rule file (see ADR-002's threat
   * model): the base branch is a commit the change author does not control.
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
  getRuleFilesFromBase(
    locator: ReviewLocator,
    baseSha: string,
    rulesDir: string,
  ): Promise<RuleFileContent[]>;
}

export interface InlineReviewComment {
  readonly clientId: string;
  /** Repo-relative path on the NEW side of the diff. */
  path: string;
  /**
   * NEW-file line number; must lie inside a diff hunk. For a multi-line range
   * (ADR-007's committable suggestions) this is the LAST line.
   */
  line: number;
  /** First line of a multi-line range; omitted for a single-line comment. */
  startLine?: number;
  readonly position: DiffPositionRange;
  body: string;
}

export interface InlinePublishOutcome {
  readonly clientId: string;
  readonly status: "posted" | "failed";
  readonly reason?: string;
}

export function validateInlinePublishInputs(
  comments: readonly InlineReviewComment[],
): void {
  const clientIds = new Set<string>();
  for (const comment of comments) {
    if (
      typeof comment.clientId !== "string" ||
      comment.clientId.length === 0 ||
      clientIds.has(comment.clientId)
    ) {
      throw new Error("inline comments require unique, non-empty clientId values");
    }
    clientIds.add(comment.clientId);
  }
}

export function validateInlinePublishOutcomes(
  comments: readonly InlineReviewComment[],
  outcomes: readonly InlinePublishOutcome[],
): InlinePublishOutcome[] {
  const expected = new Set(comments.map((comment) => comment.clientId));
  if (expected.size !== comments.length) throw new Error("duplicate inline comment clientId");
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (!expected.has(outcome.clientId)) throw new Error(`unknown inline outcome clientId: ${outcome.clientId}`);
    if (seen.has(outcome.clientId)) throw new Error(`duplicate inline outcome clientId: ${outcome.clientId}`);
    seen.add(outcome.clientId);
  }
  if (seen.size !== expected.size) throw new Error("incomplete inline publish outcomes");
  return [...outcomes];
}

export interface RuleFileContent {
  path: string; // relative path within the rules directory, e.g. "security-review.md"
  content: string; // raw file content
}

export interface PullRequestInfo {
  id: string; // PR/MR number
  headSha: string;
  baseSha: string;
  startSha?: string;
  headRef?: string;
  baseRef?: string;
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
  pendingState?: import("../review/comment-marker.js").PendingReviewState;
  invalidPendingState?: true;
}
