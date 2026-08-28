// Dedup decision logic: pure, synchronous, no I/O. Decides whether a review
// run should post/edit a comment or skip because the PR's head SHA was
// already reviewed WITH THE SAME REVIEW CONFIGURATION. See SPEC.md's Boundaries
// "Always" bullet: a missing or malformed marker is always treated as "no prior
// review" (safe default — re-review, never silently skip).
import { createHash } from "node:crypto";
import type { BotComment, PullRequestInfo } from "../vcs/adapter.js";

export type DedupDecision = "skip-no-new-commits" | "review";

/**
 * The subset of the resolved CLI configuration that changes a review's OUTPUT
 * for one and the same commit. Hashed into the dedup marker (see
 * computeReviewConfigHash) so a config change re-triggers a review even when the
 * head SHA hasn't moved.
 */
export interface ReviewConfigForDedup {
  advisor: "on" | "off";
  suggestions: "on" | "off";
  disableBuiltinRule: boolean;
  trustLocalRules: boolean;
  rulesDir: string;
  model?: string;
  /**
   * Design-review P0: the dispatch engine changes how findings are produced,
   * so switching it must re-trigger a review on an unchanged head. NOTE:
   * adding this field changed every pre-existing hash — one extra (safe)
   * re-review per open PR after upgrading, then hashes are stable again.
   */
  dispatch: "direct" | "legacy";
  /**
   * PR #54 review: this decides whether a review can see registry facts at
   * all, so flipping it must re-trigger on an unchanged head. Optional so the
   * older two-field callers and their pinned hashes still typecheck.
   */
  dependencyFacts?: "on" | "off";
  /**
   * Issue #75: this decides whether a claimed finding is checked against the
   * base tree at all, so flipping it must re-trigger on an unchanged head.
   * Without it, turning the feature on after a review skips before dispatch and
   * no check appears until some other commit moves the head. Optional, so
   * older callers and their pinned hashes still typecheck.
   */
  structuralChecks?: "on" | "off";
}

/**
 * Short, stable hash of the flags that change a review's output for a fixed
 * commit. It is embedded in the dedup marker so that flipping `--advisor`,
 * `--suggestions`, `--model`, `--rules-dir`, `--disable-builtin-rule`, or
 * `--trust-local-rules` re-triggers a review on an unchanged head SHA — instead
 * of the run being skipped as "already reviewed" when it would in fact produce a
 * different review.
 *
 * DOCUMENTED LIMITATION — flags, not rule-file CONTENT. The dedup decision runs
 * BEFORE any rule file is fetched (an intentional "a skipped review must fetch
 * nothing" optimization — see cli.ts and its AC-8.1 test). So this hash cannot
 * see the BODY of a rule file: editing a rule's prompt on the base branch
 * without changing any flag still relies on a new commit to re-trigger. What IS
 * captured is everything that changes WHICH rules load or HOW they run:
 * `--rules-dir` (a different directory), `--disable-builtin-rule` (drops the
 * builtin), `--trust-local-rules` (a different rule source), and the model/pass
 * flags above.
 *
 * The exact hash value is not a stable contract — it only needs to be
 * deterministic within a version and to change when any hashed field changes.
 */
export function stateRootDomainIdentifier(root: string): string {
  return createHash("sha256").update(`tgd:state-root:v1\0${root}`, "utf8").digest("hex");
}

export function conversationDedupFingerprint(input: {
  readonly selectedDiscussion: readonly { readonly id: string; readonly revisionId: string }[];
  readonly pending: readonly { readonly id: string; readonly headSha: string }[];
  readonly directions: readonly { readonly id: string; readonly headSha: string }[];
  readonly memories: readonly { readonly id: string; readonly revision: string }[];
  readonly stateRootDomain: string;
}): string {
  const canonical = JSON.stringify([
    input.selectedDiscussion.map((item) => [item.id, item.revisionId]),
    input.pending.map((item) => [item.id, item.headSha]),
    input.directions.map((item) => [item.id, item.headSha]),
    input.memories.map((item) => [item.id, item.revision]),
    input.stateRootDomain,
  ]);
  return createHash("sha256").update(`tgd:conversation-dedup:v1\0${canonical}`, "utf8").digest("hex");
}

