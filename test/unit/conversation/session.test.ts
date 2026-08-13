// Isolation tests for read-only conversational AgentSessions. These sessions
// explain/reconsider/answer/focus; they must never see the reviewed checkout
// or receive mutating, provider, or memory tools.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSessionStub } from "../../fixtures/pi-session-stub.js";
import type { DispatchSession } from "../../../src/review/dispatch.js";

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
  const createReadOnlyToolsMock = vi.fn((cwd: string) => ({ scopedTo: cwd }));
  const findModelMock = vi.fn((provider: string, modelId: string) => ({
    id: modelId,
    provider,
    name: `${provider}/${modelId}`,
  }));
  const hasConfiguredAuthMock = vi.fn(() => true);
  return {
    resourceLoaderInstances,
    FakeResourceLoader,
    createAgentSessionMock,
    createReadOnlyToolsMock,
    findModelMock,
    hasConfiguredAuthMock,
    sessionManagerInMemory: vi.fn(() => "fake-session-manager"),
    getAgentDirMock: vi.fn(() => "/fake/agent/dir"),
    authStorageCreate: vi.fn(() => "fake-auth-storage"),
    modelRegistryCreate: vi.fn(() => ({
      find: findModelMock,
      hasConfiguredAuth: hasConfiguredAuthMock,
      getAvailable: vi.fn((): { provider: string; id: string }[] => []),
    })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: hoisted.FakeResourceLoader,
  createAgentSession: hoisted.createAgentSessionMock,
  createReadOnlyTools: hoisted.createReadOnlyToolsMock,
  SessionManager: { inMemory: hoisted.sessionManagerInMemory },
  getAgentDir: hoisted.getAgentDirMock,
  AuthStorage: { create: hoisted.authStorageCreate },
  ModelRegistry: { create: hoisted.modelRegistryCreate },
}));

import {
  CONVERSATION_READ_ONLY_TOOLS,
  MAX_CONVERSATION_PROMPT_CHARS,
  MAX_CONVERSATION_RESPONSE_CHARS,
  runConversationSession,
  type ConversationSessionFactory,
} from "../../../src/conversation/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  hoisted.resourceLoaderInstances.length = 0;
  hoisted.createAgentSessionMock.mockReset();
  hoisted.createReadOnlyToolsMock.mockClear();
  hoisted.findModelMock.mockClear();
  hoisted.hasConfiguredAuthMock.mockReset();
  hoisted.hasConfiguredAuthMock.mockReturnValue(true);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const MODEL = "anthropic/claude-opus-4-5";

function capturingFactory(
  session: DispatchSession,
  capture: { cwd?: string; tools?: readonly string[]; model?: { provider: string; id: string } },
): ConversationSessionFactory {
  return async (request) => {
    capture.cwd = request.cwd;
    capture.tools = request.tools;
    capture.model = request.model;
    expect(path.isAbsolute(request.cwd)).toBe(true);
    expect(existsSync(request.cwd)).toBe(true);
    return session;
  };
}

