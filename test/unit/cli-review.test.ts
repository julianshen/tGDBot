// Tests for the `review()` command flow — see TASKS.md Task 8 "Acceptance
// Criteria (BDD)" AC-8.1 through AC-8.6.
//
// `review()` accepts an optional dependency-injection bag (resolveConfig,
// loadRules, dispatchRules, orchestrate) so these tests never touch the real
// `gh` CLI, real network, or a real pi SDK/LLM session — same
// dependency-injection spirit as Task 5's `dispatchRules` (which itself
// takes an injectable `createSession`).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { review } from "../../src/cli.js";
import type { CliArgs } from "../../src/cli.js";
import type { ResolvedConfig } from "../../src/config.js";
import type { BotComment, PullRequestInfo, RuleFileContent, VcsAdapter } from "../../src/vcs/adapter.js";
import type { LoadResult } from "../../src/rules/loader.js";
import type { RuleDefinition } from "../../src/rules/types.js";
import type { DispatchResult } from "../../src/review/types.js";
import type { OrchestrationResult } from "../../src/review/orchestrate.js";

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

function makePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    id: "42",
    headSha: "cafef00d",
    baseSha: "deadbeef",
    title: "Some PR",
    description: "Some description",
    ...overrides,
  };
}

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

interface Harness {
  args: CliArgs;
  config: ResolvedConfig;
  vcsAdapter: {
    getPullRequest: ReturnType<typeof vi.fn>;
    getDiff: ReturnType<typeof vi.fn>;
    findBotComment: ReturnType<typeof vi.fn>;
    upsertComment: ReturnType<typeof vi.fn>;
    getRuleFilesFromBase: ReturnType<typeof vi.fn>;
  };
  resolveConfig: ReturnType<typeof vi.fn>;
  loadRules: ReturnType<typeof vi.fn>;
  dispatchRules: ReturnType<typeof vi.fn>;
  orchestrate: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  args?: CliArgs;
  pr?: PullRequestInfo;
  botComment?: BotComment | null;
  loadResult?: LoadResult;
  dispatchResult?: DispatchResult;
  orchestrationResult?: OrchestrationResult;
  ruleFilesFromBase?: RuleFileContent[];
} = {}): Harness {
  const args = options.args ?? makeArgs();
  const pr = options.pr ?? makePr();
  const botComment = options.botComment ?? null;
  const loadResult: LoadResult = options.loadResult ?? { rules: [makeRule()], errors: [] };
  const dispatchResult: DispatchResult = options.dispatchResult ?? {
    findings: [],
    rulesRun: ["rule-a"],
    rulesFailed: [],
  };
  const orchestrationResult: OrchestrationResult = options.orchestrationResult ?? {
    commentBody: "## Code Review\n\nNo issues found.",
    findingsCount: 0,
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
  };
  const ruleFilesFromBase = options.ruleFilesFromBase ?? [];

  const vcsAdapter = {
    getPullRequest: vi.fn().mockResolvedValue(pr),
    getDiff: vi.fn().mockResolvedValue("diff --git a/x b/x"),
    findBotComment: vi.fn().mockResolvedValue(botComment),
    upsertComment: vi.fn().mockResolvedValue(undefined),
    getRuleFilesFromBase: vi.fn().mockResolvedValue(ruleFilesFromBase),
  };

  const config: ResolvedConfig = { ...args, vcsAdapter: vcsAdapter as unknown as VcsAdapter };

  return {
    args,
    config,
    vcsAdapter,
    resolveConfig: vi.fn().mockReturnValue(config),
    loadRules: vi.fn().mockResolvedValue(loadResult),
    dispatchRules: vi.fn().mockResolvedValue(dispatchResult),
    orchestrate: vi.fn().mockReturnValue(orchestrationResult),
  };
}

function depsFrom(h: Harness) {
  return {
    resolveConfig: h.resolveConfig,
    loadRules: h.loadRules,
    dispatchRules: h.dispatchRules,
    orchestrate: h.orchestrate,
  };
}

