// Issue #138 phases 2 and 3, at the seam where they actually take effect:
// `dispatchRulesDirect`. The unit tests beside this file cover the loader, the
// gate, and the runner in isolation; these cover the wiring, which is where a
// correct part gets connected to nothing.
import { describe, expect, it, vi } from "vitest";
import { dispatchRulesDirect, type DirectSessionFactory } from "../../../src/review/direct-dispatch.js";
import { parseAgentFile, type AgentDefinition } from "../../../src/agents/definition.js";
import type { RuleDefinition } from "../../../src/rules/types.js";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+const a = 1;\n";

const rule = (overrides: Partial<RuleDefinition> = {}): RuleDefinition => ({
  name: "rule-a",
  body: "Review it.",
  dependsOn: [],
  sourcePath: "/rules/a.md",
  provider: "anthropic",
  model: "claude-sonnet-5",
  ...overrides,
});

const agent = (frontmatter: string): AgentDefinition =>
  parseAgentFile("/a.agent.md", `---\n${frontmatter}\n---\n\nPersona prose.\n`).agent!;

/** A session that answers with a findings array through the text path. */
const answering = (findings: unknown[]): ReturnType<DirectSessionFactory> =>
  Promise.resolve({
    async prompt() {},
    getLastAssistantText: () => JSON.stringify(findings),
  });

describe("an agent definition reaches the session", () => {
  it("hands the factory the agent its rule named", async () => {
    const seen: (AgentDefinition | undefined)[] = [];
    const createSession: DirectSessionFactory = async (_rule, _cwd, _out, scope) => {
      seen.push(scope?.agent);
      return answering([]);
    };

    await dispatchRulesDirect(
      {
        rules: [rule({ agent: "docs" })],
        diff: DIFF,
        useAdvisor: false,
        agentsByRule: new Map([["rule-a", agent("name: docs\ntools: [read]")]]),
      },
      { createSession },
    );

    expect(seen[0]?.name).toBe("docs");
    expect(seen[0]?.tools).toEqual(["read"]);
  });

  it("hands it nothing when no definition is bound", async () => {
    // Every repository predating #138 is this case, and it must dispatch
    // exactly as it always did.
    const seen: (AgentDefinition | undefined)[] = [];
    const createSession: DirectSessionFactory = async (_rule, _cwd, _out, scope) => {
      seen.push(scope?.agent);
      return answering([]);
    };

    await dispatchRulesDirect({ rules: [rule()], diff: DIFF, useAdvisor: false }, { createSession });

    expect(seen).toEqual([undefined]);
  });
});

describe("per-task telemetry (#109)", () => {
  // Read off the RESULT, not off disk. The staging directory dispatch writes
  // these into is removed when it returns, so a test that read the file
  // afterwards would be testing a file nothing can ever read — which is the
  // bug this assertion exists to have caught.
  const metaFor = async (
    outcome: "succeeds" | "fails",
    boundAgent?: AgentDefinition,
  ) => {
    const createSession: DirectSessionFactory = async () => {
      if (outcome === "fails") throw new Error("provider exploded");
      return answering([]);
    };

    const result = await dispatchRulesDirect(
      {
        rules: [rule()],
        diff: DIFF,
        useAdvisor: false,
        ...(boundAgent === undefined ? {} : { agentsByRule: new Map([["rule-a", boundAgent]]) }),
      },
      { createSession },
    );
    return result.taskMeta?.[0];
  };

  it("records a successful task", async () => {
    const meta = await metaFor("succeeds");

    expect(meta).toMatchObject({
      ruleName: "rule-a",
      provider: "anthropic",
      model: "claude-sonnet-5",
      succeeded: true,
      findingCount: 0,
    });
    expect(typeof meta?.taskTextChars).toBe("number");
    expect(meta?.taskTextChars).toBeGreaterThan(0);
  });

  it("records a task that FAILED, with the reason", async () => {
    // Telemetry that only describes tasks that succeeded answers the least
    // interesting half of "what did this run cost".
    const meta = await metaFor("fails");

    expect(meta).toMatchObject({ ruleName: "rule-a", succeeded: false });
    expect(typeof meta?.failureReason).toBe("string");
  });

  it("names the agent when one is bound", async () => {
    expect(await metaFor("succeeds", agent("name: docs"))).toMatchObject({ agent: "docs" });
  });

  it("omits the agent when none is", async () => {
    expect(await metaFor("succeeds")).not.toHaveProperty("agent");
  });
});

