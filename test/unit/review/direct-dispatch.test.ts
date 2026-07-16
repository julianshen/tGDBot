// Tests for the DIRECT dispatch engine (design-review P0): one session per
// rule, deterministic TypeScript merge, advisor as a discrete bounded step.
// Sessions are injected stubs throughout — the real factories are the only
// SDK touchers and are exercised live, not here (same testing stance as the
// legacy engine's injectable createSession).
import { describe, expect, it, vi } from "vitest";
import { dispatchRulesDirect, parseAdvisorDropList } from "../../../src/review/direct-dispatch.js";
import type { DirectSessionFactory } from "../../../src/review/direct-dispatch.js";
import type { DispatchSession } from "../../../src/review/dispatch.js";
import type { RuleDefinition } from "../../../src/rules/types.js";

function makeRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: "rule-a",
    provider: "anthropic",
    model: "claude-opus-4-5",
    body: "Check for bugs.",
    sourcePath: "/rules/rule-a.md",
    ...overrides,
  };
}

const finding = (file: string, message: string) => ({
  file,
  line: 1,
  severity: "warning",
  category: "correctness",
  message,
});

// A factory that answers each rule by name; prompts are recorded per rule.
function makeFactory(outputs: Record<string, string | Error>): {
  factory: DirectSessionFactory;
  prompts: Record<string, string>;
} {
  const prompts: Record<string, string> = {};
  const factory: DirectSessionFactory = async (rule) => {
    const out = outputs[rule.name];
    if (out instanceof Error) throw out;
    const session: DispatchSession = {
      async prompt(text: string) {
        prompts[rule.name] = text;
      },
      getLastAssistantText: () => out,
    };
    return session;
  };
  return { factory, prompts };
}

