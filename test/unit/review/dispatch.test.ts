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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  // createRealDispatchSession now uses SessionManager.create(cwd) (persisted,
  // for fork-safety) instead of .inMemory(); the mock must expose it.
  const sessionManagerCreate = vi.fn(() => "fake-persisted-session-manager");
  // getAgentDir is a configurable mock (not a fixed string) so the auth.json
  // diagnostics tests (issue #1) can point it at a real temp dir with/without
  // an auth.json. Defaults to the original nonexistent path, which is what
  // every pre-existing real-factory test expects.
  const getAgentDirMock = vi.fn(() => "/fake/agent/dir");
  // Lets ONE test force symlink() to fail for a specific filename (issue #1's
  // "auth.json exists but can't be linked" case, e.g. EPERM in a locked-down
  // container). Null by default, so every other test gets the real symlink.
  const failSymlinkFor: { name: string | null } = { name: null };
  // Orchestrator-model decoupling: the real factory resolves an explicit Model
  // via ModelRegistry.find(provider, modelId) instead of inheriting pi's
  // ambient default. `findModelMock` lets a test say "this model resolves" (a
  // Model object) or "it doesn't" (undefined).
  const findModelMock = vi.fn((provider: string, modelId: string) => ({
    id: modelId,
    provider,
    name: `${provider}/${modelId}`,
  }));
  const authStorageCreate = vi.fn(() => "fake-auth-storage");
  // hasConfiguredAuth is THE credential gate (review: find() is a pure name
  // lookup with no auth check). Default true; tests flip it to prove an
  // un-credentialed model is never handed to the session.
  const hasConfiguredAuthMock = vi.fn(() => true);
  const modelRegistryCreate = vi.fn(() => ({
    find: findModelMock,
    hasConfiguredAuth: hasConfiguredAuthMock,
  }));

  return {
    failSymlinkFor,
    findModelMock,
    hasConfiguredAuthMock,
    authStorageCreate,
    modelRegistryCreate,
    resourceLoaderInstances,
    reload,
    FakeResourceLoader,
    createAgentSessionMock,
    sessionManagerInMemory,
    sessionManagerCreate,
    getAgentDirMock,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: hoisted.FakeResourceLoader,
  createAgentSession: hoisted.createAgentSessionMock,
  SessionManager: { inMemory: hoisted.sessionManagerInMemory, create: hoisted.sessionManagerCreate },
  getAgentDir: hoisted.getAgentDirMock,
  AuthStorage: { create: hoisted.authStorageCreate },
  ModelRegistry: { create: hoisted.modelRegistryCreate },
}));

// dispatch.ts imports `symlink` as an ESM named binding, so it can't be spied
// after the fact — the mock has to be hoisted ahead of the import. Everything
// is delegated to the real fs/promises EXCEPT symlink, and even that only fails
// when a test explicitly opts in via hoisted.failSymlinkFor (default: null).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (target: Parameters<typeof actual.symlink>[0], linkPath: Parameters<typeof actual.symlink>[1]) => {
      if (hoisted.failSymlinkFor.name && path.basename(String(linkPath)) === hoisted.failSymlinkFor.name) {
        throw new Error("EPERM: operation not permitted, symlink");
      }
      return actual.symlink(target, linkPath);
    },
  };
});

import { buildDispatchPrompt, describeAuthContext, dispatchRules } from "../../../src/review/dispatch.js";
import type { DispatchSession } from "../../../src/review/dispatch.js";
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

// A stub session that, on prompt(), synchronously emits one subagent
// tool_execution_end event with the given details.results to its subscriber,
// then resolves; getLastAssistantText returns the orchestrator's final JSON.
// Shared by the reconciliation and prose-recovery describe blocks below.
function makeSubscribableSession(detailsResults: unknown[], finalMessage: string): DispatchSession {
  let listener: ((event: unknown) => void) | undefined;
  return {
    subscribe(l: (event: unknown) => void) {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      listener?.({
        type: "tool_execution_end",
        toolName: "subagent",
        result: { details: { results: detailsResults } },
      });
    },
    getLastAssistantText() {
      return finalMessage;
    },
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

  // AC-5.1/AC-5.2 (review fix, multi-rule correctness): Given ≥2 rules with
  // DISTINCT name/provider/model/body, When dispatchRules builds its
  // dispatch prompt, Then the prompt sent to session.prompt() contains
  // EVERY rule (none dropped) with its OWN provider/model string paired
  // with its OWN body text — not swapped with another rule's, and not
  // silently dropped in favor of only the last rule. Before this test,
  // every existing test used either a single-rule array or never inspected
  // the actual prompt text, so a "only the last rule gets dispatched" or
  // "rule B's model used for rule A's task" regression would leave every
  // other test green.
  it("AC-5.1/5.2 (review fix): a multi-rule prompt includes every rule with its own correct provider/model pairing, not dropped or swapped", async () => {
    const ruleA = makeRule({
      name: "rule-a",
      provider: "anthropic",
      model: "claude-opus-4-5",
      body: "RULE-A-UNIQUE-INSTRUCTION: check for null derefs.",
    });
    const ruleB = makeRule({
      name: "rule-b",
      provider: "openai",
      model: "gpt-5",
      body: "RULE-B-UNIQUE-INSTRUCTION: check for SQL injection.",
    });

    const stub = createPiSessionStub(JSON.stringify({ findings: [], rulesRun: [], rulesFailed: [] }));
    await dispatchRules([ruleA, ruleB], "diff --git a/x b/x", false, async () => stub.session);

    expect(stub.prompts).toHaveLength(1);
    const prompt = stub.prompts[0];

    // Both rules' exact "provider/model" strings must appear somewhere —
    // catches a rule being dropped entirely.
    expect(prompt).toContain("anthropic/claude-opus-4-5");
    expect(prompt).toContain("openai/gpt-5");

    // Slice the prompt into each rule's own task block (from its "Task N"
    // marker up to the next one) so pairing can be checked precisely
    // rather than just "both strings appear somewhere in the prompt".
    const taskAStart = prompt.indexOf('Task 1 — rule "rule-a":');
    const taskBStart = prompt.indexOf('Task 2 — rule "rule-b":');
    expect(taskAStart).toBeGreaterThanOrEqual(0);
    expect(taskBStart).toBeGreaterThan(taskAStart);

    const blockA = prompt.slice(taskAStart, taskBStart);
    const blockB = prompt.slice(taskBStart);

    // rule-a's block must pair rule-a's own model with rule-a's own body —
    // and must NOT contain rule-b's model or body (catches a swap).
    expect(blockA).toContain("anthropic/claude-opus-4-5");
    expect(blockA).toContain("RULE-A-UNIQUE-INSTRUCTION");
    expect(blockA).not.toContain("openai/gpt-5");
    expect(blockA).not.toContain("RULE-B-UNIQUE-INSTRUCTION");

    // rule-b's block must pair rule-b's own model with rule-b's own body —
    // and must NOT contain rule-a's model or body.
    expect(blockB).toContain("openai/gpt-5");
    expect(blockB).toContain("RULE-B-UNIQUE-INSTRUCTION");
    expect(blockB).not.toContain("anthropic/claude-opus-4-5");
    expect(blockB).not.toContain("RULE-A-UNIQUE-INSTRUCTION");
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

    expect(result).toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a", "rule-b"] });
    // Review fix: fallbacks now also explain THEMSELVES, so the comment never
    // renders a bare, reasonless "- rule-a" list.
    expect(result.ruleFailureReasons?.["rule-a"]).toMatch(/orchestrator did not complete/i);
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

    expect(result).toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(result.ruleFailureReasons?.["rule-a"]).toMatch(/orchestrator did not complete/i);
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
    ).resolves.toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
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

    expect(result).toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(result.ruleFailureReasons?.["rule-a"]).toMatch(/orchestrator did not complete/i);
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

    expect(result).toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(result.ruleFailureReasons?.["rule-a"]).toMatch(/orchestrator did not complete/i);
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
    ).resolves.toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a", "rule-b"] });
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

  // Bug fix (found via a real multi-model run against hmchangw/chat#490): the
  // orchestrating LLM sometimes chose `context: "fork"` for its subagent
  // call. Fork requires a PERSISTED parent session, but dispatchRules uses
  // SessionManager.inMemory() (deliberately ephemeral, no persistence), so
  // fork hard-fails with "Forked subagent context requires a persisted
  // parent session" — taking down ALL dispatched tasks at once. Fresh
  // context is what we actually want anyway (each rule's review is
  // independent), so the prompt now explicitly instructs `context: "fresh"`.
  // Per pi-subagents' schema, an explicit top-level `context` overrides every
  // child in the invocation, so this deterministically forces fresh.
  it("bug fix (real run, hmchangw/chat#490): the dispatch prompt instructs context: fresh (fork-safety itself is now guaranteed by the persisted session, tested separately)", () => {
    const rules = [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })];

    const prompt = buildDispatchPrompt(rules, "diff --git a/x b/x", false);

    expect(prompt).toContain('"fresh"');
    expect(prompt).toMatch(/context/i);
  });

  // Bug fix (found via a real multi-model run against hmchangw/chat#490): with
  // the fork/intercom bugs fixed, BOTH parallel tasks reliably ran ("2/2
  // succeeded"), but the orchestrator's FINAL accounting sometimes marked one
  // model (whose task ran but found little/nothing, or only findings that
  // overlapped the other model's) as "failed" and dropped it — so a 2-model
  // fan-out silently degraded to 1-model coverage reported as partial. Two
  // prompt fixes make attribution reliable: (1) an explicit order→rule map so
  // the orchestrator attributes each "=== Task K ===" block by position, not
  // by guessing from content; (2) a sharp rulesRun/rulesFailed definition —
  // a task that RAN and returned a parseable findings array (INCLUDING an
  // empty []) is a SUCCESS (rulesRun), and rulesFailed is ONLY for tasks that
  // errored or returned no parseable array at all.
  it("bug fix (real run, hmchangw/chat#490): the prompt maps tasks to rules by order and defines rulesRun to include a rule that ran but found nothing", () => {
    const rules = [makeRule({ name: "grok-review" }), makeRule({ name: "terra-review" })];

    const prompt = buildDispatchPrompt(rules, "diff --git a/x b/x", false);

    // Explicit order→rule attribution: assert the EXACT pairing, not just that
    // both names appear somewhere — a reversed or off-by-one mapping (Task 1 →
    // terra) is exactly the bug this must catch, and loose keyword matching
    // would miss it.
    expect(prompt).toContain('Task 1\'s block is rule "grok-review"');
    expect(prompt).toContain('Task 2\'s block is rule "terra-review"');
    expect(prompt).toMatch(/order/i);
    // The "N/N succeeded" anchor the orchestrator keys attribution on.
    expect(prompt).toMatch(/succeeded/i);
    // The sharp rulesRun/rulesFailed distinction: empty findings is still a run.
    expect(prompt).toMatch(/empty/i);
    expect(prompt).toMatch(/\[\]/);
    // And an explicit anti-drop instruction.
    expect(prompt).toMatch(/never (drop|omit)/i);
  });
});

