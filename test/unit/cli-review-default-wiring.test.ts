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
  createInlineReview: vi.fn(),
}));

vi.mock("../../src/vcs/github-adapter.js", () => ({
  GitHubAdapter: class {
    getPullRequest = hoisted.getPullRequest;
    createInlineReview = hoisted.createInlineReview;
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

vi.mock("../../src/review/direct-dispatch.js", () => ({
  dispatchRulesDirect: vi.fn(),
}));

vi.mock("../../src/review/orchestrate.js", () => ({
  orchestrate: vi.fn(),
}));

import { review } from "../../src/cli.js";
import type { CliArgs } from "../../src/cli.js";
import { loadRules } from "../../src/rules/loader.js";
import { dispatchRules } from "../../src/review/dispatch.js";
import { dispatchRulesDirect } from "../../src/review/direct-dispatch.js";
import { orchestrate } from "../../src/review/orchestrate.js";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    pr: "42",
    vcs: "github",
    rulesDir: ".review/rules",
    disableBuiltinRule: false,
    advisor: "on",
    dryRun: false,
    trustLocalRules: false,
    dispatch: "direct",
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
          dependsOn: [],
          body: "Check for bugs.",
          sourcePath: "/rules/rule-a.md",
        },
      ],
      errors: [],
    });
    vi.mocked(dispatchRulesDirect).mockResolvedValue({
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
    vi.mocked(orchestrate).mockReturnValue({
      commentBody: "**No actionable comments.** ✅",
      inlineComments: [],
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
    expect(body).toContain("<!-- tgd-review-agent:sha=wired1234 cfg=");

    // ADR-002 CLI-native fix: rules are now sourced from the PR's base
    // branch via getRuleFilesFromBase, not the literal --rules-dir path.
    expect(hoisted.getRuleFilesFromBase).toHaveBeenCalledWith("base0000", ".review/rules");

    // The real loadRulesReal/dispatchRulesReal/orchestrateReal references
    // were actually invoked (not silently skipped by a typo'd default) —
    // loadRules is called with a fresh temp directory (not the literal
    // --rules-dir path, which by default is now only a repo-relative
    // lookup key for the base-branch fetch above).
    expect(loadRules).toHaveBeenCalledTimes(1);
    const [loadedDir, includeBuiltin] = vi.mocked(loadRules).mock.calls[0];
    expect(loadedDir).not.toBe(".review/rules");
    expect(includeBuiltin).toBe(true);
    // Task 3: the DEFAULT engine receives one shared object-shaped input.
    // contextPacks is intentionally absent until the later context-integration
    // task; direct-only dependencies remain the second argument.
    expect(dispatchRulesDirect).toHaveBeenCalledWith(
      {
        rules: expect.arrayContaining([expect.objectContaining({ name: "rule-a" })]),
        diff: "diff --git a/x b/x",
        useAdvisor: true,
        orchestratorModel: undefined,
      },
      {},
    );
    expect(dispatchRules).not.toHaveBeenCalled(); // legacy engine untouched
    expect(orchestrate).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("with vcs: gitlab and no injected deps, the real resolveConfig throws the Phase 2 error", async () => {
    await expect(review(makeArgs({ vcs: "gitlab" }))).rejects.toThrow(
      /GitLab support not yet implemented \(Phase 2\)/,
    );
  });

  it("passes --model in the object input, never in the direct deps argument", async () => {
    vi.mocked(dispatchRulesDirect).mockClear();
    vi.mocked(dispatchRulesDirect).mockResolvedValue({
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(makeArgs({ model: "x/y" }));

    expect(dispatchRulesDirect).toHaveBeenCalledWith(
      expect.objectContaining({ orchestratorModel: "x/y" }),
      {},
    );
    logSpy.mockRestore();
  });

  it("--dispatch legacy adapts the same object input to the legacy positional API", async () => {
    vi.mocked(dispatchRules).mockClear();
    vi.mocked(dispatchRulesDirect).mockClear();
    vi.mocked(dispatchRules).mockResolvedValue({
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(makeArgs({ dispatch: "legacy", model: "x/y" }));

    expect(dispatchRules).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      true,
      undefined, // createSession → real default
      "x/y", // orchestratorModel
    );
    expect(dispatchRulesDirect).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
