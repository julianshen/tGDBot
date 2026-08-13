import { describe, expect, it } from "vitest";
import { selectClarification } from "../../../src/conversation/clarification.js";
import type { Finding } from "../../../src/review/types.js";

function finding(overrides: Partial<Finding> & Pick<Finding, "message">): Finding {
  return {
    file: "src/a.ts",
    line: 4,
    severity: "warning",
    category: "correctness",
    ruleName: "rule-a",
    decision: "needs-clarification",
    question: overrides.message,
    ...overrides,
  };
}

const BINDING = {
  repositoryDigest: "a".repeat(64),
  reviewNumber: 7,
  headSha: "c".repeat(40),
};

describe("selectClarification", () => {
  it("selects nothing when there is no clarification candidate", () => {
    expect(selectClarification({
      ...BINDING,
      findings: [finding({ message: "bug", decision: "new", question: undefined })],
    })).toEqual({ deferredCount: 0 });
  });

  it("selects by workflow/rule order, then original finding order", () => {
    const findings = [
      finding({ ruleName: "later", message: "later first", question: "Later first?" }),
      finding({ ruleName: "earlier", message: "earlier second", question: "Earlier second?" }),
      finding({ ruleName: "earlier", message: "earlier first", question: "Earlier first?" }),
      finding({ ruleName: "later", message: "later second", question: "Later second?" }),
    ];

    const selected = selectClarification({
      ...BINDING,
      findings,
      ruleOrder: ["earlier", "later"],
    });

    expect(selected.selected?.question).toBe("Earlier second?");
    expect(selected.selected?.finding.message).toBe("earlier second");
    expect(selected.deferredCount).toBe(3);
  });

  it("creates a deterministic clar_ id bound to the review/head snapshot", () => {
    const candidate = finding({ question: "Is this intended?", message: "unclear" });
    const first = selectClarification({ ...BINDING, findings: [candidate] });
    const again = selectClarification({ ...BINDING, findings: [candidate] });
    const otherHead = selectClarification({
      ...BINDING,
      headSha: "d".repeat(40),
      findings: [candidate],
    });

    expect(first.selected?.id).toMatch(/^clar_[0-9a-f]{32}$/);
    expect(again.selected?.id).toBe(first.selected?.id);
    expect(otherHead.selected?.id).not.toBe(first.selected?.id);
    expect(first.deferredCount).toBe(0);
  });

  it("enforces one active clarification and returns only a deferred count", () => {
    const result = selectClarification({
      ...BINDING,
      findings: [
        finding({ question: "First?", message: "first" }),
        finding({ question: "Second?", message: "second" }),
      ],
    });

    expect(result.selected?.question).toBe("First?");
    expect(result.deferredCount).toBe(1);
    expect(result).not.toHaveProperty("deferred");
    expect(result).not.toHaveProperty("candidates");
  });
});
