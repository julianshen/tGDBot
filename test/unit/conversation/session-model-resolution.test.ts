import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveRuleSessionModelMock } = vi.hoisted(() => ({
  resolveRuleSessionModelMock: vi.fn(),
}));

vi.mock("../../../src/review/orchestrator-model.js", () => ({
  resolveRuleSessionModel: resolveRuleSessionModelMock,
}));

import { runConversationSession } from "../../../src/conversation/session.js";

afterEach(() => {
  resolveRuleSessionModelMock.mockReset();
  vi.restoreAllMocks();
});

describe("conversation model resolution failures", () => {
  it("returns a redacted transient outcome when model resolution rejects", async () => {
    const credential = `sk-ant-${"a".repeat(24)}`;
    resolveRuleSessionModelMock.mockRejectedValueOnce(
      new Error(`unable to read auth for Bearer ${credential}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runConversationSession("prompt", {
      model: "anthropic/claude-opus-4-5",
    });

    expect(result).toMatchObject({ ok: false, transient: true });
    const diagnostics = warnSpy.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("[redacted]");
    expect(diagnostics).not.toContain(credential);
  });
});
