// Tests for orchestrate — see TASKS.md Task 7 "Acceptance Criteria (BDD)"
// AC-7.1 through AC-7.4.
import { describe, expect, it } from "vitest";
import { orchestrate } from "../../../src/review/orchestrate.js";
import type { DispatchResult, Finding } from "../../../src/review/types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/foo.ts",
    line: 10,
    severity: "warning",
    category: "style",
    message: "Some message",
    ruleName: "some-rule",
    ...overrides,
  };
}

function makeDispatchResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    findings: [],
    rulesRun: [],
    rulesFailed: [],
    ...overrides,
  };
}

describe("orchestrate", () => {
  // AC-7.1: Given two findings with the same file, line, and near-identical
  // message from two different rules, When orchestrate runs, Then the
  // resulting commentBody reflects only one occurrence of that finding.
  it("AC-7.1: dedupes two findings with same file/line/near-identical message into one", () => {
    const findingA = makeFinding({
      file: "src/foo.ts",
      line: 10,
      message: "  Missing null check  ",
      ruleName: "rule-a",
      severity: "warning",
    });
    const findingB = makeFinding({
      file: "src/foo.ts",
      line: 10,
      message: "missing   null check",
      ruleName: "rule-b",
      severity: "warning",
    });

    const result = orchestrate(makeDispatchResult({ findings: [findingA, findingB] }));

    expect(result.findingsCount).toBe(1);
    const occurrences = (result.commentBody.match(/null check/gi) ?? []).length;
    expect(occurrences).toBe(1);
  });

  // AC-7.1 (severity preference): Given duplicate findings that differ only
  // in severity, When orchestrate runs, Then the higher-severity duplicate
  // is kept.
  it("AC-7.1: prefers the higher-severity duplicate when severities differ", () => {
    const warningFinding = makeFinding({
      file: "src/foo.ts",
      line: 10,
      message: "Missing null check",
      ruleName: "rule-a",
      severity: "warning",
    });
    const blockingFinding = makeFinding({
      file: "src/foo.ts",
      line: 10,
      message: "Missing null check",
      ruleName: "rule-b",
      severity: "blocking",
    });

    const result = orchestrate(
      makeDispatchResult({ findings: [warningFinding, blockingFinding] }),
    );

    expect(result.findingsCount).toBe(1);
    expect(result.commentBody).toMatch(/blocking/i);
    // The surviving finding should be listed under the Blocking section, not
    // Warning — assert no Warning heading is rendered at all since the only
    // warning-severity finding was deduped away.
    expect(result.commentBody).not.toMatch(/##\s*.*Warning/i);
  });

  it("AC-7.1: keeps findings with different file/line/message as distinct", () => {
    const findingA = makeFinding({ file: "src/foo.ts", line: 10, message: "Issue A" });
    const findingB = makeFinding({ file: "src/foo.ts", line: 11, message: "Issue B" });
    const findingC = makeFinding({ file: "src/bar.ts", line: 10, message: "Issue A" });

    const result = orchestrate(
      makeDispatchResult({ findings: [findingA, findingB, findingC] }),
    );

    expect(result.findingsCount).toBe(3);
  });

  // AC-7.2: Given findings of mixed severities, When orchestrate runs, Then
  // the commentBody presents blocking findings before warning before
  // suggestion (grouped, not interleaved).
  it("AC-7.2: renders severity groups in order blocking, warning, suggestion", () => {
    const suggestion = makeFinding({
      file: "src/a.ts",
      line: 1,
      message: "A suggestion",
      severity: "suggestion",
    });
    const blocking = makeFinding({
      file: "src/b.ts",
      line: 2,
      message: "A blocker",
      severity: "blocking",
    });
    const warning = makeFinding({
      file: "src/c.ts",
      line: 3,
      message: "A warning",
      severity: "warning",
    });

    const result = orchestrate(
      makeDispatchResult({ findings: [suggestion, blocking, warning] }),
    );

    const blockingIndex = result.commentBody.indexOf("A blocker");
    const warningIndex = result.commentBody.indexOf("A warning");
    const suggestionIndex = result.commentBody.indexOf("A suggestion");

    expect(blockingIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeGreaterThan(blockingIndex);
    expect(suggestionIndex).toBeGreaterThan(warningIndex);
  });

  // AC-7.2 (omit empty groups): Given findings of only one severity, When
  // orchestrate runs, Then no headings for the other (empty) severities
  // appear.
  it("AC-7.2: omits headings for severities with no findings", () => {
    const warning = makeFinding({ severity: "warning", message: "Only warning" });

    const result = orchestrate(makeDispatchResult({ findings: [warning] }));

    expect(result.commentBody).not.toMatch(/##\s*.*Blocking/i);
    expect(result.commentBody).not.toMatch(/##\s*.*Suggestion/i);
  });

  // AC-7.3: Given dispatchResult.rulesFailed is non-empty, When orchestrate
  // runs, Then the returned commentBody includes a visible note listing the
  // failed rule names.
  it("AC-7.3: includes a visible note listing failed rule names", () => {
    const result = orchestrate(
      makeDispatchResult({
        findings: [],
        rulesRun: ["rule-a"],
        rulesFailed: ["rule-b", "rule-c"],
      }),
    );

    expect(result.commentBody).toMatch(/rule-b/);
    expect(result.commentBody).toMatch(/rule-c/);
    // Must be "clearly visible" per the task spec — expect a warning marker.
    expect(result.commentBody).toMatch(/⚠️|failed/i);
    expect(result.rulesFailed).toEqual(["rule-b", "rule-c"]);
  });

  it("AC-7.3: failed-rules note appears even when there are findings too", () => {
    const finding = makeFinding({ severity: "blocking", message: "A real issue" });
    const result = orchestrate(
      makeDispatchResult({ findings: [finding], rulesFailed: ["broken-rule"] }),
    );

    expect(result.commentBody).toMatch(/broken-rule/);
    expect(result.commentBody).toMatch(/A real issue/);
  });

  // AC-7.4: Given dispatchResult.findings is empty and rulesFailed is empty,
  // When orchestrate runs, Then the commentBody states clearly that no
  // issues were found (not a blank/empty comment).
  it("AC-7.4: states clearly that no issues were found when findings and rulesFailed are both empty", () => {
    const result = orchestrate(
      makeDispatchResult({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
    );

    expect(result.commentBody.trim().length).toBeGreaterThan(0);
    expect(result.commentBody).toMatch(/no issues/i);
    expect(result.findingsCount).toBe(0);
  });

  // AC-7.4 (also true after dedup empties the list): Given findings that all
  // collapse into duplicates of ones already deduped away is not directly
  // testable since dedup never removes all findings unless the input was
  // already empty; this test instead confirms the empty-input case
  // explicitly starts from an empty array (post-dedup state) rather than
  // relying on incidental behavior.
  it("AC-7.4: does not render a blank comment when there is nothing to report", () => {
    const result = orchestrate(makeDispatchResult());

    expect(result.commentBody).not.toBe("");
    expect(result.commentBody.trim()).not.toBe("");
  });

  // A file-level finding with no specific line (e.g. "this file is
  // missing a license header") has no exercised test coverage: every
  // existing makeFinding() call sets a concrete `line`. renderFinding's
  // `line === undefined` branch renders "general" instead of "L<n>", and
  // dedupeKey's `finding.line ?? null` must handle it without crashing
  // JSON.stringify (it doesn't — `undefined` is a perfectly valid input to
  // the nullish-coalescing operator — but this pins that explicitly).
  it("renders the 'general' placeholder (not a line number) for a finding with no line, and does not crash", () => {
    const generalFinding = makeFinding({
      file: "src/foo.ts",
      line: undefined,
      message: "Missing license header",
      severity: "warning",
    });

    const result = orchestrate(makeDispatchResult({ findings: [generalFinding] }));

    expect(result.findingsCount).toBe(1);
    expect(result.commentBody).toContain("**[general]**");
    expect(result.commentBody).not.toMatch(/\[L(undefined|null)\]/);
    expect(result.commentBody).toContain("Missing license header");
  });

  // Same, but with `line` explicitly set to `null` (as opposed to simply
  // omitted) — the two are handled by the same `!== undefined && !== null`
  // check in renderFinding, and dedupeKey's `?? null` should treat both
  // identically for dedup purposes.
  it("renders the 'general' placeholder for a finding with line explicitly set to null", () => {
    const generalFinding = makeFinding({
      file: "src/bar.ts",
      line: null as unknown as number,
      message: "File-level issue",
      severity: "suggestion",
    });

    const result = orchestrate(makeDispatchResult({ findings: [generalFinding] }));

    expect(result.findingsCount).toBe(1);
    expect(result.commentBody).toContain("**[general]**");
    expect(result.commentBody).toContain("File-level issue");
  });

  it("passes rulesRun and rulesFailed through unchanged from the input dispatchResult", () => {
    const result = orchestrate(
      makeDispatchResult({ rulesRun: ["a", "b"], rulesFailed: ["c"] }),
    );

    expect(result.rulesRun).toEqual(["a", "b"]);
    expect(result.rulesFailed).toEqual(["c"]);
  });
});

// Smoke-test finding (fresh clone, zero-config run against a live PR): the
// built-in rule failed and the comment said only "rules failed to run and were
// skipped" — with NO reason, anywhere. The actual cause (no anthropic API key on
// that machine) was captured in the subagent's result and then thrown away. That
// is the same diagnosability hole as issue #1, one layer down.
describe("failed rules carry a reason (smoke-test finding)", () => {
  it("renders the reason next to each failed rule when one is available", () => {
    const result = orchestrate({
      findings: [],
      rulesRun: [],
      rulesFailed: ["tgd-review"],
      ruleFailureReasons: { "tgd-review": "no working credentials for provider `anthropic`" },
    });

    expect(result.commentBody).toContain("### ⚠️ Rules that failed");
    expect(result.commentBody).toContain("tgd-review");
    // The whole point: a maintainer reading the comment learns something actionable.
    expect(result.commentBody).toMatch(/no working credentials for provider `anthropic`/);
  });

  it("still renders cleanly when a reason is missing (never prints 'undefined')", () => {
    const result = orchestrate({
      findings: [],
      rulesRun: [],
      rulesFailed: ["rule-a", "rule-b"],
      ruleFailureReasons: { "rule-a": "timed out" },
    });

    expect(result.commentBody).toMatch(/rule-a.*timed out/);
    expect(result.commentBody).toContain("rule-b");
    expect(result.commentBody).not.toMatch(/undefined/);
  });

  it("is backward compatible: no ruleFailureReasons at all still renders the old bare list", () => {
    const result = orchestrate({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });

    expect(result.commentBody).toContain("- rule-a");
    expect(result.commentBody).not.toMatch(/undefined/);
  });
});
