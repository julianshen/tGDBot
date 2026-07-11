// Tests for dispatchRules — see TASKS.md Task 5 "Acceptance Criteria (BDD)"
// AC-5.1 through AC-5.4.
//
// AC-5.1 exercises dispatchRules' real (default) session factory, so it
// mocks "@earendil-works/pi-coding-agent" itself (per TASKS.md's testing
// note: "No live LLM calls in tests — pi SDK agent sessions are
// mocked/stubbed") rather than constructing a real DefaultResourceLoader/
// AgentSession. AC-5.2 through AC-5.4 instead inject a stub DispatchSession
// via dispatchRules' third parameter (test/fixtures/pi-session-stub.ts),
// which never touches the pi SDK at all.
import { describe, expect, it, vi } from "vitest";
import type { RuleDefinition } from "../../../src/rules/types.js";
import { createPiSessionStub } from "../../fixtures/pi-session-stub.js";

const hoisted = vi.hoisted(() => {
  const resourceLoaderInstances: { options: Record<string, unknown>; reload: () => Promise<void> }[] =
    [];
  const reload = vi.fn().mockResolvedValue(undefined);

  class FakeResourceLoader {
    options: Record<string, unknown>;
    reload: () => Promise<void>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.reload = reload;
      resourceLoaderInstances.push(this);
    }
  }

  const createAgentSessionMock = vi.fn();
  const sessionManagerInMemory = vi.fn(() => "fake-session-manager");

  return {
    resourceLoaderInstances,
    reload,
    FakeResourceLoader,
    createAgentSessionMock,
    sessionManagerInMemory,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: hoisted.FakeResourceLoader,
  createAgentSession: hoisted.createAgentSessionMock,
  SessionManager: { inMemory: hoisted.sessionManagerInMemory },
  getAgentDir: () => "/fake/agent/dir",
}));

import { buildDispatchPrompt, dispatchRules } from "../../../src/review/dispatch.js";
import {
  resolvePiSubagentsExtensionPath,
  resolveRpivAdvisorExtensionPath,
} from "../../../src/review/extensions.js";

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

