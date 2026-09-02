// Issue #113: turning a run into something a person reads and a baseline a
// machine diffs.
//
// Two outputs with different jobs. The BASELINE is committed and must contain
// only values the pipeline determines — a metric that moves with machine load
// makes every diff noisy, and a noisy diff is one nobody reads. The REPORT is
// what a human looks at once, and may carry timings.
import type { BaselineEntry, FixtureRunResult, RunReport } from "./types.js";

export interface Baseline {
  readonly version: 1;
  /** Recorded mode only. A real-mode run varies with the model and cannot be a baseline. */
  readonly mode: "recorded";
  readonly entries: readonly BaselineEntry[];
}

export function toBaseline(results: readonly FixtureRunResult[]): Baseline {
  return {
    version: 1,
    mode: "recorded",
    entries: [...results].map((result) => result.baseline)
      .sort((left, right) => left.fixture.localeCompare(right.fixture)),
  };
}

/** One changed number, named well enough to act on without opening the code. */
export interface BaselineDelta {
  readonly fixture: string;
  readonly metric: string;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * Every difference between two baselines, including fixtures that appeared or
 * vanished.
 *
 * A fixture missing from one side is reported as its own delta rather than
 * skipped. A benchmark that quietly stops running a fixture — a renamed
 * directory, a fixture whose recording was deleted — would otherwise look like
 * an improvement, because the failing rows simply stop being printed.
 */
export function diffBaselines(before: Baseline, after: Baseline): BaselineDelta[] {
  const deltas: BaselineDelta[] = [];
  const beforeByName = new Map(before.entries.map((entry) => [entry.fixture, entry]));
  const afterByName = new Map(after.entries.map((entry) => [entry.fixture, entry]));

  for (const name of [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort()) {
    const left = beforeByName.get(name);
    const right = afterByName.get(name);
    if (left === undefined) {
      deltas.push({ fixture: name, metric: "fixture", before: "absent", after: "present" });
      continue;
    }
    if (right === undefined) {
      deltas.push({ fixture: name, metric: "fixture", before: "present", after: "absent" });
      continue;
    }
    deltas.push(...compareEntries(name, left, right));
  }
  return deltas;
}

function compareEntries(fixture: string, left: BaselineEntry, right: BaselineEntry): BaselineDelta[] {
  const deltas: BaselineDelta[] = [];
  const note = (metric: string, before: unknown, after: unknown): void => {
    if (JSON.stringify(before) !== JSON.stringify(after)) deltas.push({ fixture, metric, before, after });
  };

  note("precision", left.quality.precision, right.quality.precision);
  note("recall", left.quality.recall, right.quality.recall);
  note("f1", left.quality.f1, right.quality.f1);
  note("truePositives", left.quality.truePositives, right.quality.truePositives);
  note("falsePositives", left.quality.falsePositives, right.quality.falsePositives);
  note("falseNegatives", left.quality.falseNegatives, right.quality.falseNegatives);
  note("findingsCount", left.findingsCount, right.findingsCount);
  note("anchoredInline", left.anchoredInline, right.anchoredInline);
  note("severityMix", left.severityMix, right.severityMix);
  note("findingsPerRule", left.findingsPerRule, right.findingsPerRule);
  note("dispatchChars", left.dispatchChars, right.dispatchChars);
  note("diffChars", left.diffChars, right.diffChars);
  note("findingTextChars", left.findingTextChars, right.findingTextChars);
  note("renderedChars", left.renderedChars, right.renderedChars);
  note("missed", left.missed, right.missed);
  return deltas;
}

/** A fixed-width table, because this is read in a terminal. */
export function formatReport(report: RunReport): string {
  const lines: string[] = [
    `mode: ${report.mode}    generated: ${report.generatedAt}`,
    "",
    pad("fixture", 28) + pad("P", 8) + pad("R", 8) + pad("F1", 8) +
      pad("TP/FP/FN", 12) + pad("anchored", 10) + pad("dispatchKc", 12) + "ms",
    "-".repeat(94),
  ];

  for (const result of report.results) {
    const { baseline } = result;
    lines.push(
      pad(baseline.fixture, 28) +
      pad(percent(baseline.quality.precision), 8) +
      pad(percent(baseline.quality.recall), 8) +
      pad(percent(baseline.quality.f1), 8) +
      pad(`${baseline.quality.truePositives}/${baseline.quality.falsePositives}/${baseline.quality.falseNegatives}`, 12) +
      pad(`${baseline.anchoredInline}/${baseline.findingsCount}`, 10) +
      pad((baseline.dispatchChars / 1000).toFixed(1), 12) +
      Math.round(result.durationMs).toString(),
    );
    for (const missed of baseline.missed) lines.push(`  missed: ${missed}`);
  }

  for (const skip of report.skipped) lines.push(`  SKIPPED ${skip.fixture}: ${skip.reason}`);

  const totals = aggregate(report);
  lines.push(
    "-".repeat(94),
    `totals  TP ${totals.truePositives}  FP ${totals.falsePositives}  FN ${totals.falseNegatives}  ` +
      `precision ${percent(totals.precision)}  recall ${percent(totals.recall)}  f1 ${percent(totals.f1)}`,
  );
  if (report.skipped.length > 0) {
    // Said out loud, at the bottom, next to the totals it distorts. A total
    // computed over some of the fixtures is not the benchmark's answer.
    lines.push(`NOTE: ${report.skipped.length} fixture(s) did not run; totals cover the rest.`);
  }
  return lines.join("\n");
}

/**
 * Totals pooled over findings, not averaged over fixtures.
 *
 * Averaging per-fixture precision would give a fixture with two findings the
 * same weight as one with twenty, so a single tiny fixture could swing the
 * headline number more than the rest of the suite combined.
 */
export function aggregate(report: RunReport): {
  truePositives: number; falsePositives: number; falseNegatives: number;
  precision: number | null; recall: number | null; f1: number | null;
} {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const result of report.results) {
    truePositives += result.baseline.quality.truePositives;
    falsePositives += result.baseline.quality.falsePositives;
    falseNegatives += result.baseline.quality.falseNegatives;
  }
  const produced = truePositives + falsePositives;
  const asserted = truePositives + falseNegatives;
  const precision = produced === 0 ? null : truePositives / produced;
  const recall = asserted === 0 ? null : truePositives / asserted;
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  return { truePositives, falsePositives, falseNegatives, precision, recall, f1 };
}

/** `n/a`, never `0%`: an undefined rate and a rate of zero are different facts. */
function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}