// Tests for ADR-003 "restrict dispatched subagent tools via project-scoped
// agent override" — closes DEBT.md's High-priority "Dispatched review
// subagents retain bash/edit/write tool access" item. See
// decisions/ADR-003-restrict-dispatched-subagent-tools-via-project-scoped-agent-override.md
// in the tgd-review-agent docs repo for the full mechanism writeup.
describe("dispatchRules isolated session cwd (ADR-003)", () => {
  // Given dispatchRules is called with an injected stub session factory,
  // When the factory is invoked, Then it receives a `cwd` argument that is
  // a fresh temp directory (not process.cwd(), not any target-repo
  // directory) which — AT THE TIME the factory runs, i.e. before session
  // creation and before dispatchRules' cleanup — already contains
  // `.pi/agents/reviewer.md` seeded with our vendored restricted-tools
  // agent definition (tools: read, grep, find, ls — no bash/edit/write).
  it("passes the session factory a fresh temp cwd seeded with the restricted reviewer.md before session creation", async () => {
    const stub = createPiSessionStub(JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }));
    let capturedCwd: string | undefined;

    const result = await dispatchRules(
      [makeRule({ name: "rule-a" })],
      "diff --git a/x b/x",
      false,
      async (_useAdvisor, cwd) => {
        capturedCwd = cwd;

        // Assert seeding happened BEFORE this factory (and therefore
        // before any session/prompt work) runs, and before dispatchRules'
        // finally-block cleanup has any chance to remove it.
        expect(path.isAbsolute(cwd)).toBe(true);
        expect(cwd).not.toBe(process.cwd());
        expect(cwd.startsWith(os.tmpdir()) || cwd.includes(os.tmpdir())).toBe(true);

        const agentFile = path.join(cwd, ".pi", "agents", "reviewer.md");
        expect(existsSync(agentFile)).toBe(true);

        const contents = readFileSync(agentFile, "utf-8");
        expect(contents).toContain("name: reviewer");
        // Must declare exactly the restricted read-only tool list...
        expect(contents).toMatch(/^tools:\s*read,\s*grep,\s*find,\s*ls\s*$/m);
        // ...and must NOT grant any mutating/comms tool.
        expect(contents).not.toMatch(/^tools:.*\bbash\b/m);
        expect(contents).not.toMatch(/^tools:.*\bedit\b/m);
        expect(contents).not.toMatch(/^tools:.*\bwrite\b/m);
        expect(contents).not.toMatch(/^tools:.*\bintercom\b/m);

        return stub.session;
      },
    );

    expect(result).toEqual({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] });
    expect(capturedCwd).toBeDefined();
  });

  // Given dispatchRules completes successfully, Then the temp directory it
  // created and seeded is removed afterward — it must not leak across CI
  // runs.
  it("removes the temp session directory after a successful dispatchRules run", async () => {
    const stub = createPiSessionStub(JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }));
    let capturedCwd: string | undefined;

    await dispatchRules([makeRule({ name: "rule-a" })], "diff --git a/x b/x", false, async (_useAdvisor, cwd) => {
      capturedCwd = cwd;
      return stub.session;
    });

    expect(capturedCwd).toBeDefined();
    expect(existsSync(capturedCwd as string)).toBe(false);
  });

  // Given the session throws during dispatchRules' error/fallback path
  // (session.prompt() rejects, handled by the existing AC-5.4 fallback
  // contract), Then the temp directory is STILL removed — cleanup must
  // happen on the error path too, not only the happy path.
  it("removes the temp session directory even when session.prompt() throws (error/fallback path)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedCwd: string | undefined;
    const throwingSession = {
      prompt: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
      getLastAssistantText: () => "should never be read",
    };

    const result = await dispatchRules(
      [makeRule({ name: "rule-a" })],
      "diff --git a/x b/x",
      false,
      async (_useAdvisor, cwd) => {
        capturedCwd = cwd;
        return throwingSession;
      },
    );

    expect(result).toMatchObject({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    expect(result.ruleFailureReasons?.["rule-a"]).toMatch(/orchestrator did not complete/i);
    expect(capturedCwd).toBeDefined();
    expect(existsSync(capturedCwd as string)).toBe(false);
    warnSpy.mockRestore();
  });

  // Given the real (default) session factory is used — i.e. the production
  // code path, with the pi SDK module mocked so no real session is
  // constructed — When dispatchRules runs, Then `createAgentSession` is
  // called with a `cwd` option pointing at a temp directory, not
  // `process.cwd()`, and the `DefaultResourceLoader` used for that session
  // is likewise constructed with that same temp directory as `cwd`.
  it("the real session factory calls createAgentSession with a temp-dir cwd, not process.cwd()", async () => {
    hoisted.resourceLoaderInstances.length = 0;
    hoisted.createAgentSessionMock.mockClear();
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () => JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
      },
    });

    const rules = [makeRule({ name: "rule-a" })];
    await dispatchRules(rules, "diff --git a/x b/x", false);

    expect(hoisted.createAgentSessionMock).toHaveBeenCalledTimes(1);
    const callArgs = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as { cwd: string };
    expect(callArgs.cwd).toBeDefined();
    expect(callArgs.cwd).not.toBe(process.cwd());
    expect(path.isAbsolute(callArgs.cwd)).toBe(true);

    expect(hoisted.resourceLoaderInstances).toHaveLength(1);
    expect(hoisted.resourceLoaderInstances[0]?.options.cwd).toBe(callArgs.cwd);

    // The real factory path also cleans up after itself.
    expect(existsSync(callArgs.cwd)).toBe(false);
  });
});

