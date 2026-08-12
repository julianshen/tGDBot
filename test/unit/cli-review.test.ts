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
import { computeReviewConfigHash, formatMarker } from "../../src/review/dedup.js";
import { relatedWorkFingerprint } from "../../src/review/related-work.js";
import { formatPendingMarker, parseBotMarker } from "../../src/review/comment-marker.js";
import type { ResolvedConfig } from "../../src/config.js";
import { resolveReviewLocator } from "../../src/config.js";
import type { BotComment, PullRequestInfo, RuleFileContent, VcsAdapter } from "../../src/vcs/adapter.js";
import type { LoadResult } from "../../src/rules/loader.js";
import type { RuleDefinition } from "../../src/rules/types.js";
import type { DispatchResult } from "../../src/review/types.js";
import { orchestrate as buildPresentation } from "../../src/review/orchestrate.js";
import type { OrchestrationResult } from "../../src/review/orchestrate.js";

describe("resolveReviewLocator", () => {
  it("resolves numeric ambient GitHub targets", () => {
    expect(resolveReviewLocator(makeArgs())).toEqual({
      kind: "ambient",
      provider: "github",
      number: 42,
    });
  });

  it("resolves numeric targets with an explicit GitHub repository", () => {
    expect(resolveReviewLocator(makeArgs({ repo: "octo-org/octo-repo" }))).toMatchObject({
      kind: "repository",
      repo: { provider: "github", owner: "octo-org", repo: "octo-repo" },
      number: 42,
    });
  });

  it.each([
    ["https://github.com/octo-org/octo-repo/pull/42", "github"],
    ["https://gitlab.example.com/group/project/-/merge_requests/42", "gitlab"],
  ] as const)("infers an explicit repository from %s", (pr, provider) => {
    expect(resolveReviewLocator(makeArgs({ pr }))).toMatchObject({
      kind: "repository",
      repo: { provider },
      number: 42,
    });
  });

  it("uses the URL provider to parse a matching --repo when --vcs was omitted", () => {
    expect(resolveReviewLocator(makeArgs({
      pr: "https://gitlab.example.com/group/project/-/merge_requests/42",
      repo: "gitlab.example.com/group/project",
    }))).toMatchObject({
      kind: "repository",
      repo: {
        provider: "gitlab",
        host: "gitlab.example.com",
        namespace: ["group"],
        repo: "project",
      },
      number: 42,
    });
  });

  it("compares redundant GitHub repository selectors case-insensitively", () => {
    expect(resolveReviewLocator(makeArgs({
      pr: "https://github.com/OpenAI/Foo/pull/42",
      repo: "openai/foo",
    }))).toMatchObject({
      kind: "repository",
      repo: {
        provider: "github",
        owner: "OpenAI",
        repo: "Foo",
      },
      number: 42,
    });
  });

  it("keeps redundant GitLab repository selectors case-sensitive", () => {
    expect(() => resolveReviewLocator(makeArgs({
      pr: "https://gitlab.com/Group/Project/-/merge_requests/42",
      repo: "gitlab.com/group/project",
    }))).toThrow(/does not match explicit --repo/i);
  });

  it("rejects numeric GitLab targets without --repo", () => {
    expect(() => resolveReviewLocator(makeArgs({ vcs: "gitlab" }))).toThrow(/--repo/i);
  });

  it("rejects URL and --repo provider mismatches", () => {
    expect(() =>
      resolveReviewLocator(makeArgs({
        pr: "https://gitlab.com/group/project/-/merge_requests/42",
        repo: "octo-org/octo-repo",
      })),
    ).toThrow(/match|mismatch/i);
  });

  it("rejects a review URL that conflicts with an explicitly supplied --vcs", () => {
    expect(() =>
      resolveReviewLocator(makeArgs({
        pr: "https://gitlab.com/group/project/-/merge_requests/42",
        vcs: "github",
        vcsExplicit: true,
      })),
    ).toThrow(/does not match explicit --vcs/i);
  });
});

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    pr: "42",
    vcs: "github",
    rulesDir: ".review/rules",
    disableBuiltinRule: false,
    advisor: "on",
    suggestions: "on",
    dryRun: false,
    trustLocalRules: false,
    dispatch: "direct",
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
    dependsOn: [],
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
    resolveStaleReviewThreads: ReturnType<typeof vi.fn>;
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
    resolveRelatedWork: vi.fn().mockImplementation((references) => Promise.resolve(references)),
    getPullRequest: vi.fn().mockResolvedValue(pr),
    getDiff: vi.fn().mockResolvedValue("diff --git a/x b/x"),
    findBotComment: vi.fn().mockResolvedValue(botComment),
    upsertComment: vi.fn().mockImplementation(
      (_locator, body: string, existing: BotComment | null) => {
        const parsed = parseBotMarker(body);
        return Promise.resolve({
          id: existing?.id ?? "written-summary-1",
          body,
          ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
        });
      },
    ),
    getRuleFilesFromBase: vi.fn().mockResolvedValue(ruleFilesFromBase),
    createInlineReview: vi.fn().mockImplementation(
      (_locator, _headSha, comments: Array<{ clientId: string }>) =>
        Promise.resolve(comments.map(({ clientId }) => ({ clientId, status: "posted" }))),
    ),
    resolveStaleReviewThreads: vi.fn().mockResolvedValue(0),
  };

  const locator = resolveReviewLocator(args);
  const config: ResolvedConfig = {
    ...args,
    locator,
    vcsAdapter: vcsAdapter as unknown as VcsAdapter,
  };

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
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    // Nor should the base-branch rule fetch — no point fetching rules for a
    // review that's about to be skipped entirely.
    expect(h.vcsAdapter.getRuleFilesFromBase).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("applies head/config dedup to an explicit GitLab merge request", async () => {
    const args = makeArgs({
      pr: "https://gitlab.example.com/group/project/-/merge_requests/42",
      vcs: "gitlab",
    });
    const cfg = computeReviewConfigHash(args);
    const botComment: BotComment = {
      id: "303",
      body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
      lastReviewedSha: "cafef00d",
      reviewedConfig: cfg,
    };
    const unchanged = makeHarness({ args, botComment });
    const changedArgs = { ...args, advisor: "off" as const };
    const changed = makeHarness({ args: changedArgs, botComment });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(unchanged.args, depsFrom(unchanged))).resolves.toBe(0);
    expect(unchanged.vcsAdapter.upsertComment).not.toHaveBeenCalled();

    await expect(review(changed.args, depsFrom(changed))).resolves.toBe(0);
    expect(changed.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("re-reviews the same SHA only when normalized related references change", async () => {
    const url = "https://github.com/acme/app/pull/42";
    const priorInput = { provider: "github" as const, reviewUrl: url, title: "Fixes #7", description: "notes" };
    const cfg = computeReviewConfigHash(makeArgs(), relatedWorkFingerprint(priorInput));
    const botComment: BotComment = { id: "999", body: formatMarker("cafef00d", cfg), lastReviewedSha: "cafef00d", reviewedConfig: cfg };

    const unchanged = makeHarness({ botComment, pr: makePr({ url, title: "Fixes #7", description: "unrelated wording changed" }) });
    await review(unchanged.args, depsFrom(unchanged));
    expect(unchanged.dispatchRules).not.toHaveBeenCalled();
    expect(unchanged.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    for (const title of ["Fixes #8", "No related work"]) {
      const changed = makeHarness({ botComment, pr: makePr({ url, title, description: "unrelated wording changed" }) });
      await review(changed.args, depsFrom(changed));
      expect(changed.dispatchRules).toHaveBeenCalledOnce();
      if (title.includes("#")) expect(changed.vcsAdapter.resolveRelatedWork).toHaveBeenCalledOnce();
      else expect(changed.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    }
  });

  it("fails closed before dispatch or writes for malformed ready recovery metadata", async () => {
    const h = makeHarness({
      botComment: {
        id: "written-777",
        body: "<!-- tgd-review-agent:pending phase=ready sha=cafef00d cfg=bad result=v2.invalid -->",
        lastReviewedSha: "",
        reviewedConfig: "",
        invalidPendingState: true,
      },
    });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/invalid pending|recovery/i);

    expect(h.vcsAdapter.getDiff).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
  });

  it("fails closed for a current ready recovery note with the wrong exact note binding", async () => {
    const h = makeHarness({ botComment: null });
    const configHash = computeReviewConfigHash(h.config);
    const body = formatPendingMarker({
      phase: "ready",
      headSha: "cafef00d",
      configHash,
      noteId: "other-888",
      terminalResult: {
        status: "posted",
        findingsCount: 0,
        rulesRun: ["rule-a"],
        rulesFailed: [],
        exitCode: 0,
      },
    });
    h.vcsAdapter.findBotComment.mockResolvedValue({
      id: "written-777",
      body,
      ...parseBotMarker(body)!,
    });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/binding|recovery|note/i);

    expect(h.vcsAdapter.getDiff).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
  });

  it("fails closed for a dry-run current ready recovery note with the wrong binding", async () => {
    const h = makeHarness({
      args: makeArgs({ dryRun: true }),
      botComment: null,
    });
    const configHash = computeReviewConfigHash(h.config);
    const body = formatPendingMarker({
      phase: "ready",
      headSha: "cafef00d",
      configHash,
      noteId: "other-888",
      terminalResult: {
        status: "posted",
        findingsCount: 0,
        rulesRun: ["rule-a"],
        rulesFailed: [],
        exitCode: 0,
      },
    });
    h.vcsAdapter.findBotComment.mockResolvedValue({
      id: "written-777",
      body,
      ...parseBotMarker(body)!,
    });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/binding|recovery|note/i);

    expect(h.vcsAdapter.getDiff).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
  });

  it("validates a dry-run ready checkpoint without finalizing and reproduces its result", async () => {
    const h = makeHarness({
      args: makeArgs({ dryRun: true }),
      botComment: null,
    });
    const configHash = computeReviewConfigHash(h.config);
    const body = formatPendingMarker({
      phase: "ready",
      headSha: "cafef00d",
      configHash,
      noteId: "written-777",
      terminalResult: {
        status: "partial",
        findingsCount: 4,
        rulesRun: ["rule-a"],
        rulesFailed: ["rule-b"],
        exitCode: 2,
      },
    });
    h.vcsAdapter.findBotComment.mockResolvedValue({
      id: "written-777",
      body,
      ...parseBotMarker(body)!,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).resolves.toBe(2);

    expect(h.vcsAdapter.getDiff).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    const status = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.startsWith("TGD_REVIEW_RESULT: "));
    expect(JSON.parse(status!.slice("TGD_REVIEW_RESULT: ".length))).toEqual({
      status: "partial",
      findingsCount: 4,
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
      reason: "recovered-pending-review-dry-run",
    });
    vi.restoreAllMocks();
  });

  // Design-review #9: the adapter infers owner/repo from ambient context, so
  // review() must name the RESOLVED target (the PR's canonical URL) up front —
  // even on a skipped run — making a mis-inferred repo visible, not silent.
  it("design-review #9: logs the resolved PR URL (or the PR number when the adapter has none) before deciding anything", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // With a URL: the URL is logged, even though this run is skipped by dedup.
    const cfg = computeReviewConfigHash(makeArgs());
    const withUrl = makeHarness({
      pr: makePr({ headSha: "cafef00d", url: "https://github.com/octo-org/octo-repo/pull/42" }),
      botComment: {
        id: "999",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: cfg,
      },
    });
    await review(withUrl.args, depsFrom(withUrl));
    expect(logSpy).toHaveBeenCalledWith(
      "tgd-review-agent: reviewing https://github.com/octo-org/octo-repo/pull/42 (head cafef00d)",
    );

    // Without a URL (a minimal adapter): falls back to the PR number.
    const withoutUrl = makeHarness({ pr: makePr({ headSha: "cafef00d" }), botComment: null });
    await review(withoutUrl.args, depsFrom(withoutUrl));
    expect(logSpy).toHaveBeenCalledWith("tgd-review-agent: reviewing PR #42 (head cafef00d)");

    logSpy.mockRestore();
  });

  // Design-review #13: when the diff exceeds --max-diff-chars, the run skips
  // LOUDLY before fetching rules or spending model tokens — exit 0, nothing
  // posted, no marker written (so a later run with a higher ceiling reviews
  // normally), and the status line carries reason: "diff-too-large".
  it("design-review #13: a diff over --max-diff-chars skips with a notice — exit 0, no rule fetch, no VCS write", async () => {
    const h = makeHarness({
      args: makeArgs({ maxDiffChars: 10 }),
      botComment: null,
    });
    // The harness's stubbed getDiff returns "diff --git a/x b/x" (18 chars > 10).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    // Skipped BEFORE any rule fetch, dispatch, or write.
    expect(h.vcsAdapter.getRuleFilesFromBase).not.toHaveBeenCalled();
    expect(h.loadRules).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    // The notice names the sizes so the ceiling is actionable.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("--max-diff-chars");
    expect(warned).toContain("18");
    // The status line distinguishes this skip from a dedup skip.
    expect(logSpy).toHaveBeenCalledWith(
      `TGD_REVIEW_RESULT: ${JSON.stringify({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [], reason: "diff-too-large" })}`,
    );

    vi.restoreAllMocks();
  });

  // Codex review fix (PR #5): a diff bigger than the adapter's execFile buffer
  // makes getDiff() itself REJECT — before the length check could run. With the
  // ceiling flag set, that must still produce the promised graceful skip (it
  // hits exactly the largest PRs the flag guards); without the flag, the
  // rejection stays fatal, the pre-existing behavior.
  it("codex fix: a getDiff maxBuffer rejection with --max-diff-chars set becomes the diff-too-large skip", async () => {
    const h = makeHarness({ args: makeArgs({ maxDiffChars: 500000 }), botComment: null });
    const bufferError = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
    h.vcsAdapter.getDiff.mockRejectedValue(bufferError);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.loadRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      `TGD_REVIEW_RESULT: ${JSON.stringify({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [], reason: "diff-too-large" })}`,
    );

    vi.restoreAllMocks();
  });

  it("codex fix: the same maxBuffer rejection WITHOUT --max-diff-chars still propagates (fatal, pre-existing behavior)", async () => {
    const h = makeHarness({ botComment: null });
    h.vcsAdapter.getDiff.mockRejectedValue(
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/maxBuffer/);
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("design-review #13: a diff exactly at (not over) --max-diff-chars still reviews normally", async () => {
    const h = makeHarness({
      args: makeArgs({ maxDiffChars: 18 }), // getDiff stub returns exactly 18 chars
      botComment: null,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    expect(h.dispatchRules).toHaveBeenCalledWith({
      rules: expect.arrayContaining([expect.objectContaining({ name: "rule-a" })]),
      diff: "diff --git a/x b/x",
      useAdvisor: true,
      orchestratorModel: undefined,
    });
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  // Design-review #10: stale inline threads from previous runs are resolved
  // (collapsed, never deleted) on the posting path — AFTER the marker-carrying
  // summary upsert (idempotency never depends on cosmetic cleanup) and only
  // there: dry-run and skipped runs must not touch existing threads.
  describe("design-review #10: stale review-thread resolution", () => {
    it("posting path: resolveStaleReviewThreads is called once, after the summary upsert", async () => {
      const h = makeHarness({ botComment: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      const exitCode = await review(h.args, depsFrom(h));

      expect(exitCode).toBe(0);
      expect(h.vcsAdapter.resolveStaleReviewThreads).toHaveBeenCalledTimes(1);
      expect(h.vcsAdapter.resolveStaleReviewThreads).toHaveBeenCalledWith(h.config.locator);
      const upsertOrder = h.vcsAdapter.upsertComment.mock.invocationCallOrder[0];
      const resolveOrder = h.vcsAdapter.resolveStaleReviewThreads.mock.invocationCallOrder[0];
      expect(resolveOrder).toBeGreaterThan(upsertOrder);

      vi.restoreAllMocks();
    });

    it("--dry-run never resolves threads (nothing is posted, so nothing is superseded)", async () => {
      const h = makeHarness({ args: makeArgs({ dryRun: true }), botComment: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await review(h.args, depsFrom(h));

      expect(h.vcsAdapter.resolveStaleReviewThreads).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("a dedup-skipped run never resolves threads", async () => {
      const cfg = computeReviewConfigHash(makeArgs());
      const h = makeHarness({
        pr: makePr({ headSha: "cafef00d" }),
        botComment: {
          id: "999",
          body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
          lastReviewedSha: "cafef00d",
          reviewedConfig: cfg,
        },
      });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await review(h.args, depsFrom(h));

      expect(h.vcsAdapter.resolveStaleReviewThreads).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("a resolution failure only warns — the review still completes with exit 0", async () => {
      const h = makeHarness({ botComment: null });
      h.vcsAdapter.resolveStaleReviewThreads.mockRejectedValue(new Error("GraphQL rate limited"));
      vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const exitCode = await review(h.args, depsFrom(h));

      expect(exitCode).toBe(0);
      expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
      const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warned).toContain("could not resolve stale inline comment threads");

      vi.restoreAllMocks();
    });
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
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
    const [prId, pendingBody, existing] = h.vcsAdapter.upsertComment.mock.calls[0];
    expect(prId).toEqual(h.config.locator);
    expect(existing).toBeNull();
    expect(pendingBody).toContain("<!-- tgd-review-agent:pending phase=publishing");
    // The marker now carries the review-config hash after the SHA (#4).
    expect(h.vcsAdapter.upsertComment.mock.calls[1]?.[1])
      .toContain("<!-- tgd-review-agent:sha=abc1234 cfg=");
    expect(h.vcsAdapter.upsertComment.mock.calls[1]?.[2])
      .toMatchObject({ id: "written-summary-1" });

    vi.restoreAllMocks();
  });

  // AC-8.3: Given a PR with an existing bot comment whose marker SHA
  // differs from the current head SHA, When review runs, Then
  // upsertComment is called with existing set to that comment (an edit,
  // not a create).
  it("AC-8.3: stale existing comment triggers an edit with the existing comment passed through", async () => {
    const pr = makePr({ headSha: "abcdef01" });
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
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
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
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

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
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
    const [, body] = h.vcsAdapter.upsertComment.mock.calls[1];
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
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
    const [, body] = h.vcsAdapter.upsertComment.mock.calls[1];
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
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
    const [, body] = h.vcsAdapter.upsertComment.mock.calls[1];
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
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

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

    expect(h.vcsAdapter.getRuleFilesFromBase).toHaveBeenCalledWith(
      h.config.locator,
      "based00d",
      ".review/rules",
    );

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
    expect(seenDir).not.toBe(".review/rules");
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

  it("preserves the legacy directory when it is supplied explicitly", async () => {
    const h = makeHarness({
      args: makeArgs({ rulesDir: ".tgd-review/rules" }),
      pr: makePr({ baseSha: "based00d" }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.getRuleFilesFromBase).toHaveBeenCalledWith(
      h.config.locator,
      "based00d",
      ".tgd-review/rules",
    );

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

// Task 3 migrates the CLI seam to ReviewDispatchInput, eliminating the former
// positional-slot ambiguity around --model.
describe("issue #1 (round 2): --model reaches dispatchRules as the orchestrator model", () => {
  it("parses --model and forwards it as the orchestratorModel argument", async () => {
    const args = parseArgs(["review", "--pr", "42", "--model", "openai-codex/gpt-5.6-terra", "--dry-run"]);
    expect(args.model).toBe("openai-codex/gpt-5.6-terra");

    const h = makeHarness({ args });
    await review(args, depsFrom(h));

    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    expect(h.dispatchRules.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        orchestratorModel: "openai-codex/gpt-5.6-terra",
      }),
    );
    expect(h.dispatchRules.mock.calls[0]?.[0]).not.toHaveProperty("contextPacks");
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

    expect(h.dispatchRules.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ orchestratorModel: undefined }),
    );
    expect(h.dispatchRules.mock.calls[0]?.[0]).not.toHaveProperty("contextPacks");
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

  const singleFinding = {
    ruleName: "rule-a",
    severity: "blocking" as const,
    category: "correctness",
    file: "x.ts",
    line: 2,
    message: "Boom.",
  };
  const withInline: OrchestrationResult = {
    commentBody: "**Actionable comments posted: 1**",
    inlineComments: [{
      clientId: "finding-0",
      path: "x.ts",
      line: 2,
      position: {
        oldPath: "x.ts",
        newPath: "x.ts",
        start: { type: "new", newLine: 2 },
        end: { type: "new", newLine: 2 },
        sameHunk: true,
      },
      body: "_🔴 Blocking_\n\n**Boom.**",
    }],
    findingsCount: 1,
    rulesRun: ["rule-a"],
    rulesFailed: [],
    findingByClientId: new Map([["finding-0", singleFinding]]),
    summaryInput: {
      rulesRun: ["rule-a"],
      rulesFailed: [],
      ruleFailureReasons: {},
      allFindings: [singleFinding],
      unanchored: [],
      filesReviewed: ["x.ts"],
      inlineCount: 1,
      inlineUnavailable: false,
    },
  };

  function partialPresentation(): OrchestrationResult {
    const result: DispatchResult = {
      findings: [1, 2, 3].map((line, index) => ({
        ruleName: "rule-a",
        severity: "warning" as const,
        category: "correctness",
        file: "x.ts",
        line,
        message: `finding ${index}`,
      })),
      rulesRun: ["rule-a"],
      rulesFailed: [],
    };
    return buildPresentation(
      result,
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n",
      { inline: true },
    );
  }

  it("rejects unrepresentable recovery metadata before the first external write", async () => {
    const h = inlineHarness({
      ...withInline,
      rulesRun: ["x".repeat(100_000)],
    });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/too large|terminal/i);

    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
  });

  it("budgets the final provider body including load errors and the ready marker", async () => {
    const findings = Array.from({ length: 6 }, (_, index) => ({
      ...singleFinding,
      line: index + 1,
      message: `finding ${index}. ${"m".repeat(1_980)}`,
      suggestion: `// fix ${index}\n${"x".repeat(7_980)}`,
    }));
    const presentation: OrchestrationResult = {
      commentBody: "**Actionable comments posted: 6**",
      inlineComments: findings.map((finding, index) => ({
        clientId: `finding-${index}`,
        path: "x.ts",
        line: 2,
        position: withInline.inlineComments[0]!.position,
        body: `finding ${index}`,
      })),
      findingsCount: findings.length,
      rulesRun: ["rule-a"],
      rulesFailed: [],
      findingByClientId: new Map(
        findings.map((finding, index) => [`finding-${index}`, finding]),
      ),
      summaryInput: {
        allFindings: findings,
        inlineCount: findings.length,
        unanchored: [],
        filesReviewed: ["x.ts"],
        rulesRun: ["rule-a"],
        rulesFailed: [],
      },
    };
    const h = inlineHarness(presentation);
    h.loadRules.mockResolvedValue({
      rules: [makeRule()],
      errors: [{ sourcePath: "/rules/bad.md", message: "e".repeat(20_000) }],
    });

    await review(h.args, depsFrom(h));

    for (const [, body] of h.vcsAdapter.upsertComment.mock.calls) {
      expect(String(body).length).toBeLessThanOrEqual(65_536);
    }
  });

  it("prints complete oversized review metadata during dry runs", async () => {
    const h = inlineHarness(withInline, true);
    const oversizedError = "e".repeat(70_000);
    h.loadRules.mockResolvedValue({
      rules: [makeRule()],
      errors: [{ sourcePath: "/rules/bad.md", message: oversizedError }],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(2);
    const output = logSpy.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain(oversizedError);
    expect(output.length).toBeGreaterThan(65_536);
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("prints complete oversized finding text during dry runs", async () => {
    const finding = {
      ...singleFinding,
      line: undefined,
      message: `${"m".repeat(70_000)} END_OF_FINDING`,
    };
    const presentation: OrchestrationResult = {
      commentBody: "unused",
      inlineComments: [],
      findingsCount: 1,
      rulesRun: ["rule-a"],
      rulesFailed: [],
      findingByClientId: new Map(),
      summaryInput: {
        allFindings: [finding],
        inlineCount: 0,
        unanchored: [finding],
        filesReviewed: ["x.ts"],
        rulesRun: ["rule-a"],
        rulesFailed: [],
      },
    };
    const h = inlineHarness(presentation, true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    const output = logSpy.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain(finding.message);
    expect(output.length).toBeGreaterThan(65_536);
    vi.restoreAllMocks();
  });

  it("posts the inline comments via createInlineReview, pinned to the head SHA", async () => {
    const h = inlineHarness(withInline);

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    const [prId, headSha, comments] = h.vcsAdapter.createInlineReview.mock.calls[0];
    expect(prId).toEqual(h.config.locator);
    expect(headSha).toBe("cafef00d"); // makePr()'s head sha
    expect(comments).toEqual(withInline.inlineComments);
    // The summary is STILL upserted — that's what carries the dedup marker.
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(4);
  });

  // GitHub 422s the ENTIRE review if any anchor is off-diff. Losing every
  // finding to a formatting technicality is unacceptable — fall back to a
  // summary comment that contains them all.
  it("falls back to a full summary comment when the inline review is rejected — never loses findings", async () => {
    const h = inlineHarness(partialPresentation());
    h.vcsAdapter.createInlineReview.mockRejectedValue(new Error("HTTP 422 line not part of the diff"));
    h.vcsAdapter.findBotComment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "909",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${computeReviewConfigHash(h.config)} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: computeReviewConfigHash(h.config),
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    // The presentation is built once and the summary is selectively rendered.
    expect(h.orchestrate).toHaveBeenCalledTimes(1);
    // The publishing summary is checkpointed with every finding before inline
    // publication, checkpointed again with the validated outcome body, then
    // finalized in place with every finding after rejection.
    const calls = h.vcsAdapter.upsertComment.mock.calls;
    expect(calls.length).toBe(4);
    expect(String(calls[0]?.[1])).not.toContain("finding 0");
    expect(String(calls[1]?.[1])).toContain("finding 0");
    expect(String(calls[1]?.[1])).toContain("finding 1");
    expect(String(calls[1]?.[1])).toContain("finding 2");
    expect(String(calls[calls.length - 1]?.[1])).toContain("finding 0");
    expect(String(calls[calls.length - 1]?.[1])).toContain("finding 1");
    expect(String(calls[calls.length - 1]?.[1])).toContain("finding 2");
    expect(exitCode).toBe(0); // a rejected inline post is NOT a failed review
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps inline findings out of the initial and successful ones out of the final summary", async () => {
    const presentation = partialPresentation();
    const h = inlineHarness(presentation);
    h.vcsAdapter.createInlineReview.mockResolvedValue([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed", reason: "position rejected" },
      { clientId: "finding-2", status: "posted" },
    ]);
    h.vcsAdapter.findBotComment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "909",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${computeReviewConfigHash(h.config)} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: computeReviewConfigHash(h.config),
      });

    await review(h.args, depsFrom(h));

    const writes = h.vcsAdapter.upsertComment.mock.calls;
    expect(writes).toHaveLength(4);
    expect(writes[0]?.[1]).not.toContain("finding 0");
    expect(writes[0]?.[1]).not.toContain("finding 1");
    expect(writes[0]?.[1]).not.toContain("finding 2");
    expect(writes[1]?.[1]).toContain("finding 0");
    expect(writes[1]?.[1]).toContain("finding 1");
    expect(writes[1]?.[1]).toContain("finding 2");
    expect(writes[2]?.[1]).not.toContain("finding 0");
    expect(writes[2]?.[1]).toContain("finding 1");
    expect(writes[2]?.[1]).not.toContain("finding 2");
    expect(writes[2]?.[2]).toMatchObject({ id: "written-summary-1" });
    expect(writes[3]?.[1]).not.toContain("finding 0");
    expect(writes[3]?.[1]).toContain("finding 1");
    expect(writes[3]?.[1]).not.toContain("finding 2");
    expect(writes[3]?.[2]).toMatchObject({ id: "written-summary-1" });
  });

  it("uses the exact written summary identity even when a competing marker note appears", async () => {
    const presentation = partialPresentation();
    const h = inlineHarness(presentation);
    h.vcsAdapter.createInlineReview.mockResolvedValue([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed" },
      { clientId: "finding-2", status: "posted" },
    ]);
    h.vcsAdapter.findBotComment
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: "competing-999",
        body: "competing",
        lastReviewedSha: "cafef00d",
        reviewedConfig: computeReviewConfigHash(h.config),
      });
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body: string) => Promise.resolve({
        id: "written-777",
        body,
        ...(parseBotMarker(body) ?? { lastReviewedSha: "", reviewedConfig: "" }),
      }),
    );

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.findBotComment).toHaveBeenCalledTimes(1);
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(4);
    expect(h.vcsAdapter.upsertComment.mock.calls[1]?.[2]).toMatchObject({
      id: "written-777",
    });
    expect(h.vcsAdapter.upsertComment.mock.calls[2]?.[2]).toMatchObject({
      id: "written-777",
    });
    expect(h.vcsAdapter.upsertComment.mock.calls[3]?.[2]).toMatchObject({
      id: "written-777",
    });
  });

  it("leaves a pending marker when finalization fails so a rerun reviews and retries the same note", async () => {
    const h = inlineHarness({
      ...withInline,
      inlineComments: [],
      findingsCount: 0,
    });
    let stored: BotComment | null = null;
    let rejectFinalization = true;
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body: string, existing: BotComment | null) => {
        const parsed = parseBotMarker(body);
        const written: BotComment = {
          id: existing?.id ?? "written-777",
          body,
          ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
        };
        if (written.lastReviewedSha !== "" && rejectFinalization) {
          rejectFinalization = false;
          return Promise.reject(new Error("final update failed"));
        }
        stored = written;
        return Promise.resolve(written);
      },
    );

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/final update failed/);
    expect(stored).toMatchObject({
      id: "written-777",
      lastReviewedSha: "",
      reviewedConfig: "",
    });

    await expect(review(h.args, depsFrom(h))).resolves.toBe(0);
    expect(h.dispatchRules).toHaveBeenCalledTimes(2);
    expect(stored).toMatchObject({
      id: "written-777",
      lastReviewedSha: "cafef00d",
      reviewedConfig: computeReviewConfigHash(h.config),
    });
  });

  it("recovers a post-inline finalization crash without reposting inline or losing findings", async () => {
    const presentation = partialPresentation();
    const h = inlineHarness(presentation);
    h.vcsAdapter.createInlineReview.mockResolvedValue([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed" },
      { clientId: "finding-2", status: "posted" },
    ]);
    let stored: BotComment | null = null;
    let rejectCompleteOnce = true;
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body: string, existing: BotComment | null) => {
        const parsed = parseBotMarker(body);
        const written: BotComment = {
          id: existing?.id ?? "written-777",
          body,
          ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
        };
        if (written.lastReviewedSha !== "" && rejectCompleteOnce) {
          rejectCompleteOnce = false;
          return Promise.reject(new Error("final update failed"));
        }
        stored = written;
        return Promise.resolve(written);
      },
    );

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/final update failed/);
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    expect(stored?.body).not.toContain("finding 0");
    expect(stored?.body).toContain("finding 1");
    expect(stored?.body).not.toContain("finding 2");

    await expect(review(h.args, depsFrom(h))).resolves.toBe(0);
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      id: "written-777",
      lastReviewedSha: "cafef00d",
      reviewedConfig: computeReviewConfigHash(h.config),
    });
    expect(stored?.body).not.toContain("finding 0");
    expect(stored?.body).toContain("finding 1");
    expect(stored?.body).not.toContain("finding 2");
  });

  it("recovers the original partial terminal result and exit semantics", async () => {
    const presentation = {
      ...partialPresentation(),
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
    };
    const loadResult: LoadResult = {
      rules: [makeRule({ name: "rule-a" })],
      errors: [{
        sourcePath: "/rules/secret-rule.md",
        message: "token=must-not-be-encoded",
      }],
    };
    const h = makeHarness({
      args: makeArgs(),
      botComment: null,
      loadResult,
      orchestrationResult: presentation,
    });
    h.vcsAdapter.getDiff.mockResolvedValue(DIFF);
    h.vcsAdapter.createInlineReview.mockResolvedValue([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed" },
      { clientId: "finding-2", status: "posted" },
    ]);
    let stored: BotComment | null = null;
    let rejectCompleteOnce = true;
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body: string, existing: BotComment | null) => {
        const parsed = parseBotMarker(body);
        const written: BotComment = {
          id: existing?.id ?? "written-777",
          body,
          ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
        };
        if (written.lastReviewedSha !== "" && rejectCompleteOnce) {
          rejectCompleteOnce = false;
          return Promise.reject(new Error("final update failed"));
        }
        stored = written;
        return Promise.resolve(written);
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/final update failed/);
    expect(stored?.pendingState?.terminalResult).toEqual({
      status: "partial",
      findingsCount: 3,
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
      loadErrors: ["/rules/secret-rule.md: token=must-not-be-encoded"],
      exitCode: 2,
    });
    const marker = stored?.body.split("\n").at(-1) ?? "";
    expect(marker).not.toContain("token=must-not-be-encoded");

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(2);
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    const statusCall = logSpy.mock.calls.findLast(
      (call) => typeof call[0] === "string" &&
        call[0].startsWith("TGD_REVIEW_RESULT: "),
    );
    const status = JSON.parse(
      String(statusCall?.[0]).slice("TGD_REVIEW_RESULT: ".length),
    );
    expect(status).toMatchObject({
      status: "partial",
      findingsCount: 3,
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
      loadErrors: ["/rules/secret-rule.md: token=must-not-be-encoded"],
      reason: "recovered-pending-review",
    });
    vi.restoreAllMocks();
  });

  it("rejects a final write result that cannot confirm the exact completed marker", async () => {
    const h = inlineHarness({
      ...withInline,
      inlineComments: [],
      findingsCount: 0,
    });
    h.vcsAdapter.upsertComment
      .mockResolvedValueOnce({
        id: "written-777",
        body: "<!-- tgd-review-agent:pending -->",
        lastReviewedSha: "",
        reviewedConfig: "",
      })
      .mockResolvedValueOnce({
        id: "other-888",
        body: "unexpected",
        lastReviewedSha: "",
        reviewedConfig: "",
      });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/exact|final|complete/i);
  });

  it.each([
    ["missing", [
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed" },
    ]],
    ["duplicate", [
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-0", status: "failed" },
      { clientId: "finding-2", status: "posted" },
    ]],
    ["unknown", [
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "posted" },
      { clientId: "not-a-finding", status: "failed" },
    ]],
    ["invalid status", [
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "accepted" },
      { clientId: "finding-2", status: "posted" },
    ]],
  ])("falls back all inline candidates for %s outcome IDs", async (_name, outcomes) => {
    const presentation = partialPresentation();
    const h = inlineHarness(presentation);
    h.vcsAdapter.createInlineReview.mockResolvedValue(outcomes);
    h.vcsAdapter.findBotComment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "909",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${computeReviewConfigHash(h.config)} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: computeReviewConfigHash(h.config),
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const fallback = String(h.vcsAdapter.upsertComment.mock.calls[1]?.[1]);
    expect(fallback).toContain("finding 0");
    expect(fallback).toContain("finding 1");
    expect(fallback).toContain("finding 2");
    vi.restoreAllMocks();
  });

  it("fails before finalization when the pending write returns no exact identity", async () => {
    const presentation = partialPresentation();
    const h = inlineHarness(presentation);
    h.vcsAdapter.createInlineReview.mockResolvedValue([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed" },
      { clientId: "finding-2", status: "posted" },
    ]);
    h.vcsAdapter.upsertComment.mockResolvedValueOnce(undefined);

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/exact identity|pending summary/i);
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(1);
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
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalledTimes(2);
  });

  it("passes the DIFF to orchestrate (that's what makes anchoring possible)", async () => {
    const h = inlineHarness(withInline, true);

    await review(h.args, depsFrom(h));

    expect(h.orchestrate.mock.calls[0]?.[1]).toBe(DIFF);
    expect(h.orchestrate.mock.calls[0]?.[2]).toEqual({ inline: true, suggestions: true, relatedWork: [] });
  });

  it("extracts and resolves GitHub related work after dispatch, then passes it only to presentation", async () => {
    const h = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7", description: "See #8" }) });
    const resolved = { provider: "github", host: "github.com", projectPath: "acme/app", number: 7, sourceText: "#7", identifier: "#7", kind: "issue", title: "Seven", state: "open", url: "https://github.com/acme/app/issues/7" };
    h.vcsAdapter.resolveRelatedWork.mockResolvedValue([resolved]);
    await review(h.args, depsFrom(h));
    expect(h.vcsAdapter.resolveRelatedWork).toHaveBeenCalledTimes(1);
    expect(h.vcsAdapter.resolveRelatedWork.mock.calls[0]?.[0]).toHaveLength(2);
    expect(h.dispatchRules.mock.calls[0]?.[0]).not.toHaveProperty("relatedWork");
    expect(h.orchestrate.mock.calls[0]?.[2]?.relatedWork).toEqual([expect.objectContaining(resolved), expect.objectContaining({ number: 8 })]);
  });

  it("falls back per reference on resolver rejection without leaking the error", async () => {
    const args = makeArgs({ pr: "https://gitlab.com/group/app/-/merge_requests/42", vcs: "gitlab" });
    const h = makeHarness({ args, pr: makePr({ url: "https://gitlab.com/group/app/-/merge_requests/42", title: "Relates to !7 and #8" }) });
    h.vcsAdapter.resolveRelatedWork.mockRejectedValue(new Error("token=super-secret body payload"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await review(h.args, depsFrom(h));
    expect(warn).toHaveBeenCalledTimes(2);
    const text = warn.mock.calls.flat().join("\n");
    expect(text).toContain("gitlab group/app!7");
    expect(text).not.toContain("super-secret");
    expect(h.orchestrate.mock.calls[0]?.[2]?.relatedWork).toHaveLength(2);
    warn.mockRestore();
  });

  it("renders an unresolved full GitHub pull link as a pull URL after lookup rejection", async () => {
    const pullUrl = "https://github.com/acme/app/pull/7";
    const h = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: `See ${pullUrl}` }) });
    h.vcsAdapter.resolveRelatedWork.mockRejectedValue(new Error("private response body"));
    h.orchestrate.mockImplementation(buildPresentation);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await review(h.args, depsFrom(h));
    const finalBody = String(h.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    expect(finalBody).toContain(`](${pullUrl})`);
    expect(finalBody).not.toContain("/issues/7");
    vi.restoreAllMocks();
  });

  it("does not resolve without references or when dispatch rejects", async () => {
    const none = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42" }) });
    await review(none.args, depsFrom(none));
    expect(none.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    const failed = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7" }) });
    failed.dispatchRules.mockRejectedValue(new Error("dispatch failed"));
    await expect(review(failed.args, depsFrom(failed))).rejects.toThrow("dispatch failed");
    expect(failed.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
  });

  it("wires GitLab references through resolution and renders the related-work section", async () => {
    const args = makeArgs({ pr: "https://gitlab.com/group/app/-/merge_requests/42", vcs: "gitlab" });
    const h = makeHarness({ args, pr: makePr({ url: args.pr, title: "Tracks !7", description: "and #8" }) });
    h.vcsAdapter.resolveRelatedWork.mockImplementation((refs) => Promise.resolve(refs.map((ref: Record<string, unknown>) => ({
      ...ref,
      kind: ref.kindHint,
      title: `Work ${ref.number}`,
      state: "open",
      url: `https://gitlab.com/group/app/-/${ref.kindHint === "merge_request" ? "merge_requests" : "issues"}/${ref.number}`,
    }))));
    h.orchestrate.mockImplementation(buildPresentation);
    await review(h.args, depsFrom(h));
    const refs = h.vcsAdapter.resolveRelatedWork.mock.calls[0]?.[0];
    expect(refs).toEqual([expect.objectContaining({ provider: "gitlab", number: 7, kindHint: "merge_request" }), expect.objectContaining({ provider: "gitlab", number: 8, kindHint: "issue" })]);
    const finalBody = String(h.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    expect(finalBody).toContain("### Related work");
    expect(finalBody).toContain("Work 7");
  });

  it.each([false, true])("does not resolve current ready recovery references (dryRun=%s)", async (dryRun) => {
    const args = makeArgs({ dryRun });
    const pr = makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7" });
    const h = makeHarness({ args, botComment: null, pr });
    const fingerprint = relatedWorkFingerprint({ provider: "github", reviewUrl: pr.url!, title: pr.title, description: pr.description });
    const body = formatPendingMarker({ phase: "ready", headSha: "cafef00d", configHash: computeReviewConfigHash(h.config, fingerprint), noteId: "written-777", terminalResult: { status: "posted", findingsCount: 0, rulesRun: ["rule-a"], rulesFailed: [], exitCode: 0 } });
    h.vcsAdapter.findBotComment.mockResolvedValue({ id: "written-777", body, ...parseBotMarker(body)! });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await review(h.args, depsFrom(h));
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("caps resolver input at ten unique references after dedup and warns without title/body data", async () => {
    const description = `secret-body ${Array.from({ length: 12 }, (_, i) => `#${i + 1}`).join(" ")} #1`;
    const h = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "secret-title #1", description }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await review(h.args, depsFrom(h));
    const refs = h.vcsAdapter.resolveRelatedWork.mock.calls[0]?.[0];
    expect(refs).toHaveLength(10);
    expect(refs.map((ref: { number: number }) => ref.number)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    const warning = warn.mock.calls.flat().join("\n");
    expect(warning).toContain("2 additional related-work reference(s) omitted");
    expect(warning).not.toContain("secret-title");
    expect(warning).not.toContain("secret-body");
    warn.mockRestore();
  });

  it.each([
    ["non-array", { unexpected: true }],
    ["throwing array length", new Proxy([], { get(target, key, receiver) { if (key === "length") throw new Error("length secret"); return Reflect.get(target, key, receiver); } })],
    ["throwing element getter", new Proxy([{}], { get(target, key, receiver) { if (key === "0") throw new Error("element secret"); return Reflect.get(target, key, receiver); } })],
    ["malformed unique candidate", [{ provider: "github", host: "github.com", projectPath: "acme/app", number: 7, kind: "issue", url: "https://evil.test/steal" }]],
  ])("safely falls back for hostile resolver output: %s", async (_name, output) => {
    const h = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7" }) });
    h.vcsAdapter.resolveRelatedWork.mockResolvedValue(output);
    await expect(review(h.args, depsFrom(h))).resolves.toBe(0);
    const fallback = h.orchestrate.mock.calls[0]?.[2]?.relatedWork;
    expect(fallback).toEqual([expect.objectContaining({ number: 7 })]);
    expect(fallback?.[0]).not.toHaveProperty("kind");
  });

  const resolvedItem = (number: number, title: string) => ({ provider: "github", host: "github.com", projectPath: "acme/app", number, sourceText: `#${number}`, identifier: `#${number}`, kind: "issue", title, state: "open", url: `https://github.com/acme/app/issues/${number}` });

  it.each([
    ["reordered valid output", [resolvedItem(8, "Eight"), resolvedItem(7, "Seven")], ["Seven", "Eight"]],
    ["partial output", [resolvedItem(8, "Eight")], [undefined, "Eight"]],
    ["foreign output", [resolvedItem(99, "Foreign"), resolvedItem(7, "Seven")], ["Seven", undefined]],
    ["duplicate identity", [resolvedItem(7, "Seven"), resolvedItem(7, "Duplicate"), resolvedItem(8, "Eight")], [undefined, "Eight"]],
  ])("reconciles %s without degrading other identities", async (_name, output, expectedTitles) => {
    const h = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "#7 #8" }) });
    h.vcsAdapter.resolveRelatedWork.mockResolvedValue(output);
    await review(h.args, depsFrom(h));
    const reconciled = h.orchestrate.mock.calls[0]?.[2]?.relatedWork;
    expect(reconciled?.map((item: { number: number }) => item.number)).toEqual([7, 8]);
    expect(reconciled?.map((item: { title?: string }) => item.title)).toEqual(expectedTitles);
  });

  it("retains one related-work section in dry-run, pending, conservative, selective, and final summaries", async () => {
    const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    const findings: DispatchResult = { findings: [1, 2].map((line, i) => ({ ruleName: "rule-a", severity: "warning", category: "correctness", file: "x.ts", line, message: `finding ${i}` })), rulesRun: ["rule-a"], rulesFailed: [] };
    const setup = (dryRun = false) => {
      const h = makeHarness({ args: makeArgs({ dryRun }), pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7" }), dispatchResult: findings });
      h.vcsAdapter.getDiff.mockResolvedValue(diff);
      h.orchestrate.mockImplementation(buildPresentation);
      return h;
    };
    const count = (body: string) => body.split("### Related work").length - 1;

    const dry = setup(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await review(dry.args, depsFrom(dry));
    expect(count(log.mock.calls.flat().join("\n"))).toBe(1);
    log.mockRestore();

    const selective = setup();
    selective.vcsAdapter.createInlineReview.mockResolvedValue([{ clientId: "finding-0", status: "posted" }, { clientId: "finding-1", status: "failed" }]);
    await review(selective.args, depsFrom(selective));
    for (const call of selective.vcsAdapter.upsertComment.mock.calls) expect(count(String(call[1]))).toBe(1);

    const conservative = setup();
    conservative.vcsAdapter.createInlineReview.mockRejectedValue(new Error("inline failure"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await review(conservative.args, depsFrom(conservative));
    for (const call of conservative.vcsAdapter.upsertComment.mock.calls) expect(count(String(call[1]))).toBe(1);
    vi.restoreAllMocks();
  });
});