describe("runConversationSession isolation", () => {
  it("creates a fresh isolated temp CWD that is not process.cwd() or the target checkout", async () => {
    const target = await tempDir("tgd-target-checkout-");
    await writeFile(path.join(target, "secret.ts"), "export const secret = 1;\n", "utf8");
    const stub = createPiSessionStub('{"explanation":"ok"}');
    const captured: { cwd?: string; entries?: string[] } = {};

    const result = await runConversationSession("explain this finding", {
      model: MODEL,
      createSession: async (request) => {
        captured.cwd = request.cwd;
        captured.entries = readdirSync(request.cwd);
        expect(path.isAbsolute(request.cwd)).toBe(true);
        expect(existsSync(request.cwd)).toBe(true);
        return stub.session;
      },
    });

    expect(result).toMatchObject({ ok: true, text: '{"explanation":"ok"}' });
    expect(captured.cwd).toBeDefined();
    expect(captured.cwd).not.toBe(process.cwd());
    expect(captured.cwd).not.toBe(target);
    expect(captured.cwd!.startsWith(os.tmpdir()) || captured.cwd!.includes(os.tmpdir())).toBe(true);
    expect(captured.entries ?? []).not.toContain("secret.ts");
    expect(path.relative(captured.cwd!, target).startsWith("..")).toBe(true);
  });

  it("does not grant bash, edit, write, provider, or memory tools", async () => {
    const stub = createPiSessionStub("{}");
    const captured: { tools?: readonly string[] } = {};

    await runConversationSession("prompt", {
      model: MODEL,
      createSession: capturingFactory(stub.session, captured),
    });

    expect(captured.tools).toEqual([...CONVERSATION_READ_ONLY_TOOLS]);
    expect(captured.tools).toEqual(["read", "grep", "find", "ls"]);
    for (const forbidden of ["bash", "edit", "write", "intercom", "subagent", "advisor", "provider", "memory"]) {
      expect(captured.tools).not.toContain(forbidden);
    }
  });

  it("resolves the model explicitly instead of inheriting pi's ambient default", async () => {
    const stub = createPiSessionStub("{}");
    const captured: { model?: { provider: string; id: string } } = {};

    const result = await runConversationSession("prompt", {
      model: MODEL,
      createSession: capturingFactory(stub.session, captured),
    });

    expect(result).toMatchObject({ ok: true });
    expect(captured.model).toEqual({ provider: "anthropic", id: "claude-opus-4-5" });
    expect(result).toMatchObject({ model: { provider: "anthropic", id: "claude-opus-4-5" } });
  });

  it("rejects a prompt above the 100,000-character ceiling without creating a session", async () => {
    const createSession = vi.fn(async () => createPiSessionStub("ok").session);
    const result = await runConversationSession("x".repeat(MAX_CONVERSATION_PROMPT_CHARS + 1), {
      model: MODEL,
      createSession,
    });

    expect(result).toMatchObject({ ok: false, transient: true });
    expect(createSession).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/x{100}/);
  });

  it("rejects a response above the 100,000-character ceiling", async () => {
    const stub = createPiSessionStub("y".repeat(MAX_CONVERSATION_RESPONSE_CHARS + 1));
    const result = await runConversationSession("prompt", {
      model: MODEL,
      createSession: async () => stub.session,
    });

    expect(result).toMatchObject({ ok: false, transient: true });
    expect(JSON.stringify(result)).not.toContain("y".repeat(32));
  });

  it("removes the isolated CWD after a successful run", async () => {
    const stub = createPiSessionStub("{}");
    const captured: { cwd?: string } = {};
    await runConversationSession("prompt", {
      model: MODEL,
      createSession: capturingFactory(stub.session, captured),
    });
    expect(captured.cwd).toBeDefined();
    expect(existsSync(captured.cwd as string)).toBe(false);
  });

  it("removes the isolated CWD when prompt() throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured: { cwd?: string } = {};
    const result = await runConversationSession("prompt", {
      model: MODEL,
      createSession: capturingFactory(
        {
          prompt: vi.fn().mockRejectedValue(new Error("No API key found for anthropic sk-ant-secret")),
          getLastAssistantText: () => "unused",
        },
        captured,
      ),
    });

    expect(result).toMatchObject({ ok: false, transient: true });
    expect(captured.cwd).toBeDefined();
    expect(existsSync(captured.cwd as string)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/sk-ant-secret|No API key found/i);
    warnSpy.mockRestore();
  });

  it("removes the isolated CWD when session creation throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedCwd: string | undefined;
    const result = await runConversationSession("prompt", {
      model: MODEL,
      createSession: async (request) => {
        capturedCwd = request.cwd;
        throw new Error("factory exploded");
      },
    });

    expect(result).toMatchObject({ ok: false, transient: true });
    expect(capturedCwd).toBeDefined();
    expect(existsSync(capturedCwd as string)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("factory exploded");
    warnSpy.mockRestore();
  });

  it("cannot reach a target checkout through relative paths from the session CWD", async () => {
    const target = await tempDir("tgd-reviewed-repo-");
    writeFileSync(path.join(target, "payload.ts"), "ATTACK", "utf8");
    const stub = createPiSessionStub("{}");
    const captured: { cwd?: string } = {};

    await runConversationSession("prompt", {
      model: MODEL,
      createSession: capturingFactory(stub.session, captured),
    });

    const cwd = captured.cwd as string;
    const escape = path.resolve(cwd, path.relative(cwd, target));
    expect(escape).toBe(path.resolve(target));
    expect(path.relative(cwd, escape).startsWith("..")).toBe(true);
    expect(existsSync(path.join(cwd, "payload.ts"))).toBe(false);
    const entries = existsSync(cwd) ? readdirSync(cwd) : [];
    expect(entries).not.toContain("payload.ts");
  });
});

describe("runConversationSession real factory hermetics", () => {
  it("builds a read-only session on an isolated CWD with no* discovery flags and an explicit model", async () => {
    hoisted.createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        getLastAssistantText: () => '{"explanation":"real"}',
      },
    });

    const result = await runConversationSession("prompt", { model: MODEL });

    expect(result).toMatchObject({ ok: true, text: '{"explanation":"real"}' });
    expect(hoisted.resourceLoaderInstances).toHaveLength(1);
    const loader = hoisted.resourceLoaderInstances[0]!.options;
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true);
    expect(loader.noPromptTemplates).toBe(true);
    expect(loader.noThemes).toBe(true);
    expect(loader.noContextFiles).toBe(true);
    expect(loader.cwd).toBeDefined();
    expect(loader.cwd).not.toBe(process.cwd());

    expect(hoisted.createReadOnlyToolsMock).toHaveBeenCalledWith(loader.cwd);
    expect(hoisted.createAgentSessionMock).toHaveBeenCalledTimes(1);
    const sessionOptions = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as {
      cwd: string;
      tools: string[];
      model: { provider: string; id: string };
      customTools: unknown;
    };
    expect(sessionOptions.cwd).toBe(loader.cwd);
    expect(sessionOptions.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(sessionOptions.model).toMatchObject({ provider: "anthropic", id: "claude-opus-4-5" });
    expect(sessionOptions.customTools).toEqual({ scopedTo: loader.cwd });
    expect(existsSync(sessionOptions.cwd)).toBe(false);
  });

  it("returns a transient error with no session when the explicit model has no credentials", async () => {
    hoisted.hasConfiguredAuthMock.mockReturnValue(false);
    const result = await runConversationSession("prompt", { model: MODEL });

    expect(result).toMatchObject({ ok: false, transient: true });
    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/No API key found|auth\.json|ANTHROPIC_API_KEY/i);
  });
});

describe("conversation session bounds", () => {
  it("publishes the 100,000-character prompt and response ceilings", () => {
    expect(MAX_CONVERSATION_PROMPT_CHARS).toBe(100_000);
    expect(MAX_CONVERSATION_RESPONSE_CHARS).toBe(100_000);
  });
});
