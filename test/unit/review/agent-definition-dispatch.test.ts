// Issue #138 phase 2: the direct engine resolves an agent definition from
// the rule's `agent` frontmatter field and uses the definition's tool
// allowlist and system prompt at session spawn.
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dispatchRulesDirect, type DirectSessionFactory } from "../../../src/review/direct-dispatch.js";
import type { RuleDefinition } from "../../../src/rules/types.js";
import type { AgentDefinition } from "../../../src/review/agent-definition.js";
import type { EffectiveRule } from "../../../src/rules/types.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: "rule-a",
    provider: "anthropic",
    model: "claude-opus-4-5",
    dependsOn: [],
    body: "Check for bugs.",
    sourcePath: "/rules/rule-a.md",
    ...overrides,
  };
}

const baseDefs: AgentDefinition[] = [
  { name: "docs-reviewer", tools: ["read"], body: "Focus on documentation.", delegate: false, sourcePath: "/agents/docs.agent.md" },
];

describe("dispatchRulesDirect — agent definitions (#138 phase 2)", () => {
  it("passes the resolved definition (narrow tools) into createSession", async () => {
    const captured: { rule: EffectiveRule; definition?: AgentDefinition }[] = [];
    const createSession: DirectSessionFactory = async (rule, _cwd, _outputDir, definition) => {
      captured.push({ rule, definition });
      return { async prompt() {}, getLastAssistantText: () => "[]" };
    };

    const result = await dispatchRulesDirect(
      { rules: [makeRule({ name: "rule-a", agent: "docs-reviewer" })], diff: "diff", useAdvisor: false },
      { createSession, agentDefinitions: baseDefs },
    );

    expect(result.rulesRun).toEqual(["rule-a"]);
    expect(captured[0]?.definition?.tools).toEqual(["read"]);
    expect(captured[0]?.definition?.body).toBe("Focus on documentation.");
  });

  it("passes no definition when no agent reference is present", async () => {
    let capturedDefinition: AgentDefinition | undefined | "unset" = "unset";
    const createSession: DirectSessionFactory = async (_rule, _cwd, _outputDir, definition) => {
      capturedDefinition = definition;
      return { async prompt() {}, getLastAssistantText: () => "[]" };
    };

    await dispatchRulesDirect(
      { rules: [makeRule({ name: "rule-a" })], diff: "diff", useAdvisor: false },
      { createSession, agentDefinitions: baseDefs },
    );

    expect(capturedDefinition).toBeUndefined();
  });

  it("warns and passes no definition when the rule references an unknown definition", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedDefinition: AgentDefinition | undefined | "unset" = "unset";
    const createSession: DirectSessionFactory = async (_rule, _cwd, _outputDir, definition) => {
      capturedDefinition = definition;
      return { async prompt() {}, getLastAssistantText: () => "[]" };
    };

    try {
      const result = await dispatchRulesDirect(
        { rules: [makeRule({ name: "rule-a", agent: "nonexistent" })], diff: "diff", useAdvisor: false },
        { createSession, agentDefinitions: baseDefs },
      );

      expect(result.rulesRun).toEqual(["rule-a"]);
      expect(capturedDefinition).toBeUndefined();
      expect(warnSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/unknown agent definition "nonexistent"/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("passes the definition's openai/gpt-4.1-mini pin through to createSession", async () => {
    let capturedDefinition: AgentDefinition | undefined;
    const createSession: DirectSessionFactory = async (_rule, _cwd, _outputDir, definition) => {
      capturedDefinition = definition;
      return { async prompt() {}, getLastAssistantText: () => "[]" };
    };

    const modelDefs: AgentDefinition[] = [
      { name: "cheap-reviewer", tools: ["read"], provider: "openai", model: "gpt-4.1-mini", body: "", delegate: false, sourcePath: "/c.md" },
    ];

    await dispatchRulesDirect(
      { rules: [makeRule({ name: "rule-a", agent: "cheap-reviewer" })], diff: "diff", useAdvisor: false },
      { createSession, agentDefinitions: modelDefs },
    );

    expect(capturedDefinition?.provider).toBe("openai");
    expect(capturedDefinition?.model).toBe("gpt-4.1-mini");
  });

  it("resolves definitions from ReviewDispatchInput when deps omit them", async () => {
    const captured: { definition?: AgentDefinition }[] = [];
    const createSession: DirectSessionFactory = async (_rule, _cwd, _outputDir, definition) => {
      captured.push({ definition });
      return { async prompt() {}, getLastAssistantText: () => "[]" };
    };

    const result = await dispatchRulesDirect(
      {
        rules: [makeRule({ name: "rule-a", agent: "docs-reviewer" })],
        diff: "diff",
        useAdvisor: false,
        agentDefinitions: baseDefs,
      },
      { createSession },
    );

    expect(result.rulesRun).toEqual(["rule-a"]);
    expect(captured[0]?.definition?.tools).toEqual(["read"]);
  });
});
