// Tests for the DIRECT dispatch engine (design-review P0): one session per
// rule, deterministic TypeScript merge, advisor as a discrete bounded step.
// Sessions are injected stubs throughout — the real RULE-session factory is
// the only SDK toucher exercised live, not here. The real ADVISOR-session
// factory's hermeticity (below) IS unit tested against a mocked SDK, the same
// stance dispatch.test.ts takes for the legacy engine's real factory.
import { describe, expect, it, vi } from "vitest";
import {
  dispatchRulesDirect as dispatchRulesDirectObject,
  parseAdvisorDropList,
} from "../../../src/review/direct-dispatch.js";
import type {
  DirectDispatchDeps,
  DirectSessionFactory,
} from "../../../src/review/direct-dispatch.js";
import { DispatchInputError } from "../../../src/review/dispatch-context.js";
import type { DispatchSession } from "../../../src/review/dispatch.js";
import { resolveRpivAdvisorExtensionPath } from "../../../src/review/extensions.js";
import { ReviewWorkflowError } from "../../../src/review/workflow.js";
import type { RuleDefinition } from "../../../src/rules/types.js";
import type { RuleContextPacks } from "../../../src/review/types.js";

// Hoisted so the SDK mock below can reference it before direct-dispatch.ts is
// imported (vi.mock is hoisted to the top of the module by vitest).
const hoisted = vi.hoisted(() => {
  const resourceLoaderInstances: { options: Record<string, unknown> }[] = [];
  class FakeResourceLoader {
    options: Record<string, unknown>;
    reload = vi.fn().mockResolvedValue(undefined);
    constructor(options: Record<string, unknown>) {
      this.options = options;
      resourceLoaderInstances.push(this);
    }
  }
  const createAgentSessionMock = vi.fn();
  const findModelMock = vi.fn((provider: string, modelId: string) => ({
    id: modelId,
    provider,
    name: `${provider}/${modelId}`,
  }));
  const modelRegistryCreate = vi.fn(() => ({
    find: findModelMock,
    hasConfiguredAuth: vi.fn(() => true),
    getAvailable: vi.fn((): { provider: string; id: string }[] => []),
  }));
  return {
    resourceLoaderInstances,
    FakeResourceLoader,
    createAgentSessionMock,
    sessionManagerInMemory: vi.fn(() => "fake-session-manager"),
    getAgentDirMock: vi.fn(() => "/fake/agent/dir"),
    authStorageCreate: vi.fn(() => "fake-auth-storage"),
    modelRegistryCreate,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: hoisted.FakeResourceLoader,
  createAgentSession: hoisted.createAgentSessionMock,
  createReadOnlyTools: vi.fn(() => ({})),
  SessionManager: { inMemory: hoisted.sessionManagerInMemory },
  getAgentDir: hoisted.getAgentDirMock,
  AuthStorage: { create: hoisted.authStorageCreate },
  ModelRegistry: { create: hoisted.modelRegistryCreate },
}));

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