// Bug fix (found via a real multi-model run against hmchangw/chat#490):
// pi-subagents' intercom bridge defaults to mode "always", which makes a
// PARALLEL run "detach for intercom coordination" — multi-turn work our
// single-shot orchestrator can't do, failing every task at once. The fix
// disables the bridge via a hermetic PI_CODING_AGENT_DIR (see
// createIsolatedAgentDir). These tests pin: (a) the setup is real-factory-only
// (a stub factory never mutates the env or symlinks the real ~/.pi/agent), and
// (b) on the real path the env points at a temp agent dir seeded with
// intercomBridge.mode: "off" DURING the session, then is restored and removed.
describe("dispatchRules intercom-bridge disable (hermetic agent dir)", () => {
  it("does NOT mutate PI_CODING_AGENT_DIR when a stub session factory is injected", async () => {
    // Set a distinctive value so a broken gate (which would overwrite it with
    // a temp dir during the session) is detectable AT the moment the factory
    // runs — checking only post-call state would miss it, since the restore
    // logic makes the net effect zero even when the gate is broken.
    const sentinel = "/tmp/tgd-test-sentinel-agent-dir";
    const hadBefore = "PI_CODING_AGENT_DIR" in process.env;
    const realBefore = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = sentinel;

    let envDuringFactory: string | undefined;
    const stub = createPiSessionStub(
      JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
    );
    await dispatchRules([makeRule({ name: "rule-a" })], "diff --git a/x b/x", false, async () => {
      envDuringFactory = process.env.PI_CODING_AGENT_DIR;
      return stub.session;
    });

    // The stub path must never touch the env — the sentinel is intact both
    // DURING the factory call and after.
    expect(envDuringFactory).toBe(sentinel);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(sentinel);

    // Restore the test's own env change.
    if (hadBefore) process.env.PI_CODING_AGENT_DIR = realBefore;
    else delete process.env.PI_CODING_AGENT_DIR;
  });

  it("bug fix (real run, hmchangw/chat#490): the real factory points PI_CODING_AGENT_DIR at a hermetic agent dir seeded with intercomBridge.mode:off during the session, then restores and removes it", async () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    hoisted.resourceLoaderInstances.length = 0;
    hoisted.createAgentSessionMock.mockClear();

    let agentDirDuringSession: string | undefined;
    let configDuringSession: string | undefined;
    hoisted.createAgentSessionMock.mockImplementationOnce(async () => {
      // Captured at session-creation time, i.e. while dispatchRules is inside
      // its try block with the override active.
      agentDirDuringSession = process.env.PI_CODING_AGENT_DIR;
      if (agentDirDuringSession) {
        configDuringSession = readFileSync(
          path.join(agentDirDuringSession, "extensions", "subagent", "config.json"),
          "utf-8",
        );
      }
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          getLastAssistantText: () =>
            JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
        },
      };
    });

    await dispatchRules([makeRule({ name: "rule-a" })], "diff --git a/x b/x", false);

    // During the session the env pointed at a hermetic temp agent dir, NOT the
    // real one, seeded with the intercom bridge turned off.
    expect(agentDirDuringSession).toBeDefined();
    expect(agentDirDuringSession).not.toBe(before);
    expect(agentDirDuringSession?.startsWith(os.tmpdir()) || agentDirDuringSession?.includes(os.tmpdir())).toBe(true);
    expect(configDuringSession).toBeDefined();
    expect(JSON.parse(configDuringSession as string)).toEqual({ intercomBridge: { mode: "off" } });

    // Afterward the env is restored to exactly its prior state and the temp
    // agent dir is removed.
    expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
    expect(existsSync(agentDirDuringSession as string)).toBe(false);
  });

  // Companion to the above: exercises the OTHER restore branch — when
  // PI_CODING_AGENT_DIR was ALREADY set to a specific value before
  // dispatchRules, it must be restored to exactly that value (not deleted,
  // not corrupted to the literal "undefined"). This is the corruption-prone
  // branch the previous test doesn't cover (it runs with the env unset).
  it("restores PI_CODING_AGENT_DIR to its prior VALUE (not unset) when it was already set", async () => {
    const hadBefore = "PI_CODING_AGENT_DIR" in process.env;
    const realBefore = process.env.PI_CODING_AGENT_DIR;
    const preExisting = "/tmp/tgd-test-preexisting-agent-dir";
    process.env.PI_CODING_AGENT_DIR = preExisting;

    hoisted.resourceLoaderInstances.length = 0;
    hoisted.createAgentSessionMock.mockClear();

    let agentDirDuringSession: string | undefined;
    hoisted.createAgentSessionMock.mockImplementationOnce(async () => {
      agentDirDuringSession = process.env.PI_CODING_AGENT_DIR;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          getLastAssistantText: () =>
            JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
        },
      };
    });

    await dispatchRules([makeRule({ name: "rule-a" })], "diff --git a/x b/x", false);

    // During the session it was overridden to the temp dir...
    expect(agentDirDuringSession).toBeDefined();
    expect(agentDirDuringSession).not.toBe(preExisting);
    // ...and afterward restored to the exact prior value, still present in env.
    expect("PI_CODING_AGENT_DIR" in process.env).toBe(true);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(preExisting);

    // Restore the test's own env change.
    if (hadBefore) process.env.PI_CODING_AGENT_DIR = realBefore;
    else delete process.env.PI_CODING_AGENT_DIR;
  });
});