export function computeReviewConfigHash(
  config: ReviewConfigForDedup,
  relatedWorkFingerprint?: string,
  conversationFingerprint?: string,
  /**
   * Identifies the trusted-base context this review would be given — the
   * context mode plus the cache key identity, not the produced manifest. See
   * `contextFingerprint`. Appended inside a tagged object rather than as a
   * bare positional so it can never be confused with `conversationFingerprint`
   * when that one is absent.
   */
  contextFingerprint?: string,
): string {
  // A positional array (not an object) so the serialization can't drift on key
  // ordering; every field that affects review output is included explicitly.
  // rulesDir separators are normalized to POSIX `/` so the SAME logical rules
  // directory hashes identically regardless of the OS the CLI runs on — e.g. a
  // `--trust-local-rules` run passing `.tgd-review\rules` on Windows must not
  // read as a config change versus `.tgd-review/rules` in Linux CI and force a
  // spurious re-review. (The default value has no backslashes, so this leaves
  // existing hashes unchanged.)
  const canonical = JSON.stringify([
    config.advisor,
    config.suggestions,
    config.disableBuiltinRule,
    config.trustLocalRules,
    config.rulesDir.replace(/\\/g, "/"),
    config.model ?? null,
    config.dispatch,
    // Contributes NOTHING when off, which is the default. Appending an
    // unconditional field would have changed every hash in the wild and cost a
    // spurious re-review of every open pull request on upgrade — the price the
    // `dispatch` field above had to pay. Turning the flag on still changes the
    // hash, which is the whole point.
    ...(config.dependencyFacts === "on" ? ["dependency-facts"] : []),
    ...(config.structuralChecks === "on" ? ["structural-checks"] : []),
    // Appending this field intentionally changes every legacy config hash:
    // each open review runs once after upgrade, then remains stable again.
    relatedWorkFingerprint ?? null,
    ...(conversationFingerprint === undefined ? [] : [conversationFingerprint]),
    ...(contextFingerprint === undefined ? [] : [{ context: contextFingerprint }]),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * Decides whether to review or skip.
 *
 * `currentConfigHash` is optional so the pure two-argument form (used by older
 * callers/tests) keeps its original SHA-only semantics. When supplied, a run is
 * skipped ONLY when the marker's SHA matches the head AND the marker recorded a
 * config hash that still matches the current one. A config change — or a legacy
 * marker that carries no config hash at all — re-reviews rather than skipping
 * (the same safe default the whole module is built on: re-review, never
 * silently skip).
 */
export function decideDedup(
  pr: PullRequestInfo,
  botComment: BotComment | null,
  currentConfigHash?: string,
): DedupDecision {
  if (!botComment) return "review";
  if (!botComment.lastReviewedSha) return "review"; // malformed marker → safe default
  if (botComment.lastReviewedSha !== pr.headSha) return "review"; // new commits landed

  // Head SHA already reviewed. Without a config hash to compare, preserve the
  // original SHA-only behavior.
  if (currentConfigHash === undefined) return "skip-no-new-commits";

  // A marker with no recorded config (a pre-config-aware marker) is treated as
  // "unknown config" → re-review once, rather than skipping on an assumption we
  // can't verify.
  const recordedConfig = botComment.reviewedConfig ?? "";
  if (!recordedConfig) return "review";

  return recordedConfig === currentConfigHash ? "skip-no-new-commits" : "review";
}

/**
 * The HTML marker comment carrying the reviewed head SHA and (optionally) the
 * review-config hash, e.g. `<!-- tgd-review-agent:sha=abc1234 cfg=1a2b3c4d5e6f -->`.
 * `configHash` is optional so callers that don't track config still produce the
 * original SHA-only marker.
 */
export function formatMarker(headSha: string, configHash?: string): string {
  return configHash
    ? `<!-- tgd-review-agent:sha=${headSha} cfg=${configHash} -->`
    : `<!-- tgd-review-agent:sha=${headSha} -->`;
}