describe("nesting is off unless everything agrees", () => {
  const sawDelegate = async (input: {
    nestingEnabled?: boolean;
    boundAgent?: AgentDefinition;
    withRunner?: boolean;
  }): Promise<boolean> => {
    let offered = false;
    const createSession: DirectSessionFactory = async (_rule, _cwd, _out, scope) => {
      offered = scope?.delegate !== undefined;
      return answering([]);
    };

    await dispatchRulesDirect(
      {
        rules: [rule({ agent: "deep" })],
        diff: DIFF,
        useAdvisor: false,
        changedFiles: ["src/a.ts"],
        ...(input.nestingEnabled === undefined ? {} : { nestingEnabled: input.nestingEnabled }),
        ...(input.boundAgent === undefined ? {} : { agentsByRule: new Map([["rule-a", input.boundAgent]]) }),
      },
      {
        createSession,
        ...(input.withRunner === true
          ? { runDelegation: vi.fn(async () => ({ findings: [], digest: "" })) }
          : {}),
      },
    );
    return offered;
  };

  const permitted = agent("name: deep\ndelegate: true");

  it("offers the tool when the flag and the definition agree", async () => {
    expect(await sawDelegate({ nestingEnabled: true, boundAgent: permitted, withRunner: true }))
      .toBe(true);
  });

  it("offers it without an injected runner, because dispatch builds the real one", async () => {
    // Regression guard for a flag that did nothing: `runDelegation` was a test
    // seam with no production supplier, so `--subagent-nesting on` parsed,
    // passed every gate, and then silently withheld the tool.
    expect(await sawDelegate({ nestingEnabled: true, boundAgent: permitted, withRunner: false }))
      .toBe(true);
  });

  it.each([
    ["the flag is off", { nestingEnabled: false, boundAgent: permitted, withRunner: true }],
    ["the definition did not ask", {
      nestingEnabled: true,
      boundAgent: agent("name: deep"),
      withRunner: true,
    }],

    ["no agent is bound at all", { nestingEnabled: true, withRunner: true }],
  ])("withholds the tool when %s", async (_label, input) => {
    // The flag AND the definition must agree. A tool that accepts calls it
    // cannot service is worse than no tool: the reviewer spends a turn
    // discovering that.
    expect(await sawDelegate(input)).toBe(false);
  });
});

describe("harvested child findings reach the merge", () => {
  it("merges them alongside the parent's own", async () => {
    const createSession: DirectSessionFactory = async (_rule, _cwd, _out, scope) => {
      // The reviewer calls `delegate` once, then reports one finding itself.
      const tool = scope?.delegate as unknown as {
        execute: (...args: never[]) => Promise<unknown>;
      };
      return {
        async prompt() {
          await tool.execute(
            "call-1" as never,
            { file: "src/a.ts", question: "look closer" } as never,
            undefined as never,
            undefined as never,
            undefined as never,
          );
        },
        getLastAssistantText: () =>
          JSON.stringify([
            { file: "src/a.ts", line: 1, severity: "warning", category: "c", message: "Parent's own." },
          ]),
      };
    };

    const result = await dispatchRulesDirect(
      {
        rules: [rule({ agent: "deep" })],
        diff: DIFF,
        useAdvisor: false,
        changedFiles: ["src/a.ts"],
        nestingEnabled: true,
        agentsByRule: new Map([["rule-a", agent("name: deep\ndelegate: true")]]),
      },
      {
        createSession,
        runDelegation: async () => ({
          findings: [
            {
              file: "src/a.ts",
              line: 2,
              severity: "blocking",
              category: "c",
              ruleName: "rule-a",
              message: "Child's finding.",
            },
          ],
          digest: "one finding",
        }),
      },
    );

    const messages = result.findings.map((finding) => finding.message).sort();
    expect(messages).toEqual(["Child's finding.", "Parent's own."]);
    // Attributed to the parent rule: the child is a second look on its behalf,
    // not a reviewer with its own name that would appear in `rulesRun` without
    // existing in any rule file.
    expect(result.findings.every((finding) => finding.ruleName === "rule-a")).toBe(true);
  });
});
