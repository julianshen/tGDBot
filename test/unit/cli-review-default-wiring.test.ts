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
  getRuleFilesFromBase: vi.fn(),
}));

vi.mock("../../src/vcs/github-adapter.js", () => ({
  GitHubAdapter: class {
    getPullRequest = hoisted.getPullRequest;
    getDiff = hoisted.getDiff;
    findBotComment = hoisted.findBotComment;
    upsertComment = hoisted.upsertComment;
    getRuleFilesFromBase = hoisted.getRuleFilesFromBase;
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
    trustLocalRules: false,
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
    hoisted.getRuleFilesFromBase.mockResolvedValue([]);

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

    // ADR-002 CLI-native fix: rules are now sourced from the PR's base
    // branch via getRuleFilesFromBase, not the literal --rules-dir path.
    expect(hoisted.getRuleFilesFromBase).toHaveBeenCalledWith("base0000", ".tgd-review/rules");

    // The real loadRulesReal/dispatchRulesReal/orchestrateReal references
    // were actually invoked (not silently skipped by a typo'd default) —
    // loadRules is called with a fresh temp directory (not the literal
    // --rules-dir path, which by default is now only a repo-relative
    // lookup key for the base-branch fetch above).
    expect(loadRules).toHaveBeenCalledTimes(1);
    const [loadedDir, includeBuiltin] = vi.mocked(loadRules).mock.calls[0];
    expect(loadedDir).not.toBe(".tgd-review/rules");
    expect(includeBuiltin).toBe(true);
    // Issue #1 (round 2): review() now wires dispatchRules through an adapter so
    // the --model string lands in the 5th (orchestratorModel) slot, NOT the 4th
    // (createSession factory). The 4th must stay `undefined` so dispatchRules
    // keeps its real default factory — asserting it here is what would catch a
    // regression that silently passes the model string as the session factory.
    expect(dispatchRules).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "rule-a" })]),
      "diff --git a/x b/x",
      true,
      undefined, // createSession → real default (NOT the model string)
      undefined, // orchestratorModel → none given; dispatchRules derives it from the rules
    );
    expect(orchestrate).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("with vcs: gitlab and no injected deps, the real resolveConfig throws the Phase 2 error", async () => {
    await expect(review(makeArgs({ vcs: "gitlab" }))).rejects.toThrow(
      /GitLab support not yet implemented \(Phase 2\)/,
    );
  });

  // Slot-pinning with a REAL model: with --model absent, slots 4 and 5 are both
  // `undefined`, so the assertion above cannot tell them apart. Setting a model
  // makes it behavioral — a slot swap (the model string landing in the
  // session-factory slot) fails loudly here.
  it("passes --model into the orchestratorModel slot (5th), never the session-factory slot (4th)", async () => {
    const { dispatchRules } = await import("../../src/review/dispatch.js");
    vi.mocked(dispatchRules).mockClear();
    vi.mocked(dispatchRules).mockResolvedValue({
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(makeArgs({ model: "x/y" }));

    expect(dispatchRules).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      true,
      undefined, // createSession → real default
      "x/y", // orchestratorModel
    );
    logSpy.mockRestore();
  });
});
