// Issue #113. These tests are about the harness's HONESTY rather than its
// mechanics: every one of them pins a way a benchmark can quietly flatter the
// thing it measures.
import { describe, expect, it } from "vitest";
import { matchFindings, qualityOf, satisfies } from "../../../src/benchmark/match.js";
import type { ExpectedFinding } from "../../../src/benchmark/types.js";
import type { Finding } from "../../../src/review/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 10,
    severity: "blocking",
    category: "correctness",
    message: "user may be undefined here",
    ruleName: "rule-a",
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedFinding> = {}): ExpectedFinding {
  return { id: "e1", file: "src/a.ts", lines: [8, 12], ...overrides };
}

describe("satisfies", () => {
  it("accepts a finding inside the expected range", () => {
    expect(satisfies(expected(), finding())).toBe(true);
  });

  it("treats equivalent spellings of a path as one path", () => {
    // The same cosmetic mismatch that made the structural checker publish a
    // false accusation. Here it would silently score a correct finding as both
    // a miss and a false positive.
    expect(satisfies(expected({ file: "./src/a.ts" }), finding({ file: "src//a.ts" }))).toBe(true);
  });

  it("rejects a finding with no line when the expectation names a range", () => {
    // It went to the summary rather than to the defect. A reader sees
    // something different, so the benchmark must too (#114).
    expect(satisfies(expected(), finding({ line: undefined }))).toBe(false);
  });

  it("accepts a multi-line finding that only overlaps the expected range", () => {
    expect(satisfies(expected({ lines: [12, 14] }), finding({ line: 10, endLine: 13 }))).toBe(true);
  });

  it("rejects a finding that misses the range entirely", () => {
    expect(satisfies(expected({ lines: [20, 24] }), finding({ line: 10 }))).toBe(false);
  });

  it("requires the message pattern when the expectation gives one", () => {
    expect(satisfies(expected({ messagePattern: "undefined" }), finding())).toBe(true);
    expect(satisfies(expected({ messagePattern: "race condition" }), finding())).toBe(false);
  });

  it("ignores the rule name, so finding the bug through another rule still counts", () => {
    expect(satisfies(expected(), finding({ ruleName: "some-other-rule" }))).toBe(true);
  });
});

describe("matchFindings", () => {
  it("does not let one vague finding satisfy every expectation", () => {
    // Without one-to-one assignment a single finding scores a perfect recall
    // on a fixture asserting three defects — the most flattering bug this
    // harness could have.
    const outcome = matchFindings(
      [expected({ id: "a" }), expected({ id: "b" }), expected({ id: "c" })],
      [finding()],
    );
    expect(outcome.truePositives).toHaveLength(1);
    expect(outcome.falseNegatives).toEqual(["b", "c"]);
  });

  it("does not count a matched finding as a false positive as well", () => {
    const outcome = matchFindings([expected()], [finding()]);
    expect(outcome.falsePositives).toEqual([]);
  });

  it("reports an unmatched finding as a false positive", () => {
    const outcome = matchFindings([], [finding()]);
    expect(outcome.falsePositives).toEqual([0]);
    expect(outcome.truePositives).toEqual([]);
  });
});

describe("qualityOf", () => {
  it("reports precision as undefined, not zero, when nothing was produced", () => {
    // Zero would read as "everything it said was wrong" about a run that said
    // nothing at all.
    const quality = qualityOf(matchFindings([expected()], []));
    expect(quality.precision).toBeNull();
    expect(quality.recall).toBe(0);
    expect(quality.f1).toBeNull();
  });

  it("reports recall as undefined, not zero, when a fixture asserts nothing", () => {
    // A clean pull request the reviewer should stay quiet about is a
    // legitimate fixture; its only meaningful number is the false positives.
    const quality = qualityOf(matchFindings([], [finding()]));
    expect(quality.recall).toBeNull();
    expect(quality.precision).toBe(0);
  });

  it("leaves every rate undefined when a fixture asserts nothing and nothing was produced", () => {
    const quality = qualityOf(matchFindings([], []));
    expect(quality).toMatchObject({ precision: null, recall: null, f1: null });
  });

  it("computes precision, recall and F1 separately", () => {
    // Kept separate on purpose: measured on one harness, a newer model scored
    // higher precision and much lower recall than its predecessor and landed
    // at a worse F1. One collapsed number cannot say which happened.
    const quality = qualityOf(matchFindings(
      [expected({ id: "a" }), expected({ id: "b", lines: [20, 24] })],
      [finding(), finding({ line: 40 })],
    ));
    expect(quality).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1 });
    expect(quality.precision).toBeCloseTo(0.5);
    expect(quality.recall).toBeCloseTo(0.5);
    expect(quality.f1).toBeCloseTo(0.5);
  });
});
