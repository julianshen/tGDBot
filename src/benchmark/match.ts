// Issue #113: deciding whether a produced finding is the defect a fixture
// asserts. This is the one place a benchmark is most easily made dishonest, so
// the rules are written out rather than implied by the code.
import type { Finding } from "../review/types.js";
import type { ExpectedFinding, MatchOutcome, QualityMetrics } from "./types.js";

/**
 * Whether `finding` satisfies `expected`.
 *
 * Three independent conditions, all required when present:
 *
 * - FILE, always. Compared after normalising, so `./src/a.ts` and `src/a.ts`
 *   are one path — the same cosmetic mismatch that produced a false accusation
 *   in the structural checker (see `canonicalRelative` there).
 * - LINE, when the expectation gives a range. A finding with no line at all
 *   fails a ranged expectation: it went to the summary rather than to the
 *   defect, which is a real difference in what a reader sees, and #114 exists
 *   because that difference is currently unmeasured.
 * - MESSAGE, when the expectation gives a pattern. Case-insensitive, and
 *   matched against the message only — not the title or the suggestion —
 *   because the message is the part a reader is asked to act on.
 *
 * Deliberately NOT compared: rule name. Several rules routinely land on one
 * defect and `clusterFindings` collapses them; requiring a particular rule
 * would fail a run that found the bug through a different one, which is not a
 * worse review.
 */
export function satisfies(expected: ExpectedFinding, finding: Finding): boolean {
  if (normalizePath(finding.file) !== normalizePath(expected.file)) return false;
  if (expected.lines !== undefined) {
    if (finding.line === undefined) return false;
    const [start, end] = expected.lines;
    // A range finding counts if it OVERLAPS the expected span. Requiring
    // containment would fail a correct multi-line finding for being more
    // precise about its own extent than the expectation was.
    const findingEnd = finding.endLine ?? finding.line;
    if (findingEnd < start || finding.line > end) return false;
  }
  if (expected.severity !== undefined && finding.severity !== expected.severity) return false;
  if (expected.messagePattern !== undefined) {
    if (!new RegExp(expected.messagePattern, "iu").test(finding.message)) return false;
  }
  return true;
}

/** `./src/a.ts`, `src//a.ts` and `src/a.ts` are one path. */
function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
}

/**
 * Assigns produced findings to expectations, at most one each way.
 *
 * GREEDY, in fixture order: each expectation takes the first unclaimed finding
 * that satisfies it. Not an optimal assignment, and it does not need to be —
 * expectations are line-scoped, so two of them competing for one finding means
 * the fixture has written overlapping expectations, which is a fixture bug
 * worth noticing rather than an ambiguity worth resolving cleverly. The order
 * is deterministic, which is what the committed baseline actually requires.
 *
 * A finding claimed by one expectation cannot also be a false positive, and an
 * expectation matched once cannot be matched again: without both, a single
 * vague finding could satisfy every expectation in the fixture and score a
 * perfect recall.
 */
export function matchFindings(
  expected: readonly ExpectedFinding[],
  findings: readonly Finding[],
): MatchOutcome {
  const claimed = new Set<number>();
  const truePositives: { expectedId: string; findingIndex: number }[] = [];
  const falseNegatives: string[] = [];

  for (const expectation of expected) {
    const index = findings.findIndex((finding, at) => !claimed.has(at) && satisfies(expectation, finding));
    if (index === -1) {
      falseNegatives.push(expectation.id);
      continue;
    }
    claimed.add(index);
    truePositives.push({ expectedId: expectation.id, findingIndex: index });
  }

  const falsePositives = findings.map((_, at) => at).filter((at) => !claimed.has(at));
  return { truePositives, falseNegatives, falsePositives };
}

/**
 * Precision, recall and F1 from a match outcome.
 *
 * Every undefined case is `null` rather than a number. A run that produced
 * nothing has no precision — not zero, which would read as "everything it said
 * was wrong" about a run that said nothing. Same for recall on a fixture that
 * asserts no defects, which is a legitimate fixture: a clean pull request the
 * reviewer should stay quiet about, where the only meaningful number is the
 * false-positive count.
 */
export function qualityOf(outcome: MatchOutcome): QualityMetrics {
  const truePositives = outcome.truePositives.length;
  const falsePositives = outcome.falsePositives.length;
  const falseNegatives = outcome.falseNegatives.length;

  const produced = truePositives + falsePositives;
  const asserted = truePositives + falseNegatives;
  const precision = produced === 0 ? null : truePositives / produced;
  const recall = asserted === 0 ? null : truePositives / asserted;
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);

  return { truePositives, falsePositives, falseNegatives, precision, recall, f1 };
}

/**
 * Rounded to four decimals for the committed baseline.
 *
 * Float division puts values like 0.30000000000000004 in the JSON, which then
 * churns the diff on an unrelated machine. Four places distinguishes anything
 * a fixture of this size can express.
 */
export function roundMetric(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}
