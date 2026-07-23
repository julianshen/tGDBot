import { describe, expect, it } from "vitest";
import type { RuleDefinition } from "../../../src/rules/types.js";
import {
  planReviewWorkflow,
  ReviewWorkflowError,
} from "../../../src/review/workflow.js";

function rule(
  name: string,
  dependsOn: readonly string[] = [],
  parallelGroup?: string,
): RuleDefinition {
  return {
    name,
    dependsOn,
    ...(parallelGroup === undefined ? {} : { parallelGroup }),
    body: `Review as ${name}.`,
    sourcePath: `/rules/${name}.md`,
  };
}

describe("planReviewWorkflow", () => {
  it("places ungrouped independent rules in sequential input-order waves", () => {
    expect(planReviewWorkflow([rule("a"), rule("b"), rule("c")])).toEqual({
      waves: [
        { ruleNames: ["a"] },
        { ruleNames: ["b"] },
        { ruleNames: ["c"] },
      ],
    });
  });

  it("groups all currently ready same-group rules while preserving input order", () => {
    expect(
      planReviewWorkflow([
        rule("foundation"),
        rule("security-b", ["foundation"], "security"),
        rule("unrelated"),
        rule("security-a", ["foundation"], "security"),
        rule("after-security", ["security-a"]),
      ]),
    ).toEqual({
      waves: [
        { ruleNames: ["foundation"] },
        { ruleNames: ["security-b", "security-a"], parallelGroup: "security" },
        { ruleNames: ["unrelated"] },
        { ruleNames: ["after-security"] },
      ],
    });
  });

  it("returns deeply frozen deterministic snapshots without mutating input", () => {
    const dependencies = ["a"];
    const rules = [rule("a"), rule("b", dependencies)];
    const before = structuredClone(rules);

    const first = planReviewWorkflow(rules);
    const second = planReviewWorkflow(rules);
    expect(rules).toEqual(before);
    dependencies.push("later-mutation");

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.waves)).toBe(true);
    expect(first.waves.every(Object.isFrozen)).toBe(true);
    expect(first.waves.every((wave) => Object.isFrozen(wave.ruleNames))).toBe(true);
  });

  it("supports an empty rule list", () => {
    expect(planReviewWorkflow([])).toEqual({ waves: [] });
  });

  it.each([
    ["duplicate rule names", [rule("a"), rule("a")]],
    ["an unknown dependency", [rule("a", ["missing"])]],
    ["a self dependency", [rule("a", ["a"])]],
    ["duplicate dependencies", [rule("a"), rule("b", ["a", "a"])]],
    ["a cycle", [rule("a", ["b"]), rule("b", ["a"])]],
  ])("rejects %s", (_label, rules) => {
    expect(() => planReviewWorkflow(rules)).toThrow(ReviewWorkflowError);
  });
});
