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
export function computeReviewConfigHash(config: ReviewConfigForDedup): string {
  // A positional array (not an object) so the serialization can't drift on key
  // ordering; every field that affects review output is included explicitly.
  const canonical = JSON.stringify([
    config.advisor,
    config.suggestions,
    config.disableBuiltinRule,
    config.trustLocalRules,
    config.rulesDir,
    config.model ?? null,
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
