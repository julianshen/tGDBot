// Verifies review()'s DEFAULT dependency wiring — i.e. that
// `deps.resolveConfig ?? resolveConfigReal` (and the loadRules/dispatchRules/
// orchestrate equivalents) actually reference the real, correctly-imported
// functions from config.ts/rules/loader.ts/review/dispatch.ts/
// review/orchestrate.ts, with no typo'd import or wrong-reference bug.
//
// test/unit/cli-review.test.ts exercises review()'s CONTROL FLOW via fully
// injected deps and never runs this default-parameter code path at all.
// This file instead calls review(args) with NO injected deps, mocking the
// underlying modules (not review()'s parameters) — the same "mock the SDK
// module, exercise the real factory" approach Task 5's AC-5.1 used for
// dispatchRules' default session factory — so the real default wiring runs
// end-to-end against mocks, never against real `gh`, the network, or a real
// pi SDK session.
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getDiff: vi.fn(),
  findBotComment: vi.fn(),
  upsertComment: vi.fn(),
}));

vi.mock("../../src/vcs/github-adapter.js", () => ({
  GitHubAdapter: class {
    getPullRequest = hoisted.getPullRequest;
    getDiff = hoisted.getDiff;
    findBotComment = hoisted.findBotComment;
    upsertComment = hoisted.upsertComment;
  },
  realExecGh: vi.fn(),
}));

vi.mock("../../src/rules/loader.js", () => ({
  loadRules: vi.fn(),
}));

vi.mock("../../src/review/dispatch.js", () => ({
  dispatchRules: vi.fn(),
}));

vi.mock("../../src/review/orchestrate.js", () => ({
  orchestrate: vi.fn(),
}));

import { review } from "../../src/cli.js";
import type { CliArgs } from "../../src/cli.js";
import { loadRules } from "../../src/rules/loader.js";
import { dispatchRules } from "../../src/review/dispatch.js";
import { orchestrate } from "../../src/review/orchestrate.js";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    pr: "42",
    vcs: "github",
    rulesDir: ".tgd-review/rules",
    disableBuiltinRule: false,
    advisor: "on",
    dryRun: false,
    ...overrides,
  };
}

describe("review — default dependency wiring", () => {
  it("with no injected deps, resolves the real config/loadRules/dispatchRules/orchestrate wiring against mocked modules (never real gh/network/LLM)", async () => {
    hoisted.getPullRequest.mockResolvedValue({
      id: "42",
      headSha: "wired1234",
      baseSha: "base0000",
      title: "Real wiring PR",
      description: "desc",
    });
    hoisted.getDiff.mockResolvedValue("diff --git a/x b/x");
    hoisted.findBotComment.mockResolvedValue(null);
    hoisted.upsertComment.mockResolvedValue(undefined);

    vi.mocked(loadRules).mockResolvedValue({
      rules: [
        {
          name: "rule-a",
          provider: "anthropic",
          model: "claude-opus-4-5",
          body: "Check for bugs.",
          sourcePath: "/rules/rule-a.md",
        },
      ],
      errors: [],
    });
    vi.mocked(dispatchRules).mockResolvedValue({
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
    vi.mocked(orchestrate).mockReturnValue({
      commentBody: "## Code Review\n\nNo issues found.",
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // No `deps` argument at all — exercises `resolveConfigReal`,
    // `loadRulesReal`, `dispatchRulesReal`, `orchestrateReal` directly.
    const exitCode = await review(makeArgs());

    expect(exitCode).toBe(0);

    // resolveConfigReal must have constructed a real GitHubAdapter (our
    // mocked class) and review() must have driven it correctly.
    expect(hoisted.getPullRequest).toHaveBeenCalledWith("42");
    expect(hoisted.findBotComment).toHaveBeenCalledWith("42");
    expect(hoisted.getDiff).toHaveBeenCalledWith("42");
    expect(hoisted.upsertComment).toHaveBeenCalledTimes(1);

    const [prId, body, existing] = hoisted.upsertComment.mock.calls[0];
    expect(prId).toBe("42");
    expect(existing).toBeNull();
    expect(body).toContain("<!-- tgd-review-agent:sha=wired1234 -->");

    // The real loadRulesReal/dispatchRulesReal/orchestrateReal references
    // were actually invoked (not silently skipped by a typo'd default).
    expect(loadRules).toHaveBeenCalledWith(".tgd-review/rules", true);
    expect(dispatchRules).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "rule-a" })]),
      "diff --git a/x b/x",
      true,
    );
    expect(orchestrate).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("with vcs: gitlab and no injected deps, the real resolveConfig throws the Phase 2 error", async () => {
    await expect(review(makeArgs({ vcs: "gitlab" }))).rejects.toThrow(
      /GitLab support not yet implemented \(Phase 2\)/,
    );
  });
});
