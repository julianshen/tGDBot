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
import { parseArgs, review } from "../../src/cli.js";
import type { CliArgs } from "../../src/cli.js";
import { computeReviewConfigHash } from "../../src/review/dedup.js";
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
    suggestions: "on",
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
    createInlineReview: ReturnType<typeof vi.fn>;
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
    commentBody: "**No actionable comments.** ✅",
    inlineComments: [],
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
    createInlineReview: vi.fn().mockResolvedValue(undefined),
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
  it("AC-8.1: sha AND config match skips the review, exits 0, and never calls upsertComment", async () => {
    const pr = makePr({ headSha: "cafef00d" });
    // A skip now requires BOTH the head SHA and the review-config hash to match —
    // the marker records the config the last review ran with (see #4 / dedup).
    const cfg = computeReviewConfigHash(makeArgs());
    const botComment: BotComment = {
      id: "999",
      body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
      lastReviewedSha: "cafef00d",
      reviewedConfig: cfg,
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
    // The marker now carries the review-config hash after the SHA (#4).
    expect(body).toContain("<!-- tgd-review-agent:sha=abc1234 cfg=");

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
      reviewedConfig: "",
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
      inlineComments: [],
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
      inlineComments: [],
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
      inlineComments: [],
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

  // Review fix (defense-in-depth, non-blocking hardening item): `file.path`
  // in a fetched RuleFileContent comes from the GitHub Contents API response
  // and is used directly to build a write path under the temp rules dir. Not
  // currently exploitable — the base branch isn't attacker-controlled per
  // ADR-002's own threat model — but a relative-traversal or absolute path
  // must still be rejected/skipped (never written outside the temp dir),
  // the same "one bad thing shouldn't kill the whole run" philosophy this
  // codebase already applies to malformed rule files elsewhere.
  it("path-traversal defense-in-depth: a fetched rule file whose path escapes the temp dir via '../' is skipped (never written outside it), other legit files still load", async () => {
    const ruleFilesFromBase: RuleFileContent[] = [
      { path: "../../etc/passwd", content: "malicious content" },
      { path: "security-review.md", content: "legit content" },
    ];
    const h = makeHarness({ botComment: null, ruleFilesFromBase });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let seenDir: string | undefined;
    h.loadRules.mockImplementation(async (dir: string) => {
      seenDir = dir;
      expect(readFileSync(path.join(dir, "security-review.md"), "utf-8")).toBe("legit content");
      return { rules: [makeRule()], errors: [] };
    });

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(seenDir).toBeDefined();

    // The traversal target (two levels above the temp dir, then etc/passwd)
    // must never have been written to.
    const escapedPath = path.resolve(seenDir as string, "../../etc/passwd");
    expect(existsSync(escapedPath)).toBe(false);

    // A warning names the offending path — visible, not silently dropped.
    const warnedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warnedText).toContain("../../etc/passwd");

    vi.restoreAllMocks();
  });

  it("path-traversal defense-in-depth: a fetched rule file with an absolute path is skipped (never written to that absolute location)", async () => {
    const ruleFilesFromBase: RuleFileContent[] = [
      { path: "/etc/passwd", content: "malicious content" },
      { path: "security-review.md", content: "legit content" },
    ];
    const h = makeHarness({ botComment: null, ruleFilesFromBase });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let seenDir: string | undefined;
    h.loadRules.mockImplementation(async (dir: string) => {
      seenDir = dir;
      expect(readFileSync(path.join(dir, "security-review.md"), "utf-8")).toBe("legit content");
      return { rules: [makeRule()], errors: [] };
    });

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(seenDir).toBeDefined();

    const warnedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warnedText).toContain("/etc/passwd");

    vi.restoreAllMocks();
  });
});

// Issue #1 (round 2): the `--model` flag must reach dispatchRules as the
// ORCHESTRATOR MODEL, not as its injectable session factory. dispatchRules'
// 4th positional param is `createSession`; `orchestratorModel` is only the 5th,
// so wiring dispatchRulesReal straight in would silently pass the model string
// into the factory slot — a bug TypeScript would happily accept at the call
// site. Pin the contract at the boundary.
describe("issue #1 (round 2): --model reaches dispatchRules as the orchestrator model", () => {
  it("parses --model and forwards it as the orchestratorModel argument", async () => {
    const args = parseArgs(["review", "--pr", "42", "--model", "openai-codex/gpt-5.6-terra", "--dry-run"]);
    expect(args.model).toBe("openai-codex/gpt-5.6-terra");

    const h = makeHarness({ args });
    await review(args, depsFrom(h));

    // 4th positional arg of ReviewDependencies["dispatchRules"] = orchestratorModel.
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    expect(h.dispatchRules.mock.calls[0]?.[3]).toBe("openai-codex/gpt-5.6-terra");
  });

  // Review fix: `??` is nullish-only, so `--model ""` would otherwise slip past
  // the rule-derived default and land back on pi's AMBIENT default — silently
  // restoring the exact coupling this flag exists to remove. Realistic trigger:
  // a workflow passing `--model "${{ inputs.model }}"` with the input unset.
  // Fail fast at parse time, like --vcs/--advisor already do.
  it("rejects a malformed or EMPTY --model instead of silently falling back to pi's ambient default", () => {
    for (const bad of ["", "just-a-name", "/leading", "trailing/"]) {
      expect(() => parseArgs(["review", "--pr", "42", "--model", bad])).toThrow(/Invalid --model/);
    }
    // A model id may itself contain slashes — that must still be accepted.
    expect(parseArgs(["review", "--pr", "42", "--model", "openrouter/vendor/model-x"]).model).toBe(
      "openrouter/vendor/model-x",
    );
  });

  it("forwards undefined when --model is omitted (dispatchRules then defaults to the first rule's pinned model)", async () => {
    const args = parseArgs(["review", "--pr", "42", "--dry-run"]);
    expect(args.model).toBeUndefined();

    const h = makeHarness({ args });
    await review(args, depsFrom(h));

    expect(h.dispatchRules.mock.calls[0]?.[3]).toBeUndefined();
  });
});