// Deterministic reconciliation of the orchestrator's self-reported result
// against the subagent tool's structured details.results — the "fix all"
// hardening (found via hmchangw/chat#490). See dispatchRules /
// reconcileWithCapturedResults. A session that supports subscribe() emits one
// subagent tool_execution_end event carrying details.results; dispatchRules
// uses those to correct rulesRun/rulesFailed and recover dropped findings.
describe("dispatchRules deterministic reconciliation (details.results)", () => {
  const twoRules = () => [
    makeRule({ name: "grok-review", provider: "xai", model: "grok-4.5" }),
    makeRule({ name: "terra-review", provider: "openai-codex", model: "gpt-5.6-terra" }),
  ];

  it("corrects a task the orchestrator wrongly marked failed but which actually ran (exit 0)", async () => {
    const details = [
      { model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" },
      { model: "openai-codex/gpt-5.6-terra:high", exitCode: 0, finalOutput: "[]" },
    ];
    const buggyFinal = JSON.stringify({ findings: [], rulesRun: ["grok-review"], rulesFailed: ["terra-review"] });
    const session = makeSubscribableSession(details, buggyFinal);

    const result = await dispatchRules(twoRules(), "diff", false, async () => session);

    expect([...result.rulesRun].sort()).toEqual(["grok-review", "terra-review"]);
    expect(result.rulesFailed).toEqual([]);
  });

  it("recovers a whole rule's findings from finalOutput when the orchestrator dropped them", async () => {
    const terraFinding = { file: "a.go", line: 1, severity: "warning", category: "correctness", message: "bug" };
    const details = [
      { model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" },
      { model: "openai-codex/gpt-5.6-terra:high", exitCode: 0, finalOutput: JSON.stringify([terraFinding]) },
    ];
    const buggyFinal = JSON.stringify({ findings: [], rulesRun: ["grok-review"], rulesFailed: ["terra-review"] });
    const session = makeSubscribableSession(details, buggyFinal);

    const result = await dispatchRules(twoRules(), "diff", false, async () => session);

    expect([...result.rulesRun].sort()).toEqual(["grok-review", "terra-review"]);
    expect(result.findings).toContainEqual({ ...terraFinding, ruleName: "terra-review" });
  });

  it("with advisor ON, does NOT recover a dropped rule's raw findings (recovering would undo the advisor's false-positive filtering) — but still corrects accounting", async () => {
    const terraFinding = { file: "a.go", line: 1, severity: "warning", category: "correctness", message: "maybe-false-positive" };
    const details = [
      { model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" },
      { model: "openai-codex/gpt-5.6-terra:high", exitCode: 0, finalOutput: JSON.stringify([terraFinding]) },
    ];
    // Orchestrator ran the advisor pass and it removed ALL of terra's findings
    // (legitimately, as false positives) → zero findings for terra, but terra
    // DID run. With advisor on we must NOT re-add terra's raw finalOutput.
    const finalWithAdvisor = JSON.stringify({ findings: [], rulesRun: ["grok-review", "terra-review"], rulesFailed: [] });
    const session = makeSubscribableSession(details, finalWithAdvisor);

    // useAdvisor = true (4th arg)
    const result = await dispatchRules(twoRules(), "diff", true, async () => session);

    // Accounting still deterministically correct: both ran.
    expect([...result.rulesRun].sort()).toEqual(["grok-review", "terra-review"]);
    expect(result.rulesFailed).toEqual([]);
    // But the advisor-removed finding is NOT resurrected.
    expect(result.findings).toEqual([]);
  });

  it("keeps the orchestrator's (advisor-filtered) findings and does NOT re-add raw ones when the rule was not dropped", async () => {
    const rules = [makeRule({ name: "grok-review", provider: "xai", model: "grok-4.5" })];
    const rawFinding = { file: "a.go", line: 1, severity: "warning", category: "x", message: "raw" };
    const advisorKept = {
      file: "a.go",
      line: 1,
      severity: "warning",
      category: "x",
      message: "advisor-kept",
      ruleName: "grok-review",
    };
    const details = [{ model: "xai/grok-4.5:high", exitCode: 0, finalOutput: JSON.stringify([rawFinding]) }];
    const final = JSON.stringify({ findings: [advisorKept], rulesRun: ["grok-review"], rulesFailed: [] });
    const session = makeSubscribableSession(details, final);

    const result = await dispatchRules(rules, "diff", false, async () => session);

    expect(result.findings).toEqual([advisorKept]);
  });

  it("marks a genuinely failed task (exit != 0) as rulesFailed and drops any findings the orchestrator attributed to it", async () => {
    const details = [
      { model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" },
      { model: "openai-codex/gpt-5.6-terra:high", exitCode: 1, error: "No API key found for openai-codex" },
    ];
    const final = JSON.stringify({
      findings: [{ file: "x", line: null, severity: "warning", category: "c", message: "m", ruleName: "terra-review" }],
      rulesRun: ["grok-review", "terra-review"],
      rulesFailed: [],
    });
    const session = makeSubscribableSession(details, final);

    const result = await dispatchRules(twoRules(), "diff", false, async () => session);

    expect(result.rulesRun).toEqual(["grok-review"]);
    expect(result.rulesFailed).toEqual(["terra-review"]);
    expect(result.findings).toEqual([]);
  });

  it("falls back to the orchestrator's result when captured count != rules count (no safe order mapping)", async () => {
    const details = [{ model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" }];
    const orch = JSON.stringify({ findings: [], rulesRun: ["grok-review"], rulesFailed: ["terra-review"] });
    const session = makeSubscribableSession(details, orch);

    const result = await dispatchRules(twoRules(), "diff", false, async () => session);

    expect(result.rulesRun).toEqual(["grok-review"]);
    expect(result.rulesFailed).toEqual(["terra-review"]);
  });

  it("falls back when a captured model doesn't match its positional rule (order not verifiable)", async () => {
    // Results delivered in the WRONG order (terra first) — each model no longer
    // prefix-matches its positional rule, so reconciliation must not trust it.
    const details = [
      { model: "openai-codex/gpt-5.6-terra:high", exitCode: 0, finalOutput: "[]" },
      { model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" },
    ];
    const orch = JSON.stringify({ findings: [], rulesRun: ["grok-review"], rulesFailed: ["terra-review"] });
    const session = makeSubscribableSession(details, orch);

    const result = await dispatchRules(twoRules(), "diff", false, async () => session);

    expect(result.rulesRun).toEqual(["grok-review"]);
    expect(result.rulesFailed).toEqual(["terra-review"]);
  });

  it("a session without subscribe() skips reconciliation entirely (uses the orchestrator's result as-is)", async () => {
    const stub = createPiSessionStub(
      JSON.stringify({ findings: [], rulesRun: ["grok-review"], rulesFailed: ["terra-review"] }),
    );
    const result = await dispatchRules(twoRules(), "diff", false, async () => stub.session);

    expect(result.rulesRun).toEqual(["grok-review"]);
    expect(result.rulesFailed).toEqual(["terra-review"]);
  });
});

// Fork-safety fix (hmchangw/chat#490): the orchestrating session is now
// PERSISTED so a `context: "fork"` subagent call can never crash regardless of
// the LLM's choice. See createRealDispatchSession's SessionManager.create.
describe("dispatchRules persisted session (fork-safety)", () => {
  it("createRealDispatchSession uses SessionManager.create (persisted), never .inMemory()", async () => {
    hoisted.createAgentSessionMock.mockClear();
    hoisted.sessionManagerCreate.mockClear();
    hoisted.sessionManagerInMemory.mockClear();
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () =>
          JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
      },
    });

    await dispatchRules([makeRule({ name: "rule-a" })], "diff --git a/x b/x", false);

    expect(hoisted.sessionManagerCreate).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionManagerInMemory).not.toHaveBeenCalled();
    const opts = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as { sessionManager: unknown };
    expect(opts.sessionManager).toBe("fake-persisted-session-manager");
  });
});

// Follow-up fix (found via hmchangw/chat#490 runs): a dispatched reviewer
// occasionally returned prose instead of the JSON findings contract, so its
// findings weren't extractable. Root cause: the vendored reviewer agent's
// system prompt (systemPromptMode: replace) had a "## Review output format"
// section instructing PROSE markdown, directly contradicting the task-level
// JSON contract. These tests pin the vendored agent's output contract so that
// conflict can't silently return.
describe("vendored reviewer agent output contract", () => {
  const reviewerMd = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../src/review/builtin-agents/reviewer.md",
    ),
    "utf-8",
  );

  it("instructs JSON-array-only output and does NOT carry the old prose '## Review' format", () => {
    // JSON-array-only contract present.
    expect(reviewerMd).toMatch(/ONLY the JSON array/i);
    expect(reviewerMd).toMatch(/first character of your response must be `\[`/i);
    // The old prose format (which conflicted with the JSON contract) is gone.
    expect(reviewerMd).not.toMatch(/^- Correct:/m);
    expect(reviewerMd).not.toMatch(/^- Blocker:/m);
  });

  it("does not set defaultReads (self-contained review tasks; avoids spurious plan.md/progress.md findings)", () => {
    // Frontmatter is the block between the first two `---` lines.
    const frontmatter = reviewerMd.split("---")[1] ?? "";
    expect(frontmatter).not.toMatch(/defaultReads/);
  });

  it("still declares exactly the restricted read-only tool set (regression guard alongside the output-format change)", () => {
    expect(reviewerMd).toMatch(/^tools:\s*read,\s*grep,\s*find,\s*ls\s*$/m);
    expect(reviewerMd).not.toMatch(/^tools:.*\b(bash|edit|write|intercom)\b/m);
  });
});

// Leniency safety net (same follow-up): even with the reviewer instructed to
// emit ONLY the array, if a model wraps it in preamble/trailing prose the
// recovery path must still extract the findings rather than silently losing
// them. Exercised through the public API (dispatchRules recovery path, advisor
// off) since the parser itself is internal.
describe("dispatchRules recovery tolerates preamble/trailing prose around the findings array", () => {
  it("recovers a dropped rule's findings even when its finalOutput has prose around the JSON array", async () => {
    const rules = [makeRule({ name: "grok-review", provider: "xai", model: "grok-4.5" })];
    const finding = { file: "a.go", line: 7, severity: "warning", category: "correctness", message: "off-by-one" };
    // finalOutput wraps the array in preamble + trailing prose (contract violation).
    const messyOutput = `Here is my review of the diff:\n\n[${JSON.stringify(finding)}]\n\nThat's all I found.`;
    const details = [{ model: "xai/grok-4.5:high", exitCode: 0, finalOutput: messyOutput }];
    // Orchestrator dropped the rule (prose confused it); advisor OFF so recovery runs.
    const buggyFinal = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["grok-review"] });
    const session = makeSubscribableSession(details, buggyFinal);

    const result = await dispatchRules(rules, "diff", false, async () => session);

    expect(result.rulesRun).toEqual(["grok-review"]);
    expect(result.rulesFailed).toEqual([]);
    expect(result.findings).toContainEqual({ ...finding, ruleName: "grok-review" });
  });

  it("returns no recovered findings when finalOutput is pure prose with no JSON array at all", async () => {
    const rules = [makeRule({ name: "grok-review", provider: "xai", model: "grok-4.5" })];
    const details = [
      { model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "I reviewed the code and everything looks fine to me." },
    ];
    const buggyFinal = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["grok-review"] });
    const session = makeSubscribableSession(details, buggyFinal);

    const result = await dispatchRules(rules, "diff", false, async () => session);

    // Accounting still corrected (it ran, exit 0), but nothing recoverable.
    expect(result.rulesRun).toEqual(["grok-review"]);
    expect(result.findings).toEqual([]);
  });
});

