// Issue #113: the report and baseline diff. Same stance as match.test.ts —
// these pin the ways a benchmark can look better than it is.
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/benchmark/cli.js";
import { publishedBytes } from "../../../src/benchmark/run.js";
import { aggregate, diffBaselines, formatReport, toBaseline, type Baseline } from "../../../src/benchmark/report.js";
import type { BaselineEntry, FixtureRunResult, RunReport } from "../../../src/benchmark/types.js";

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    fixture: "f1",
    quality: { truePositives: 1, falsePositives: 1, falseNegatives: 0, precision: 0.5, recall: 1, f1: 0.6667 },
    findingsCount: 2,
    severityMix: { blocking: 1, warning: 0, suggestion: 1 },
    findingsPerRule: { "rule-a": 2 },
    dispatchChars: 1000,
    diffChars: 100,
    findingTextChars: 50,
    renderedChars: 400,
    anchoredInline: 2,
    missed: [],
    ...overrides,
  };
}

function result(overrides: Partial<BaselineEntry> = {}): FixtureRunResult {
  return {
    baseline: entry(overrides),
    durationMs: 12.3,
    findings: [],
    match: { truePositives: [], falseNegatives: [], falsePositives: [] },
  };
}

function baseline(entries: BaselineEntry[]): Baseline {
  return { version: 1, mode: "recorded", entries };
}

describe("baseline", () => {
  it("sorts entries by fixture name, so the committed JSON does not reorder", () => {
    const built = toBaseline([result({ fixture: "zebra" }), result({ fixture: "alpha" })]);
    expect(built.entries.map((item) => item.fixture)).toEqual(["alpha", "zebra"]);
  });

  it("carries no wall-clock timing", () => {
    // durationMs varies with machine load by more than any change we would be
    // trying to detect. Committing it churns every diff until nobody reads them.
    expect(JSON.stringify(toBaseline([result()]))).not.toMatch(/duration/i);
  });
});

describe("diffBaselines", () => {
  it("reports nothing when the run matches", () => {
    expect(diffBaselines(baseline([entry()]), baseline([entry()]))).toEqual([]);
  });

  it("names the metric that moved", () => {
    const deltas = diffBaselines(baseline([entry()]), baseline([entry({ dispatchChars: 1200 })]));
    expect(deltas).toEqual([{ fixture: "f1", metric: "dispatchChars", before: 1000, after: 1200 }]);
  });

  it("reports a fixture that stopped running instead of quietly dropping it", () => {
    // A renamed directory or a deleted recording would otherwise look like an
    // improvement, because the failing rows simply stop being printed.
    const deltas = diffBaselines(baseline([entry()]), baseline([]));
    expect(deltas).toEqual([{ fixture: "f1", metric: "fixture", before: "present", after: "absent" }]);
  });

  it("reports a newly added fixture", () => {
    const deltas = diffBaselines(baseline([]), baseline([entry()]));
    expect(deltas).toEqual([{ fixture: "f1", metric: "fixture", before: "absent", after: "present" }]);
  });

  it("names which expectation started being missed", () => {
    const deltas = diffBaselines(baseline([entry()]), baseline([entry({ missed: ["deref-guard"] })]));
    expect(deltas).toEqual([{ fixture: "f1", metric: "missed", before: [], after: ["deref-guard"] }]);
  });
});

describe("aggregate", () => {
  it("pools over findings rather than averaging over fixtures", () => {
    // Averaging per-fixture precision gives a two-finding fixture the same
    // weight as a twenty-finding one, so one tiny fixture can swing the
    // headline further than the rest of the suite combined.
    const report: RunReport = {
      mode: "recorded",
      generatedAt: "2026-08-31T00:00:00.000Z",
      results: [
        result({ fixture: "small", quality: { truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1, f1: 1 } }),
        result({ fixture: "large", quality: { truePositives: 1, falsePositives: 9, falseNegatives: 0, precision: 0.1, recall: 1, f1: 0.1818 } }),
      ],
      skipped: [],
    };
    // Pooled: 2 true of 11 produced. An average of the two rates would be 55%.
    expect(aggregate(report).precision).toBeCloseTo(2 / 11);
  });
});

