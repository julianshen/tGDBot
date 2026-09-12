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

// Issue #139's review turned up a defect in #138's merged code: a persona
// narrowing its tools produced a delegated child with no way to report.
describe("a delegated child can always report", () => {
  it("gets submit_findings even when the persona narrowed its tools", async () => {
    // `tools: read, grep` is the configuration the README teaches. The child
    // path has no assistant-text fallback by design, so a child without the
    // reporting tool returned nothing — silently, on every delegation
    // (Codex review of PR #151).
    const seen: (readonly string[] | undefined)[] = [];
    const narrow: AgentDefinition = {
      name: "deep",
      tools: ["read", "grep"],
      delegate: true,
      body: "Look closely.",
      sourcePath: "/agents/deep.agent.md",
    };

    const createSession: DirectSessionFactory = async (_rule, _cwd, _out, definition, delegate) => {
      seen.push(definition?.tools);
      if (delegate === undefined) {
        return { async prompt() {}, getLastAssistantText: () => "[]" };
      }
      const tool = delegate as unknown as { execute: (...args: never[]) => Promise<unknown> };
      return {
        async prompt() {
          await tool.execute(
            "call-1" as never,
            { file: "src/a.ts", question: "look" } as never,
            undefined as never,
            undefined as never,
            undefined as never,
          );
        },
        getLastAssistantText: () => "[]",
      };
    };

    await dispatchRulesDirect(
      {
        rules: [makeRule({ agent: "deep" })],
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n",
        useAdvisor: false,
        changedFiles: ["src/a.ts"],
        subagentNesting: "on",
        agentDefinitions: [narrow],
      },
      { createSession },
    );

    // The PARENT keeps its narrowed set; the CHILD gains the reporting tool.
    expect(seen[0]).toEqual(["read", "grep"]);
    expect(seen[1]).toContain("submit_findings");
    expect(seen[1]).toContain("read");
  });

  it("does not duplicate the tool for a persona that already allows it", async () => {
    // Asserted through the dispatch path rather than by exporting the helper:
    // a tool listed twice is the kind of thing a session factory might reject,
    // and the public behaviour is what matters.
    const seen: (readonly string[] | undefined)[] = [];
    const permissive: AgentDefinition = {
      name: "deep",
      tools: ["read", "submit_findings"],
      delegate: true,
      body: "Look closely.",
      sourcePath: "/a.agent.md",
    };

    const createSession: DirectSessionFactory = async (_rule, _cwd, _out, definition, delegate) => {
      seen.push(definition?.tools);
      if (delegate === undefined) {
        return { async prompt() {}, getLastAssistantText: () => "[]" };
      }
      const tool = delegate as unknown as { execute: (...args: never[]) => Promise<unknown> };
      return {
        async prompt() {
          await tool.execute(
            "call-1" as never,
            { file: "src/a.ts", question: "look" } as never,
            undefined as never,
            undefined as never,
            undefined as never,
          );
        },
        getLastAssistantText: () => "[]",
      };
    };

    await dispatchRulesDirect(
      {
        rules: [makeRule({ agent: "deep" })],
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n",
        useAdvisor: false,
        changedFiles: ["src/a.ts"],
        subagentNesting: "on",
        agentDefinitions: [permissive],
      },
      { createSession },
    );

    expect(seen[1]).toEqual(["read", "submit_findings"]);
  });
});