// Issue #1 (github.com/julianshen/tGDBot/issues/1): a cron/headless run died
// with the cryptic `No API key found for undefined`. Root cause: dispatchRules
// replaces PI_CODING_AGENT_DIR with a HERMETIC temp agent dir holding only
// symlinks to auth.json/models.json/settings.json — and when the source
// auth.json didn't exist, it was silently skipped, yielding a credential-free
// agent dir. pi's model registry then had zero providers, so the resolved model
// had no `provider` field, and ~30s later prompt() blew up with an error naming
// neither auth.json nor the directory.
//
// The fix is DIAGNOSABILITY, not fail-fast — a missing auth.json is legitimate
// (the shipped GitHub Actions workflow authenticates purely via env vars, with
// no auth.json anywhere), so it must stay non-fatal AND stay quiet on that
// healthy path. Two complementary signals instead:
//   (a) createAgentSession's `modelFallbackMessage` — the SDK's own structured
//       "No models available" signal, previously destructured away. It is set
//       exactly when zero providers resolved, and is absent when env-var auth
//       works, so it is silent on healthy runs.
//   (b) an auth-context note appended to the pi auth error, naming the resolved
//       agent dir and distinguishing "absent" from "exists but couldn't link".
describe("issue #1: credential-free agent dir is diagnosable", () => {
  const AUTH_ERROR = "No API key found for undefined.\n\nUse /login to log into a provider";
  const tempDirs: string[] = [];

  // Both reviewers flagged this: getAgentDirMock is shared and mockReturnValue
  // persists, and the temp dirs leaked. Restore + clean after every test so
  // this block can't poison the pre-existing real-factory tests (which expect
  // "/fake/agent/dir") regardless of file order or vitest sequence.shuffle.
  afterEach(() => {
    hoisted.getAgentDirMock.mockReturnValue("/fake/agent/dir");
    hoisted.failSymlinkFor.name = null;
    // Nit from review: an un-consumed mockImplementationOnce would leak into the
    // next test if one of these ever threw before dispatchRules ran.
    hoisted.createAgentSessionMock.mockReset();
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function realSessionThatThrows(message: string, modelFallbackMessage?: string) {
    hoisted.createAgentSessionMock.mockImplementationOnce(async () => ({
      modelFallbackMessage,
      session: {
        prompt: vi.fn().mockRejectedValue(new Error(message)),
        getLastAssistantText: () => undefined,
      },
    }));
  }

  function realSessionOk(modelFallbackMessage?: string) {
    hoisted.createAgentSessionMock.mockImplementationOnce(async () => ({
      modelFallbackMessage,
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () =>
          JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
      },
    }));
  }

  function agentDir({ withAuth }: { withAuth: boolean }): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tgd-test-agentdir-"));
    tempDirs.push(dir);
    if (withAuth) {
      writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "openai-codex": {} }), "utf-8");
    }
    hoisted.getAgentDirMock.mockReturnValue(dir);
    return dir;
  }

  function warnings(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  // The pi auth error is itself MULTI-LINE, so the appended hint lands after a
  // newline — inspect each console.warn call whole rather than splitting.
  function promptWarn(spy: ReturnType<typeof vi.spyOn>): string | undefined {
    return spy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("session.prompt() threw"));
  }

  // (a) The SDK signal we used to throw away. This is the EARLY diagnosis —
  // it fires at session creation, before the 30-second detonation in prompt().
  it("surfaces pi's modelFallbackMessage (\"No models available\") instead of discarding it", async () => {
    agentDir({ withAuth: false });
    realSessionOk("No models available. Use /login to log into a provider via OAuth or API key.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    expect(warnings(warn)).toMatch(/could not resolve a model/i);
    expect(warnings(warn)).toMatch(/No models available/);
    warn.mockRestore();
  });

  // The whole reason the fix is diagnostics-only: this healthy path (env-var
  // auth, exactly what .github/workflows/tgd-review.yml does) must stay SILENT.
  // A warning that fires on every good CI run is a warning nobody reads.
  it("stays silent AND non-fatal when auth.json is absent but credentials resolve (env-var auth — the shipped CI workflow)", async () => {
    agentDir({ withAuth: false });
    realSessionOk(undefined); // pi resolved a model from env vars → no fallback message
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    expect(result.rulesRun).toEqual(["rule-a"]);
    expect(result.rulesFailed).toEqual([]);
    // No auth noise at all on the healthy env-var path.
    expect(warnings(warn)).not.toMatch(/auth\.json/);
    expect(warnings(warn)).not.toMatch(/could not resolve a model/i);
    warn.mockRestore();
  });

  // (b) The exact issue #1 failure: the opaque SDK error now names its cause.
  it("annotates the pi auth error with the resolved agent dir when auth.json was ABSENT", async () => {
    const dir = agentDir({ withAuth: false });
    realSessionThatThrows(AUTH_ERROR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    const promptWarnMsg = promptWarn(warn);
    expect(promptWarnMsg).toContain("No API key found"); // original SDK message kept
    expect(promptWarnMsg).toMatch(/no auth\.json was found/i); // ...now with the cause
    expect(promptWarnMsg).toContain(dir); // ...and the RESOLVED dir
    expect(promptWarnMsg).toMatch(/PI_CODING_AGENT_DIR/); // ...and where to look
    expect(result.rulesFailed).toEqual(["rule-a"]);
    warn.mockRestore();
  });

  // Mutation-testing gap found in verification review: deleting the
  // `authStatus = "link-failed"` assignment in createIsolatedAgentDir left the
  // whole suite green, because only the PURE describeAuthContext was tested. If
  // that wiring regresses, a container that simply cannot symlink (EPERM) would
  // once again be told "no auth.json was found — PI_CODING_AGENT_DIR is likely
  // not pointing where you think" while the file sits right there. Pin the
  // END-TO-END path: real createIsolatedAgentDir -> real authStatus -> message.
  it("wires link-failed end-to-end: a real symlink failure yields the EXISTS message, not the absent one", async () => {
    const dir = agentDir({ withAuth: true }); // auth.json really is there
    hoisted.failSymlinkFor.name = "auth.json"; // ...but it cannot be linked
    realSessionThatThrows(AUTH_ERROR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    const msg = promptWarn(warn);
    expect(msg).toMatch(/EXISTS/);
    expect(msg).toContain(dir);
    // The confident lie must NOT come back.
    expect(msg).not.toMatch(/no auth\.json was found/i);
    expect(msg).not.toMatch(/not pointing where you think/i);
    warn.mockRestore();
  });

  it("adds NO auth context when auth.json linked fine (no misleading noise)", async () => {
    const dir = agentDir({ withAuth: true });
    realSessionThatThrows(AUTH_ERROR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    const promptWarnMsg = promptWarn(warn);
    // Structural assertion (not prose-coupled): a linked auth.json means the
    // agent-dir path must never be appended to the error at all.
    expect(promptWarnMsg).not.toContain(dir);
    warn.mockRestore();
  });

  it("adds NO auth context to a NON-auth error, even when auth.json is absent", async () => {
    const dir = agentDir({ withAuth: false });
    realSessionThatThrows("ECONNRESET: socket hang up");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    const promptWarnMsg = promptWarn(warn);
    expect(promptWarnMsg).toContain("ECONNRESET");
    // A network error has nothing to do with auth.json — don't misdirect.
    expect(promptWarnMsg).not.toContain(dir);
    expect(promptWarnMsg).not.toMatch(/auth\.json/);
    warn.mockRestore();
  });
});

// Reviewer catch: conflating "auth.json is absent" with "auth.json exists but
// couldn't be symlinked" makes the tool confidently LIE — it would tell someone
// to go check PI_CODING_AGENT_DIR when the file is exactly where they put it,
// while the real cause (a filesystem that can't symlink, e.g. EPERM in a locked
// -down container) goes unmentioned. describeAuthContext is the single source of
// this wording, so pin all three states here — a pure function, no mocking, and
// it can't drift from what dispatchRules actually appends.
describe("issue #1: describeAuthContext distinguishes the two auth failure causes", () => {
  const DIR = "/home/julianshen/.pi/agent";

  it("says nothing when auth.json linked fine", () => {
    expect(describeAuthContext("linked", DIR)).toBeUndefined();
  });

  it("ABSENT: names the dir, explains env-var fallback, and points at PI_CODING_AGENT_DIR", () => {
    const msg = describeAuthContext("absent", DIR) as string;
    expect(msg).toContain(DIR);
    expect(msg).toMatch(/no auth\.json was found/i);
    expect(msg).toMatch(/environment variables/i);
    expect(msg).toMatch(/PI_CODING_AGENT_DIR/);
  });

  it("LINK-FAILED: says the file EXISTS — and does NOT misdirect to PI_CODING_AGENT_DIR", () => {
    const msg = describeAuthContext("link-failed", DIR) as string;
    expect(msg).toContain(DIR);
    expect(msg).toMatch(/EXISTS/);
    expect(msg).toMatch(/could not be linked/i);
    // The path is correct in this case — sending the reader to re-check it
    // would waste their time and hide the real cause.
    expect(msg).not.toMatch(/no auth\.json was found/i);
    expect(msg).not.toMatch(/not pointing where you think/i);
  });
});

// Issue #1, round 2 — the ACTUAL design flaw. The orchestrating session was
// created WITHOUT a `model` option, so pi fell back to "from settings, else
// first available" — the machine's ambient default. tGDBot's core function was
// BOUND to a global it cannot verify: on the cron box that default would not
// resolve and the whole review died, even though every rule declared a good
// model of its own.
//
// Resolution order is now: --model → pi's settings default → each rule's model
// → pi's own auth-aware default. EVERY candidate is gated on hasConfiguredAuth,
// because ModelRegistry.find() is a pure NAME lookup with no credential check
// and setting `options.model` SHORT-CIRCUITS the SDK's auth-aware selection —
// so passing an un-credentialed model is strictly WORSE than passing none
// (guaranteed `No API key found` → fallbackResult → every rule marked failed).
describe("issue #1 (round 2): orchestrator model — explicit → settings → rules, all credential-gated", () => {
  const AGENT_DIR_WITH_DEFAULT = (spec?: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tgd-test-orch-"));
    agentDirs.push(dir);
    if (spec) {
      const [provider, ...rest] = spec.split("/");
      writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: rest.join("/") }),
        "utf-8",
      );
    }
    hoisted.getAgentDirMock.mockReturnValue(dir);
    return dir;
  };
  const agentDirs: string[] = [];

  afterEach(() => {
    hoisted.getAgentDirMock.mockReturnValue("/fake/agent/dir");
    hoisted.createAgentSessionMock.mockReset();
    hoisted.findModelMock.mockClear();
    hoisted.findModelMock.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: `${provider}/${modelId}`,
    }));
    hoisted.hasConfiguredAuthMock.mockClear();
    hoisted.hasConfiguredAuthMock.mockReturnValue(true);
    for (const d of agentDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function okSession() {
    hoisted.createAgentSessionMock.mockImplementationOnce(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () =>
          JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
      },
    }));
  }

  function chosen(): { provider: string; id: string } | undefined {
    const args = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as {
      model?: { provider: string; id: string };
    };
    return args?.model;
  }
  const warnings = (spy: ReturnType<typeof vi.spyOn>): string =>
    spy.mock.calls.map((c) => String(c[0])).join("\n");

  // Healthy machines must keep the model they already had. Rule models are
  // chosen for their RULE's job (someone may pin a cheap model to a style rule);
  // silently demoting the orchestrator onto one would be an unannounced quality
  // regression. Gating it on credentials is what stops it being a hard binding.
  it("prefers pi's settings default when it HAS credentials (no silent downgrade for healthy users)", async () => {
    AGENT_DIR_WITH_DEFAULT("openai-codex/gpt-5.6-terra");
    okSession();
    const rules = [makeRule({ name: "rule-a", provider: "xai", model: "grok-4.5" })];

    await dispatchRules(rules, "diff", false);

    expect(chosen()).toMatchObject({ provider: "openai-codex", id: "gpt-5.6-terra" });
  });

  // THE issue #1 SCENARIO: the settings default can't be used → fall through to
  // the rules instead of dying.
  it("falls through to the RULES when pi's settings default has no credentials (the cron-box bug)", async () => {
    AGENT_DIR_WITH_DEFAULT("openai-codex/gpt-5.6-luna"); // the cron box's broken default
    okSession();
    hoisted.hasConfiguredAuthMock.mockImplementation((m: { provider: string }) => m.provider === "xai");
    const rules = [makeRule({ name: "rule-a", provider: "xai", model: "grok-4.5" })];

    const result = await dispatchRules(rules, "diff", false);

    expect(chosen()).toMatchObject({ provider: "xai", id: "grok-4.5" });
    expect(result.rulesRun).toEqual(["rule-a"]); // review survives
  });

  // THE CRITICAL ONE (round-1 review). Mirrors the shipped CI workflow: only
  // ANTHROPIC_API_KEY is set, but rules[0] is pinned to openai-codex. Passing an
  // un-credentialed model would fail EVERY rule.
  it("skips candidates with NO credentials and picks the first that has them (no total wipeout)", async () => {
    AGENT_DIR_WITH_DEFAULT(undefined); // no settings default
    okSession();
    hoisted.hasConfiguredAuthMock.mockImplementation(
      (m: { provider: string }) => m.provider === "anthropic",
    );
    const rules = [
      makeRule({ name: "rule-a", provider: "openai-codex", model: "gpt-5.6-terra" }), // no key here
      makeRule({ name: "rule-b", provider: "anthropic", model: "claude-opus-4-5" }), // key present
    ];

    const result = await dispatchRules(rules, "diff", false);

    expect(chosen()).toMatchObject({ provider: "anthropic", id: "claude-opus-4-5" });
    expect(result.rulesRun).toEqual(["rule-a"]);
  });

  it("never hands the session an UN-CREDENTIALED model — falls back to pi's own auth-aware default", async () => {
    AGENT_DIR_WITH_DEFAULT(undefined);
    okSession();
    hoisted.hasConfiguredAuthMock.mockReturnValue(false); // nothing is authed
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules([makeRule({ name: "rule-a" })], "diff", false);

    expect(chosen()).toBeUndefined(); // → pi picks an *available* model itself
    expect(warnings(warn)).toMatch(/no orchestrator model with configured credentials/i);
    expect(result.rulesRun).toEqual(["rule-a"]); // still never hard-fails
    warn.mockRestore();
  });

  it("an explicit --model outranks both the settings default and the rules", async () => {
    AGENT_DIR_WITH_DEFAULT("openai-codex/gpt-5.6-terra");
    okSession();
    const rules = [makeRule({ provider: "xai", model: "grok-4.5" })];

    await dispatchRules(rules, "diff", false, undefined, "anthropic/claude-opus-4-5");

    expect(chosen()).toMatchObject({ provider: "anthropic", id: "claude-opus-4-5" });
  });

  // Review finding: previously an unusable --model fell straight back to pi's
  // AMBIENT default — the very thing broken on the cron box — making --model
  // STRICTLY WORSE than omitting it. It must fall through the remaining
  // candidates instead.
  it("an unusable --model warns and falls through to the other candidates (never straight to the ambient default)", async () => {
    AGENT_DIR_WITH_DEFAULT(undefined);
    okSession();
    hoisted.hasConfiguredAuthMock.mockImplementation((m: { provider: string }) => m.provider === "xai");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = [makeRule({ name: "rule-a", provider: "xai", model: "grok-4.5" })];

    await dispatchRules(rules, "diff", false, undefined, "anthropic/claude-opus-4-5"); // no creds

    // Fell through to the rule's model — NOT undefined (which would mean the
    // ambient default), and NOT the un-credentialed explicit one.
    expect(chosen()).toMatchObject({ provider: "xai", id: "grok-4.5" });
    expect(warnings(warn)).toMatch(/--model "anthropic\/claude-opus-4-5" has no configured credentials/i);
    warn.mockRestore();
  });

  // Review finding: pi-subagents resolves a rule's model fuzzily (it strips a
  // thinking suffix), but ModelRegistry.find() is EXACT. Without stripping, a
  // rule written `model: claude-opus-4-5:high` would run fine as a subagent yet
  // be silently skipped as an orchestrator candidate.
  it("strips a thinking-level suffix so `model: x:high` still resolves (find() is exact; pi-subagents is fuzzy)", async () => {
    AGENT_DIR_WITH_DEFAULT(undefined);
    okSession();

    await dispatchRules([makeRule()], "diff", false, undefined, "anthropic/claude-opus-4-5:high");

    expect(hoisted.findModelMock).toHaveBeenCalledWith("anthropic", "claude-opus-4-5");
  });

  it("splits provider/model on the FIRST slash, so model ids containing slashes survive", async () => {
    AGENT_DIR_WITH_DEFAULT(undefined);
    okSession();

    await dispatchRules([makeRule()], "diff", false, undefined, "openrouter/vendor/model-x");

    expect(hoisted.findModelMock).toHaveBeenCalledWith("openrouter", "vendor/model-x");
  });

  // Duplicate specs are legitimate (--model may equal the settings default; two
  // rules may share a model). Without dedup we'd re-query the registry and warn
  // about the same rejected model twice — observed live.
  it("dedupes candidates, so a rejected model is reported once, not once per duplicate", async () => {
    AGENT_DIR_WITH_DEFAULT("anthropic/claude-opus-4-5"); // settings default == --model below
    okSession();
    hoisted.hasConfiguredAuthMock.mockImplementation((m: { provider: string }) => m.provider === "xai");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchRules(
      [makeRule({ name: "rule-a", provider: "xai", model: "grok-4.5" })],
      "diff",
      false,
      undefined,
      "anthropic/claude-opus-4-5",
    );

    const hits = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("has no configured credentials"));
    expect(hits).toHaveLength(1); // exactly once, despite the duplicate
    expect(chosen()).toMatchObject({ provider: "xai", id: "grok-4.5" }); // still falls through
    warn.mockRestore();
  });

  // Rule/settings candidates are routine automatic selection — narrating their
  // rejection would print on every healthy CI run (the round-1 lesson).
  it("stays QUIET when skipping an unauthenticated RULE candidate (no CI warning noise)", async () => {
    AGENT_DIR_WITH_DEFAULT(undefined);
    okSession();
    hoisted.hasConfiguredAuthMock.mockImplementation(
      (m: { provider: string }) => m.provider === "anthropic",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchRules(
      [
        makeRule({ name: "rule-a", provider: "openai-codex", model: "gpt-5.6-terra" }),
        makeRule({ name: "rule-b", provider: "anthropic", model: "claude-opus-4-5" }),
      ],
      "diff",
      false,
    );

    expect(warnings(warn)).toBe("");
    warn.mockRestore();
  });
});