describe("dispatchRulesDirect", () => {
  it("runs one session per rule and merges findings deterministically, stamped by construction", async () => {
    const { factory, prompts } = makeFactory({
      "rule-a": JSON.stringify([finding("a.ts", "bug in a")]),
      "rule-b": JSON.stringify([finding("b.ts", "bug in b")]),
    });

    const result = await dispatchRulesDirect(
      [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b", provider: "xai", model: "grok-4.5" })],
      "the-diff",
      false,
      { createSession: factory },
    );

    expect(result.rulesRun).toEqual(["rule-a", "rule-b"]);
    expect(result.rulesFailed).toEqual([]);
    // Attribution is by construction — each finding carries its own rule's name.
    expect(result.findings).toEqual([
      expect.objectContaining({ file: "a.ts", ruleName: "rule-a" }),
      expect.objectContaining({ file: "b.ts", ruleName: "rule-b" }),
    ]);
    // Each session got ITS rule's task text, diff embedded.
    expect(prompts["rule-a"]).toContain("the-diff");
    expect(prompts["rule-b"]).toContain("the-diff");
  });

  it("an empty array is a SUCCESS (the rule ran and found nothing)", async () => {
    const { factory } = makeFactory({ "rule-a": "[]" });

    const result = await dispatchRulesDirect([makeRule()], "diff", false, {
      createSession: factory,
    });

    expect(result.rulesRun).toEqual(["rule-a"]);
    expect(result.rulesFailed).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("one rule's failure never takes down the others — classified reason, raw error to logs", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { factory } = makeFactory({
        "rule-a": new Error("No API key found for provider anthropic"),
        "rule-b": JSON.stringify([finding("b.ts", "bug in b")]),
      });

      const result = await dispatchRulesDirect(
        [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b", provider: "xai", model: "grok-4.5" })],
        "diff",
        false,
        { createSession: factory },
      );

      expect(result.rulesRun).toEqual(["rule-b"]);
      expect(result.rulesFailed).toEqual(["rule-a"]);
      // Publish-safe classification, not the raw provider error.
      expect(result.ruleFailureReasons?.["rule-a"]).toContain("no working credentials");
      expect(result.findings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("unparseable reviewer output fails THAT rule with a clear reason", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { factory } = makeFactory({ "rule-a": "I reviewed everything and it looks great!" });

      const result = await dispatchRulesDirect([makeRule()], "diff", false, {
        createSession: factory,
      });

      expect(result.rulesRun).toEqual([]);
      expect(result.rulesFailed).toEqual(["rule-a"]);
      expect(result.ruleFailureReasons?.["rule-a"]).toContain("no parseable findings");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never throws: a factory that explodes for every rule degrades to all-failed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await dispatchRulesDirect([makeRule()], "diff", false, {
        createSession: async () => {
          throw new Error("catastrophe");
        },
      });

      expect(result.rulesRun).toEqual([]);
      expect(result.rulesFailed).toEqual(["rule-a"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe("advisor pass (discrete, bounded, best-effort)", () => {
    const twoFindings = JSON.stringify([finding("a.ts", "real bug"), finding("a.ts", "maybe fp")]);

    it("drops exactly the advisor's drop-list indices", async () => {
      const { factory } = makeFactory({ "rule-a": twoFindings });
      const advisorPrompts: string[] = [];

      const result = await dispatchRulesDirect([makeRule()], "diff", true, {
        createSession: factory,
        createAdvisorSession: async () => ({
          async prompt(text: string) {
            advisorPrompts.push(text);
          },
          getLastAssistantText: () => '{"drop": [1]}',
        }),
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].message).toBe("real bug");
      // The advisor saw the COMPLETE merged set, with indices.
      expect(advisorPrompts[0]).toContain("real bug");
      expect(advisorPrompts[0]).toContain("maybe fp");
      // Accounting untouched by filtering — the rule still ran.
      expect(result.rulesRun).toEqual(["rule-a"]);
    });

    it("keeps ALL findings (and warns) when the advisor fails or answers garbage", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { factory } = makeFactory({ "rule-a": twoFindings });

        const failed = await dispatchRulesDirect([makeRule()], "diff", true, {
          createSession: factory,
          createAdvisorSession: async () => {
            throw new Error("advisor unavailable");
          },
        });
        expect(failed.findings).toHaveLength(2);

        const { factory: factory2 } = makeFactory({ "rule-a": twoFindings });
        const garbage = await dispatchRulesDirect([makeRule()], "diff", true, {
          createSession: factory2,
          createAdvisorSession: async () => ({
            async prompt() {},
            getLastAssistantText: () => "sure, they all look fine to me",
          }),
        });
        expect(garbage.findings).toHaveLength(2);

        const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warned).toContain("advisor");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("skips the advisor entirely when there are no findings or advisor is off", async () => {
      const advisorFactory = vi.fn();

      const { factory } = makeFactory({ "rule-a": "[]" });
      await dispatchRulesDirect([makeRule()], "diff", true, {
        createSession: factory,
        createAdvisorSession: advisorFactory,
      });

      const { factory: factory2 } = makeFactory({ "rule-a": twoFindings });
      await dispatchRulesDirect([makeRule()], "diff", false, {
        createSession: factory2,
        createAdvisorSession: advisorFactory,
      });

      expect(advisorFactory).not.toHaveBeenCalled();
    });
  });

  it("does NOT mutate PI_CODING_AGENT_DIR (no hermetic-agent-dir games in direct mode)", async () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    const { factory } = makeFactory({ "rule-a": "[]" });

    await dispatchRulesDirect([makeRule()], "diff", false, { createSession: factory });

    expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
  });
});

describe("parseAdvisorDropList", () => {
  it("parses a clean drop object", () => {
    expect(parseAdvisorDropList('{"drop": [0, 2]}')).toEqual([0, 2]);
  });

  it("tolerates surrounding prose", () => {
    expect(parseAdvisorDropList('After review: {"drop": [1]} — done.')).toEqual([1]);
  });

  it("returns undefined for garbage, non-integer entries, or missing text", () => {
    expect(parseAdvisorDropList(undefined)).toBeUndefined();
    expect(parseAdvisorDropList("all good")).toBeUndefined();
    expect(parseAdvisorDropList('{"drop": ["a"]}')).toBeUndefined();
  });
});