// Inline review comments: findings are posted as review comments anchored to the
// diff (createInlineReview), with the summary comment upserted as before (so the
// SHA-marker dedup — "never re-comment without new commits" — still holds).
describe("inline review comments", () => {
  const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n ctx\n+added\n";

  // NOTE: resolveConfig is mocked to return config built from the HARNESS's args,
  // so dryRun must be set here — passing it to review() would have no effect.
  function inlineHarness(orchestrationResult: OrchestrationResult, dryRun = false) {
    const h = makeHarness({ args: makeArgs({ dryRun }), botComment: null, orchestrationResult });
    h.vcsAdapter.getDiff.mockResolvedValue(DIFF);
    return h;
  }

  const withInline: OrchestrationResult = {
    commentBody: "**Actionable comments posted: 1**",
    inlineComments: [{ path: "x.ts", line: 2, body: "_🔴 Blocking_\n\n**Boom.**" }],
    findingsCount: 1,
    rulesRun: ["rule-a"],
    rulesFailed: [],
  };

  it("posts the inline comments via createInlineReview, pinned to the head SHA", async () => {
    const h = inlineHarness(withInline);

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    const [prId, headSha, comments] = h.vcsAdapter.createInlineReview.mock.calls[0];
    expect(prId).toBe("42");
    expect(headSha).toBe("cafef00d"); // makePr()'s head sha
    expect(comments).toEqual(withInline.inlineComments);
    // The summary is STILL upserted — that's what carries the dedup marker.
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
  });

  // GitHub 422s the ENTIRE review if any anchor is off-diff. Losing every
  // finding to a formatting technicality is unacceptable — fall back to a
  // summary comment that contains them all.
  it("falls back to a full summary comment when the inline review is rejected — never loses findings", async () => {
    const h = inlineHarness(withInline);
    h.vcsAdapter.createInlineReview.mockRejectedValue(new Error("HTTP 422 line not part of the diff"));
    // The fallback re-renders with inline: false.
    h.orchestrate.mockReturnValueOnce(withInline).mockReturnValueOnce({
      ...withInline,
      commentBody: "**Actionable comments posted: 1**\n\n### 💬 Findings (1)\n\nBoom.",
      inlineComments: [],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    // Re-orchestrated with inline disabled...
    expect(h.orchestrate).toHaveBeenCalledTimes(2);
    expect(h.orchestrate.mock.calls[1]?.[2]).toEqual({ inline: false, suggestions: true });
    // ...and the summary is REWRITTEN (upserted again) to carry the finding. The
    // marker-bearing summary is posted FIRST by design, so the fallback edits it.
    const calls = h.vcsAdapter.upsertComment.mock.calls;
    expect(calls.length).toBe(2);
    expect(String(calls[calls.length - 1]?.[1])).toContain("Boom.");
    expect(exitCode).toBe(0); // a rejected inline post is NOT a failed review
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("--dry-run posts nothing: no inline review, no comment", async () => {
    const h = inlineHarness(withInline, true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    // ...but it PREVIEWS the inline comments, so a dry run shows the whole review.
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("x.ts:2");
    expect(printed).toContain("Boom.");
    log.mockRestore();
  });

  it("skips createInlineReview entirely when there are no anchored findings", async () => {
    const h = inlineHarness({ ...withInline, inlineComments: [], findingsCount: 0 });

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
  });

  it("passes the DIFF to orchestrate (that's what makes anchoring possible)", async () => {
    const h = inlineHarness(withInline, true);

    await review(h.args, depsFrom(h));

    expect(h.orchestrate.mock.calls[0]?.[1]).toBe(DIFF);
    expect(h.orchestrate.mock.calls[0]?.[2]).toEqual({ inline: true, suggestions: true });
  });
});
