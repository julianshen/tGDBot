// Issue #57: a human's accept/defer is a parser decision, never a model one.
// Matching later reviews to an accepted finding uses only digests and a line
// number — the same mechanical class as outcome records.
import {
  outcomeLabelDigest,
  type FindingOutcomeEntry,
} from "./state-schema.js";

export type FindingDisposition = "accepted" | "deferred";

export function acceptanceKey(input: {
  readonly ruleName: string;
  readonly file: string;
  readonly line?: number;
}): string {
  return JSON.stringify([
    outcomeLabelDigest(input.ruleName),
    outcomeLabelDigest(input.file),
    input.line ?? null,
  ]);
}

export function acceptanceKeyFromOutcome(entry: FindingOutcomeEntry): string | undefined {
  if (entry.disposition !== "accepted" || entry.fileDigest === undefined) return undefined;
  return JSON.stringify([entry.ruleDigest, entry.fileDigest, entry.line ?? null]);
}

export function isAcceptedOnReview(
  finding: { readonly ruleName: string; readonly file: string; readonly line?: number },
  outcomes: readonly FindingOutcomeEntry[],
  reviewNumber: number,
): boolean {
  const key = acceptanceKey(finding);
  return outcomes.some((entry) =>
    entry.reviewNumber === reviewNumber && acceptanceKeyFromOutcome(entry) === key);
}