function dispatchRulesDirect(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
  deps: DirectDispatchDeps = {},
  orchestratorModel?: string,
  contextPacks?: RuleContextPacks,
) {
  return dispatchRulesDirectObject(
    {
      rules,
      diff,
      useAdvisor,
      ...(orchestratorModel === undefined ? {} : { orchestratorModel }),
      ...(contextPacks === undefined ? {} : { contextPacks }),
    },
    deps,
  );
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
  it("rejects invalid workflow and context input before reviewer or advisor factories run", async () => {
    const createSession = vi.fn();
    const createAdvisorSession = vi.fn();

    await expect(
      dispatchRulesDirect(
        [
          makeRule({ name: "rule-a", dependsOn: ["rule-b"] }),
          makeRule({ name: "rule-b", dependsOn: ["rule-a"] }),
        ],
        "diff",
        true,
        { createSession, createAdvisorSession },
      ),
    ).rejects.toThrow(ReviewWorkflowError);

    await expect(
      dispatchRulesDirect(
        [makeRule()],
        "diff",
        true,
        { createSession, createAdvisorSession },
        undefined,
        {},
      ),
    ).rejects.toThrow(DispatchInputError);

    expect(createSession).not.toHaveBeenCalled();
    expect(createAdvisorSession).not.toHaveBeenCalled();
  });

  it("runs ungrouped rules in non-overlapping sequential waves", async () => {
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const createSession: DirectSessionFactory = async (rule) => ({
      async prompt() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${rule.name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`end:${rule.name}`);
        active -= 1;
      },
      getLastAssistantText: () => "[]",
    });

    await dispatchRulesDirect(
      [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" }), makeRule({ name: "rule-c" })],
      "diff",
      false,
      { createSession },
    );

    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "start:rule-a",
      "end:rule-a",
      "start:rule-b",
      "end:rule-b",
      "start:rule-c",
      "end:rule-c",
    ]);
  });

  it("overlaps only an explicit parallel wave and waits for it before the next wave", async () => {
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const createSession: DirectSessionFactory = async (rule) => ({
      async prompt() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${rule.name}`);
        await new Promise((resolve) => setTimeout(resolve, rule.name === "rule-a" ? 10 : 5));
        events.push(`end:${rule.name}`);
        active -= 1;
      },
      getLastAssistantText: () =>
        JSON.stringify([finding(`${rule.name}.ts`, `finding from ${rule.name}`)]),
    });
    const createAdvisorSession = vi.fn(async (): Promise<DispatchSession> => ({
      async prompt() {
        events.push("start:advisor");
      },
      getLastAssistantText: () => '{"drop": []}',
    }));

    await dispatchRulesDirect(
      [
        makeRule({ name: "rule-a", parallelGroup: "checks" }),
        makeRule({ name: "rule-b", parallelGroup: "checks" }),
        makeRule({ name: "rule-c" }),
      ],
      "diff",
      true,
      { createSession, createAdvisorSession },
    );

    expect(maxActive).toBe(2);
    expect(events.slice(0, 2)).toEqual(["start:rule-a", "start:rule-b"]);
    expect(events.indexOf("start:rule-c")).toBeGreaterThan(events.indexOf("end:rule-a"));
    expect(events.indexOf("start:rule-c")).toBeGreaterThan(events.indexOf("end:rule-b"));
    expect(events.indexOf("start:advisor")).toBeGreaterThan(events.indexOf("end:rule-c"));
    expect(createAdvisorSession).toHaveBeenCalledTimes(1);
  });

  it("keeps findings and accounting in planned order under inverse completion and retains context identity", async () => {
    const manifestHash = "a".repeat(64);
    const contextPacks = {
      "rule-a": { text: "context a", manifestHash, truncated: false, sources: [] },
      "rule-b": { text: "context b", manifestHash, truncated: false, sources: [] },
      "rule-c": { text: "context c", manifestHash, truncated: false, sources: [] },
    };
    const prompts: Record<string, string> = {};
    const createSession: DirectSessionFactory = async (rule) => {
      if (rule.name === "rule-c") throw new Error("provider unavailable");
      return {
        async prompt(text: string) {
          prompts[rule.name] = text;
          await new Promise((resolve) => setTimeout(resolve, rule.name === "rule-a" ? 10 : 1));
        },
        getLastAssistantText: () =>
          JSON.stringify([finding(`${rule.name}.ts`, `finding from ${rule.name}`)]),
      };
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRulesDirect(
      [
        makeRule({ name: "rule-a", parallelGroup: "checks" }),
        makeRule({ name: "rule-b", parallelGroup: "checks" }),
        makeRule({ name: "rule-c", dependsOn: ["rule-a"] }),
      ],
      "diff",
      false,
      { createSession },
      undefined,
      contextPacks,
    );

    expect(result.findings.map((item) => item.ruleName)).toEqual(["rule-a", "rule-b"]);
    expect(result.rulesRun).toEqual(["rule-a", "rule-b"]);
    expect(result.rulesFailed).toEqual(["rule-c"]);
    expect(result.contextManifestHash).toBe(manifestHash);
    expect(prompts["rule-a"]).toContain("context a");
    expect(prompts["rule-b"]).toContain("context b");
    vi.restoreAllMocks();
  });

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

  // CodeRabbit review (PR #7): a hung provider call must not block the whole
  // run indefinitely — each session's prompt() is wrapped in a bounded
  // timeout (overridable via deps for tests).
  describe("prompt timeouts", () => {
    it("a rule whose session never resolves times out, is classified 'timed out', and never blocks the others", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const events: string[] = [];
        const hangingSession: DispatchSession = {
          prompt: () => new Promise(() => {}), // never resolves
          getLastAssistantText: () => undefined,
          async abort() {
            events.push("abort:rule-a");
          },
        };
        const { factory } = makeFactory({ "rule-b": JSON.stringify([finding("b.ts", "ok")]) });
        const combinedFactory: DirectSessionFactory = async (rule, cwd) => {
          if (rule.name === "rule-a") return hangingSession;
          const session = await factory(rule, cwd);
          return {
            ...session,
            async prompt(text: string) {
              events.push("start:rule-b");
              await session.prompt(text);
            },
          };
        };

        const result = await dispatchRulesDirect(
          [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b", provider: "xai", model: "grok-4.5" })],
          "diff",
          false,
          { createSession: combinedFactory, ruleTimeoutMs: 20 },
        );

        expect(result.rulesFailed).toEqual(["rule-a"]);
        expect(result.rulesRun).toEqual(["rule-b"]); // the hung rule never blocks this one
        expect(events).toEqual(["abort:rule-a", "start:rule-b"]);
        expect(result.ruleFailureReasons?.["rule-a"]).toContain("timed out");
        const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warned).toContain("timed out");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("an advisor pass that never resolves times out and keeps all findings (best-effort)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { factory } = makeFactory({
          "rule-a": JSON.stringify([finding("a.ts", "bug")]),
        });

        const result = await dispatchRulesDirect([makeRule()], "diff", true, {
          createSession: factory,
          createAdvisorSession: async () => ({
            prompt: () => new Promise(() => {}), // never resolves
            getLastAssistantText: () => undefined,
          }),
          advisorTimeoutMs: 20,
        });

        expect(result.findings).toHaveLength(1); // kept — best-effort
        const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warned).toContain("advisor pass failed");
        expect(warned).toContain("timed out");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("does NOT mutate PI_CODING_AGENT_DIR (no hermetic-agent-dir games in direct mode)", async () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    const { factory } = makeFactory({ "rule-a": "[]" });

    await dispatchRulesDirect([makeRule()], "diff", false, { createSession: factory });

    expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
  });

  // Codex review (PR #7): the real advisor session's DefaultResourceLoader was
  // missing `noExtensions: true`, so it still discovered the machine's REAL
  // ambient extensions alongside rpiv-advisor — breaking the "everything else
  // off" hermeticity the surrounding code already claimed. The rule session
  // here uses an injected stub (so this test only exercises the real ADVISOR
  // factory); createAgentSession/DefaultResourceLoader are mocked so we can
  // inspect the exact options the advisor's loader was constructed with.
  it("constructs the real advisor session's loader with noExtensions: true (only rpiv-advisor active)", async () => {
    hoisted.resourceLoaderInstances.length = 0;
    hoisted.createAgentSessionMock.mockReset();
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        async prompt() {},
        getLastAssistantText: () => '{"drop": []}',
      },
    });
    const { factory } = makeFactory({ "rule-a": JSON.stringify([finding("a.ts", "bug")]) });

    await dispatchRulesDirect([makeRule()], "diff", true, { createSession: factory });

    expect(hoisted.resourceLoaderInstances).toHaveLength(1);
    expect(hoisted.resourceLoaderInstances[0]?.options.noExtensions).toBe(true);
    expect(hoisted.resourceLoaderInstances[0]?.options.additionalExtensionPaths).toEqual([
      resolveRpivAdvisorExtensionPath(),
    ]);
  });

  // Codex review (PR #7): the SDK's own ThinkingLevel type is "off" |
  // "minimal" | "low" | "medium" | "high" | "xhigh" | "max" — "off" IS the
  // valid disabled value; "none" is not accepted at all. resolveRuleSessionModel
  // used to map "off" -> "none" (backwards), which would hand createAgentSession
  // an invalid thinkingLevel exactly when a rule asked to disable thinking.
  // This exercises the REAL rule-session factory (no createSession override)
  // against the mocked SDK to assert the value actually reaching
  // createAgentSession.
  it("normalizes both ':off' and ':none' rule-model suffixes to the SDK's valid \"off\" thinking level", async () => {
    for (const suffix of ["off", "none"]) {
      hoisted.createAgentSessionMock.mockReset();
      hoisted.createAgentSessionMock.mockResolvedValueOnce({
        session: {
          async prompt() {},
          getLastAssistantText: () => "[]",
        },
      });

      await dispatchRulesDirect(
        [makeRule({ model: `claude-opus-4-5:${suffix}` })],
        "diff",
        false,
        {},
      );

      const callArgs = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as {
        thinkingLevel?: string;
      };
      expect(callArgs.thinkingLevel).toBe("off");
    }
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
