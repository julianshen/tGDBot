import type {
  RepositoryRef as ProviderNeutralRepositoryRef,
} from "../target/types.js";
import type { DiffPositionRange } from "../review/diff-anchors.js";
import type { RelatedWorkItem, RelatedWorkReference } from "../review/related-work.js";
import type { ConversationItemIdentity } from "../conversation/types.js";
import type { RepositoryRef } from "../target/types.js";

/**
 * Total order over `orderKey` strings, matching the `<` / `>` / `<=` operators
 * used everywhere a key is compared against a page cutoff or boundary.
 *
 * MUST be used for every orderKey sort. `String.prototype.localeCompare` is a
 * DIFFERENT total order: it reorders "_", "-" and case relative to codepoint
 * order. Sorting a candidate window one way and then counting it against a
 * cutoff the other way makes a paginated scan emit one set and account for
 * another — which is exactly how the review-event traversal broke its
 * `cutoffRank === emittedRank` invariant on a real pull request, where GitHub's
 * base64url node ids ("PRRT_kwDOTX0Oys...") contain the characters the two
 * orders disagree about.
 */
export function compareOrderKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  /**
   * Best-effort metadata lookup for references extracted from the review title
   * and description. Implementations return one item per input, in input order,
   * and preserve an unresolved reference when its lookup fails. Callers still
   * reconcile by canonical identity and treat whole-operation rejection as
   * non-fatal, so metadata resolution can never prevent the main review.
   */
  resolveRelatedWork(references: readonly RelatedWorkReference[]): Promise<readonly RelatedWorkItem[]>;
  getPullRequest(locator: ReviewLocator): Promise<PullRequestInfo>;
  /**
   * Fetches the review's diff.
   *
   * `expectedHeadSha`, when given, is the head the CALLER has already pinned
   * and will publish against (dedup fingerprint, inline `commit_id`). An
   * implementation that can observe the head it actually read must reject a
   * mismatch rather than return a diff of a different commit: findings
   * computed from newer code but published against the older SHA anchor to
   * lines that may not exist there.
   *
   * `expectedBaseSha` pins the other half of the comparison. A diff is
   * base..head, so retargeting the review or force-pushing its base changes
   * what the diff CONTAINS while the head sits still — and the caller has
   * already sourced its rules from the base it pinned.
   */
  getDiff(
    locator: ReviewLocator,
    options?: { expectedHeadSha?: string; expectedBaseSha?: string },
  ): Promise<string>;
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
    recovery?: import("../review/comment-marker.js").InlineRecoveryState,
  ): Promise<InlinePublishOutcome[]>;
  prepareInlineReviewRecovery?(
    locator: ReviewLocator,
    headSha: string,
    comments: readonly InlineReviewComment[],
    runIdentity: string,
  ): Promise<import("../review/comment-marker.js").InlineRecoveryState>;
  /** Reconciles a previously ambiguous atomic inline write without reposting. */
  recoverInlineReview?(
    locator: ReviewLocator,
    recovery: import("../review/comment-marker.js").InlineRecoveryState,
  ): Promise<"complete" | "none" | "ambiguous">;
  /** Recovers a previously written child by its frozen publication marker. */
  findPublishedMarker?(
    locator: ReviewLocator,
    marker: string,
  ): Promise<ConversationItemIdentity | null>;
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

export type InlinePublishOutcome =
  | { readonly clientId: string; readonly status: "posted"; readonly identity: ConversationItemIdentity }
  | { readonly clientId: string; readonly status: "failed"; readonly reason: string };

/**
 * A provider accepted (or may have accepted) an atomic inline write, but the
 * adapter could not recover every durable child identity. Callers must not
 * publish fallback copies; a later marker reconciliation is the only safe path.
 */
export class AmbiguousInlinePublishError extends Error {
  readonly code = "INLINE_WRITE_AMBIGUOUS";
  constructor(message = "The provider may have accepted an inline review but complete identity recovery was ambiguous") {
    super(message);
    this.name = "AmbiguousInlinePublishError";
  }
}

