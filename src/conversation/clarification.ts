// Pure selection of the single active clarification for a review/head
// snapshot. Deferred candidates are counted, never persisted here.
import { createHash } from "node:crypto";
import type { Finding } from "../review/types.js";

export interface ClarificationSelectionInput {
  readonly repositoryDigest: string;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly findings: readonly Finding[];
  readonly ruleOrder?: readonly string[];
}

export interface SelectedClarification {
  readonly id: string;
  readonly question: string;
  readonly finding: Finding;
}

export interface ClarificationSelection {
  readonly selected?: SelectedClarification;
  readonly deferredCount: number;
}

function isClarificationCandidate(
  finding: Finding,
): finding is Finding & { question: string } {
  return finding.decision === "needs-clarification" && typeof finding.question === "string";
}

function clarificationId(input: ClarificationSelectionInput, finding: Finding & { question: string }): string {
  const digest = createHash("sha256")
    .update("tgd:clarification:v1\0", "utf8")
    .update(input.repositoryDigest)
    .update("\0")
    .update(String(input.reviewNumber))
    .update("\0")
    .update(input.headSha)
    .update("\0")
    .update(finding.ruleName)
    .update("\0")
    .update(finding.file)
    .update("\0")
    .update(finding.line === undefined ? "" : String(finding.line))
    .update("\0")
    .update(finding.question)
    .digest("hex")
    .slice(0, 32);
  return `clar_${digest}`;
}

/**
 * Picks the first needs-clarification finding by workflow/rule order, then
 * original finding order. One active question per review/head snapshot.
 */
export function selectClarification(input: ClarificationSelectionInput): ClarificationSelection {
  const candidates = input.findings
    .map((finding, index) => ({ finding, index }))
    .filter((item): item is { finding: Finding & { question: string }; index: number } =>
      isClarificationCandidate(item.finding),
    );
  if (candidates.length === 0) return { deferredCount: 0 };

  const ruleRank = new Map((input.ruleOrder ?? []).map((name, index) => [name, index]));
  candidates.sort((left, right) => {
    const leftRank = ruleRank.get(left.finding.ruleName) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = ruleRank.get(right.finding.ruleName) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.index - right.index;
  });

  const first = candidates[0]!;
  return {
    selected: {
      id: clarificationId(input, first.finding),
      question: first.finding.question,
      finding: first.finding,
    },
    deferredCount: candidates.length - 1,
  };
}
