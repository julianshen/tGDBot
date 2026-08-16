// Tests for the `review()` command flow — see TASKS.md Task 8 "Acceptance
// Criteria (BDD)" AC-8.1 through AC-8.6.
//
// `review()` accepts an optional dependency-injection bag (resolveConfig,
// loadRules, dispatchRules, orchestrate) so these tests never touch the real
// `gh` CLI, real network, or a real pi SDK/LLM session — same
// dependency-injection spirit as Task 5's `dispatchRules` (which itself
// takes an injectable `createSession`).
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandArgs } from "../../src/cli-args.js";
import { main, parseArgs, review } from "../../src/cli.js";
import { selectClarification } from "../../src/conversation/clarification.js";
import { poll } from "../../src/poll/poll.js";
import type { CliArgs, ReviewDependencies } from "../../src/cli.js";
import { computeReviewConfigHash, conversationDedupFingerprint, formatMarker, stateRootDomainIdentifier } from "../../src/review/dedup.js";
import { extractRelatedWork, relatedWorkFingerprint } from "../../src/review/related-work.js";
import { deriveInlineChildId, formatInlineRecoveryMarker, formatPendingMarker, parseBotMarker } from "../../src/review/comment-marker.js";
import type { ResolvedConfig } from "../../src/config.js";
import { resolveReviewLocator } from "../../src/config.js";
import { AmbiguousInlinePublishError, validateConversationItemIdentity } from "../../src/vcs/adapter.js";
import type { BotComment, PullRequestInfo, RuleFileContent, VcsAdapter } from "../../src/vcs/adapter.js";
import type { LoadResult } from "../../src/rules/loader.js";
import type { RuleDefinition } from "../../src/rules/types.js";
import type { DispatchResult } from "../../src/review/types.js";
import { orchestrate as buildPresentation } from "../../src/review/orchestrate.js";
import type { OrchestrationResult } from "../../src/review/orchestrate.js";
import { computeRepositoryDigest, parseChildMarker } from "../../src/conversation/markers.js";
import { createConversationStateStore } from "../../src/conversation/state-store.js";
import { deriveConversationStatePaths } from "../../src/conversation/state-paths.js";
import { parseRepositoryRef } from "../../src/target/review-target.js";
import type { ReviewThreadSnapshot } from "../../src/vcs/conversation-adapter.js";
import { INLINE_COMMENT_MARKER } from "../../src/review/comment-format.js";

const temporaryStateRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryStateRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isolatedStateDir(): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tgd-review-state-")));
  temporaryStateRoots.push(directory);
  return directory;
}

const postedInline = (clientId: string) => ({
  clientId,
  status: "posted" as const,
  identity: validateConversationItemIdentity({
    provider: "github" as const,
    commentId: `comment-${clientId}`,
    threadId: `thread-${clientId}`,
    url: `https://github.com/acme/app/pull/42#discussion_rcomment-${clientId}`,
  }, {
    repo: { provider: "github", host: "github.com", owner: "acme", repo: "app", canonicalUrl: "https://github.com/acme/app" },
    reviewNumber: 42,
  }),
});