describe("dispatchRules", () => {
  // AC-5.1: Given a list of 2 rules and a diff, When dispatchRules is
  // called against a stubbed session, Then the session is created with
  // resourceLoader configured with additionalExtensionPaths including the
  // resolved pi-subagents path.
  it("AC-5.1: creates the session with resourceLoader's additionalExtensionPaths including the resolved pi-subagents path", async () => {
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () =>
          JSON.stringify({ findings: [], rulesRun: ["rule-a", "rule-b"], rulesFailed: [] }),
      },
    });

    const rules = [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })];
    await dispatchRules(rules, "diff --git a/x b/x", false);

    expect(hoisted.resourceLoaderInstances).toHaveLength(1);
    expect(hoisted.resourceLoaderInstances[0]?.options.additionalExtensionPaths).toEqual([
      resolvePiSubagentsExtensionPath(),
    ]);

    expect(hoisted.createAgentSessionMock).toHaveBeenCalledTimes(1);
    const callArgs = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as {
      resourceLoader: unknown;
      tools: string[];
    };
    expect(callArgs.resourceLoader).toBe(hoisted.resourceLoaderInstances[0]);
    expect(callArgs.tools).toContain("subagent");
  });

  // AC-5.2: Given a rule with provider: "anthropic", model:
  // "claude-opus-4-5", When dispatchRules builds its dispatch prompt, Then
  // the prompt text sent to the stubbed session's prompt() call contains
  // the exact string "anthropic/claude-opus-4-5" associated with that
  // rule's task, and the task's agent reference is "reviewer".
  it("AC-5.2: the dispatch prompt contains the exact provider/model string and agent: \"reviewer\"", async () => {
    const stub = createPiSessionStub(JSON.stringify({ findings: [], rulesRun: [], rulesFailed: [] }));
    const rule = makeRule({ provider: "anthropic", model: "claude-opus-4-5" });

    await dispatchRules([rule], "diff --git a/x b/x", false, async () => stub.session);

    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]).toContain("anthropic/claude-opus-4-5");
    expect(stub.prompts[0]).toContain('agent: "reviewer"');
  });

  // AC-5.3: Given the stubbed session's final message is a well-formed
  // DispatchResult JSON object, When dispatchRules returns, Then the
  // returned value deep-equals that parsed object.
  it("AC-5.3: a well-formed DispatchResult JSON final message is returned as-is", async () => {
    const wellFormed = {
      findings: [
        {
          file: "src/foo.ts",
          line: 12,
          severity: "warning" as const,
          category: "style",
          message: "Prefer const",
          ruleName: "rule-a",
        },
      ],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    };
    const stub = createPiSessionStub(JSON.stringify(wellFormed));

    const result = await dispatchRules([makeRule()], "diff --git a/x b/x", false, async () => stub.session);

    expect(result).toEqual(wellFormed);
  });

  // AC-5.3 (fence variant): the same well-formed JSON wrapped in markdown
  // code fences is still parsed correctly (defensive parsing).
  it("AC-5.3: a well-formed DispatchResult JSON wrapped in markdown code fences is still parsed", async () => {
    const wellFormed = { findings: [], rulesRun: ["rule-a"], rulesFailed: [] };
    const stub = createPiSessionStub("```json\n" + JSON.stringify(wellFormed) + "\n```");

    const result = await dispatchRules([makeRule()], "diff --git a/x b/x", false, async () => stub.session);

    expect(result).toEqual(wellFormed);
  });

  // AC-5.4: Given the stubbed session's final message is malformed
  // (non-JSON, or JSON missing required fields), When dispatchRules
  // returns, Then it returns { findings: [], rulesRun: [], rulesFailed:
  // <all rule names> } and logs a warning — it does not throw.
  it("AC-5.4: non-JSON final message falls back to empty findings + all rules failed, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = createPiSessionStub("Sorry, I could not complete this task.");
    const rules = [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })];

    const result = await dispatchRules(rules, "diff --git a/x b/x", false, async () => stub.session);

    expect(result).toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a", "rule-b"] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // AC-5.4 (structurally invalid variant): well-formed JSON that is
  // missing required DispatchResult fields also falls back gracefully.
  it("AC-5.4: JSON missing required DispatchResult fields falls back, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = createPiSessionStub(JSON.stringify({ findings: [] })); // missing rulesRun/rulesFailed
    const rules = [makeRule({ name: "rule-a" })];

    const result = await dispatchRules(rules, "diff --git a/x b/x", false, async () => stub.session);

    expect(result).toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // AC-5.4 (undefined final message variant): a session that produced no
  // final assistant text at all also falls back gracefully.
  it("AC-5.4: an undefined final message falls back, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = createPiSessionStub(undefined);
    const rules = [makeRule({ name: "rule-a" })];

    await expect(
      dispatchRules(rules, "diff --git a/x b/x", false, async () => stub.session),
    ).resolves.toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // AC-5.4 (malformed Finding element variant, review fix): a
  // structurally-valid DispatchResult whose findings array contains an
  // element missing required Finding fields (file/severity/category/
  // message/ruleName) must not be returned as-is — that would silently
  // hand Task 7's orchestration garbage Finding objects. The whole
  // response falls back, same as the non-JSON case.
  it("AC-5.4: a findings element missing required Finding fields falls back, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = {
      findings: [{ foo: "bar" }],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    };
    const stub = createPiSessionStub(JSON.stringify(malformed));
    const rules = [makeRule({ name: "rule-a" })];

    const result = await dispatchRules(rules, "diff --git a/x b/x", false, async () => stub.session);

    expect(result).toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // AC-5.4 (invalid Finding severity variant, review fix): a findings
  // element with all fields present but an out-of-enum "severity" value
  // is equally untrustworthy and must also fall back.
  it("AC-5.4: a findings element with an invalid severity value falls back, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = {
      findings: [
        {
          file: "src/foo.ts",
          line: 1,
          severity: "critical", // not one of blocking/warning/suggestion
          category: "security",
          message: "bad",
          ruleName: "rule-a",
        },
      ],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    };
    const stub = createPiSessionStub(JSON.stringify(malformed));
    const rules = [makeRule({ name: "rule-a" })];

    const result = await dispatchRules(rules, "diff --git a/x b/x", false, async () => stub.session);

    expect(result).toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // AC-5.4 (session.prompt() throws variant, review fix): dispatchRules is
  // a safety boundary that later tasks (Task 8's CLI wiring) call directly
  // without their own try/catch — a real SDK exception during
  // session.prompt() (network error, tool failure, rate limit, ...) must
  // be caught here and turned into the same fallback shape, not
  // propagated.
  it("AC-5.4: session.prompt() throwing falls back, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })];
    const throwingSession = {
      prompt: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
      getLastAssistantText: () => "should never be read",
    };

    await expect(
      dispatchRules(rules, "diff --git a/x b/x", false, async () => throwingSession),
    ).resolves.toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a", "rule-b"] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// Tests for the Task 6 advisor second-opinion integration — see TASKS.md
// Task 6 "Acceptance Criteria (BDD)" AC-6.1 through AC-6.3. These exercise
// dispatchRules' real (default) session factory (same approach as AC-5.1),
// mocking "@earendil-works/pi-coding-agent" so no real SDK/network call is
// made, in order to inspect the resourceLoader's additionalExtensionPaths.
describe("dispatchRules advisor integration (Task 6)", () => {
  it("AC-6.1: useAdvisor: true includes both the pi-subagents and rpiv-advisor extension paths", async () => {
    hoisted.resourceLoaderInstances.length = 0;
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () => JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
      },
    });

    const rules = [makeRule({ name: "rule-a" })];
    await dispatchRules(rules, "diff --git a/x b/x", true);

    expect(hoisted.resourceLoaderInstances).toHaveLength(1);
    expect(hoisted.resourceLoaderInstances[0]?.options.additionalExtensionPaths).toEqual([
      resolvePiSubagentsExtensionPath(),
      resolveRpivAdvisorExtensionPath(),
    ]);
  });

  it("AC-6.2: useAdvisor: false includes only the pi-subagents extension path — rpiv-advisor is never loaded", async () => {
    hoisted.resourceLoaderInstances.length = 0;
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () => JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
      },
    });

    const rules = [makeRule({ name: "rule-a" })];
    await dispatchRules(rules, "diff --git a/x b/x", false);

    expect(hoisted.resourceLoaderInstances).toHaveLength(1);
    const paths = hoisted.resourceLoaderInstances[0]?.options.additionalExtensionPaths as string[];
    expect(paths).toEqual([resolvePiSubagentsExtensionPath()]);
    expect(paths).not.toContain(resolveRpivAdvisorExtensionPath());
  });

  it("AC-6.3: useAdvisor: true includes an explicit instruction to call the advisor tool before finalizing", () => {
    const rules = [makeRule({ name: "rule-a" })];

    const promptWithAdvisor = buildDispatchPrompt(rules, "diff --git a/x b/x", true);
    const promptWithoutAdvisor = buildDispatchPrompt(rules, "diff --git a/x b/x", false);

    expect(promptWithAdvisor).toContain('call the "advisor" tool');
    expect(promptWithAdvisor).toMatch(/advisor/i);
    expect(promptWithoutAdvisor).not.toContain('call the "advisor" tool');
  });
});
