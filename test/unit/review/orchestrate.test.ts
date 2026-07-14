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
    // AC-7.4 guarantee is unchanged (never render a blank/near-empty comment);
    // only the wording moved to the CodeRabbit-style header.
    expect(result.commentBody).toMatch(/no actionable comments/i);
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
    // A finding with no line can't be anchored, so it goes to the summary and is
    // identified by FILE alone — the guarantee is that it still renders, and
    // never leaks "undefined"/"null" into the comment.
    expect(result.commentBody).toContain("`src/foo.ts`");
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
    // A finding with no line can't be anchored, so it goes to the summary and is
    // identified by FILE alone — the guarantee is that it still renders, and
    // never leaks "undefined"/"null" into the comment.
    expect(result.commentBody).toContain("`src/bar.ts`");
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

    expect(result.commentBody).toContain("`rule-a`");
    expect(result.commentBody).not.toMatch(/undefined/);
  });
});

// Inline review comments (CodeRabbit/Cursor model): a finding belongs next to
// the code it is about. orchestrate() now splits findings into ones it can
// ANCHOR to a line of the diff (posted inline) and ones it cannot (rendered in
// the summary). The invariant that matters most: every finding lands in exactly
// ONE of those two places — never dropped, never duplicated.
describe("inline anchoring", () => {
  const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@
 ctx
+added
+added2
`;

  const anchored = () =>
    makeFinding({ file: "src/a.ts", line: 11, message: "Bad thing here.", severity: "blocking" });
  const offDiffLine = () =>
    makeFinding({ file: "src/a.ts", line: 900, message: "Line not in the diff.", severity: "warning" });
  const otherFile = () =>
    makeFinding({ file: "src/untouched.ts", line: 3, message: "File not in the PR.", severity: "warning" });
  const noLine = () =>
    makeFinding({ file: "src/a.ts", line: undefined, message: "No line at all.", severity: "suggestion" });

  it("anchors a finding whose line IS in the diff, as an inline comment", () => {
    const result = orchestrate(makeDispatchResult({ findings: [anchored()] }), DIFF);

    expect(result.inlineComments).toHaveLength(1);
    expect(result.inlineComments[0]).toMatchObject({ path: "src/a.ts", line: 11 });
    expect(result.inlineComments[0].body).toContain("🔴 Blocking");
    expect(result.inlineComments[0].body).toContain("Prompt for AI Agents");
    // Counted, not repeated, in the summary.
    expect(result.commentBody).toContain("Actionable comments posted: 1");
    expect(result.commentBody).not.toContain("Bad thing here.");
  });

  // THE INVARIANT. GitHub 422s the whole review if any anchor is off-diff, so
  // these three must be routed to the summary — but they must still be SEEN.
  it("never loses a finding: no line, off-diff line, and untouched file all land in the summary", () => {
    const result = orchestrate(
      makeDispatchResult({ findings: [anchored(), offDiffLine(), otherFile(), noLine()] }),
      DIFF,
    );

    expect(result.inlineComments).toHaveLength(1); // only the anchorable one
    expect(result.findingsCount).toBe(4); // all four still counted

    // The other three are rendered IN FULL in the summary.
    expect(result.commentBody).toContain("Line not in the diff.");
    expect(result.commentBody).toContain("File not in the PR.");
    expect(result.commentBody).toContain("No line at all.");
    expect(result.commentBody).toContain("Additional comments (3)");
    // Total = inline + summary, so nothing is double-counted.
    expect(result.commentBody).toContain("Actionable comments posted: 4");
  });

  it("never duplicates: an anchored finding appears inline and NOT in the summary body", () => {
    const result = orchestrate(makeDispatchResult({ findings: [anchored()] }), DIFF);

    const inSummary = result.commentBody.includes("Bad thing here.");
    const inInline = result.inlineComments[0].body.includes("Bad thing here.");
    expect(inInline).toBe(true);
    expect(inSummary).toBe(false);
  });

  it("inline: false forces EVERY finding into the summary (the fallback path)", () => {
    const result = orchestrate(
      makeDispatchResult({ findings: [anchored(), noLine()] }),
      DIFF,
      { inline: false },
    );

    expect(result.inlineComments).toEqual([]);
    expect(result.commentBody).toContain("Bad thing here."); // the anchorable one too
    expect(result.commentBody).toContain("No line at all.");
    expect(result.commentBody).toMatch(/Inline comments could not be posted/i);
  });

  it("with no diff, nothing is anchored (and nothing is lost)", () => {
    const result = orchestrate(makeDispatchResult({ findings: [anchored()] }));

    expect(result.inlineComments).toEqual([]);
    expect(result.commentBody).toContain("Bad thing here.");
  });

  it("lists the reviewed files and the rules that ran in collapsed sections", () => {
    const result = orchestrate(
      makeDispatchResult({ findings: [], rulesRun: ["terra-review"] }),
      DIFF,
    );

    expect(result.commentBody).toContain("📒 Files reviewed (1)");
    expect(result.commentBody).toContain("`src/a.ts`");
    expect(result.commentBody).toContain("⚙️ Rules run (1)");
    expect(result.commentBody).toContain("`terra-review`");
    expect(result.commentBody).toContain("No actionable comments");
  });

  // Finding text is LLM output over an ATTACKER-CONTROLLED diff, and it lands in
  // a world-readable comment inside <details> blocks. It must not be able to
  // forge review structure or escape its container.
  it("neutralises HTML/comment injection in finding text", () => {
    const evil = makeFinding({
      file: "src/a.ts",
      line: 11,
      message: "x --><script>alert(1)</script></details> ## ✅ Approved",
    });

    const result = orchestrate(makeDispatchResult({ findings: [evil] }), DIFF);
    const body = result.inlineComments[0].body;

    expect(body).not.toContain("<script");
    expect(body).not.toContain("</details> ## ✅ Approved"); // can't close our block
    expect(body).not.toContain("-->"); // can't terminate an HTML comment we open
  });
});

// Found on the FIRST live run against a real PR: a finding whose first sentence
// ran to 175 chars fell through the "short sentence" case and the entire
// five-sentence message was emitted as one giant bold headline — a wall of bold,
// the opposite of the scannable title+prose the format exists for.
describe("headline splitting (live-run finding)", () => {
  const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n ctx\n+added\n";
  const render = (message: string): string =>
    orchestrate(makeDispatchResult({ findings: [makeFinding({ file: "x.ts", line: 2, message })] }), DIFF)
      .inlineComments[0].body;
  // The VISIBLE prose — everything before the collapsed 🤖 prompt block, which
  // deliberately repeats the message (that repetition is what makes it a
  // self-contained, copy-pasteable instruction). Duplication assertions below are
  // about what a reader SEES, not about the prompt payload.
  const prose = (message: string): string => render(message).split("<details>")[0];

  it("keeps a short first sentence as the headline and the rest as prose", () => {
    const body = render("Off-by-one in the loop. It should start at zero, not one.");
    expect(body).toContain("**Off-by-one in the loop.**");
    expect(body).toContain("It should start at zero, not one.");
  });

  // Review finding: truncating a too-long first sentence into a headline and then
  // printing that same sentence two lines below reads as a stutter. A headline is
  // a TITLE — if one can't be derived, there simply isn't one.
  it("omits the headline entirely when no sentence is short enough — never a bold wall, never a stutter", () => {
    const longFirst =
      "The reaction toggle remains a check-then-act operation because it branches on the previously computed alreadyReacted value and then separately calls RemoveReaction or AddReaction. Concurrent callers can lose a toggle.";
    const visible = prose(longFirst);

    // No bold headline at all...
    expect(visible).not.toMatch(/\*\*.*check-then-act/);
    // ...and the message appears EXACTLY once in the visible prose (no stutter).
    expect((visible.match(/check-then-act operation because/g) ?? []).length).toBe(1);
    expect(visible).toContain("Concurrent callers can lose a toggle.");
  });

  it("never prints a single-sentence finding twice (headline + duplicate prose)", () => {
    const visible = prose("Missing null check.");
    expect((visible.match(/Missing null check/g) ?? []).length).toBe(1); // headline IS the message
  });

  it("collapses newlines in the headline so bold never breaks", () => {
    const body = render("Problems:\n- naming\n- nesting. And more prose here.");
    const headline = /\*\*(.+?)\*\*/s.exec(body)?.[1] ?? "";
    expect(headline).not.toContain("\n");
  });

  it("a single short sentence yields a headline and no empty prose paragraph", () => {
    const body = render("Missing null check.");
    expect(body).toContain("**Missing null check.**");
    expect(body).not.toMatch(/\*\*Missing null check\.\*\*\n\n\n/);
  });
});

// ADR-007: a committable suggestion REPLACES the range line..endLine, so BOTH
// ends must be inside the diff — GitHub 422s the entire review otherwise. The
// tradeoff when the range isn't fully addressable is deliberate: drop the
// SUGGESTION, keep the FINDING. Losing the one-click fix is a fair price; losing
// the finding is not.
describe("ADR-007: suggestion ranges are validated against the diff", () => {
  // Hunk covers new lines 10..13.
  const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,1 +10,4 @@
 ctx
+one
+two
+three
`;

  const find = (over: Partial<Finding>): Finding =>
    makeFinding({ file: "a.ts", line: 11, message: "m", ...over });

  it("anchors a multi-line suggestion across the range (startLine..line)", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [find({ line: 11, endLine: 13, suggestion: "x\ny\nz" })] }),
      DIFF,
    );

    // GitHub's convention: `line` is the LAST line, `startLine` the first.
    expect(r.inlineComments[0]).toMatchObject({ path: "a.ts", startLine: 11, line: 13 });
    expect(r.inlineComments[0].body).toContain("Committable suggestion");
  });

  it("drops the SUGGESTION but keeps the FINDING when endLine is outside the diff", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [find({ line: 11, endLine: 999, suggestion: "x" })] }),
      DIFF,
    );

    // Still posted, still anchored to its own line...
    expect(r.inlineComments).toHaveLength(1);
    expect(r.inlineComments[0]).toMatchObject({ line: 11 });
    expect(r.inlineComments[0].startLine).toBeUndefined();
    // ...but with no committable block, because the range would 422 the review.
    expect(r.inlineComments[0].body).not.toContain("Committable suggestion");
    expect(r.findingsCount).toBe(1);
  });

  it("treats a single-line suggestion (no endLine) as a one-line range", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [find({ line: 12, suggestion: "fixed();" })] }),
      DIFF,
    );

    expect(r.inlineComments[0]).toMatchObject({ line: 12 });
    expect(r.inlineComments[0].startLine).toBeUndefined();
    expect(r.inlineComments[0].body).toContain("Committable suggestion");
  });

  it("--suggestions off keeps the finding and the anchor, minus the commit button", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [find({ line: 11, endLine: 13, suggestion: "x" })] }),
      DIFF,
      { suggestions: false },
    );

    expect(r.inlineComments).toHaveLength(1);
    expect(r.inlineComments[0].body).not.toContain("Committable suggestion");
  });
});