const MAX_INLINE_FAILURE_REASON_LENGTH = 512;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_IDENTITY_URL_LENGTH = 2_048;
interface CanonicalIdentityBinding {
  readonly provider: "github" | "gitlab";
  readonly canonicalUrl: string;
  readonly reviewNumber: number;
}
const validatedConversationIdentities = new WeakMap<object, CanonicalIdentityBinding>();

export interface ConversationIdentityBinding {
  readonly repo: RepositoryRef;
  readonly reviewNumber: number;
}

function canonicalIdentityBinding(expected: ConversationIdentityBinding): CanonicalIdentityBinding {
  if (expected.repo.provider === "github") {
    const owner = expected.repo.owner.toLowerCase();
    const repository = expected.repo.repo.toLowerCase();
    return Object.freeze({
      provider: "github",
      canonicalUrl: `https://github.com/${owner}/${repository}`,
      reviewNumber: expected.reviewNumber,
    });
  }
  return Object.freeze({
    provider: expected.repo.provider,
    canonicalUrl: expected.repo.canonicalUrl,
    reviewNumber: expected.reviewNumber,
  });
}

function identityReviewUrlMatches(url: URL, binding: CanonicalIdentityBinding): boolean {
  const canonical = new URL(binding.canonicalUrl);
  if (url.origin !== canonical.origin || url.search !== "") return false;
  const basePath = canonical.pathname.replace(/\/$/u, "");
  const expectedPath = binding.provider === "github"
    ? `${basePath}/pull/${binding.reviewNumber}`
    : `${basePath}/-/merge_requests/${binding.reviewNumber}`;
  return binding.provider === "github"
    ? url.pathname.toLowerCase() === expectedPath.toLowerCase()
    : url.pathname === expectedPath;
}

export function validateConversationItemIdentity(
  identity: unknown,
  expected: ConversationIdentityBinding,
): ConversationItemIdentity {
  if (typeof expected !== "object" || expected === null || typeof expected.repo !== "object" || expected.repo === null) {
    throw new Error("conversation identity requires canonical repository/review binding");
  }
  if (!Number.isSafeInteger(expected.reviewNumber) || expected.reviewNumber <= 0) throw new Error("invalid identity review binding");
  const canonicalBinding = canonicalIdentityBinding(expected);
  if (typeof identity !== "object" || identity === null) throw new Error("posted inline outcome requires identity");
  const prototype = Object.getPrototypeOf(identity) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid inline identity prototype");
  const keys = Reflect.ownKeys(identity);
  const allowed = keys.includes("threadId")
    ? ["provider", "commentId", "threadId", "url"]
    : ["provider", "commentId", "url"];
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error("invalid inline identity keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(identity);
  const candidate: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("inline identity fields must be enumerable data properties, not accessors");
    }
    candidate[key] = descriptor.value;
  }
  if (candidate.provider !== "github" && candidate.provider !== "gitlab") throw new Error("invalid inline identity provider");
  if (typeof candidate.commentId !== "string" || !PROVIDER_ID_RE.test(candidate.commentId)) throw new Error("invalid inline identity commentId");
  if (candidate.threadId !== undefined && (typeof candidate.threadId !== "string" || !PROVIDER_ID_RE.test(candidate.threadId))) {
    throw new Error("invalid inline identity threadId");
  }
  if (typeof candidate.url !== "string" || candidate.url.length > MAX_IDENTITY_URL_LENGTH) throw new Error("invalid inline identity URL");
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    throw new Error("invalid inline identity URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("invalid inline identity URL");
  }
  {
    if (candidate.provider !== canonicalBinding.provider) throw new Error("inline identity provider binding mismatch");
    if (!identityReviewUrlMatches(url, canonicalBinding)) throw new Error("inline identity review URL binding mismatch");
    const validFragment = candidate.provider === "github"
      ? url.hash === `#discussion_r${candidate.commentId}` || url.hash === `#issuecomment-${candidate.commentId}`
      : url.hash === `#note_${candidate.commentId}`;
    if (!validFragment) throw new Error("inline identity comment URL binding mismatch");
  }
  const validated: ConversationItemIdentity = Object.freeze({
    provider: candidate.provider,
    commentId: candidate.commentId as string,
    ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId as string }),
    url: candidate.url,
  });
  validatedConversationIdentities.set(validated, canonicalBinding);
  return validated;
}