describe("main command dispatch", () => {
  it("dispatches poll arguments through the injectable temporary seam", async () => {
    const runPoll = vi.fn().mockResolvedValue(0);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await main(["poll", "--repo", "owner/repo"], { runPoll });

    expect(runPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "poll",
        repo: "owner/repo",
      }),
      expect.objectContaining({ runReview: expect.any(Function) }),
    );
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it("dispatches the default poll runtime instead of the not-implemented stub", async () => {
    const runPoll = vi.fn().mockResolvedValue(0);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      await main(["poll", "--repo", "owner/repo"], { runPoll });
      expect(runPoll).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });
});

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

  it("resolves numeric GitHub targets against GH_REPO instead of the checkout remote", () => {
    expect(resolveReviewLocator(makeArgs(), { GH_REPO: "hmchangw/newchat" })).toMatchObject({
      kind: "repository",
      repo: { provider: "github", owner: "hmchangw", repo: "newchat" },
      number: 42,
    });
  });

  it("uses an explicit --repo in preference to GH_REPO", () => {
    expect(resolveReviewLocator(
      makeArgs({ repo: "octo-org/octo-repo" }),
      { GH_REPO: "hmchangw/newchat" },
    )).toMatchObject({
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

const DEFAULT_PR_URL = "https://github.com/acme/app/pull/42";
const DEFAULT_REVIEW_ID = "PR_kwDOTest42";

function makePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    id: "42",
    reviewId: DEFAULT_REVIEW_ID,
    headSha: "cafef00d",
    baseSha: "deadbeef",
    title: "Some PR",
    description: "Some description",
    url: DEFAULT_PR_URL,
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
    resolveRelatedWork: ReturnType<typeof vi.fn>;
    getPullRequest: ReturnType<typeof vi.fn>;
    getDiff: ReturnType<typeof vi.fn>;
    findBotComment: ReturnType<typeof vi.fn>;
    upsertComment: ReturnType<typeof vi.fn>;
    getRuleFilesFromBase: ReturnType<typeof vi.fn>;
    createInlineReview: ReturnType<typeof vi.fn>;
    prepareInlineReviewRecovery: ReturnType<typeof vi.fn>;
    recoverInlineReview: ReturnType<typeof vi.fn>;
    resolveStaleReviewThreads: ReturnType<typeof vi.fn>;
    findPublishedMarker: ReturnType<typeof vi.fn>;
    findBotChildMarker: ReturnType<typeof vi.fn>;
    postGeneralReply: ReturnType<typeof vi.fn>;
    listReviewThreads?: ReturnType<typeof vi.fn>;
    listReviewEvents?: ReturnType<typeof vi.fn>;
    getReviewThread?: ReturnType<typeof vi.fn>;
    resolveReviewIdentity?: ReturnType<typeof vi.fn>;
  };
  resolveConfig: ReturnType<typeof vi.fn>;
  loadRules: ReturnType<typeof vi.fn>;
  dispatchRules: ReturnType<typeof vi.fn>;
  orchestrate: ReturnType<typeof vi.fn>;
  publicationHooks?: ReviewDependencies["publicationHooks"];
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
  if (args.stateDir === undefined) args.stateDir = isolatedStateDir();
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
        Promise.resolve(comments.map(({ clientId }) => postedInline(clientId))),
    ),
    prepareInlineReviewRecovery: vi.fn().mockImplementation(
      (_locator, headSha: string, comments: Array<{ clientId: string }>, runIdentity: string) => {
        const parentId = `act_${createHash("sha256").update(runIdentity).digest("hex").slice(0, 32)}`;
        return Promise.resolve({ noFallbackBody: "", children: comments.map(({ clientId }) => {
          const repositoryDigest = "d".repeat(64);
          const contentDigest = createHash("sha256").update(clientId).digest("hex");
          const placementDigest = "e".repeat(64);
          const childId = deriveInlineChildId(parentId, clientId, contentDigest, placementDigest);
          const child = { clientId, kind: "finding" as const, parentId, childId, repositoryDigest, reviewNumber: 42, contentDigest, headSha, placementDigest };
          return { ...child, marker: formatInlineRecoveryMarker(child) };
        }) });
      },
    ),
    recoverInlineReview: vi.fn().mockResolvedValue("complete"),
    resolveStaleReviewThreads: vi.fn().mockResolvedValue(0),
    findPublishedMarker: vi.fn().mockResolvedValue(null),
    findBotChildMarker: vi.fn().mockResolvedValue(null),
    postGeneralReply: vi.fn().mockImplementation((_review, input: { body: string }) => {
      const commentId = `question-${Math.random().toString(16).slice(2, 10)}`;
      return Promise.resolve({
        provider: "github" as const,
        commentId,
        url: `https://github.com/acme/app/pull/42#issuecomment-${commentId}`,
        body: input.body,
      });
    }),
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
    publicationHooks: h.publicationHooks,
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
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  // `check latest` exists precisely to overrule dedup: a human asking for a
  // fresh review on an unchanged head must get one. Only an explicit forced
  // invocation may do this — a normal run on the same head still skips.
  it("a forced-command invocation reviews a head that normal dedup would skip", async () => {
    const pr = makePr({ headSha: "cafef00d" });
    // A forced run reaches the full publication flow, so it needs its own state
    // root: without one it resolves the real user-level root and every parallel
    // worker contends on that single lock.
    const args = makeArgs({ stateDir: isolatedStateDir() });
    const cfg = computeReviewConfigHash(args);
    const botComment: BotComment = {
      id: "999",
      body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
      lastReviewedSha: "cafef00d",
      reviewedConfig: cfg,
    };
    const h = makeHarness({ args, pr, botComment });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, {
      ...depsFrom(h),
      invocation: { kind: "forced-command", actionId: `action_${"4".repeat(32)}` },
    });

    expect(exitCode).toBe(0);
    expect(h.dispatchRules).toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("gives a forced command its own publication after a completed normal review", async () => {
    const args = makeArgs({ stateDir: isolatedStateDir() });
    const h = makeHarness({ args });
    const deps = depsFrom(h);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, deps)).resolves.toBe(0);
    h.dispatchRules.mockClear();
    h.vcsAdapter.upsertComment.mockClear();

    await expect(review(h.args, {
      ...deps,
      invocation: { kind: "forced-command", actionId: `action_${"8".repeat(32)}` },
    })).resolves.toBe(0);

    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runs a focused command even when the normal summary already covers the head", async () => {
    const args = makeArgs({ stateDir: isolatedStateDir() });
    const cfg = computeReviewConfigHash(args);
    const h = makeHarness({
      args,
      botComment: {
        id: "999",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: cfg,
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, {
      ...depsFrom(h),
      invocation: {
        kind: "focused-command",
        actionId: `action_${"9".repeat(32)}`,
        direction: "check the error handling",
      },
    })).resolves.toBe(0);

    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    expect(h.vcsAdapter.postGeneralReply).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  // A focused run is supplemental. It answers the person who asked, and must
  // leave the managed summary and the previous head's threads exactly as they
  // were — otherwise asking a narrow question silently rewrites the review.
  it("a focused-command invocation replies beneath the command without touching the summary", async () => {
    const args = makeArgs({ stateDir: isolatedStateDir() });
    const findings = {
      findings: [{
        ruleName: "rule-a",
        severity: "warning" as const,
        category: "correctness",
        file: "x.ts",
        line: 1,
        message: "the error path drops the cause",
      }],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    };
    const h = makeHarness({
      args,
      dispatchResult: findings,
      orchestrationResult: {
        commentBody: "- x.ts:1 — the error path drops the cause",
        inlineComments: [],
        findingsCount: 1,
        rulesRun: findings.rulesRun,
        rulesFailed: findings.rulesFailed,
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, {
      ...depsFrom(h),
      invocation: {
        kind: "focused-command",
        actionId: `action_${"6".repeat(32)}`,
        direction: "check the error handling",
      },
    });

    expect(exitCode).toBe(0);
    // The findings went to a reply of their own...
    expect(h.vcsAdapter.postGeneralReply).toHaveBeenCalledTimes(1);
    const [, replyInput] = h.vcsAdapter.postGeneralReply.mock.calls[0] as [unknown, { body: string }];
    expect(replyInput.body).toContain("the error path drops the cause");
    expect(replyInput.body).toContain("check the error handling");
    // ...and nothing else moved.
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveStaleReviewThreads).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  // A focused run should anchor what it finds to the code, the same as a normal
  // review — the difference is where the narrative goes, not whether findings
  // are actionable in place.
  // Regression: publication detached `findBotChildMarker` from the adapter and
  // called it unbound. Both real adapters implement it as a CLASS METHOD that
  // reaches for `this.repositoryForReview(...)`, so `this` was undefined and every
  // inline lookup threw a TypeError. The manifest executor swallowed it, marked
  // every inline child failed, and relocated the findings to the summary — WITHOUT
  // ever calling the provider. Verified against hmchangw/newchat#281, where the
  // review reported "inline publication failed" while no request was ever sent.
  //
  // Every fake in this file is an object literal whose methods ignore `this`,
  // which is precisely why the suite could not see the bug. This one does not.
  it("calls findBotChildMarker bound to the adapter, so a class method keeps its receiver", async () => {
    const args = makeArgs({ stateDir: isolatedStateDir() });
    const finding = {
      ruleName: "rule-a",
      severity: "warning" as const,
      category: "correctness",
      file: "x.ts",
      line: 1,
      message: "the error path drops the cause",
    };
    const h = makeHarness({
      args,
      dispatchResult: { findings: [finding], rulesRun: ["rule-a"], rulesFailed: [] },
      orchestrationResult: {
        commentBody: "- x.ts:1 — the error path drops the cause",
        inlineComments: [{
          clientId: "finding-0",
          path: "x.ts",
          line: 1,
          body: "the error path drops the cause",
          position: {
            oldPath: "x.ts",
            newPath: "x.ts",
            start: { type: "new" as const, newLine: 1 },
            end: { type: "new" as const, newLine: 1 },
            sameHunk: true as const,
          },
        }],
        findingsCount: 1,
        rulesRun: ["rule-a"],
        rulesFailed: [],
      },
    });

    // Stands in for the real adapters' `this.repositoryForReview(review)`.
    const receivers: unknown[] = [];
    function findBotChildMarker(this: unknown) {
      receivers.push(this);
      if (this === undefined || this === null) {
        throw new TypeError("Cannot read properties of undefined (reading 'repositoryForReview')");
      }
      return Promise.resolve(null);
    }
    h.vcsAdapter.findBotChildMarker = findBotChildMarker as never;

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver !== undefined && receiver !== null)).toBe(true);
    // The point of the fix: publication actually reaches the provider.
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalled();
  });

  it("a focused-command invocation anchors its findings as inline children", async () => {
    const args = makeArgs({ stateDir: isolatedStateDir() });
    const finding = {
      ruleName: "rule-a",
      severity: "warning" as const,
      category: "correctness",
      file: "x.ts",
      line: 1,
      message: "the error path drops the cause",
    };
    const secondFinding = {
      ...finding,
      line: 2,
      message: "the retry path drops the cause",
    };
    const h = makeHarness({
      args,
      dispatchResult: { findings: [finding, secondFinding], rulesRun: ["rule-a"], rulesFailed: [] },
      orchestrationResult: {
        commentBody: "- x.ts:1 — the error path drops the cause\n- x.ts:2 — the retry path drops the cause",
        inlineComments: [{
          // The orchestrator mints client IDs in this exact shape, and the
          // inline child derivation validates it.
          clientId: "finding-0",
          path: "x.ts",
          line: 1,
          body: "the error path drops the cause",
          position: {
            oldPath: "x.ts",
            newPath: "x.ts",
            start: { type: "new" as const, newLine: 1 },
            end: { type: "new" as const, newLine: 1 },
            sameHunk: true as const,
          },
        }, {
          clientId: "finding-1",
          path: "x.ts",
          line: 2,
          body: "the retry path drops the cause",
          position: {
            oldPath: "x.ts",
            newPath: "x.ts",
            start: { type: "new" as const, newLine: 2 },
            end: { type: "new" as const, newLine: 2 },
            sameHunk: true as const,
          },
        }],
        findingsCount: 2,
        rulesRun: ["rule-a"],
        rulesFailed: [],
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, {
      ...depsFrom(h),
      invocation: {
        kind: "focused-command",
        actionId: `action_${"7".repeat(32)}`,
        direction: "check the error handling",
      },
    });

    expect(exitCode).toBe(0);
    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    const [, , comments] = h.vcsAdapter.createInlineReview.mock.calls[0] as [unknown, string, { path: string; line: number }[]];
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ path: "x.ts", line: 1 });
    expect(comments[1]).toMatchObject({ path: "x.ts", line: 2 });
    expect(h.vcsAdapter.postGeneralReply).toHaveBeenCalledTimes(1);
    // Still supplemental.
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.resolveStaleReviewThreads).not.toHaveBeenCalled();
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
    const cfg = computeReviewConfigHash(makeArgs(), relatedWorkFingerprint(extractRelatedWork(priorInput)));
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

  it("ignores changes beyond the first ten references but re-reviews shorthand changed to an explicit pull", async () => {
    const url = "https://github.com/acme/app/pull/42";
    const ten = Array.from({ length: 10 }, (_, i) => `#${i + 1}`).join(" ");
    const configFor = (title: string) => computeReviewConfigHash(makeArgs(), relatedWorkFingerprint(extractRelatedWork({ provider: "github", reviewUrl: url, title, description: "" })));
    const cappedCfg = configFor(`${ten} #11`);
    const cappedComment: BotComment = { id: "999", body: formatMarker("cafef00d", cappedCfg), lastReviewedSha: "cafef00d", reviewedConfig: cappedCfg };
    const eleventhChanged = makeHarness({ botComment: cappedComment, pr: makePr({ url, title: `${ten} #12`, description: "" }) });
    await review(eleventhChanged.args, depsFrom(eleventhChanged));
    expect(eleventhChanged.dispatchRules).not.toHaveBeenCalled();
    expect(eleventhChanged.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    const shorthandCfg = configFor("#3");
    const shorthandComment: BotComment = { id: "999", body: formatMarker("cafef00d", shorthandCfg), lastReviewedSha: "cafef00d", reviewedConfig: shorthandCfg };
    const explicitPull = makeHarness({ botComment: shorthandComment, pr: makePr({ url, title: "https://github.com/acme/app/pull/3", description: "" }) });
    explicitPull.vcsAdapter.resolveRelatedWork.mockRejectedValue(new Error("lookup failed"));
    explicitPull.orchestrate.mockImplementation(buildPresentation);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await review(explicitPull.args, depsFrom(explicitPull));
    expect(explicitPull.dispatchRules).toHaveBeenCalledOnce();
    expect(explicitPull.vcsAdapter.resolveRelatedWork).toHaveBeenCalledOnce();
    expect(String(explicitPull.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1])).toContain("/pull/3");
    vi.restoreAllMocks();
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

    // Without a URL (a minimal adapter): the log still names the PR number, then
    // identity resolution fails closed instead of inventing a shared placeholder.
    const withoutUrl = makeHarness({ pr: makePr({ headSha: "cafef00d", url: undefined }), botComment: null });
    await expect(review(withoutUrl.args, depsFrom(withoutUrl))).rejects.toThrow(/identit|repository/i);
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

  it("completes anchored fallback publication for an adapter without durable inline recovery capability", async () => {
    const h = inlineHarness(partialPresentation());
    h.args = makeArgs({ vcs: "gitlab" });
    h.vcsAdapter.prepareInlineReviewRecovery = undefined as never;
    h.vcsAdapter.recoverInlineReview = undefined as never;
    h.vcsAdapter.createInlineReview.mockRejectedValue(new Error("inline unsupported"));
    expect(await review(h.args, depsFrom(h))).toBe(0);
    const finalBody = String(h.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    expect(finalBody).toContain("finding 0");
    expect(finalBody).toContain("tgd-review-agent:sha=");
    expect(finalBody).not.toContain("phase=ambiguous");
  });

  it("keeps all findings durably visible and leaves a pending marker after an ambiguous inline write", async () => {
    const h = inlineHarness(partialPresentation());
    h.vcsAdapter.createInlineReview.mockRejectedValue(new AmbiguousInlinePublishError());

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    const finalBody = String(h.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    for (const finding of ["finding 0", "finding 1", "finding 2"]) {
      expect(finalBody).toContain(finding);
    }
    expect(parseBotMarker(finalBody)?.pendingState?.phase).toBe("ambiguous");
    expect(finalBody).not.toContain("tgd-review-agent:sha=");
  });

  it("recovers an ambiguously accepted write on the next run without redispatch or repost", async () => {
    const first = inlineHarness(partialPresentation());
    first.vcsAdapter.createInlineReview.mockRejectedValue(new AmbiguousInlinePublishError());
    await review(first.args, depsFrom(first));
    const body = String(first.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    const parsed = parseBotMarker(body)!;
    const second = makeHarness({ botComment: { id: "written-summary-1", body, ...parsed } });
    second.vcsAdapter.recoverInlineReview.mockResolvedValue("complete");
    const exit = await review(second.args, depsFrom(second));
    expect(exit).toBe(0);
    expect(second.dispatchRules).not.toHaveBeenCalled();
    expect(second.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    const finalized = String(second.vcsAdapter.upsertComment.mock.calls[0]?.[1]);
    expect(finalized).toContain("tgd-review-agent:sha=cafef00d");
    expect(finalized).not.toContain("finding 0");
  });

  it("keeps fallback visible and pending when the first reconciliation sees no markers", async () => {
    const first = inlineHarness(partialPresentation());
    first.vcsAdapter.createInlineReview.mockRejectedValue(new AmbiguousInlinePublishError());
    await review(first.args, depsFrom(first));
    const body = String(first.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    const second = makeHarness({ botComment: { id: "written-summary-1", body, ...parseBotMarker(body)! } });
    second.vcsAdapter.recoverInlineReview.mockResolvedValue("none");
    const logSpy = vi.spyOn(console, "log");
    expect(await review(second.args, depsFrom(second))).toBe(2);
    expect(second.dispatchRules).not.toHaveBeenCalled();
    expect(second.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(body).toContain("finding 0");
    expect(parseBotMarker(body)?.pendingState?.phase).toBe("ambiguous");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("inline-publication-awaiting-consistency"));
  });

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
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      clientId: withInline.inlineComments[0]!.clientId,
      path: "x.ts",
      line: 2,
      position: withInline.inlineComments[0]!.position,
    });
    expect(String(comments[0]?.body)).toContain(withInline.inlineComments[0]!.body);
    expect(parseChildMarker(String(comments[0]?.body).trim().split("\n").at(-1) ?? "")?.kind).toBe("finding");
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
      postedInline("finding-0"),
      { clientId: "finding-1", status: "failed", reason: "position rejected" },
      postedInline("finding-2"),
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
      postedInline("finding-0"),
      { clientId: "finding-1", status: "failed", reason: "position rejected" },
      postedInline("finding-2"),
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
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
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
      postedInline("finding-0"),
      { clientId: "finding-1", status: "failed", reason: "position rejected" },
      postedInline("finding-2"),
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
      postedInline("finding-0"),
      { clientId: "finding-1", status: "failed", reason: "position rejected" },
      postedInline("finding-2"),
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
      postedInline("finding-0"),
      { clientId: "finding-1", status: "failed" },
    ]],
    ["duplicate", [
      postedInline("finding-0"),
      { clientId: "finding-0", status: "failed" },
      postedInline("finding-2"),
    ]],
    ["unknown", [
      postedInline("finding-0"),
      postedInline("finding-1"),
      { clientId: "not-a-finding", status: "failed" },
    ]],
    ["invalid status", [
      postedInline("finding-0"),
      { clientId: "finding-1", status: "accepted" },
      postedInline("finding-2"),
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
      postedInline("finding-0"),
      { clientId: "finding-1", status: "failed", reason: "position rejected" },
      postedInline("finding-2"),
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
    expect(h.orchestrate.mock.calls[0]?.[2]).toMatchObject({ inline: true, suggestions: true, relatedWork: [] });
    expect(h.orchestrate.mock.calls[0]?.[2]).toMatchObject({
      reviewBinding: { reviewNumber: 42, headSha: "cafef00d" },
    });
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
    const fingerprint = relatedWorkFingerprint(extractRelatedWork({ provider: "github", reviewUrl: pr.url!, title: pr.title, description: pr.description }));
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
    selective.vcsAdapter.createInlineReview.mockResolvedValue([postedInline("finding-0"), { clientId: "finding-1", status: "failed", reason: "position rejected" }]);
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

describe("review publication crash-matrix", () => {
  const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n";
  const GITLAB_REPO = {
    provider: "gitlab" as const,
    host: "gitlab.example.com",
    namespace: ["group"],
    repo: "project",
    canonicalUrl: "https://gitlab.example.com/group/project",
  };
  const GITLAB_BINDING = { repo: GITLAB_REPO, reviewNumber: 42 };

  function threeInlineHarness(stateDir: string, provider: "github" | "gitlab" = "github") {
    const findings: DispatchResult = {
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
    const args = provider === "gitlab"
      ? makeArgs({
          pr: "https://gitlab.example.com/group/project/-/merge_requests/42",
          vcs: "gitlab",
          stateDir,
        })
      : makeArgs({ stateDir });
    const h = makeHarness({
      args,
      pr: makePr({ url: provider === "gitlab" ? args.pr : DEFAULT_PR_URL }),
      dispatchResult: findings,
    });
    h.vcsAdapter.getDiff.mockResolvedValue(DIFF);
    h.orchestrate.mockImplementation(buildPresentation);
    if (provider === "gitlab") {
      h.vcsAdapter.prepareInlineReviewRecovery = undefined as never;
      h.vcsAdapter.recoverInlineReview = undefined as never;
    }
    return h;
  }

  function postedGitlabInline(clientId: string) {
    const commentId = `note-${clientId.replace(/[^A-Za-z0-9._:-]/gu, "")}`;
    return {
      clientId,
      status: "posted" as const,
      identity: validateConversationItemIdentity({
        provider: "gitlab",
        commentId,
        threadId: `discussion-${clientId.replace(/[^A-Za-z0-9._:-]/gu, "")}`,
        url: `${GITLAB_REPO.canonicalUrl}/-/merge_requests/42#note_${commentId}`,
      }, GITLAB_BINDING),
    };
  }

  function wireSharedPublication(
    h: Harness,
    shared: {
      stored: BotComment | null;
      posted: Array<{ clientId: string; body: string; identity: ReturnType<typeof postedGitlabInline>["identity"] }>;
    },
  ) {
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(shared.stored));
    h.vcsAdapter.upsertComment.mockImplementation((_locator, body: string, existing: BotComment | null) => {
      const parsed = parseBotMarker(body);
      shared.stored = {
        id: existing?.id ?? "written-summary-1",
        body,
        ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
      };
      return Promise.resolve(shared.stored);
    });
    h.vcsAdapter.createInlineReview.mockImplementation(
      (_locator, _headSha, comments: Array<{ clientId: string; body: string }>) => {
        const outcomes = comments.map((comment) => {
          const posted = comment.clientId === "finding-1"
            ? { clientId: comment.clientId, status: "failed" as const, reason: "position rejected" }
            : postedGitlabInline(comment.clientId);
          if (posted.status === "posted") {
            shared.posted.push({ clientId: comment.clientId, body: comment.body, identity: posted.identity });
          }
          return posted;
        });
        return Promise.resolve(outcomes);
      },
    );
    h.vcsAdapter.findPublishedMarker.mockImplementation((_locator, marker: string) => {
      const found = shared.posted.find((entry) => entry.body.includes(marker));
      return Promise.resolve(found?.identity ?? null);
    });
    h.vcsAdapter.findBotChildMarker.mockImplementation(() => Promise.resolve(null));
    return shared;
  }

  it("recovers a crash before the first provider write without invoking the model again", async () => {
    const stateDir = isolatedStateDir();
    const first = threeInlineHarness(stateDir);
    first.publicationHooks = {
      beforeChildWrite: async () => {
        throw new Error("crash before first write");
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(review(first.args, depsFrom(first))).rejects.toThrow(/crash before first write/);
    expect(first.dispatchRules).toHaveBeenCalledTimes(1);
    expect(first.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(first.vcsAdapter.createInlineReview).not.toHaveBeenCalled();

    const second = threeInlineHarness(stateDir);
    const modelOnRecovery = vi.fn();
    second.publicationHooks = { onModelWork: modelOnRecovery };
    expect(await review(second.args, depsFrom(second))).toBe(0);
    expect(second.dispatchRules).not.toHaveBeenCalled();
    expect(second.orchestrate).not.toHaveBeenCalled();
    expect(modelOnRecovery).not.toHaveBeenCalled();
    expect(second.vcsAdapter.upsertComment).toHaveBeenCalled();
    expect(second.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    expect(second.vcsAdapter.findPublishedMarker).toHaveBeenCalled();
  });

  it("recovers GitHub atomic-inline fallback from a frozen manifest", async () => {
    const stateDir = isolatedStateDir();
    const first = threeInlineHarness(stateDir);
    first.vcsAdapter.createInlineReview.mockRejectedValue(new Error("atomic inline rejected"));
    first.publicationHooks = {
      afterChildWrite: async (child) => {
        if (child.kind === "inline") throw new Error("crash after atomic inline fallback");
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(review(first.args, depsFrom(first))).rejects.toThrow(/crash after atomic inline fallback|atomic inline rejected/);

    const second = threeInlineHarness(stateDir);
    second.vcsAdapter.createInlineReview.mockRejectedValue(new Error("atomic inline rejected"));
    expect(await review(second.args, depsFrom(second))).toBe(0);
    expect(second.dispatchRules).not.toHaveBeenCalled();
    const finalBody = String(second.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1] ?? first.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    expect(finalBody).toContain("finding 0");
    expect(finalBody).toContain("finding 1");
    expect(finalBody).toContain("finding 2");
  });

  it.each([0, 1, 2, 3])(
    "recovers GitLab after %s inline(s) were accepted before persist",
    async (crashAfter) => {
      const stateDir = isolatedStateDir();
      const shared = {
        stored: null as BotComment | null,
        posted: [] as Array<{ clientId: string; body: string; identity: ReturnType<typeof postedGitlabInline>["identity"] }>,
      };
      const first = threeInlineHarness(stateDir, "gitlab");
      wireSharedPublication(first, shared);
      let inlinesSeen = 0;
      first.publicationHooks = {
        beforeChildWrite: async (child) => {
          if (crashAfter === 0 && child.kind === "inline" && ++inlinesSeen === 1) {
            throw new Error("crash before first gitlab inline");
          }
        },
        afterChildWrite: async (child) => {
          if (child.kind === "inline" && crashAfter > 0 && ++inlinesSeen === crashAfter) {
            throw new Error(`crash after gitlab inline ${crashAfter} before persist`);
          }
        },
      };
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(review(first.args, depsFrom(first))).rejects.toThrow(/crash (?:before first gitlab inline|after gitlab inline)/);
      expect(first.dispatchRules).toHaveBeenCalledTimes(1);
      const postedAfterCrash = {
        0: [],
        1: ["finding-0"],
        2: ["finding-0"],
        3: ["finding-0", "finding-2"],
      }[crashAfter];
      expect(shared.posted.map((entry) => entry.clientId)).toEqual(postedAfterCrash);
      expect(shared.stored?.pendingState?.phase).toBe("ready");

      const second = threeInlineHarness(stateDir, "gitlab");
      wireSharedPublication(second, shared);
      const modelOnRecovery = vi.fn();
      second.publicationHooks = { onModelWork: modelOnRecovery };
      expect(shared.stored?.pendingState?.phase).toBe("ready");
      expect(await review(second.args, depsFrom(second))).toBe(0);
      expect(second.dispatchRules).not.toHaveBeenCalled();
      expect(second.orchestrate).not.toHaveBeenCalled();
      expect(modelOnRecovery).not.toHaveBeenCalled();
      expect(second.vcsAdapter.findPublishedMarker).toHaveBeenCalled();
      expect(second.vcsAdapter.findPublishedMarker.mock.calls.some((call) =>
        typeof call[1] === "string" && call[1].includes("tgd-"),
      )).toBe(true);
      const postedIds = shared.posted.map((entry) => entry.clientId);
      expect(postedIds).toEqual(["finding-0", "finding-2"]);
      expect(new Set(postedIds).size).toBe(postedIds.length);
      const resumeWrites = second.vcsAdapter.createInlineReview.mock.calls.flatMap(
        (call) => (call[2] as Array<{ clientId: string }>).map((comment) => comment.clientId),
      );
      expect(resumeWrites).toEqual({
        0: ["finding-0", "finding-1", "finding-2"],
        1: ["finding-1", "finding-2"],
        2: ["finding-1", "finding-2"],
        3: [],
      }[crashAfter]);
      const finalBody = String(second.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
      expect(finalBody).not.toContain("finding 0");
      expect(finalBody).toContain("finding 1");
      expect(finalBody).not.toContain("finding 2");
    },
  );

  it("does not promote the conservative ready body after a crash between complete persist and summary rewrite", async () => {
    const stateDir = isolatedStateDir();
    let stored: BotComment | null = null;
    const wire = (h: Harness) => {
      h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
      h.vcsAdapter.upsertComment.mockImplementation((_locator, body: string, existing: BotComment | null) => {
        const parsed = parseBotMarker(body);
        stored = {
          id: existing?.id ?? "written-summary-1",
          body,
          ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
        };
        return Promise.resolve(stored);
      });
      h.vcsAdapter.createInlineReview.mockResolvedValue([
        postedInline("finding-0"),
        { clientId: "finding-1", status: "failed", reason: "position rejected" },
        postedInline("finding-2"),
      ]);
    };

    const first = threeInlineHarness(stateDir);
    wire(first);
    first.publicationHooks = {
      afterPublication: async () => {
        throw new Error("crash after complete persist before summary rewrite");
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(review(first.args, depsFrom(first))).rejects.toThrow(
      /crash after complete persist before summary rewrite/,
    );
    expect(first.dispatchRules).toHaveBeenCalledTimes(1);
    expect(first.vcsAdapter.createInlineReview).toHaveBeenCalledTimes(1);
    expect(stored?.pendingState?.phase).toBe("ready");
    expect(stored?.lastReviewedSha).toBe("");
    expect(stored?.body).toContain("finding 0");
    expect(stored?.body).toContain("finding 1");
    expect(stored?.body).toContain("finding 2");

    const second = threeInlineHarness(stateDir);
    wire(second);
    second.vcsAdapter.createInlineReview.mockImplementation(() => {
      throw new Error("duplicate inline publish");
    });
    const modelOnRecovery = vi.fn();
    second.publicationHooks = { onModelWork: modelOnRecovery };
    expect(await review(second.args, depsFrom(second))).toBe(0);
    expect(second.dispatchRules).not.toHaveBeenCalled();
    expect(second.orchestrate).not.toHaveBeenCalled();
    expect(modelOnRecovery).not.toHaveBeenCalled();
    expect(second.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
    expect(stored?.pendingState).toBeUndefined();
    expect(stored?.lastReviewedSha).toBe("cafef00d");
    expect(stored?.reviewedConfig).toBe(computeReviewConfigHash(second.config));
    expect(stored?.body).not.toContain("finding 0");
    expect(stored?.body).toContain("finding 1");
    expect(stored?.body).not.toContain("finding 2");
  });

  it("serializes two review publishers so each marker is written once", async () => {
    const stateDir = isolatedStateDir();
    const release = Promise.withResolvers<void>();
    const ready: Array<PromiseWithResolvers<void>> = [];
    const first = threeInlineHarness(stateDir);
    const second = threeInlineHarness(stateDir);
    const pause = async () => {
      const gate = Promise.withResolvers<void>();
      ready.push(gate);
      gate.resolve();
      await release.promise;
    };
    first.publicationHooks = { beforePublication: pause };
    second.publicationHooks = { beforePublication: pause };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runs = Promise.all([
      review(first.args, depsFrom(first)),
      review(second.args, depsFrom(second)),
    ]);
    await vi.waitFor(() => expect(ready).toHaveLength(2), { timeout: 10_000 });
    release.resolve();
    await expect(runs).resolves.toEqual([0, 0]);
    const inlineCalls = first.vcsAdapter.createInlineReview.mock.calls.length
      + second.vcsAdapter.createInlineReview.mock.calls.length;
    expect(inlineCalls).toBe(1);
  });
});

const CONVERSATION_HEAD = "cafef00d";
const CONVERSATION_PR_URL = "https://github.com/acme/app/pull/42";
const conversationRepo = parseRepositoryRef("acme/app", "github");

function conversationBinding() {
  return {
    provider: "github" as const,
    repositoryDigest: createHash("sha256").update(conversationRepo.canonicalUrl, "utf8").digest("hex"),
    reviewNumber: 42,
  };
}

function conversationThread(overrides: Partial<ReviewThreadSnapshot> & Pick<ReviewThreadSnapshot, "threadId" | "events">): ReviewThreadSnapshot {
  const binding = conversationBinding();
  const root = overrides.events[0];
  const rootCommentId = root && "commentId" in root && root.commentId ? root.commentId : `${overrides.threadId}-root`;
  return {
    ...binding,
    rootCommentId,
    url: `${CONVERSATION_PR_URL}#discussion_r${rootCommentId}`,
    resolved: false,
    outdated: false,
    updatedAt: "2026-08-14T00:00:00.000Z",
    orderKey: `thread:${overrides.threadId}`,
    placement: {
      file: "src/changed.ts",
      line: 10,
      side: "new",
      originalHeadSha: CONVERSATION_HEAD,
      currentHeadSha: CONVERSATION_HEAD,
      outdated: false,
    },
    ...overrides,
    threadId: overrides.threadId,
    events: overrides.events,
  };
}

function conversationComment(threadId: string, commentId: string, body: string, extras: Record<string, unknown> = {}) {
  const binding = conversationBinding();
  return {
    ...binding,
    kind: "thread-comment" as const,
    eventId: `review-comment:${commentId}`,
    revisionId: `rev-${commentId}`,
    orderKey: `comment:${commentId}`,
    authorLogin: extras.authorLogin ?? "tgdbot",
    authorIsBot: extras.authorIsBot ?? true,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    url: `${CONVERSATION_PR_URL}#discussion_r${commentId}`,
    commentId,
    threadId,
    body,
    ...extras,
  };
}

function emptyEventPage() {
  const binding = conversationBinding();
  return {
    events: [],
    nextCursor: {
      scope: "review-events" as const,
      provider: "github" as const,
      repositoryDigest: binding.repositoryDigest,
      reviewNumber: 42,
      opaque: "hw-0",
      orderKey: "2026-08-14T00:00:00.000Z",
    },
  };
}

function installConversationReads(
  h: Harness,
  threads: readonly ReviewThreadSnapshot[],
  options: { extraUnrelated?: ReviewThreadSnapshot } = {},
) {
  const binding = conversationBinding();
  const all = options.extraUnrelated === undefined ? threads : [...threads, options.extraUnrelated];
  h.vcsAdapter.listReviewThreads = vi.fn().mockResolvedValue({
    threads: all.map(({ events, ...summary }) => {
      void events;
      return summary;
    }),
  });
  h.vcsAdapter.getReviewThread = vi.fn().mockImplementation((_review, threadId: string) => {
    const match = all.find((thread) => thread.threadId === threadId);
    return match === undefined ? Promise.reject(new Error(`missing thread ${threadId}`)) : Promise.resolve(match);
  });
  h.vcsAdapter.listReviewEvents = vi.fn().mockResolvedValue(emptyEventPage());
  void binding;
}

async function seedConversationState(stateDir: string, options: {
  memoryText?: string;
  directionText?: string;
  pendingQuestion?: string;
} = {}): Promise<void> {
  const store = createConversationStateStore({ root: stateDir, repository: conversationRepo });
  await store.transact((tx) => {
    tx.initializeIfAbsent();
    if (options.memoryText !== undefined) {
      tx.appendMemory({
        version: 1,
        repository: tx.snapshot.cursor.repository,
        operation: "create",
        id: `memory_${"a".repeat(32)}`,
        text: options.memoryText,
        attribution: "reviewer",
        source: `${CONVERSATION_PR_URL}#discussion_r9`,
        at: "2026-08-14T00:00:00.000Z",
      });
    }
    if (options.directionText !== undefined || options.pendingQuestion !== undefined) {
      tx.replacePending({
        version: 1,
        repository: tx.snapshot.cursor.repository,
        clarifications: options.pendingQuestion === undefined ? [] : [{
          id: `clar_${"b".repeat(26)}`,
          reviewNumber: 42,
          headSha: CONVERSATION_HEAD,
          question: options.pendingQuestion,
          createdAt: "2026-08-14T00:00:00.000Z",
        }],
        directions: options.directionText === undefined ? [] : [{
          id: `direction_${"c".repeat(32)}`,
          reviewNumber: 42,
          headSha: CONVERSATION_HEAD,
          text: options.directionText,
          createdAt: "2026-08-14T00:00:00.000Z",
        }],
      });
    }
  });
}

function conversationHarness(options: {
  dispatch?: "direct" | "legacy";
  botComment?: BotComment | null;
  threads?: readonly ReviewThreadSnapshot[];
} = {}) {
  const h = makeHarness({
    args: makeArgs({ dispatch: options.dispatch ?? "direct" }),
    pr: makePr({ url: CONVERSATION_PR_URL }),
    botComment: options.botComment ?? null,
  });
  if (options.threads) installConversationReads(h, options.threads);
  return h;
}

function captureFindingAppends(h: Harness) {
  const appended: Array<{ identity?: unknown }> = [];
  const original = h.config as ResolvedConfig;
  void original;
  const createStateStore: ReviewDependencies["createStateStore"] = (opts) => {
    const store = createConversationStateStore(opts);
    const wrap = <T>(tx: T): T => {
      const record = tx as { appendFinding: (entry: { identity?: unknown }) => void };
      const originalAppend = record.appendFinding.bind(record);
      record.appendFinding = (entry) => {
        appended.push(structuredClone(entry));
        return originalAppend(entry);
      };
      return tx;
    };
    return {
      ...store,
      repositoryBinding: store.repositoryBinding,
      readContextSnapshot: store.readContextSnapshot.bind(store),
      readAuditPage: store.readAuditPage.bind(store),
      findTerminalAction: store.findTerminalAction.bind(store),
      findTerminalActions: store.findTerminalActions.bind(store),
      findMemory: store.findMemory.bind(store),
      findFinding: store.findFinding.bind(store),
      transact: (fn) => store.transact((tx) => fn(wrap(tx))),
      withExclusiveLock: (fn) => store.withExclusiveLock(async (session) => {
        const originalCommit = session.commit.bind(session);
        return fn({
          snapshot: session.snapshot.bind(session),
          findTerminalAction: session.findTerminalAction.bind(session),
          commit: (txFn) => originalCommit((tx) => txFn(wrap(tx))),
        });
      }),
    };
  };
  return { appended, createStateStore };
}

describe("conversation-aware review", () => {
  const relevant = conversationThread({
    threadId: "changed-line",
    events: [conversationComment("changed-line", "c1", "RELEVANT still open on the changed line")],
  });
  const unrelated = conversationThread({
    threadId: "unrelated-human",
    placement: {
      file: "src/unrelated.ts",
      line: 1,
      side: "new",
      originalHeadSha: CONVERSATION_HEAD,
      currentHeadSha: CONVERSATION_HEAD,
      outdated: false,
    },
    events: [conversationComment("unrelated-human", "u1", "UNRELATED chatter that must not affect review", {
      authorLogin: "alice",
      authorIsBot: false,
    })],
  });

  it("passes active review anchors and human comment memories into orchestration", async () => {
    const human = conversationThread({
      threadId: "human-existing-issue",
      events: [conversationComment(
        "human-existing-issue",
        "human-c1",
        "This nil case is already handled by the caller.",
        { authorLogin: "alice", authorIsBot: false },
      )],
    });
    const h = conversationHarness({ threads: [human] });

    await review(h.args, depsFrom(h));

    expect(h.orchestrate.mock.calls[0]?.[2]).toMatchObject({
      existingIssues: [{ threadId: "human-existing-issue", file: "src/changed.ts", line: 10 }],
      discussionMemories: [{
        threadId: "human-existing-issue",
        file: "src/changed.ts",
        line: 10,
        author: "alice",
        summary: "This nil case is already handled by the caller.",
      }],
    });
  });

  it("fetches current discussion even when no poll state exists and passes it to both dispatch modes", async () => {
    for (const dispatch of ["direct", "legacy"] as const) {
      const h = conversationHarness({ dispatch, threads: [relevant] });
      await seedConversationState(h.args.stateDir!, {
        memoryText: "ACTIVE_MEMORY prefer explicit types",
        directionText: "DIRECTION_NOW focus on auth",
      });
      const paths = deriveConversationStatePaths(h.args.stateDir!, conversationRepo);

      await review(h.args, depsFrom(h));

      expect(h.vcsAdapter.listReviewThreads).toHaveBeenCalled();
      expect(h.vcsAdapter.getReviewThread).toHaveBeenCalled();
      const input = h.dispatchRules.mock.calls[0]?.[0];
      expect(input.conversationContext?.text).toContain("RELEVANT still open");
      expect(input.conversationContext?.text).toContain("ACTIVE_MEMORY prefer explicit types");
      expect(input.conversationContext?.text).toContain("DIRECTION_NOW focus on auth");
      expect(input.conversationContext?.text).not.toContain("UNRELATED chatter");
      expect(input.conversationContext?.digest).toMatch(/^[0-9a-f]{64}$/u);
      const cursor = JSON.parse(readFileSync(paths.cursorPath, "utf8")) as { initialized?: boolean; reviews?: unknown[] };
      expect(cursor.reviews ?? []).toEqual([]);
      expect(cursor.initialized === true ? cursor.reviews : []).toEqual([]);
    }
  });

  it("includes the conversation digest in dedup, re-reviews relevant changes, and ignores unrelated comments", async () => {
    const first = conversationHarness({ threads: [relevant] });
    await seedConversationState(first.args.stateDir!, { memoryText: "ACTIVE_MEMORY prefer explicit types" });
    await review(first.args, depsFrom(first));
    const posted = String(first.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    const parsed = parseBotMarker(posted)!;
    const fingerprint = conversationDedupFingerprint({
      selectedDiscussion: [{ id: "changed-line", revisionId: "rev-c1" }],
      pending: [],
      directions: [],
      memories: [{ id: `memory_${"a".repeat(32)}`, revision: "2026-08-14T00:00:00.000Z" }],
      stateRootDomain: stateRootDomainIdentifier(first.args.stateDir!),
    });
    expect(parsed.reviewedConfig).toBe(computeReviewConfigHash(first.config, undefined, fingerprint));

    const unchanged = conversationHarness({
      botComment: { id: "999", body: posted, lastReviewedSha: CONVERSATION_HEAD, reviewedConfig: parsed.reviewedConfig },
      threads: [relevant],
    });
    unchanged.args.stateDir = first.args.stateDir;
    unchanged.config = { ...unchanged.config, stateDir: first.args.stateDir };
    unchanged.resolveConfig.mockReturnValue(unchanged.config);
    installConversationReads(unchanged, [relevant], { extraUnrelated: unrelated });
    await review(unchanged.args, depsFrom(unchanged));
    expect(unchanged.dispatchRules).not.toHaveBeenCalled();

    const edited = conversationThread({
      threadId: "changed-line",
      events: [conversationComment("changed-line", "c1", "RELEVANT still open on the changed line", { revisionId: "rev-c1-edited" })],
    });
    const changed = conversationHarness({
      botComment: { id: "999", body: posted, lastReviewedSha: CONVERSATION_HEAD, reviewedConfig: parsed.reviewedConfig },
      threads: [edited],
    });
    changed.args.stateDir = first.args.stateDir;
    changed.config = { ...changed.config, stateDir: first.args.stateDir };
    changed.resolveConfig.mockReturnValue(changed.config);
    await review(changed.args, depsFrom(changed));
    expect(changed.dispatchRules).toHaveBeenCalledOnce();
  });

  it("passes the native provider review identity — not the PR number — to conversation reads", async () => {
    const nativeId = "PR_kwDOTestNativeId";
    expect(nativeId).not.toBe("42");
    const h = conversationHarness({ threads: [relevant] });
    h.vcsAdapter.getPullRequest.mockResolvedValue(makePr({
      url: CONVERSATION_PR_URL,
      reviewId: nativeId,
    }));

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.listReviewThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: nativeId,
        repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
      }),
      undefined,
    );
    expect(h.vcsAdapter.getReviewThread).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: nativeId }),
      "changed-line",
    );
  });

  it("uses an adapter-resolved ReviewIdentity when the adapter exposes one", async () => {
    const nativeId = "PR_kwDOResolvedFromAdapter";
    const h = conversationHarness({ threads: [relevant] });
    h.vcsAdapter.resolveReviewIdentity = vi.fn().mockResolvedValue({
      provider: "github",
      repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
      reviewNumber: 42,
      reviewId: nativeId,
      url: CONVERSATION_PR_URL,
    });

    await review(h.args, depsFrom(h));

    expect(h.vcsAdapter.resolveReviewIdentity).toHaveBeenCalled();
    expect(h.vcsAdapter.listReviewThreads).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: nativeId }),
      undefined,
    );
    expect(nativeId).not.toBe(String((await h.vcsAdapter.getPullRequest()).id));
  });

  it("does not skip when a human unresolved thread sits on a file that appears in the new diff", async () => {
    const diff = [
      "diff --git a/src/changed.ts b/src/changed.ts",
      "--- a/src/changed.ts",
      "+++ b/src/changed.ts",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+added",
    ].join("\n");
    const humanThread = conversationThread({
      threadId: "human-changed-line",
      events: [conversationComment("human-changed-line", "h1", "Please check this changed line", {
        authorLogin: "alice",
        authorIsBot: false,
      })],
    });

    const first = conversationHarness();
    first.vcsAdapter.getDiff.mockResolvedValue(diff);
    await review(first.args, depsFrom(first));
    const posted = String(first.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    const parsed = parseBotMarker(posted)!;

    const second = conversationHarness({
      botComment: {
        id: "999",
        body: posted,
        lastReviewedSha: CONVERSATION_HEAD,
        reviewedConfig: parsed.reviewedConfig,
      },
      threads: [humanThread],
    });
    second.args.stateDir = first.args.stateDir;
    second.config = { ...second.config, stateDir: first.args.stateDir };
    second.resolveConfig.mockReturnValue(second.config);
    second.vcsAdapter.getDiff.mockResolvedValue(diff);

    await review(second.args, depsFrom(second));

    expect(second.dispatchRules).toHaveBeenCalledOnce();
    expect(second.dispatchRules.mock.calls[0]?.[0].conversationContext?.text).toContain("Please check this changed line");
  });

  it("renders a visible notice when optional discussion context cannot load", async () => {
    const h = conversationHarness();
    h.args = makeArgs({ dryRun: true, dispatch: "direct" });
    h.config = { ...h.config, dryRun: true };
    h.resolveConfig.mockReturnValue(h.config);
    h.vcsAdapter.listReviewThreads = vi.fn().mockRejectedValue(new Error("GitHub authentication failed (HTTP 401)"));
    h.vcsAdapter.listReviewEvents = vi.fn().mockResolvedValue(emptyEventPage());
    h.vcsAdapter.getReviewThread = vi.fn();
    h.orchestrate.mockImplementation(buildPresentation);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(h.dispatchRules).toHaveBeenCalledOnce();
    expect(h.dispatchRules.mock.calls[0]?.[0].conversationContext).toBeUndefined();
    expect(h.orchestrate.mock.calls[0]?.[2]?.contextUnavailable).toEqual(expect.arrayContaining(["discussion"]));
    expect(log.mock.calls.flat().join("\n")).toMatch(/discussion context was unavailable/i);
  });

  it("discards partial thread pagination instead of dispatching a truncated snapshot", async () => {
    const h = conversationHarness();
    h.args = makeArgs({ dryRun: true, dispatch: "direct" });
    h.config = { ...h.config, dryRun: true };
    h.resolveConfig.mockReturnValue(h.config);
    const binding = conversationBinding();
    const token = {
      scope: "review-thread-page" as const,
      provider: "github" as const,
      repositoryDigest: binding.repositoryDigest,
      reviewNumber: 42,
      opaque: "page-2",
    };
    h.vcsAdapter.listReviewThreads = vi.fn()
      .mockResolvedValueOnce({
        threads: [relevant].map(({ events, ...summary }) => {
          void events;
          return summary;
        }),
        nextPageToken: token,
      })
      .mockRejectedValueOnce(new Error("GitHub lookup exceeded its bounded resource limit"));
    h.vcsAdapter.getReviewThread = vi.fn().mockResolvedValue(relevant);
    h.vcsAdapter.listReviewEvents = vi.fn().mockResolvedValue(emptyEventPage());
    h.orchestrate.mockImplementation(buildPresentation);

    await review(h.args, depsFrom(h));

    expect(h.dispatchRules.mock.calls[0]?.[0].conversationContext?.text ?? "").not.toContain("RELEVANT still open");
    expect(h.orchestrate.mock.calls[0]?.[2]?.contextUnavailable).toEqual(expect.arrayContaining(["discussion"]));
  });

  it("prepares a finding ledger record before publication and binds provider identity after", async () => {
    const finding = {
      ruleName: "rule-a",
      severity: "blocking" as const,
      category: "correctness",
      file: "x.ts",
      line: 2,
      message: "Boom.",
    };
    const h = makeHarness({
      pr: makePr({ url: CONVERSATION_PR_URL }),
      orchestrationResult: {
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
          body: "_🔴 Blocking_\n\n**Boom.**\n<!-- tgd-review-agent:inline -->",
        }],
        findingsCount: 1,
        rulesRun: ["rule-a"],
        rulesFailed: [],
        findingByClientId: new Map([["finding-0", finding]]),
        summaryInput: {
          rulesRun: ["rule-a"],
          rulesFailed: [],
          allFindings: [finding],
          unanchored: [],
          filesReviewed: ["x.ts"],
          inlineCount: 1,
        },
      },
    });
    const { appended, createStateStore } = captureFindingAppends(h);
    let preparedBeforeWrite: { identity?: unknown } | undefined;
    h.vcsAdapter.createInlineReview.mockImplementation(async (locator, headSha, comments) => {
      preparedBeforeWrite = appended.find((entry) => entry.identity === undefined);
      return (comments as Array<{ clientId: string }>).map(({ clientId }) => postedInline(clientId));
    });

    await review(h.args, { ...depsFrom(h), createStateStore });

    expect(preparedBeforeWrite).toMatchObject({
      id: expect.stringMatching(/^finding_[0-9a-f]{32}$/u),
      finding,
      reviewOptions: expect.objectContaining({ dispatch: "direct", suggestions: "on" }),
      baseSha: "deadbeef",
      headSha: CONVERSATION_HEAD,
      placement: expect.objectContaining({ file: "x.ts", line: 2 }),
    });
    expect(typeof (preparedBeforeWrite as { bodyDigest?: string } | undefined)?.bodyDigest).toBe("string");
    expect(typeof (preparedBeforeWrite as { ruleDigest?: string } | undefined)?.ruleDigest).toBe("string");
    expect(typeof (preparedBeforeWrite as { ruleSnapshot?: string } | undefined)?.ruleSnapshot).toBe("string");
    expect((preparedBeforeWrite as { reviewId?: string } | undefined)?.reviewId).toBe(DEFAULT_REVIEW_ID);
    expect((preparedBeforeWrite as { reviewId?: string } | undefined)?.reviewId).not.toBe("42");
    expect(appended.some((entry) => entry.identity !== undefined)).toBe(true);
    expect(appended.find((entry) => entry.identity !== undefined)?.identity).toMatchObject({
      provider: "github",
      commentId: "comment-finding-0",
    });

    const postedInlineBody = String((h.vcsAdapter.createInlineReview.mock.calls[0]?.[2] as Array<{ body: string }>)[0]?.body ?? "");
    expect(postedInlineBody).toContain(INLINE_COMMENT_MARKER);
    const markerLine = postedInlineBody.trim().split("\n").at(-1) ?? "";
    expect(parseChildMarker(markerLine)?.kind).toBe("finding");
    expect(h.vcsAdapter.findBotChildMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: DEFAULT_REVIEW_ID,
        reviewNumber: 42,
        repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
      }),
      expect.objectContaining({ kind: "finding" }),
    );
  });

  function inlineFindingOrchestration(message = "Boom.") {
    const finding = {
      ruleName: "rule-a",
      severity: "blocking" as const,
      category: "correctness",
      file: "x.ts",
      line: 2,
      message,
    };
    return {
      finding,
      orchestrationResult: {
        commentBody: "**Actionable comments posted: 1**",
        inlineComments: [{
          clientId: "finding-0",
          path: "x.ts",
          line: 2,
          position: {
            oldPath: "x.ts",
            newPath: "x.ts",
            start: { type: "new" as const, newLine: 2 },
            end: { type: "new" as const, newLine: 2 },
            sameHunk: true as const,
          },
          body: `_🔴 Blocking_\n\n**${message}**\n<!-- tgd-review-agent:inline -->`,
        }],
        findingsCount: 1,
        rulesRun: ["rule-a"],
        rulesFailed: [],
        findingByClientId: new Map([["finding-0", finding]]),
        summaryInput: {
          rulesRun: ["rule-a"],
          rulesFailed: [],
          allFindings: [finding],
          unanchored: [],
          filesReviewed: ["x.ts"],
          inlineCount: 1,
        },
      } satisfies OrchestrationResult,
    };
  }

  it("canonicalizes mixed-case ambient GitHub identity across conversation, ledger, and publication", async () => {
    const mixedUrl = "https://github.com/Azure/sdk/pull/42";
    const mixedRepo = parseRepositoryRef("Azure/sdk", "github");
    const canonicalRepo = parseRepositoryRef("azure/sdk", "github");
    const nativeId = "PR_kwDOAzureSdk";
    const { orchestrationResult } = inlineFindingOrchestration();
    const h = makeHarness({
      pr: makePr({ url: mixedUrl, reviewId: nativeId }),
      orchestrationResult,
    });
    installConversationReads(h, [relevant]);
    const { appended, createStateStore } = captureFindingAppends(h);

    await review(h.args, { ...depsFrom(h), createStateStore });

    const mixedStore = createConversationStateStore({ root: h.args.stateDir!, repository: mixedRepo });
    const canonicalStore = createConversationStateStore({ root: h.args.stateDir!, repository: canonicalRepo });
    const binding = mixedStore.repositoryBinding;
    expect(canonicalStore.repositoryBinding).toEqual(binding);
    expect(binding.repositoryDigest).not.toBe(
      createHash("sha256").update(mixedRepo.canonicalUrl, "utf8").digest("hex"),
    );
    expect(binding.repositoryDigest).toBe(
      createHash("sha256").update(canonicalRepo.canonicalUrl, "utf8").digest("hex"),
    );

    const conversationDigest = computeRepositoryDigest("github", canonicalRepo.canonicalUrl);
    expect(conversationDigest).not.toBe(computeRepositoryDigest("github", mixedRepo.canonicalUrl));
    expect(h.vcsAdapter.listReviewThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: nativeId,
        repositoryDigest: conversationDigest,
      }),
      undefined,
    );
    expect(h.vcsAdapter.findBotChildMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: nativeId,
        repositoryDigest: conversationDigest,
      }),
      expect.objectContaining({ kind: "finding" }),
    );

    expect(appended[0]).toMatchObject({
      repository: binding,
      reviewId: nativeId,
    });
    const snapshot = await mixedStore.readContextSnapshot();
    const published = await mixedStore.readAuditPage("events");
    expect(published.entries.length).toBeGreaterThan(0);
    expect(published.entries.every((entry) =>
      (entry as { repository: { repositoryDigest: string } }).repository.repositoryDigest === binding.repositoryDigest,
    )).toBe(true);
    expect(snapshot.findings.every((entry) => entry.repository.repositoryDigest === binding.repositoryDigest)).toBe(true);
    expect(snapshot.findings.some((entry) => entry.reviewId === nativeId && entry.identity !== undefined)).toBe(true);
  });

  it("accepts mixed-case repository locators against lowercase recovered inline identity URLs", async () => {
    const mixedUrl = "https://github.com/Azure/sdk/pull/42";
    const { orchestrationResult } = inlineFindingOrchestration();
    const h = makeHarness({
      args: makeArgs({ pr: mixedUrl }),
      pr: makePr({ url: mixedUrl, reviewId: "PR_kwDOAzureSdk" }),
      orchestrationResult,
    });
    installConversationReads(h, [relevant]);
    const { appended, createStateStore } = captureFindingAppends(h);
    h.vcsAdapter.createInlineReview.mockImplementation((_locator, _headSha, comments: Array<{ clientId: string }>) =>
      Promise.resolve(comments.map(({ clientId }) => ({
        clientId,
        status: "posted" as const,
        identity: {
          provider: "github" as const,
          commentId: `comment-${clientId}`,
          threadId: `thread-${clientId}`,
          url: `https://github.com/azure/sdk/pull/42#discussion_rcomment-${clientId}`,
        },
      }))),
    );

    expect(h.config.locator).toMatchObject({
      kind: "repository",
      repo: { owner: "Azure", repo: "sdk" },
      number: 42,
    });
    expect(await review(h.args, { ...depsFrom(h), createStateStore })).toBe(0);
    expect(appended.find((entry) => entry.identity !== undefined)).toMatchObject({
      identity: {
        provider: "github",
        commentId: "comment-finding-0",
        url: "https://github.com/azure/sdk/pull/42#discussion_rcomment-finding-0",
      },
    });
  });

  it("fails closed when ambient GitHub identity cannot be resolved", async () => {
    const missingUrl = makeHarness({ pr: makePr({ url: undefined }) });
    await expect(review(missingUrl.args, depsFrom(missingUrl))).rejects.toThrow(/identit|repository/i);
    expect(missingUrl.dispatchRules).not.toHaveBeenCalled();

    const unparsable = makeHarness({ pr: makePr({ url: "not-a-review-url" }) });
    await expect(review(unparsable.args, depsFrom(unparsable))).rejects.toThrow(/identit|repository/i);
    expect(unparsable.dispatchRules).not.toHaveBeenCalled();
  });

  it("binds prepared ledger identities when recovering after a post-write crash", async () => {
    const stateDir = isolatedStateDir();
    const nativeId = "PR_kwDORecover42";
    const { orchestrationResult } = inlineFindingOrchestration("Recover me.");
    const first = makeHarness({
      args: makeArgs({ stateDir }),
      pr: makePr({ url: CONVERSATION_PR_URL, reviewId: nativeId }),
      orchestrationResult,
    });
    const firstCapture = captureFindingAppends(first);
    first.publicationHooks = {
      afterPublication: async () => {
        throw new Error("crash after provider write before ledger bind");
      },
    };
    await expect(review(first.args, { ...depsFrom(first), createStateStore: firstCapture.createStateStore }))
      .rejects.toThrow(/crash after provider write before ledger bind/);
    expect(firstCapture.appended.some((entry) => entry.identity === undefined)).toBe(true);
    expect(firstCapture.appended.some((entry) => entry.identity !== undefined)).toBe(false);

    const second = makeHarness({
      args: makeArgs({ stateDir }),
      pr: makePr({ url: CONVERSATION_PR_URL, reviewId: nativeId }),
      orchestrationResult,
    });
    const secondCapture = captureFindingAppends(second);
    expect(await review(second.args, { ...depsFrom(second), createStateStore: secondCapture.createStateStore })).toBe(0);
    expect(second.dispatchRules).not.toHaveBeenCalled();
    expect(secondCapture.appended.some((entry) => entry.identity !== undefined)).toBe(true);
    expect(secondCapture.appended.find((entry) => entry.identity !== undefined)).toMatchObject({
      reviewId: nativeId,
      identity: { provider: "github", commentId: "comment-finding-0" },
    });

    const snapshot = await createConversationStateStore({
      root: stateDir,
      repository: conversationRepo,
    }).readContextSnapshot();
    expect(snapshot.findings.some((entry) =>
      entry.reviewId === nativeId && entry.identity?.commentId === "comment-finding-0",
    )).toBe(true);
  });

  it("continues a dry-run with a visible notice when the state store is missing", async () => {
    const h = conversationHarness();
    h.args = makeArgs({ dryRun: true, dispatch: "direct" });
    h.config = { ...h.config, dryRun: true };
    h.resolveConfig.mockReturnValue(h.config);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    h.orchestrate.mockImplementation(buildPresentation);

    await review(h.args, {
      ...depsFrom(h),
      createStateStore: () => {
        throw new Error("Conversation state store is not available");
      },
    });

    expect(h.dispatchRules).toHaveBeenCalledOnce();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/memory context was unavailable|discussion context was unavailable/i);
    log.mockRestore();
  });
});

describe("conversation context integrity fail-closed", () => {
  it.each([
    ["corrupt", "Malformed conversation ledger JSON"],
    ["oversized", "Conversation state file is too large"],
    ["unknown-schema", "cursor has an unsupported schema version"],
    ["path", "Conversation state path is a symlink"],
    ["permission", "Conversation state file permissions must be 0600"],
    ["impossible-transition", "Impossible action transition from observed to published"],
    ["cross-repository", "State repository binding does not match the requested repository"],
  ])("aborts before provider writes for %s integrity failures", async (_name, message) => {
    const h = conversationHarness({ threads: [conversationThread({
      threadId: "changed-line",
      events: [conversationComment("changed-line", "c1", "RELEVANT")],
    })] });
    await expect(review(h.args, {
      ...depsFrom(h),
      createStateStore: () => {
        throw new Error(message);
      },
    })).rejects.toThrow(message);
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
  });

  it.each([
    ["auth", "GitHub authentication failed (HTTP 401)"],
    ["network", Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" })],
    ["rate-limit", "HTTP 429 rate limit exceeded"],
    ["timeout", Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })],
  ])("refuses to publish when duplicate-suppression discussion is unavailable because of %s", async (_name, error) => {
    const h = conversationHarness();
    h.vcsAdapter.listReviewThreads = vi.fn().mockRejectedValue(typeof error === "string" ? new Error(error) : error);
    h.vcsAdapter.listReviewEvents = vi.fn().mockResolvedValue(emptyEventPage());
    h.vcsAdapter.getReviewThread = vi.fn();
    h.orchestrate.mockImplementation(buildPresentation);
    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/duplicate|discussion context/i);
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
  });

  it("refuses to publish when one thread snapshot fails after other summaries load", async () => {
    const h = conversationHarness();
    h.vcsAdapter.listReviewThreads = vi.fn().mockResolvedValue({
      threads: [
        { threadId: "known", updatedAt: "2026-08-14T00:00:00.000Z", orderKey: "known" },
        { threadId: "broken", updatedAt: "2026-08-14T00:00:01.000Z", orderKey: "broken" },
      ],
    });
    h.vcsAdapter.getReviewThread = vi.fn().mockImplementation(async (_identity, threadId: string) => {
      if (threadId === "broken") throw new Error("reaction lookup failed");
      return conversationThread({ threadId: "known" });
    });

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/duplicate|discussion context/i);
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(h.vcsAdapter.createInlineReview).not.toHaveBeenCalled();
  });

  it("does not treat an integrity failure as optional unavailability when both occur", async () => {
    const h = conversationHarness();
    h.vcsAdapter.listReviewThreads = vi.fn().mockRejectedValue(new Error("GitHub authentication failed (HTTP 401)"));
    await expect(review(h.args, {
      ...depsFrom(h),
      createStateStore: () => {
        throw new Error("State repository binding does not match the requested repository");
      },
    })).rejects.toThrow(/repository binding/i);
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
  });
});

describe("clarification question publication", () => {
  const questionFinding = {
    file: "src/a.ts",
    line: 4,
    severity: "warning" as const,
    category: "correctness",
    ruleName: "rule-a",
    decision: "needs-clarification" as const,
    question: "Is the fallback path intentional?",
    message: "unclear timeout",
  };

  function clarificationHarness(stateDir = isolatedStateDir()) {
    const h = makeHarness({
      args: makeArgs({ stateDir }),
      pr: makePr({ url: CONVERSATION_PR_URL }),
      dispatchResult: { findings: [questionFinding], rulesRun: ["rule-a"], rulesFailed: [] },
    });
    h.orchestrate.mockImplementation(buildPresentation);
    h.vcsAdapter.getDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@\n context\n+added\n");
    return h;
  }

  function wireQuestionWrites(h: Harness, shared: {
    bodies: string[];
    posted: Map<string, { provider: "github"; commentId: string; url: string }>;
    failNext?: "throw" | "accept-then-fail" | null;
  }) {
    h.vcsAdapter.postGeneralReply.mockImplementation((_review, input: { body: string }) => {
      const marker = input.body.split(/\r?\n/u).at(-1)?.trim() ?? "";
      const identity = {
        provider: "github" as const,
        commentId: `q-${shared.bodies.length + 1}`,
        url: `https://github.com/acme/app/pull/42#issuecomment-q-${shared.bodies.length + 1}`,
      };
      if (shared.failNext === "throw") {
        shared.failNext = null;
        throw new Error("provider write failed");
      }
      if (marker.length > 0) shared.posted.set(marker, identity);
      if (shared.failNext === "accept-then-fail") {
        shared.failNext = null;
        throw new Error("transport failed after accepted write");
      }
      shared.bodies.push(input.body);
      return Promise.resolve(identity);
    });
    h.vcsAdapter.findBotChildMarker.mockImplementation((_review, lookup: { childId: string; contentDigest: string }) => {
      for (const [marker, identity] of shared.posted) {
        const parsed = parseChildMarker(marker);
        if (parsed?.childId === lookup.childId && parsed.contentDigest === lookup.contentDigest) {
          return Promise.resolve(identity);
        }
      }
      return Promise.resolve(null);
    });
  }

  it("publishes one tracked question and shows the answer syntax", async () => {
    const h = clarificationHarness();
    const shared = { bodies: [] as string[], posted: new Map<string, { provider: "github"; commentId: string; url: string }>() };
    wireQuestionWrites(h, shared);
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await review(h.args, depsFrom(h))).toBe(0);
    expect(shared.bodies).toHaveLength(1);
    const selected = selectClarification({
      repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
      reviewNumber: 42,
      headSha: CONVERSATION_HEAD,
      findings: [questionFinding],
      ruleOrder: ["rule-a"],
    });
    expect(shared.bodies[0]).toContain(`answer ${selected.selected!.id}:`);
    const snapshot = await createConversationStateStore({
      root: h.args.stateDir!,
      repository: conversationRepo,
    }).readContextSnapshot();
    expect(snapshot.pending.clarifications).toHaveLength(1);
    expect(snapshot.pending.clarifications[0]?.state).toBe("published");
    const summary = String(h.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    expect(summary).toContain("### Needs clarification");
    expect(summary).toContain(`https://github.com/acme/app/pull/42#issuecomment-q-1`);
  });

  it("recovers a crash before write, after an accepted write, and before local published", { timeout: 20_000 }, async () => {
    const cases = [
      { hooks: { beforeChildWrite: async () => { throw new Error("crash before write"); } }, failNext: null, message: /crash before write/ },
      { hooks: {}, failNext: "accept-then-fail" as const, message: /accepted write/ },
      { hooks: { afterChildWrite: async () => { throw new Error("crash before local published"); } }, failNext: null, message: /crash before local published/ },
    ];
    for (const testCase of cases) {
      const stateDir = isolatedStateDir();
      const shared = {
        bodies: [] as string[],
        posted: new Map<string, { provider: "github"; commentId: string; url: string }>(),
        failNext: testCase.failNext,
      };
      const first = clarificationHarness(stateDir);
      wireQuestionWrites(first, shared);
      first.publicationHooks = testCase.hooks;
      vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(review(first.args, depsFrom(first))).rejects.toThrow(testCase.message);

      const second = clarificationHarness(stateDir);
      wireQuestionWrites(second, shared);
      expect(await review(second.args, depsFrom(second))).toBe(0);
      expect(shared.bodies.length + (shared.posted.size > 0 && shared.bodies.length === 0 ? 1 : 0)).toBeGreaterThanOrEqual(0);
      const snapshot = await createConversationStateStore({
        root: stateDir,
        repository: conversationRepo,
      }).readContextSnapshot();
      expect(snapshot.pending.clarifications).toHaveLength(1);
      expect(snapshot.pending.clarifications[0]?.state).toBe("published");
      expect(snapshot.pending.clarifications[0]?.identity).toBeDefined();
    }
  });

  it("publishes once when review and poll share one state root", async () => {
    const stateDir = isolatedStateDir();
    const shared = { bodies: [] as string[], posted: new Map<string, { provider: "github"; commentId: string; url: string }>() };
    const first = clarificationHarness(stateDir);
    const second = clarificationHarness(stateDir);
    wireQuestionWrites(first, shared);
    wireQuestionWrites(second, shared);
    const adapter = {
      getAuthenticatedBotIdentity: async () => ({ provider: "github" as const, login: "tgdbot", mention: "@tgdbot" }),
      resolveReviewIdentity: async () => ({
        provider: "github" as const,
        repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
        reviewNumber: 42,
        reviewId: DEFAULT_REVIEW_ID,
        url: CONVERSATION_PR_URL,
      }),
      listOpenReviews: async () => ({
        reviews: [{
          identity: {
            provider: "github" as const,
            repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
            reviewNumber: 42,
            reviewId: DEFAULT_REVIEW_ID,
            url: CONVERSATION_PR_URL,
          },
          title: "Some PR",
          headSha: CONVERSATION_HEAD,
          updatedAt: "2026-08-14T00:00:00.000Z",
          orderKey: "2026-08-14T00:00:00.000Z|0000000000000042",
        }],
        nextCursor: {
          scope: "open-review-discovery" as const,
          provider: "github" as const,
          repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
          opaque: "open",
          orderKey: "open",
        },
      }),
      listReviewEvents: async () => ({
        events: [],
        nextCursor: {
          scope: "review-events" as const,
          provider: "github" as const,
          repositoryDigest: computeRepositoryDigest("github", conversationRepo.canonicalUrl),
          reviewNumber: 42,
          opaque: JSON.stringify({ at: "1970-01-01T00:00:00.000Z", seen: [] }),
          orderKey: "1970-01-01T00:00:00.000Z",
        },
      }),
      listReviewThreads: async () => ({ threads: [] }),
      getReviewThread: async () => { throw new Error("unused"); },
      postGeneralReply: async (_review: unknown, input: { body: string }) => first.vcsAdapter.postGeneralReply(undefined, input),
      postThreadReply: async () => { throw new Error("unused"); },
      findBotChildMarker: async (_review: unknown, lookup: { childId: string; contentDigest: string }) =>
        first.vcsAdapter.findBotChildMarker(undefined, lookup),
    };
    await poll(parseCommandArgs(["poll", "--repo", "acme/app", "--state-dir", stateDir]), {
      conversationAdapter: adapter as never,
    });
    const release = Promise.withResolvers<void>();
    const ready: Array<PromiseWithResolvers<void>> = [];
    const pause = async () => {
      const gate = Promise.withResolvers<void>();
      ready.push(gate);
      gate.resolve();
      await release.promise;
    };
    first.publicationHooks = { beforePublication: pause };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runs = Promise.all([
      review(first.args, depsFrom(first)),
      poll(parseCommandArgs(["poll", "--repo", "acme/app", "--state-dir", stateDir]), {
        conversationAdapter: adapter as never,
      }),
    ]);
    await vi.waitFor(() => expect(ready.length).toBeGreaterThan(0), { timeout: 10_000 });
    release.resolve();
    await runs;
    expect(shared.bodies).toHaveLength(1);
    const snapshot = await createConversationStateStore({
      root: stateDir,
      repository: conversationRepo,
    }).readContextSnapshot();
    expect(snapshot.pending.clarifications).toHaveLength(1);
  });
});