describe("formatReport", () => {
  const withSkip: RunReport = {
    mode: "recorded",
    generatedAt: "2026-08-31T00:00:00.000Z",
    results: [result()],
    skipped: [{ fixture: "broken", kind: "no-recording" as const, reason: "no recorded.json; real mode only" }],
  };

  it("says a total was computed over fewer fixtures than exist", () => {
    // A total over some of the fixtures is not the benchmark's answer, and the
    // note sits next to the number it qualifies.
    const text = formatReport(withSkip);
    expect(text).toMatch(/SKIPPED broken/);
    expect(text).toMatch(/did not run; totals cover the rest/);
  });

  it("prints an undefined rate as n/a rather than 0%", () => {
    const text = formatReport({
      ...withSkip,
      skipped: [],
      results: [result({ quality: { truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: null, recall: null, f1: null } })],
    });
    expect(text).toMatch(/n\/a/);
    expect(text).not.toMatch(/0\.0%/);
  });
});

describe("publishedBytes", () => {
  // Review content only. The dry run's `----- ... -----` headers are framing
  // and are asserted separately below.
  const review = ["**2 findings · 2 inline comments posted**", "body text"];

  it("counts the review preview", () => {
    expect(publishedBytes(review)).toBe(review.join("\n").length);
  });

  it("is unmoved by the dry run's own section headers", () => {
    // Preview scaffolding, not published bytes — and the inline header carries
    // the comment's path and line, so counting it made a placement change look
    // like a rendering change.
    expect(publishedBytes([
      "\n----- review body -----",
      "\n----- inline comment: src/a.ts:14 -----",
      "\n----- summary comment -----",
      ...review,
    ])).toBe(publishedBytes(review));
  });

  it("keeps a finding body that contains a rule-like line", () => {
    // Each console.log call is one entry, so framing is matched whole. A body
    // that happens to contain such a line is review, and must still count.
    const body = ["some prose", "----- not framing -----", "more prose"].join("\n");
    expect(publishedBytes([body])).toBe(body.length);
  });

  it("is unmoved by operational logging", () => {
    // A change to a progress message must not read as a rendering regression:
    // the findings and the published bytes are the same, only the machinery
    // said something different.
    expect(publishedBytes([
      "tgd-review-agent: repository context ready for 1 rule(s)",
      ...review,
      "TGD_REVIEW_SEVERITIES: {\"blocking\":1}",
      "TGD_REVIEW_RESULT: {\"status\":\"posted\"}",
    ])).toBe(publishedBytes(review));
  });
});

describe("parseArgs", () => {
  it("defaults to recorded mode, which spends nothing", () => {
    expect(parseArgs([])).toMatchObject({ mode: "recorded", update: false, check: false });
  });

  it("refuses --model in recorded mode", () => {
    // Accepting it silently would let someone believe they had measured a
    // model when they had replayed a recording.
    expect(() => parseArgs(["--model", "anthropic/claude-opus-4-5"])).toThrow(/real mode only/);
  });

  it("refuses --update together with --check", () => {
    expect(() => parseArgs(["--update", "--check"])).toThrow(/mutually exclusive/);
  });

  it("refuses --update or --check in real mode during argument parsing", () => {
    // Validated BEFORE the fixture loop. Checking after meant a mistyped
    // command called the paid model for every fixture and only then reported
    // the combination invalid.
    expect(() => parseArgs(["--mode", "real", "--check"])).toThrow(/recorded mode only/);
    expect(() => parseArgs(["--mode", "real", "--update"])).toThrow(/recorded mode only/);
  });

  it("refuses --only with --update or --check", () => {
    // The baseline covers the whole suite. Written from a filtered run it
    // deletes every unselected row; compared against one it reports them all
    // as vanished. Both are data loss dressed as a result.
    expect(() => parseArgs(["--only", "x", "--update"])).toThrow(/whole suite/);
    expect(() => parseArgs(["--only", "x", "--check"])).toThrow(/whole suite/);
  });

  it("allows --only on its own", () => {
    expect(parseArgs(["--only", "x"])).toMatchObject({ only: "x", update: false, check: false });
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--fast"])).toThrow(/unknown argument/);
  });
});
