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
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getDiff: vi.fn(),
  findBotComment: vi.fn(),
  upsertComment: vi.fn(),
  getRuleFilesFromBase: vi.fn(),
  createInlineReview: vi.fn(),
  resolveStaleReviewThreads: vi.fn(),
  resolveRelatedWork: vi.fn(),
  gitLabConstructed: vi.fn(),
}));

vi.mock("../../src/vcs/github-adapter.js", () => ({
  GitHubAdapter: class {
    getPullRequest = hoisted.getPullRequest;
    createInlineReview = hoisted.createInlineReview;
    getDiff = hoisted.getDiff;
    findBotComment = hoisted.findBotComment;
    upsertComment = hoisted.upsertComment;
    getRuleFilesFromBase = hoisted.getRuleFilesFromBase;
    resolveStaleReviewThreads = hoisted.resolveStaleReviewThreads;
    resolveRelatedWork = hoisted.resolveRelatedWork;
  },
  realExecGh: vi.fn(),
}));

vi.mock("../../src/vcs/gitlab-adapter.js", () => ({
  GitLabAdapter: class {
    constructor() {
      hoisted.gitLabConstructed();
    }
    getPullRequest = hoisted.getPullRequest;
    createInlineReview = hoisted.createInlineReview;
    getDiff = hoisted.getDiff;
    findBotComment = hoisted.findBotComment;
    upsertComment = hoisted.upsertComment;
    getRuleFilesFromBase = hoisted.getRuleFilesFromBase;
    resolveStaleReviewThreads = hoisted.resolveStaleReviewThreads;
    resolveRelatedWork = hoisted.resolveRelatedWork;
  },
  realExecGlab: vi.fn(),
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

vi.mock("../../src/review/orchestrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/review/orchestrate.js")>();
  return { ...actual, orchestrate: vi.fn() };
});

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { review } from "../../src/cli.js";
import type { CliArgs } from "../../src/cli.js";
import { loadRules } from "../../src/rules/loader.js";
import { dispatchRules } from "../../src/review/dispatch.js";
import { dispatchRulesDirect } from "../../src/review/direct-dispatch.js";
import { orchestrate } from "../../src/review/orchestrate.js";
import { parseBotMarker } from "../../src/review/comment-marker.js";
import { emptyOrchestration } from "../helpers/orchestration.js";

const stateRoots: string[] = [];
afterEach(() => {
  for (const directory of stateRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ambientLocator = { kind: "ambient", provider: "github", number: 42 } as const;

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    pr: "42",
    vcs: "github",
    rulesDir: ".review/rules",
    disableBuiltinRule: false,
    advisor: "on",
    prIntent: "on",
    suggestions: "on",
    dependencyFacts: "off",
    structuralChecks: "off",
    dryRun: false,
    trustLocalRules: false,
    dispatch: "direct",
    // This file exercises DEFAULT wiring, so nothing here is injected. Context
    // stays off: mapping needs a real git mirror and a model session, and a
    // wiring test must not reach for either.
    context: "off",
    allowDegradedContext: false,
    stateDir: overrides.stateDir ?? (stateRoots.push(realpathSync(mkdtempSync(path.join(os.tmpdir(), "tgd-wiring-state-")))), stateRoots.at(-1)),
    ...overrides,
  };
}

describe("review — default dependency wiring", () => {
  it("with no injected deps, resolves the real config/loadRules/dispatchRules/orchestrate wiring against mocked modules (never real gh/network/LLM)", async () => {
    // `url` is what carries the resolved owner/repo for an ambient locator, so
    // GitHubAdapter always asks `gh pr view` for it. The double has to supply it
    // too: conversation state and every published marker bind to the canonical
    // repository identity, which ambient mode can only derive from this URL.
    hoisted.getPullRequest.mockResolvedValue({
      id: "42",
      headSha: "abc12345",
      baseSha: "base0000",
      title: "Real wiring PR",
      description: "desc",
      url: "https://github.com/owner/repo/pull/42",
    });
    hoisted.getDiff.mockResolvedValue("diff --git a/x b/x");
    hoisted.findBotComment.mockResolvedValue(null);
    hoisted.upsertComment.mockImplementation(
      (_locator, body: string, existing: { id: string } | null) => Promise.resolve({
        id: existing?.id ?? "written-summary-1",
        body,
        ...(parseBotMarker(body) ?? { lastReviewedSha: "", reviewedConfig: "" }),
      }),
    );
    hoisted.getRuleFilesFromBase.mockResolvedValue([]);
    hoisted.resolveStaleReviewThreads.mockResolvedValue(0);

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
    vi.mocked(orchestrate).mockReturnValue(emptyOrchestration({
      commentBody: "**No actionable comments.** ✅",
      inlineComments: [],
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: [],
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // No `deps` argument at all — exercises `resolveConfigReal`,
    // `loadRulesReal`, `dispatchRulesReal`, `orchestrateReal` directly.
    const exitCode = await review(makeArgs());

    expect(exitCode).toBe(0);

    // resolveConfigReal must have constructed a real GitHubAdapter (our
    // mocked class) and review() must have driven it correctly.
    expect(hoisted.getPullRequest).toHaveBeenCalledWith(ambientLocator);
    expect(hoisted.findBotComment).toHaveBeenCalledWith(ambientLocator);
    // The diff is requested against the SAME head this run pinned and will
    // publish against, so an oversized-PR fallback cannot hand back a diff of
    // a newer commit (Codex review, PR #34).
    expect(hoisted.getDiff).toHaveBeenCalledWith(ambientLocator, {
      expectedHeadSha: "abc12345",
      expectedBaseSha: "base0000",
    });
    expect(hoisted.upsertComment).toHaveBeenCalledTimes(2);

    const [prId, pendingBody, existing] = hoisted.upsertComment.mock.calls[0];
    expect(prId).toEqual(ambientLocator);
    expect(existing).toBeNull();
    expect(pendingBody).toContain("<!-- tgd-review-agent:pending phase=publishing");
    expect(hoisted.upsertComment.mock.calls[1]?.[1])
      .toContain("<!-- tgd-review-agent:sha=abc12345 cfg=");

    // ADR-002 CLI-native fix: rules are now sourced from the PR's base
    // branch via getRuleFilesFromBase, not the literal --rules-dir path.
    expect(hoisted.getRuleFilesFromBase).toHaveBeenCalledWith(
      ambientLocator,
      "base0000",
      ".review/rules",
    );
    expect(hoisted.resolveStaleReviewThreads).toHaveBeenCalledWith(ambientLocator);

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
        // Issue #59: the PR's stated intent rides along as untrusted evidence.
        prIntent: { title: "Real wiring PR", description: "desc" },
      },
      {},
    );
    expect(dispatchRules).not.toHaveBeenCalled(); // legacy engine untouched
    expect(orchestrate).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("with an explicit GitLab repository, default wiring constructs and drives GitLabAdapter", async () => {
    hoisted.gitLabConstructed.mockClear();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      review(makeArgs({ vcs: "gitlab", repo: "group/project" })),
    ).resolves.toBe(0);

    expect(hoisted.gitLabConstructed).toHaveBeenCalledTimes(1);
    expect(hoisted.getPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "repository",
        repo: expect.objectContaining({
          provider: "gitlab",
          canonicalUrl: "https://gitlab.com/group/project",
        }),
        number: 42,
      }),
    );
    logSpy.mockRestore();
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
      undefined, // conversationContext when none was loaded
      undefined, // contextPacks — --context off prepares none
      { title: "Real wiring PR", description: "desc" }, // prIntent (issue #59)
    );
    expect(dispatchRulesDirect).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