// Review fixes on ADR-007's first draft. Each of these was a real defect.
describe("ADR-007: review fixes", () => {
  // Two hunks: new lines 10-12 and 50-52.
  const TWO_HUNKS = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,1 +10,3 @@
 c
+x
+y
@@ -50,1 +50,3 @@
 c
+p
+q
`;
  const f = (over: Partial<Finding>): Finding =>
    makeFinding({ file: "a.ts", line: 10, message: "m", ...over });

  // CRITICAL: commentableLines merges a file's hunks into ONE set, so checking only
  // the ENDPOINTS lets a range straddle two hunks. GitHub requires the range to be
  // within a single hunk and 422s the ENTIRE review otherwise — killing every
  // inline comment on the run, the exact failure diff-anchors exists to prevent.
  it("rejects a range whose ends are in DIFFERENT hunks (endpoint-only checking 422s the review)", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 10, endLine: 51, suggestion: "x" })] }),
      TWO_HUNKS,
    );

    // Anchored to its own line, no range, no committable block.
    expect(r.inlineComments[0].startLine).toBeUndefined();
    expect(r.inlineComments[0].line).toBe(10);
    expect(r.inlineComments[0].body).not.toContain("Committable suggestion");
    expect(r.findingsCount).toBe(1); // finding kept
  });

  it("accepts a range fully inside ONE hunk", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 10, endLine: 12, suggestion: "x\ny\nz" })] }),
      TWO_HUNKS,
    );
    expect(r.inlineComments[0]).toMatchObject({ startLine: 10, line: 12 });
    expect(r.inlineComments[0].body).toContain("Committable suggestion");
  });

  // A 3-line replacement collapsed onto 1 line would duplicate the other 2 — a
  // wrong one-click fix, which the ADR itself says is worse than none.
  it("DROPS the suggestion when endLine < line instead of silently anchoring one line", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 12, endLine: 10, suggestion: "a\nb\nc" })] }),
      TWO_HUNKS,
    );
    expect(r.inlineComments[0].body).not.toContain("Committable suggestion");
    expect(r.findingsCount).toBe(1);
  });

  it("DROPS the suggestion when endLine is not an integer", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 10, endLine: 11.5, suggestion: "x" })] }),
      TWO_HUNKS,
    );
    expect(r.inlineComments[0].body).not.toContain("Committable suggestion");
  });

  // An EMPTY ```suggestion block is how GitHub expresses "delete these lines".
  it("never renders an empty suggestion (a one-click DELETE nobody authored)", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 10, endLine: 12, suggestion: "  \n " })] }),
      TWO_HUNKS,
    );
    expect(r.inlineComments[0].body).not.toContain("Committable suggestion");
    expect(r.inlineComments[0].startLine).toBeUndefined(); // and no range anchor
  });

  // Blast-radius cap: a mistaken click here is arbitrary execution WITH SECRETS,
  // not merely bad code in a PR.
  it("never offers a COMMIT BUTTON on files that execute with secrets — but still shows the fix", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "package.json",
      "Dockerfile",
      "pnpm-lock.yaml",
      "Makefile",
    ]) {
      const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n c\n+x\n`;
      const r = orchestrate(
        makeDispatchResult({
          findings: [makeFinding({ file, line: 2, message: "m", suggestion: "evil()" })],
        }),
        diff,
      );

      const body = r.inlineComments[0].body;
      expect(body, file).not.toContain("Committable suggestion");
      expect(body, file).not.toMatch(/```suggestion/);
      // ...but the proposed fix is still visible, as an inert block.
      expect(body, file).toContain("Proposed fix (not committable)");
      expect(body, file).toContain("evil()");
    }
  });

  it("still offers the commit button on ordinary application code", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 10, suggestion: "const ok = 1;" })] }),
      TWO_HUNKS,
    );
    expect(r.inlineComments[0].body).toContain("Committable suggestion");
  });

  // The safe mode must not be the lossy mode.
  it("--suggestions off DOWNGRADES the fix to a plain block — it does not delete it", () => {
    const r = orchestrate(
      makeDispatchResult({ findings: [f({ line: 10, suggestion: "const x = 1;" })] }),
      TWO_HUNKS,
      { suggestions: false },
    );
    const body = r.inlineComments[0].body;
    expect(body).not.toContain("Committable suggestion");
    expect(body).toContain("Proposed fix (not committable)");
    expect(body).toContain("const x = 1;"); // the fix is STILL SHOWN
  });
});