describe("review", () => {
  // AC-8.1: Given a PR whose head SHA matches the bot comment's marker,
  // When review runs, Then it exits 0, logs status: "skipped", and
  // upsertComment is never called.
  it("AC-8.1: sha match skips the review, exits 0, and never calls upsertComment", async () => {
    const pr = makePr({ headSha: "cafef00d" });
    const botComment: BotComment = {
      id: "999",
      body: "<!-- tgd-review-agent:sha=cafef00d -->",
      lastReviewedSha: "cafef00d",
    };
    const h = makeHarness({ pr, botComment });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      `TGD_REVIEW_RESULT: ${JSON.stringify({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [] })}`,
    );
    // Dispatch/orchestrate machinery must not even run for a skipped review.
    expect(h.loadRules).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    // Nor should the base-branch rule fetch — no point fetching rules for a
    // review that's about to be skipped entirely.
    expect(h.vcsAdapter.getRuleFilesFromBase).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  // AC-8.2: Given a PR with no existing bot comment, When review runs
  // against stubbed rules/orchestration that succeed, Then it exits 0,
  // calls upsertComment with existing: null, and the posted body contains
  // the marker with the PR's current head SHA.
  it("AC-8.2: no existing comment creates a new one with the current head sha marker", async () => {
    const pr = makePr({ headSha: "abc1234" });
    const h = makeHarness({ pr, botComment: null });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
    const [prId, body, existing] = h.vcsAdapter.upsertComment.mock.calls[0];
    expect(prId).toBe("42");
    expect(existing).toBeNull();
    expect(body).toContain("<!-- tgd-review-agent:sha=abc1234 -->");

    vi.restoreAllMocks();
  });

  // AC-8.3: Given a PR with an existing bot comment whose marker SHA
  // differs from the current head SHA, When review runs, Then
  // upsertComment is called with existing set to that comment (an edit,
  // not a create).
  it("AC-8.3: stale existing comment triggers an edit with the existing comment passed through", async () => {
    const pr = makePr({ headSha: "newsha01" });
    const botComment: BotComment = {
      id: "555",
      body: "<!-- tgd-review-agent:sha=oldsha00 -->",
      lastReviewedSha: "oldsha00",
    };
    const h = makeHarness({ pr, botComment });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
    const [, , existing] = h.vcsAdapter.upsertComment.mock.calls[0];
    expect(existing).toEqual(botComment);

    vi.restoreAllMocks();
  });

  // AC-8.4: Given --dry-run is set, When review runs, Then the synthesized
  // body is printed to stdout and upsertComment is never called.
  it("AC-8.4: --dry-run prints the body to stdout and never calls upsertComment", async () => {
    const args = makeArgs({ dryRun: true });
    const pr = makePr();
    const h = makeHarness({ args, pr, botComment: null });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    const printedBodyCall = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("tgd-review-agent:sha="),
    );
    expect(printedBodyCall).toBeDefined();

    logSpy.mockRestore();
  });

  // AC-8.5: Given every rule fails to load, When review runs, Then it
  // exits 1 before attempting any VCS comment write.
  it("AC-8.5: all rules failing to load exits 1 without any VCS write", async () => {
    const loadResult: LoadResult = {
      rules: [],
      errors: [{ sourcePath: "/rules/bad.md", message: 'missing required frontmatter field "provider"' }],
    };
    const h = makeHarness({ botComment: null, loadResult });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(1);
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // AC-8.6: Given one rule fails during execution but at least one other
  // rule succeeds, When review runs, Then it exits 2, the comment is still
  // posted, and the comment body names the failed rule.
  it("AC-8.6: partial rule failure exits 2, still posts the comment, and names the failed rule", async () => {
    const loadResult: LoadResult = {
      rules: [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })],
      errors: [],
    };
    const dispatchResult: DispatchResult = {
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
    };
    const orchestrationResult: OrchestrationResult = {
      commentBody: "## Code Review\n\n### ⚠️ Rules that failed\n\n- rule-b",
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
    };
    const h = makeHarness({ botComment: null, loadResult, dispatchResult, orchestrationResult });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(2);
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
    const [, body] = h.vcsAdapter.upsertComment.mock.calls[0];
    expect(body).toContain("rule-b");

    vi.restoreAllMocks();
  });

  // AC-8.6 (same "partial failure must be visible" intent, applied to a
  // rule that failed to LOAD rather than a rule that failed at dispatch
  // time — Task 8 review fix #1): a partial load failure must surface in
  // console.error, the posted comment body, and the JSON status line's
  // `loadErrors` field, not just when every rule fails to load.
  it("AC-8.6: partial rule LOAD failure is surfaced in console.error, the comment body, and the status line's loadErrors — exits 2", async () => {
    const loadResult: LoadResult = {
      rules: [makeRule({ name: "rule-a" })],
      errors: [{ sourcePath: "/rules/bad.md", message: 'missing required frontmatter field "model"' }],
    };
    const dispatchResult: DispatchResult = { findings: [], rulesRun: ["rule-a"], rulesFailed: [] };
    const orchestrationResult: OrchestrationResult = {
      commentBody: "## Code Review\n\nNo issues found.",
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: [],
    };
    const h = makeHarness({ botComment: null, loadResult, dispatchResult, orchestrationResult });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(2);

    // The comment is still posted (not swallowed).
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
    const [, body] = h.vcsAdapter.upsertComment.mock.calls[0];
    expect(body).toContain("/rules/bad.md");
    expect(body).toContain('missing required frontmatter field "model"');

    // console.error names the load failure, not just in the all-rules-failed branch.
    const errorText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errorText).toContain("/rules/bad.md");

    // The final JSON status line carries the load errors so CI log
    // scrapers/dashboards see them even without reading the comment body.
    const statusCall = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].startsWith("TGD_REVIEW_RESULT: "),
    );
    expect(statusCall).toBeDefined();
    const statusJson = JSON.parse((statusCall![0] as string).slice("TGD_REVIEW_RESULT: ".length));
    expect(statusJson.loadErrors).toEqual(['/rules/bad.md: missing required frontmatter field "model"']);
    expect(statusJson.status).toBe("partial");

    vi.restoreAllMocks();
  });

  // Review fix #1: rules LOADED fine (loadErrors is empty, rules.length >
  // 0), but every rule failed at DISPATCH time (e.g. a total LLM/provider
  // outage sends dispatchRules down its fallback path, which returns
  // `rulesRun: []` / `rulesFailed: [...all rule names]`). This is
  // distinct from AC-8.5 (every rule fails to LOAD, which aborts BEFORE
  // any VCS write with exit 1). Here a comment IS posted — so exit code
  // must be EXIT_PARTIAL (2), not EXIT_FATAL (1): a CI consumer treating
  // exit 1 as "nothing happened, no VCS write" would be wrong, since a
  // comment WAS posted naming the total dispatch failure.
  it("all rules failing at DISPATCH time (not load) still posts the comment and exits 2, not 1", async () => {
    const loadResult: LoadResult = {
      rules: [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })],
      errors: [],
    };
    const dispatchResult: DispatchResult = {
      findings: [],
      rulesRun: [],
      rulesFailed: ["rule-a", "rule-b"],
    };
    const orchestrationResult: OrchestrationResult = {
      commentBody: "## Code Review\n\n### ⚠️ Rules that failed\n\nThe following rules failed to run and were skipped:\n\n- rule-a\n- rule-b",
      findingsCount: 0,
      rulesRun: [],
      rulesFailed: ["rule-a", "rule-b"],
    };
    const h = makeHarness({ botComment: null, loadResult, dispatchResult, orchestrationResult });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(2);
    // The comment WAS posted — never fail silently, even on total wipeout.
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
    const [, body] = h.vcsAdapter.upsertComment.mock.calls[0];
    expect(body).toContain("rule-a");
    expect(body).toContain("rule-b");

    vi.restoreAllMocks();
  });

  // Review fix #2: SPEC.md's exit code contract lists "missing gh/glab
  // auth" and "no such PR" as fatal (exit 1) cases. Until now that
  // behavior was only ever exercised via main()'s outer catch-all — never
  // pinned against review() itself. Reading review()'s actual source
  // (src/cli.ts) confirms it has NO try/catch of its own around
  // `config.vcsAdapter.getPullRequest`/`findBotComment`/`getDiff`: a
  // rejection there propagates straight out of `review()` as a rejected
  // promise, and it is `main()` (not `review()`) that catches it and maps
  // it to exit 1. These tests pin that actual, current behavior so a
  // future refactor that adds an inner try/catch with different
  // swallow-and-continue fallback behavior fails loudly here instead of
  // silently changing the exit-code contract.
  it("review fix #2: getPullRequest rejecting (e.g. `gh: not found` / auth error) propagates out of review() rather than being swallowed", async () => {
    const h = makeHarness();
    h.vcsAdapter.getPullRequest.mockRejectedValue(
      new Error("gh: command not found (is the GitHub CLI installed and authenticated?)"),
    );

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/gh: command not found/);

    // Nothing downstream of the failed fetch should have run.
    expect(h.vcsAdapter.findBotComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.loadRules).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
  });

  it("review fix #2: findBotComment rejecting (e.g. no such PR) propagates out of review()", async () => {
    const h = makeHarness();
    h.vcsAdapter.findBotComment.mockRejectedValue(new Error("no such PR: #42"));

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/no such PR/);

    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.loadRules).not.toHaveBeenCalled();
  });

  it("review fix #2: getDiff rejecting propagates out of review()", async () => {
    const h = makeHarness();
    h.vcsAdapter.getDiff.mockRejectedValue(new Error("gh: failed to fetch diff"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/failed to fetch diff/);

    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.loadRules).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ADR-002 / CLI-native fix: by default, review() sources rule files from the
// PR's BASE branch via vcsAdapter.getRuleFilesFromBase (never the local
// filesystem at config.rulesDir directly) — writing them into a fresh temp
// directory before handing that directory to loadRules(). --trust-local-rules
// reverts to the old local-filesystem behavior.
describe("review — base-branch rule sourcing (ADR-002 CLI-native fix)", () => {
  it("default (trustLocalRules: false): fetches rule files from the PR's base sha via getRuleFilesFromBase(baseSha, rulesDir)", async () => {
    const pr = makePr({ baseSha: "based00d" });
    const h = makeHarness({ pr, botComment: null });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.getRuleFilesFromBase).toHaveBeenCalledWith("based00d", ".tgd-review/rules");

    vi.restoreAllMocks();
  });

  it("default (trustLocalRules: false): writes the fetched rule files into a fresh temp directory and calls loadRules with THAT directory, not config.rulesDir", async () => {
    const pr = makePr({ baseSha: "based00d" });
    const ruleFilesFromBase: RuleFileContent[] = [
      { path: "security-review.md", content: "---\nname: security-review\nprovider: anthropic\nmodel: claude-opus-4-5\n---\nBody A" },
      { path: "style-guide.md", content: "---\nname: style-guide\nprovider: anthropic\nmodel: claude-opus-4-5\n---\nBody B" },
    ];
    const h = makeHarness({ pr, botComment: null, ruleFilesFromBase });
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Inspect the temp dir's contents INSIDE the loadRules mock, before
    // review()'s `finally` block cleans it up.
    let seenDir: string | undefined;
    let seenIncludeBuiltin: boolean | undefined;
    let seenFileA: string | undefined;
    let seenFileB: string | undefined;
    h.loadRules.mockImplementation(async (dir: string, includeBuiltin: boolean) => {
      seenDir = dir;
      seenIncludeBuiltin = includeBuiltin;
      seenFileA = readFileSync(path.join(dir, "security-review.md"), "utf-8");
      seenFileB = readFileSync(path.join(dir, "style-guide.md"), "utf-8");
      return { rules: [makeRule()], errors: [] };
    });

    await review(h.args, depsFrom(h));

    expect(h.loadRules).toHaveBeenCalledTimes(1);
    expect(seenDir).not.toBe(".tgd-review/rules");
    expect(path.isAbsolute(seenDir as string)).toBe(true);
    expect(seenIncludeBuiltin).toBe(true);

    // The temp dir actually contained the fetched files, written verbatim,
    // at the time loadRules ran.
    expect(seenFileA).toBe(ruleFilesFromBase[0].content);
    expect(seenFileB).toBe(ruleFilesFromBase[1].content);

    // ...and was removed afterward.
    expect(existsSync(seenDir as string)).toBe(false);

    vi.restoreAllMocks();
  });

  it("default (trustLocalRules: false): removes the temp rules directory after loadRules runs", async () => {
    const h = makeHarness({ botComment: null, ruleFilesFromBase: [{ path: "a.md", content: "x" }] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    let capturedDir: string | undefined;
    h.loadRules.mockImplementation(async (dir: string) => {
      capturedDir = dir;
      return { rules: [makeRule()], errors: [] };
    });

    await review(h.args, depsFrom(h));

    expect(capturedDir).toBeDefined();
    expect(existsSync(capturedDir as string)).toBe(false);

    vi.restoreAllMocks();
  });

  it("default (trustLocalRules: false): removes the temp rules directory even when loadRules rejects", async () => {
    const h = makeHarness({ botComment: null, ruleFilesFromBase: [{ path: "a.md", content: "x" }] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    let capturedDir: string | undefined;
    h.loadRules.mockImplementation(async (dir: string) => {
      capturedDir = dir;
      throw new Error("boom");
    });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/boom/);

    expect(capturedDir).toBeDefined();
    expect(existsSync(capturedDir as string)).toBe(false);

    vi.restoreAllMocks();
  });

  it("--trust-local-rules: skips getRuleFilesFromBase entirely and calls loadRules with config.rulesDir directly", async () => {
    const args = makeArgs({ trustLocalRules: true, rulesDir: "local/rules" });
    const h = makeHarness({ args, botComment: null });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.getRuleFilesFromBase).not.toHaveBeenCalled();
    expect(h.loadRules).toHaveBeenCalledWith("local/rules", true);

    vi.restoreAllMocks();
  });

  it("passes through --disable-builtin-rule as includeBuiltin: false when fetching from the base branch", async () => {
    const args = makeArgs({ disableBuiltinRule: true });
    const h = makeHarness({ args, botComment: null });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const [, includeBuiltin] = h.loadRules.mock.calls[0];
    expect(includeBuiltin).toBe(false);

    vi.restoreAllMocks();
  });

  it("getRuleFilesFromBase rejecting (e.g. auth failure) propagates out of review() rather than being swallowed", async () => {
    const h = makeHarness({ botComment: null });
    h.vcsAdapter.getRuleFilesFromBase.mockRejectedValue(new Error("gh: authentication required"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/authentication required/);

    expect(h.loadRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("an empty getRuleFilesFromBase result (no rule files on the base branch) still loads successfully (builtin rule only)", async () => {
    const h = makeHarness({ botComment: null, ruleFilesFromBase: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.loadRules).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });
});