function assertStoredIdentityBinding(
  identity: ConversationItemIdentity,
  binding: CanonicalIdentityBinding,
): void {
  if (!Object.isFrozen(identity) || identity.provider !== binding.provider) {
    throw new Error("posted inline identity no longer matches its validated binding");
  }
  const url = new URL(identity.url);
  const validFragment = binding.provider === "github"
    ? url.hash === `#discussion_r${identity.commentId}` || url.hash === `#issuecomment-${identity.commentId}`
    : url.hash === `#note_${identity.commentId}`;
  if (!identityReviewUrlMatches(url, binding) || !validFragment) {
    throw new Error("posted inline identity no longer matches its validated binding");
  }
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
  expectedIdentity?: ConversationIdentityBinding,
): InlinePublishOutcome[] {
  const expected = new Set(comments.map((comment) => comment.clientId));
  if (expected.size !== comments.length) throw new Error("duplicate inline comment clientId");
  const seen = new Set<string>();
  const validated: InlinePublishOutcome[] = [];
  for (const outcome of outcomes) {
    if (!expected.has(outcome.clientId)) throw new Error(`unknown inline outcome clientId: ${outcome.clientId}`);
    if (seen.has(outcome.clientId)) throw new Error(`duplicate inline outcome clientId: ${outcome.clientId}`);
    if (outcome.status === "posted") {
      const identity = expectedIdentity
        ? validateConversationItemIdentity(outcome.identity, expectedIdentity)
        : (() => {
            const stored = validatedConversationIdentities.get(outcome.identity as object);
            if (!stored) throw new Error("posted inline identity requires validated repository/review binding");
            assertStoredIdentityBinding(outcome.identity, stored);
            return outcome.identity;
          })();
      validated.push({ ...outcome, identity });
    } else if (outcome.status !== "failed") {
      throw new Error("invalid inline outcome status");
    } else if (
      typeof outcome.reason !== "string" ||
      outcome.reason.trim().length === 0 ||
      outcome.reason.length > MAX_INLINE_FAILURE_REASON_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(outcome.reason)
    ) {
      throw new Error("failed inline outcome requires a non-empty bounded reason without control characters");
    } else {
      validated.push({ clientId: outcome.clientId, status: "failed", reason: outcome.reason });
    }
    seen.add(outcome.clientId);
  }
  if (seen.size !== expected.size) throw new Error("incomplete inline publish outcomes");
  return validated;
}

export interface RuleFileContent {
  path: string; // relative path within the rules directory, e.g. "security-review.md"
  content: string; // raw file content
}

export interface PullRequestInfo {
  id: string; // PR/MR number
  /**
   * Provider-native stable pull/merge request ID, not the review number.
   * GitHub: GraphQL node ID (`PR_kwDO…`). GitLab: global database ID.
   * Optional so existing test doubles that only have the number still work.
   */
  reviewId?: string;
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
   * instead of silently reviewing the wrong repo.
   *
   * Still optional in the type, but only for a locator that already names its
   * repository — there the identity comes from the locator and the log merely
   * falls back to the bare PR number. An AMBIENT locator has no owner/repo of
   * its own, so this URL is the sole source of the canonical repository
   * identity that conversation state and every published marker bind to;
   * adapters must populate it there, and GitHubAdapter rejects an ambient
   * response that omits it rather than deferring the failure to review().
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