// Smoke-test finding: a rule's subagent can fail (e.g. no API key for its
// pinned provider) and NOTHING anywhere said why — not stderr, not the PR
// comment. The cause was already captured in the subagent tool's
// details.results[i].error and then dropped on the floor.
//
// Two audiences, two levels of detail, deliberately:
//   - stderr (private CI logs): the RAW provider error, for the operator.
//   - PR comment (PUBLIC): a CLASSIFIED reason only. Raw provider errors can
//     echo request details, and the comment is world-readable on a public repo.
describe("failed rules report WHY (smoke-test finding)", () => {
  it("classifies a missing-credentials failure and exposes it as a rule failure reason", async () => {
    const rules = [makeRule({ name: "tgd-review", provider: "anthropic", model: "claude-opus-4-5" })];
    const details = [
      {
        model: "anthropic/claude-opus-4-5:high",
        exitCode: 1,
        error: "No API key found for anthropic. Use /login to log into a provider",
      },
    ];
    const final = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["tgd-review"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules(rules, "diff", false, async () =>
      makeSubscribableSession(details, final),
    );

    expect(result.rulesFailed).toEqual(["tgd-review"]);
    // PUBLIC comment reason: classified + names the provider, no raw error text.
    expect(result.ruleFailureReasons?.["tgd-review"]).toMatch(/no working credentials/i);
    expect(result.ruleFailureReasons?.["tgd-review"]).toContain("anthropic");
    // stderr: the RAW error, for whoever is reading CI logs.
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toMatch(/tgd-review/);
    expect(messages).toMatch(/No API key found for anthropic/);
    warn.mockRestore();
  });

  it("does NOT leak the raw provider error into the public comment reason (generic branch)", async () => {
    const rules = [makeRule({ name: "rule-a", provider: "anthropic", model: "claude-opus-4-5" })];
    // Deliberately a NON-auth error, so this exercises the generic
    // "errored (see the CI logs...)" branch — the one someone would be tempted to
    // "improve" by appending the raw message. Routing through the auth branch
    // would make this test near-tautological (that branch interpolates nothing).
    const secretish = "boom: upstream rejected token sk-abc123SECRET while streaming";
    const details = [{ model: "anthropic/claude-opus-4-5:high", exitCode: 1, error: secretish }];
    const final = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules(rules, "diff", false, async () =>
      makeSubscribableSession(details, final),
    );

    const publicReason = result.ruleFailureReasons?.["rule-a"] ?? "";
    // The comment is world-readable — raw provider text must never reach it.
    expect(publicReason).not.toContain("sk-abc123SECRET");
    expect(publicReason).not.toContain(secretish);
    expect(publicReason.length).toBeGreaterThan(0); // but it still says SOMETHING
    warn.mockRestore();
  });

  it("classifies a timeout distinctly from a generic failure", async () => {
    const rules = [
      makeRule({ name: "slow-rule", provider: "xai", model: "grok-4.5" }),
      makeRule({ name: "odd-rule", provider: "xai", model: "grok-4.5" }),
    ];
    const details = [
      { model: "xai/grok-4.5:high", exitCode: 1, timedOut: true },
      { model: "xai/grok-4.5:high", exitCode: 7 },
    ];
    const final = JSON.stringify({
      findings: [],
      rulesRun: [],
      rulesFailed: ["slow-rule", "odd-rule"],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules(rules, "diff", false, async () =>
      makeSubscribableSession(details, final),
    );

    expect(result.ruleFailureReasons?.["slow-rule"]).toMatch(/timed out/i);
    expect(result.ruleFailureReasons?.["odd-rule"]).toMatch(/exit(ed)? .*7/i);
    warn.mockRestore();
  });

  it("reports no reasons for rules that SUCCEEDED (no spurious noise)", async () => {
    const rules = [makeRule({ name: "ok-rule", provider: "xai", model: "grok-4.5" })];
    const details = [{ model: "xai/grok-4.5:high", exitCode: 0, finalOutput: "[]" }];
    const final = JSON.stringify({ findings: [], rulesRun: ["ok-rule"], rulesFailed: [] });

    const result = await dispatchRules(rules, "diff", false, async () =>
      makeSubscribableSession(details, final),
    );

    expect(result.rulesFailed).toEqual([]);
    expect(result.ruleFailureReasons ?? {}).toEqual({});
  });
});

// Review findings on the first draft of this fix.
describe("failed-rule reasons: review fixes", () => {
  // BOTH reviewers caught this. A bare /401|403/ matches those digits ANYWHERE —
  // "retry after 4030ms", "40312 tokens", "req_011CS401xyz" — and the result is
  // PUBLISHED in the PR comment. Telling a maintainer "no working credentials"
  // when the truth was a rate limit sends them to rotate a healthy key. Being
  // confidently wrong is worse than the silence this change exists to fix.
  it("does NOT misclassify rate-limit / timeout / token-count errors as auth failures", async () => {
    const nonAuthErrors = [
      "429 rate_limit_error: retry after 4030ms",
      "context length 40312 tokens exceeds limit",
      "500 Internal Server Error (request_id: req_011CS401xyz)",
      "Error: connection reset after 4013 ms",
    ];
    for (const error of nonAuthErrors) {
      const rules = [makeRule({ name: "r", provider: "anthropic", model: "claude-opus-4-5" })];
      const details = [{ model: "anthropic/claude-opus-4-5:high", exitCode: 1, error }];
      const final = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["r"] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await dispatchRules(rules, "diff", false, async () =>
        makeSubscribableSession(details, final),
      );

      expect(result.ruleFailureReasons?.["r"], `misclassified: ${error}`).not.toMatch(
        /no working credentials/i,
      );
      warn.mockRestore();
    }
  });

  it("still classifies genuine auth failures (incl. an anchored 401)", async () => {
    for (const error of [
      "No API key found for anthropic",
      "401 Unauthorized",
      "HTTP 403 forbidden",
    ]) {
      const rules = [makeRule({ name: "r", provider: "anthropic", model: "claude-opus-4-5" })];
      const details = [{ model: "anthropic/claude-opus-4-5:high", exitCode: 1, error }];
      const final = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["r"] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await dispatchRules(rules, "diff", false, async () =>
        makeSubscribableSession(details, final),
      );

      expect(result.ruleFailureReasons?.["r"], `missed: ${error}`).toMatch(/no working credentials/i);
      warn.mockRestore();
    }
  });

  // Review finding: without this, every ORCHESTRATOR-level failure still rendered
  // the bare "- rule-name" list — the symptom survived in the fallback paths.
  it("stamps a reason even when the ORCHESTRATOR itself fails (fallbackResult path)", async () => {
    const rules = [makeRule({ name: "rule-a" })];
    const throwing: DispatchSession = {
      prompt: vi.fn().mockRejectedValue(new Error("session exploded")),
      getLastAssistantText: () => undefined,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules(rules, "diff", false, async () => throwing);

    expect(result.rulesFailed).toEqual(["rule-a"]);
    expect(result.ruleFailureReasons?.["rule-a"]).toMatch(/orchestrator did not complete/i);
    warn.mockRestore();
  });

  // A rule literally named "__proto__" must not render "[object Object]".
  it("survives a rule named __proto__ (null-prototype reason map)", async () => {
    const rules = [makeRule({ name: "__proto__", provider: "xai", model: "grok-4.5" })];
    const details = [{ model: "xai/grok-4.5:high", exitCode: 1, error: "boom" }];
    const final = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["__proto__"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules(rules, "diff", false, async () =>
      makeSubscribableSession(details, final),
    );

    const reason = result.ruleFailureReasons?.["__proto__"];
    expect(typeof reason).toBe("string");
    expect(reason).not.toMatch(/\[object Object\]/);
    warn.mockRestore();
  });

  // rule.provider is rule-file-sourced and lands inside a code span in a
  // world-readable comment; a crafted value must not break out and inject markdown.
  it("sanitizes rule.provider so it cannot break out of the comment code span", async () => {
    const evil = "x`\n\n### ✅ All rules passed\n\n`y";
    const rules = [makeRule({ name: "r", provider: evil, model: "m" })];
    const details = [{ exitCode: 1, error: "No API key found" }]; // no model => order trusted
    const final = JSON.stringify({ findings: [], rulesRun: [], rulesFailed: ["r"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRules(rules, "diff", false, async () =>
      makeSubscribableSession(details, final),
    );

    const reason = result.ruleFailureReasons?.["r"] ?? "";
    // The security property is BREAKOUT, not the payload's mere presence: with
    // backticks and newlines stripped, the value stays inert INSIDE the code span
    // (rendered as literal code), so it cannot open a heading or close the span.
    const provider = /`([^`]*)`/.exec(reason)?.[1] ?? "";
    expect(reason.match(/`/g)).toHaveLength(2); // exactly the span's own two backticks
    expect(provider).not.toMatch(/[`\r\n|]/);
    expect(provider.length).toBeLessThanOrEqual(60); // capped
    warn.mockRestore();
  });
});
