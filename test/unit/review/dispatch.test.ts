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
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  it("bug fix (real run, hmchangw/chat#490): the dispatch prompt instructs context: fresh and forbids fork (fork needs a persisted session, which we don't use)", () => {
    const rules = [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })];

    const prompt = buildDispatchPrompt(rules, "diff --git a/x b/x", false);

    expect(prompt).toContain('"fresh"');
    expect(prompt).toMatch(/context/i);
    expect(prompt).toMatch(/fork/i);
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

    expect(result).toEqual({ findings: [], rulesRun: [], rulesFailed: ["rule-a"] });
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
    const before = process.env.PI_CODING_AGENT_DIR;
    const hadBefore = "PI_CODING_AGENT_DIR" in process.env;

    const stub = createPiSessionStub(
      JSON.stringify({ findings: [], rulesRun: ["rule-a"], rulesFailed: [] }),
    );
    await dispatchRules([makeRule({ name: "rule-a" })], "diff --git a/x b/x", false, async () => stub.session);

    expect("PI_CODING_AGENT_DIR" in process.env).toBe(hadBefore);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
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
});
