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
  return { findings: [], rulesRun: [], rulesFailed: [], ...overrides };
}

describe("probe", () => {
  it("no match", () => {
    const DIFF = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,1 +10,3 @@",
      " ctx",
      "+added",
      "+added2",
      "",
    ].join("\n");
    const result = orchestrate(
      makeDispatchResult({
        findings: [
          makeFinding({
            file: "src/a.ts",
            line: 11,
            severity: "blocking",
            existingCode: "not in this diff at all",
          }),
        ],
      }),
      DIFF,
    );
    console.log("PROBE BODY FULL:", JSON.stringify(result.commentBody));
    console.log("PROBE INLINE:", JSON.stringify(result.inlineComments));
    expect(true).toBe(true);
  });
});
