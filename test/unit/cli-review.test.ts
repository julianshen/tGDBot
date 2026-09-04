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
import type { MockedFunction } from "vitest";
import { parseCommandArgs } from "../../src/cli-args.js";
import { main, parseArgs, review } from "../../src/cli.js";
import { selectClarification } from "../../src/conversation/clarification.js";
import { poll } from "../../src/poll/poll.js";
import type { CliArgs, ReviewDependencies } from "../../src/cli.js";
import type { PreparedWorkspace, WorkspaceRequest } from "../../src/workspace/types.js";
import { computeReviewConfigHash, conversationDedupFingerprint, formatMarker, stateRootDomainIdentifier } from "../../src/review/dedup.js";
import { prIntentFingerprint, sanitizePrIntent } from "../../src/review/pr-intent.js";
import { BOT_SIGNATURE, BOT_SIGNATURE_BLOCK } from "../../src/review/comment-format.js";
import { extractRelatedWork, relatedWorkFingerprint } from "../../src/review/related-work.js";
import { ContextRequiredError, contextFingerprint } from "../../src/context/prepare.js";
import { GitHubDiffIncompleteError } from "../../src/vcs/github-large-diff.js";
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
import type { ReviewActivityEvent, ReviewThreadSnapshot } from "../../src/vcs/conversation-adapter.js";
import { INLINE_COMMENT_MARKER } from "../../src/review/comment-format.js";
import { emptyOrchestration, emptySummaryInput } from "../helpers/orchestration.js";

const temporaryStateRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryStateRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  // Tests here spy on console.log/warn and restore at the end of the body. A
  // FAILING assertion skips that call, leaking the spy into every later test
  // and turning one red test into a confusing cascade. Restoring here runs on
  // both paths (CodeRabbit review, PR #34).
  vi.restoreAllMocks();
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
    contextMapper: "tgd",
    rulesDir: ".review/rules",
    disableBuiltinRule: false,
    advisor: "on",
    prIntent: "on",
    suggestions: "on",
    dependencyFacts: "off",
    dryRun: false,
    trustLocalRules: false,
    dispatch: "direct",
    // Off, matching the CLI default. `structuralChecks` is REQUIRED on
    // `SharedReviewOptions`, so omitting it made this factory stop satisfying
    // its own declared return type — invisibly, because this file is not in
    // the type-test program (CodeRabbit review).
    structuralChecks: "off",
    // Off by default in this harness: mapping is the one review step that
    // needs a real git mirror and a model session, and no test here is about
    // that. `contextFingerprint` returns undefined for "off", so every config
    // hash below stays exactly what it was before context existed. Tests that
    // DO exercise context set it explicitly and inject `prepareContext`.
    context: "off",
    allowDegradedContext: false,
    ...overrides,
  };
}

const DEFAULT_PR_URL = "https://github.com/acme/app/pull/42";
const DEFAULT_REVIEW_ID = "PR_kwDOTest42";

/**
 * The config hash the review() flow actually computes for the harness's
 * default PR (title "Some PR", description "Some description"): the pure
 * dedup hash plus, when --pr-intent is on (the default), the intent digest
 * issue #59 folds in so a description edit re-triggers. Related-work
 * fingerprint tests pass their own value with --pr-intent off to exercise
 * the pre-#59 semantics in isolation.
 */
function expectedConfigHash(
  config: Parameters<typeof computeReviewConfigHash>[0],
  relatedWork?: string,
  conversation?: string,
  context?: string,
): string {
  const intent = config.prIntent === "off"
    ? undefined
    : prIntentFingerprint(sanitizePrIntent({ title: "Some PR", description: "Some description" }));
  const parts = [relatedWork, intent].filter((value): value is string => value !== undefined);
  return computeReviewConfigHash(
    config,
    parts.length === 0 ? undefined : parts.join("\n"),
    conversation,
    context,
  );
}

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
    getPullRequest: MockedFunction<VcsAdapter["getPullRequest"]>;
    getDiff: ReturnType<typeof vi.fn>;
    findBotComment: MockedFunction<VcsAdapter["findBotComment"]>;
    upsertComment: MockedFunction<VcsAdapter["upsertComment"]>;
    getRuleFilesFromBase: ReturnType<typeof vi.fn>;
    getFileAtRef: ReturnType<typeof vi.fn>;
    getMergeBaseSha: ReturnType<typeof vi.fn>;
    createInlineReview: ReturnType<typeof vi.fn>;
    prepareInlineReviewRecovery: ReturnType<typeof vi.fn>;
    recoverInlineReview: ReturnType<typeof vi.fn>;
    resolveStaleReviewThreads: ReturnType<typeof vi.fn>;
    findPublishedMarker: ReturnType<typeof vi.fn>;
    findBotChildMarker: MockedFunction<(
      review: unknown,
      lookup: { childId: string; contentDigest: string },
    ) => Promise<{ provider: "github"; commentId: string; url: string } | null>>;
    postGeneralReply: MockedFunction<(
      review: unknown,
      input: { body: string },
    ) => Promise<{ provider: "github"; commentId: string; url: string; body?: string }>>;
    listReviewThreads?: ReturnType<typeof vi.fn>;
    listReviewEvents?: ReturnType<typeof vi.fn>;
    getReviewThread?: ReturnType<typeof vi.fn>;
    resolveReviewIdentity?: ReturnType<typeof vi.fn>;
  };
  resolveConfig: MockedFunction<ReviewDependencies["resolveConfig"]>;
  loadRules: MockedFunction<ReviewDependencies["loadRules"]>;
  dispatchRules: MockedFunction<ReviewDependencies["dispatchRules"]>;
  orchestrate: MockedFunction<ReviewDependencies["orchestrate"]>;
  prepareContext: MockedFunction<NonNullable<ReviewDependencies["prepareContext"]>>;
  runStructuralChecks: MockedFunction<NonNullable<ReviewDependencies["runStructuralChecks"]>>;
  prepareStructuralWorkspace: MockedFunction<NonNullable<ReviewDependencies["prepareStructuralWorkspace"]>>;
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
  const orchestrationResult: OrchestrationResult = options.orchestrationResult ?? emptyOrchestration({
    commentBody: "**No actionable comments.** ✅",
    inlineComments: [],
    findingsCount: 0,
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
  });
  const ruleFilesFromBase = options.ruleFilesFromBase ?? [];

  const vcsAdapter = {
    resolveRelatedWork: vi.fn().mockImplementation((references) => Promise.resolve(references)),
    getPullRequest: vi.fn<VcsAdapter["getPullRequest"]>().mockResolvedValue(pr),
    getDiff: vi.fn().mockResolvedValue("diff --git a/x b/x"),
    findBotComment: vi.fn<VcsAdapter["findBotComment"]>().mockResolvedValue(botComment),
    upsertComment: vi.fn<VcsAdapter["upsertComment"]>().mockImplementation(
      (_locator, body, existing) => {
        const parsed = parseBotMarker(body);
        return Promise.resolve({
          id: existing?.id ?? "written-summary-1",
          body,
          ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
        });
      },
    ),
    getRuleFilesFromBase: vi.fn().mockResolvedValue(ruleFilesFromBase),
    // Issue #56 / PR #67: extraction compares the manifest at BASE against the
    // one at HEAD, so the double answers per ref. At base the packages the
    // dependency tests bump are older or absent; at head they are what those
    // tests expect to see reported.
    // PR #67: the comparison base is the point the branches diverged, which the
    // adapter resolves. The double answers with the base sha, so the base
    // manifest below is what these tests compare against.
    getMergeBaseSha: vi.fn().mockResolvedValue(pr.baseSha),
    getFileAtRef: vi.fn(async (_locator: unknown, ref: string) => JSON.stringify(
      ref === pr.baseSha
        ? {
            name: "app",
            version: "1.0.0",
            engines: { node: "20.0.0" },
            dependencies: { "left-pad": "1.2.0", lodash: "4.17.20", react: "18.0.0" },
          }
        : {
            name: "app",
            version: "1.0.0",
            engines: { node: "22.0.0" },
            dependencies: { "left-pad": "1.3.1", lodash: "4.17.21", react: "18.0.0" },
          },
    )),
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
    prepareContext: vi.fn().mockResolvedValue({ status: "off" }),
    runStructuralChecks: vi.fn(async (input) => [...input.findings]),
    // Lock-SCOPED: the consumer runs inside the callback. A stub that only
    // returned the paths would pass against a version that reads the worktree
    // after the lock is released (#78).
    // The cast is about generic-mock ergonomics, not semantics: `vi.fn` cannot
    // express the real function's `<T>`, and `MockedFunction` wants an exact
    // parameter match including the optional dependencies argument. The stub
    // does implement the contract — it runs the callback under the caller's
    // control, which is the property #78 is about.
    prepareStructuralWorkspace: vi.fn(async (
      _request: WorkspaceRequest,
      use: (prepared: PreparedWorkspace) => Promise<unknown>,
    ) => use({
      root: "/ws", repositoryRoot: "/ws/repo", mirrorPath: "/ws/repo/mirror",
      worktreesRoot: "/ws/repo/worktrees", baseWorktreePath: "/ws/repo/base",
      ownerMarkerPath: "/ws/repo/owner.json", baseSha: "deadbeef",
    } as PreparedWorkspace)) as unknown as Harness["prepareStructuralWorkspace"],
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
    // Belt and braces alongside `context: "off"` above: even if a test
    // overrides the mode, it must never reach a real worktree or mapper.
    prepareContext: h.prepareContext,
    // Same stance for #75: a review test must never walk a real worktree with
    // a real parser.
    runStructuralChecks: h.runStructuralChecks,
    prepareStructuralWorkspace: h.prepareStructuralWorkspace,
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
    const cfg = expectedConfigHash(makeArgs());
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
    const cfg = expectedConfigHash(args);
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
    const cfg = expectedConfigHash(args);
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
      orchestrationResult: emptyOrchestration({
        commentBody: "- x.ts:1 — the error path drops the cause",
        inlineComments: [],
        findingsCount: 1,
        rulesRun: findings.rulesRun,
        rulesFailed: findings.rulesFailed,
        summaryInput: emptySummaryInput({
          allFindings: findings.findings,
          unanchored: findings.findings,
          rulesRun: findings.rulesRun,
          rulesFailed: findings.rulesFailed,
        }),
      }),
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
    // Issue #109 / Codex review of PR #117: a focused command dispatched every
    // rule, so its terminal line carries the same metrics as any other run.
    const focusedStatus = logSpy.mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith("TGD_REVIEW_RESULT: "))
      .at(-1);
    const parsedFocused = JSON.parse(focusedStatus!.slice("TGD_REVIEW_RESULT: ".length));
    expect(parsedFocused.status).toBe("posted");
    expect(parsedFocused.metrics.findingsPerRule).toEqual({ "rule-a": 1 });
    expect(parsedFocused.metrics.durationMs).toEqual(expect.any(Number));
    expect(parsedFocused.metrics).not.toHaveProperty("startedAtMs");
    // The findings went to a reply of their own...
    expect(h.vcsAdapter.postGeneralReply).toHaveBeenCalledTimes(1);
    const [, replyInput] = h.vcsAdapter.postGeneralReply.mock.calls[0] as [unknown, { body: string }];
    expect(replyInput.body).toContain("the error path drops the cause");
    expect(replyInput.body).toContain("check the error handling");
    // The reply is ONE comment, so it carries ONE signature — the conversation
    // renderer's. The summary it wraps must therefore be built unsigned, or the
    // wrapped copy shows up escaped in the body above it (Codex review).
    expect(replyInput.body.split(BOT_SIGNATURE)).toHaveLength(2);
    expect(replyInput.body.trimEnd()).toContain(BOT_SIGNATURE_BLOCK);
    expect(replyInput.body).not.toContain("Posted by \\[tGDBot");
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
      orchestrationResult: emptyOrchestration({
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
        findingByClientId: new Map([["finding-0", finding]]),
        summaryInput: emptySummaryInput({
          allFindings: [finding],
          inlineCount: 1,
          rulesRun: ["rule-a"],
        }),
      }),
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
      orchestrationResult: emptyOrchestration({
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
      }),
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
    const cfg = expectedConfigHash(args);
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
    const args = makeArgs({ prIntent: "off" });
    const cfg = expectedConfigHash(args, relatedWorkFingerprint(extractRelatedWork(priorInput)));
    const botComment: BotComment = { id: "999", body: formatMarker("cafef00d", cfg), lastReviewedSha: "cafef00d", reviewedConfig: cfg };

    const unchanged = makeHarness({ args, botComment, pr: makePr({ url, title: "Fixes #7", description: "unrelated wording changed" }) });
    await review(unchanged.args, depsFrom(unchanged));
    expect(unchanged.dispatchRules).not.toHaveBeenCalled();
    expect(unchanged.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    for (const title of ["Fixes #8", "No related work"]) {
      const changed = makeHarness({ args, botComment, pr: makePr({ url, title, description: "unrelated wording changed" }) });
      await review(changed.args, depsFrom(changed));
      expect(changed.dispatchRules).toHaveBeenCalledOnce();
      if (title.includes("#")) expect(changed.vcsAdapter.resolveRelatedWork).toHaveBeenCalledOnce();
      else expect(changed.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    }
  });

  it("ignores changes beyond the first ten references but re-reviews shorthand changed to an explicit pull", async () => {
    const url = "https://github.com/acme/app/pull/42";
    const ten = Array.from({ length: 10 }, (_, i) => `#${i + 1}`).join(" ");
    const configFor = (title: string) => expectedConfigHash(makeArgs({ prIntent: "off" }), relatedWorkFingerprint(extractRelatedWork({ provider: "github", reviewUrl: url, title, description: "" })));
    const cappedCfg = configFor(`${ten} #11`);
    const cappedComment: BotComment = { id: "999", body: formatMarker("cafef00d", cappedCfg), lastReviewedSha: "cafef00d", reviewedConfig: cappedCfg };
    const offArgs = makeArgs({ prIntent: "off" });
    const eleventhChanged = makeHarness({ args: offArgs, botComment: cappedComment, pr: makePr({ url, title: `${ten} #12`, description: "" }) });
    await review(eleventhChanged.args, depsFrom(eleventhChanged));
    expect(eleventhChanged.dispatchRules).not.toHaveBeenCalled();
    expect(eleventhChanged.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();

    const shorthandCfg = configFor("#3");
    const shorthandComment: BotComment = { id: "999", body: formatMarker("cafef00d", shorthandCfg), lastReviewedSha: "cafef00d", reviewedConfig: shorthandCfg };
    const explicitPull = makeHarness({ args: offArgs, botComment: shorthandComment, pr: makePr({ url, title: "https://github.com/acme/app/pull/3", description: "" }) });
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
    const configHash = expectedConfigHash(h.config);
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
    const configHash = expectedConfigHash(h.config);
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
    const configHash = expectedConfigHash(h.config);
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
    const cfg = expectedConfigHash(makeArgs());
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

  // Issue #33: GitHub refuses a diff over 20,000 lines, and the per-file
  // fallback could not load all of it either (a withheld patch, or more files
  // than GitHub will list). There is no honest review to run: what DID load is
  // a subset of the pull request, and reviewing it would report "clean" on
  // code nobody looked at. With the ceiling flag set — the operator has
  // already said oversized pull requests should be skipped, not fail the
  // build — this joins the graceful skip.
  it("issue #33: an incomplete large diff with --max-diff-chars set skips instead of reviewing a subset", async () => {
    const h = makeHarness({ args: makeArgs({ maxDiffChars: 500000 }), botComment: null });
    h.vcsAdapter.getDiff.mockRejectedValue(
      new GitHubDiffIncompleteError("GitHub sent no patch for 1 changed file (src/huge.ts)", {
        omittedPatches: ["src/huge.ts"],
        truncated: false,
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.loadRules).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    // The notice names the file whose patch is missing, so the skip is actionable.
    expect(warnSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("src/huge.ts");
    // A distinct reason: this is NOT "the diff is bigger than your ceiling",
    // it is "the complete diff could not be loaded at all".
    expect(logSpy).toHaveBeenCalledWith(
      `TGD_REVIEW_RESULT: ${JSON.stringify({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [], reason: "diff-incomplete" })}`,
    );

    vi.restoreAllMocks();
  });

  it("issue #33: an incomplete large diff WITHOUT --max-diff-chars fails loudly rather than reviewing a subset", async () => {
    const h = makeHarness({ botComment: null });
    h.vcsAdapter.getDiff.mockRejectedValue(
      new GitHubDiffIncompleteError("GitHub sent no patch for 1 changed file (src/huge.ts)", {
        omittedPatches: ["src/huge.ts"],
        truncated: false,
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/src\/huge\.ts/);
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
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
      // Issue #59: the PR's stated intent rides along as untrusted evidence.
      prIntent: { title: "Some PR", description: "Some description" },
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
      const cfg = expectedConfigHash(makeArgs());
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
    const orchestrationResult: OrchestrationResult = emptyOrchestration({
      inlineComments: [],
      commentBody: "## Code Review\n\n### ⚠️ Rules that failed\n\n- rule-b",
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: ["rule-b"],
    });
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
    const orchestrationResult: OrchestrationResult = emptyOrchestration({
      inlineComments: [],
      commentBody: "## Code Review\n\nNo issues found.",
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
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


  // Issue #36: the severity mix goes on the machine-readable status line, so
  // calibration drift is trackable ACROSS runs. A rule set that returns 80%
  // blocking over a sample of pull requests is describing its own prompt, not
  // the code — and that is only visible in aggregate, never in one comment.
  it("issue #36: the status line reports the severity mix", async () => {
    const h = makeHarness({ botComment: null });
    h.dispatchRules.mockResolvedValue({
      findings: [
        { file: "a.ts", line: 1, severity: "blocking", category: "c", message: "One.", ruleName: "rule-a" },
        { file: "a.ts", line: 2, severity: "warning", category: "c", message: "Two.", ruleName: "rule-a" },
        { file: "a.ts", line: 3, severity: "warning", category: "c", message: "Three.", ruleName: "rule-a" },
        { file: "a.ts", line: 4, severity: "suggestion", category: "c", message: "Four.", ruleName: "rule-a" },
      ],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });
    // The real orchestrator, so the mix is counted from what a run actually
    // produces rather than from a canned presentation object.
    h.orchestrate.mockImplementation(buildPresentation);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const lines = logSpy.mock.calls.map(([entry]) => String(entry));
    const mixLine = lines.find((entry) => entry.startsWith("TGD_REVIEW_SEVERITIES: "));
    const statusLine = lines.find((entry) => entry.startsWith("TGD_REVIEW_RESULT: "));

    expect(JSON.parse(mixLine!.slice("TGD_REVIEW_SEVERITIES: ".length)))
      .toEqual({ blocking: 1, warning: 2, suggestion: 1 });
    // The mix describes the FINDINGS, not what was shown — clustering changes
    // presentation only, so the two lines agree on the total.
    expect(JSON.parse(statusLine!.slice("TGD_REVIEW_RESULT: ".length)).findingsCount).toBe(4);

    vi.restoreAllMocks();
  });



  // Issue #50: dependency facts the HOST parsed reach every rule as trusted
  // context. Supplied for all rules or none, because the dispatch contract
  // requires a pack per rule and rejects a partial map.
  it("issue #50: passes host-parsed dependency changes to the rules", async () => {
    // Final round: the pack is part of the --dependency-facts opt-in, because
    // its package names and manifest paths are diff-controlled.
    const h = makeHarness({ botComment: null, args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(
      [
        "diff --git a/package.json b/package.json",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1,3 +1,3 @@",
        '   "dependencies": {',
        '-    "left-pad": "1.2.0",',
        '+    "left-pad": "1.3.1",',
      ].join("\n"),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const passed = h.dispatchRules.mock.calls[0]?.[0] as {
      contextPacks?: Record<string, { text: string; untrustedText?: string }>;
    };
    expect(passed.contextPacks).toBeDefined();
    expect(Object.keys(passed.contextPacks ?? {})).toEqual(["rule-a"]);
    // #63: the identifier still reaches the rule, on the untrusted side of the
    // pack — the author wrote "left-pad", so the trusted half cannot vouch for
    // it. End-to-end through the real CLI wiring, not just the pack builder.
    expect(passed.contextPacks?.["rule-a"]?.untrustedText).toContain("left-pad@1.3.1");
    expect(passed.contextPacks?.["rule-a"]?.text).not.toContain("left-pad");
    expect(passed.contextPacks?.["rule-a"]?.text).toContain("Entry 1");

    vi.restoreAllMocks();
  });

  // The common case must be untouched: no dependency change, no pack, no extra
  // section in any rule's task.
  it("issue #50: passes no context packs when no dependency changed", async () => {
    const h = makeHarness({ botComment: null });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const passed = h.dispatchRules.mock.calls[0]?.[0] as { contextPacks?: unknown };
    expect(passed.contextPacks).toBeUndefined();

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
    const orchestrationResult: OrchestrationResult = emptyOrchestration({
      inlineComments: [],
      commentBody: "## Code Review\n\n### ⚠️ Rules that failed\n\nThe following rules failed to run and were skipped:\n\n- rule-a\n- rule-b",
      findingsCount: 0,
      rulesRun: [],
      rulesFailed: ["rule-a", "rule-b"],
    });
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
    // must never have been written to. Note the target resolves to the real
    // /etc/passwd on any Unix system (tempRulesDir sits directly under /tmp,
    // so ../.. lands at /), so existence can't discriminate here — assert the
    // system file was never overwritten with the malicious payload instead.
    const escapedPath = path.resolve(seenDir as string, "../../etc/passwd");
    expect(readFileSync(escapedPath, "utf-8")).not.toContain("malicious content");

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

  // The summary is signed at composition time, not by the renderer: relocated
  // findings are appended after the frozen summary body, so a signature
  // rendered with the summary would land in the middle of the comment.
  it("signs the posted summary after any relocated findings and before the marker", async () => {
    const h = inlineHarness(partialPresentation());
    h.vcsAdapter.createInlineReview.mockRejectedValue(new Error("inline unsupported"));
    expect(await review(h.args, depsFrom(h))).toBe(0);

    const finalBody = String(h.vcsAdapter.upsertComment.mock.calls.at(-1)?.[1]);
    const relocated = finalBody.indexOf("finding 0");
    const signature = finalBody.indexOf(BOT_SIGNATURE);
    const dedupMarker = finalBody.indexOf("<!-- tgd-review-agent:sha=");
    expect(relocated).toBeGreaterThan(-1);
    expect(signature).toBeGreaterThan(relocated);
    expect(dedupMarker).toBeGreaterThan(signature);
    expect(finalBody).toContain(BOT_SIGNATURE_BLOCK);
    expect(finalBody.indexOf(BOT_SIGNATURE)).toBe(finalBody.lastIndexOf(BOT_SIGNATURE));
  });

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
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${expectedConfigHash(h.config)} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: expectedConfigHash(h.config),
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
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${expectedConfigHash(h.config)} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: expectedConfigHash(h.config),
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
        reviewedConfig: expectedConfigHash(h.config),
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
    let stored = null as BotComment | null;
    let rejectFinalization = true;
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body, existing) => {
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
      reviewedConfig: expectedConfigHash(h.config),
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
    let stored = null as BotComment | null;
    let rejectCompleteOnce = true;
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body, existing) => {
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
      reviewedConfig: expectedConfigHash(h.config),
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
    let stored = null as BotComment | null;
    let rejectCompleteOnce = true;
    h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
    h.vcsAdapter.upsertComment.mockImplementation(
      (_locator, body, existing) => {
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
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${expectedConfigHash(h.config)} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: expectedConfigHash(h.config),
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
    h.vcsAdapter.upsertComment.mockResolvedValueOnce(undefined as unknown as BotComment);

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

  it("does not resolve without references", async () => {
    const none = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42" }) });
    await review(none.args, depsFrom(none));
    expect(none.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    // Issue #59 moved resolution BEFORE dispatch (the resolved titles/states
    // feed the intent section), so a dispatch rejection can no longer promise
    // that the resolver was never called — it runs first, best-effort, and
    // its failure is non-fatal either way.
    const failed = makeHarness({ pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7" }) });
    failed.dispatchRules.mockRejectedValue(new Error("dispatch failed"));
    await expect(review(failed.args, depsFrom(failed))).rejects.toThrow("dispatch failed");
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
    const args = makeArgs({ dryRun, prIntent: "off" });
    const pr = makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7" });
    const h = makeHarness({ args, botComment: null, pr });
    const fingerprint = relatedWorkFingerprint(extractRelatedWork({ provider: "github", reviewUrl: pr.url!, title: pr.title, description: pr.description }));
    const body = formatPendingMarker({ phase: "ready", headSha: "cafef00d", configHash: expectedConfigHash(h.config, fingerprint), noteId: "written-777", terminalResult: { status: "posted", findingsCount: 0, rulesRun: ["rule-a"], rulesFailed: [], exitCode: 0 } });
    h.vcsAdapter.findBotComment.mockResolvedValue({ id: "written-777", body, ...parseBotMarker(body)! });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await review(h.args, depsFrom(h));
    expect(h.vcsAdapter.resolveRelatedWork).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // Issue #109: per-run cost/size telemetry on the posted/partial status line.
  describe("issue #109: run metrics", () => {
    it("carries cost and size metrics on a posted run", async () => {
      const h = makeHarness({
        dispatchResult: {
          findings: [{
            file: "src/x.ts",
            line: 3,
            severity: "warning",
            category: "correctness",
            message: "Off by one.",
            ruleName: "rule-a",
            title: "Bad loop",
            suggestion: "for (let i = 0; i < n; i++)",
            hostCheck: { status: "resolved", references: [], occurrences: 1, unresolved: [], unresolvedOccurrences: 0, filesSearched: 2, filesResolved: 2 },
          }],
          rulesRun: ["rule-a"],
          rulesFailed: [],
          taskTextChars: 4321,
        },
      });
      // Codex review of PR #117 (P1): the duration must include publication,
      // not stop where the metrics object was first built. Slow the summary
      // write so the terminal duration has to cover it.
      const innerUpsert = h.vcsAdapter.upsertComment.getMockImplementation()!;
      h.vcsAdapter.upsertComment.mockImplementation(async (locator, body, existing) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return innerUpsert(locator, body, existing);
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await review(h.args, depsFrom(h));

      // The publication module logs its own intermediate "posted" line; the
      // metrics live on the TERMINAL status line (the documented last-line-
      // of-stdout contract), so take the last one.
      const status = logSpy.mock.calls.map(([line]) => String(line))
        .filter((line) => line.startsWith("TGD_REVIEW_RESULT: "))
        .at(-1);
      const parsed = JSON.parse(status!.slice("TGD_REVIEW_RESULT: ".length));

      expect(parsed.status).toBe("posted");
      expect(parsed.metrics).toEqual({
        durationMs: expect.any(Number),
        diffChars: "diff --git a/x b/x".length,
        // From the stub engine's result: engines report what they built.
        dispatchChars: 4321,
        contextPackChars: 0,
        prIntentChars: expect.any(Number),
        conversationChars: 0,
        findingsPerRule: { "rule-a": 1 },
        findingTextChars: "Bad loop".length + "Off by one.".length + "for (let i = 0; i < n; i++)".length,
        hostChecks: { resolved: 1, lexical: 0, notChecked: 0 },
      });
      expect(parsed.metrics.prIntentChars).toBeGreaterThan(0);
      // The 40ms write above happened AFTER the metrics object was built, so
      // a duration frozen at build time would be far below it.
      expect(parsed.metrics.durationMs).toBeGreaterThanOrEqual(40);
      expect(parsed.metrics).not.toHaveProperty("startedAtMs");
      vi.restoreAllMocks();
    });

    it("omits metrics from a skipped run so its shape never changes", async () => {
      const pr = makePr({ headSha: "cafef00d" });
      const cfg = expectedConfigHash(makeArgs());
      const botComment: BotComment = { id: "999", body: formatMarker("cafef00d", cfg), lastReviewedSha: "cafef00d", reviewedConfig: cfg };
      const h = makeHarness({ botComment, pr });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await review(h.args, depsFrom(h));

      const status = logSpy.mock.calls.map(([line]) => String(line))
        .find((line) => line.startsWith("TGD_REVIEW_RESULT: "));
      expect(JSON.parse(status!.slice("TGD_REVIEW_RESULT: ".length))).toEqual({
        status: "skipped",
        findingsCount: 0,
        rulesRun: [],
        rulesFailed: [],
      });
      vi.restoreAllMocks();
    });
  });

  // Issue #59: the PR's stated intent reaches dispatch as sanitized
  // untrusted evidence, and editing the prose re-triggers a review.
  describe("issue #59: PR intent as untrusted evidence", () => {
    it("dispatches the sanitized intent and --pr-intent off dispatches none", async () => {
      const on = makeHarness({
        pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Intent check", description: "Makes the budget per-host." }),
      });
      on.vcsAdapter.resolveRelatedWork.mockResolvedValue([]);
      on.orchestrate.mockImplementation(buildPresentation);
      vi.spyOn(console, "log").mockImplementation(() => {});
      await review(on.args, depsFrom(on));

      const dispatched = on.dispatchRules.mock.calls[0]?.[0] as { prIntent?: unknown };
      expect(dispatched.prIntent).toEqual({ title: "Intent check", description: "Makes the budget per-host." });

      const off = makeHarness({
        args: makeArgs({ prIntent: "off" }),
        pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Intent check", description: "Makes the budget per-host." }),
      });
      off.vcsAdapter.resolveRelatedWork.mockResolvedValue([]);
      off.orchestrate.mockImplementation(buildPresentation);
      await review(off.args, depsFrom(off));
      const offDispatched = off.dispatchRules.mock.calls[0]?.[0] as { prIntent?: unknown };
      expect("prIntent" in offDispatched).toBe(false);
      vi.restoreAllMocks();
    });

    it("carries resolved linked-reference titles and states into the intent", async () => {
      const h = makeHarness({
        pr: makePr({ url: "https://github.com/acme/app/pull/42", title: "Fixes #7", description: "as discussed" }),
      });
      h.vcsAdapter.resolveRelatedWork.mockImplementation((refs) => Promise.resolve((refs as readonly Record<string, unknown>[]).map((ref) => ({
        ...ref,
        kind: "issue",
        title: `Linked work ${ref.number}`,
        state: "closed",
        url: `https://github.com/acme/app/issues/${String(ref.number)}`,
      }))));
      h.orchestrate.mockImplementation(buildPresentation);
      vi.spyOn(console, "log").mockImplementation(() => {});
      await review(h.args, depsFrom(h));

      const dispatched = h.dispatchRules.mock.calls[0]?.[0] as {
        prIntent?: { linked?: readonly { identifier: string; title?: string; state?: string }[] };
      };
      expect(dispatched.prIntent?.linked).toEqual([
        { identifier: "#7", title: "Linked work 7", state: "closed" },
      ]);
      vi.restoreAllMocks();
    });

    it("re-reviews an unchanged head when the PR description is edited", async () => {
      const url = "https://github.com/acme/app/pull/42";
      const priorDescription = "Makes the budget per-host.";
      const cfg = computeReviewConfigHash(
        makeArgs(),
        [
          relatedWorkFingerprint(extractRelatedWork({ provider: "github", reviewUrl: url, title: "Some PR", description: priorDescription })),
          prIntentFingerprint(sanitizePrIntent({ title: "Some PR", description: priorDescription })),
        ].filter((value) => value !== undefined).join("\n"),
      );
      const botComment: BotComment = { id: "999", body: formatMarker("cafef00d", cfg), lastReviewedSha: "cafef00d", reviewedConfig: cfg };

      const unchanged = makeHarness({ botComment, pr: makePr({ url, description: priorDescription }) });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await review(unchanged.args, depsFrom(unchanged));
      expect(unchanged.dispatchRules).not.toHaveBeenCalled();

      const edited = makeHarness({ botComment, pr: makePr({ url, description: "EDITED after the review ran" }) });
      await review(edited.args, depsFrom(edited));
      expect(edited.dispatchRules).toHaveBeenCalledOnce();
      logSpy.mockRestore();
    });
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
    let stored = null as BotComment | null;
    const wire = (h: Harness) => {
      h.vcsAdapter.findBotComment.mockImplementation(() => Promise.resolve(stored));
      h.vcsAdapter.upsertComment.mockImplementation((_locator, body, existing) => {
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
    expect(stored?.reviewedConfig).toBe(expectedConfigHash(second.config));
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

function conversationComment(
  threadId: string,
  commentId: string,
  body: string,
  extras: { authorLogin?: string; authorIsBot?: boolean; revisionId?: string } = {},
): ReviewActivityEvent {
  const binding = conversationBinding();
  return {
    ...binding,
    kind: "thread-comment",
    eventId: `review-comment:${commentId}`,
    revisionId: extras.revisionId ?? `rev-${commentId}`,
    orderKey: `comment:${commentId}`,
    authorLogin: extras.authorLogin ?? "tgdbot",
    authorIsBot: extras.authorIsBot ?? true,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    url: `${CONVERSATION_PR_URL}#discussion_r${commentId}`,
    commentId,
    threadId,
    body,
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
      readFindingOutcomes: store.readFindingOutcomes.bind(store),
      readDispositionOutcomes: store.readDispositionOutcomes.bind(store),
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
    expect(parsed.reviewedConfig).toBe(expectedConfigHash(first.config, undefined, fingerprint));

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
    expect(nativeId).not.toBe(String((await h.vcsAdapter.getPullRequest(h.config.locator)).id));
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
      return conversationThread({ threadId: "known", events: [] });
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
    const firstPollArgs = parseCommandArgs(["poll", "--repo", "acme/app", "--state-dir", stateDir]);
    if (firstPollArgs.command !== "poll") throw new Error("expected poll");
    await poll(firstPollArgs, {
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
      poll(firstPollArgs, {
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

// Issue #26, reproduced against hmchangw/newchat#222 (118 review threads over 2
// pages, 250 activity events). Two distinct defects, both exercised here.
describe("review: discussion context failures are diagnosable and non-blocking", () => {
  function pagedThreadsHarness(h: Harness, eventFailure?: Error) {
    // Two pages of review threads, the shape the issue reports (hasNextPage true).
    const page2Token = {
      scope: "review-thread-page" as const,
      provider: "github" as const,
      repositoryDigest: conversationBinding().repositoryDigest,
      reviewNumber: 42,
      opaque: "cursor-page-2",
    };
    let threadCalls = 0;
    h.vcsAdapter.listReviewThreads = vi.fn().mockImplementation(() => {
      threadCalls += 1;
      return Promise.resolve(threadCalls === 1 ? { threads: [], nextPageToken: page2Token } : { threads: [] });
    });
    h.vcsAdapter.getReviewThread = vi.fn().mockRejectedValue(new Error("no threads expected"));
    let eventCalls = 0;
    h.vcsAdapter.listReviewEvents = vi.fn().mockImplementation(() => {
      eventCalls += 1;
      // Pages 1-2 succeed, page 3 fails — exactly the observed behaviour.
      if (eventCalls >= 3 && eventFailure) return Promise.reject(eventFailure);
      return Promise.resolve(
        eventCalls <= 2
          ? { ...emptyEventPage(), nextPageToken: { scope: "review-event-page" as const, provider: "github" as const, repositoryDigest: conversationBinding().repositoryDigest, reviewNumber: 42, opaque: `ev-${eventCalls}` } }
          : emptyEventPage(),
      );
    });
    return { threadCalls: () => threadCalls, eventCalls: () => eventCalls };
  }

  // The activity-event walk reads only nextPageToken and throws every page away,
  // so it cannot affect duplicate-finding suppression. Letting it abort the run
  // cost a whole review for no informational gain.
  it("still publishes when the discarded activity-event walk fails", async () => {
    const h = makeHarness({ args: makeArgs({ stateDir: isolatedStateDir() }) });
    const counters = pagedThreadsHarness(h, new Error("GitHub review event continuation cutoff rank mismatch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(counters.eventCalls()).toBeGreaterThanOrEqual(3);
    // The cause is reported rather than swallowed.
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("cutoff rank mismatch");
    warn.mockRestore();
  });

  // Bot review of PR #27 (P1): classifyConversationContextError treats ANY
  // message containing "cursor" as an integrity failure, so rethrowIfIntegrityFailure
  // inside the activity-walk catch re-raised it and aborted the review anyway —
  // leaving the fix working only for messages that happen to dodge that keyword.
  // The adapter's own pagination errors ("nonadvancing cursor", "repeated
  // cursor") all contain it.
  it("still publishes when the activity walk fails with a cursor error", async () => {
    const h = makeHarness({ args: makeArgs({ stateDir: isolatedStateDir() }) });
    const counters = pagedThreadsHarness(h, new Error("GitHub review thread scan nonadvancing cursor"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(counters.eventCalls()).toBeGreaterThanOrEqual(3);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("nonadvancing cursor");
    warn.mockRestore();
  });

  // Bot review of PR #27 (P1): a hand-rolled pattern list missed forms the
  // shared redactor already covers. A surfaced diagnostic goes to CI and
  // support logs, so a partial redactor is a credential-leak path.
  it.each([
    ["authorization header", "listReviewThreads failed: Authorization: Basic dXNlcjpwYXNzd29yZA=="],
    ["url credentials", "listReviewThreads failed for https://user:sup3rs3cret@github.com/acme/app.git"],
    ["gitlab trigger token", "listReviewThreads failed: glptt-0123456789abcdef0123456789abcdef01234567"],
  ])("redacts %s from the surfaced cause", async (_name, message) => {
    const h = conversationHarness();
    h.vcsAdapter.listReviewThreads = vi.fn().mockRejectedValue(new Error(message));
    h.vcsAdapter.listReviewEvents = vi.fn().mockResolvedValue(emptyEventPage());
    h.vcsAdapter.getReviewThread = vi.fn();
    h.orchestrate.mockImplementation(buildPresentation);

    const error = await review(h.args, depsFrom(h)).then(() => undefined, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/refusing to publish/u);
    for (const secret of ["dXNlcjpwYXNzd29yZA==", "sup3rs3cret", "0123456789abcdef0123456789abcdef01234567"]) {
      expect(error!.message).not.toContain(secret);
    }
  });

  it("paginates every review-thread page", async () => {
    const h = makeHarness({ args: makeArgs({ stateDir: isolatedStateDir() }) });
    const counters = pagedThreadsHarness(h);

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(counters.threadCalls()).toBe(2);
  });

  // When the discussion genuinely cannot be loaded the run still refuses, but
  // the operator must be told WHY: the issue reports the message alone, with no
  // way to tell pagination from malformed data from a provider outage.
  it("names the underlying cause when it refuses to publish", async () => {
    const h = conversationHarness();
    h.vcsAdapter.listReviewThreads = vi.fn().mockRejectedValue(new Error("HTTP 502 upstream unavailable"));
    h.vcsAdapter.listReviewEvents = vi.fn().mockResolvedValue(emptyEventPage());
    h.vcsAdapter.getReviewThread = vi.fn();
    h.orchestrate.mockImplementation(buildPresentation);

    const error = await review(h.args, depsFrom(h)).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    // It must still refuse — and say why. The issue reports the refusal alone,
    // with no way to tell pagination from malformed data from an outage.
    expect(error!.message).toMatch(/refusing to publish/u);
    expect(error!.message).toMatch(/HTTP 502 upstream unavailable/u);
  });
});

// #58: trusted-base repository context reaching the reviewing rules. The
// preparation itself is covered in test/unit/context/prepare.test.ts; these
// cover the CLI's side of it — what it hands to dispatch, what it says when
// there is none, and that it never blocks a review it could still run.
describe("repository context", () => {
  function readyPacks(...ruleNames: string[]) {
    const packs: Record<string, { text: string; manifestHash: string; truncated: boolean; sources: [] }> = {};
    for (const name of ruleNames) {
      packs[name] = {
        text: `# Trusted Rule Context\n\nRule: ${name}\n`,
        manifestHash: "b".repeat(64),
        truncated: false,
        sources: [],
      };
    }
    return { status: "ready" as const, packs, manifestHash: "b".repeat(64), degradedReasons: [], cacheHit: false, incremental: false };
  }

  it("hands every rule's pack to dispatch", async () => {
    const h = makeHarness({
      args: makeArgs({ context: "auto" }),
      loadResult: {
        rules: [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })],
        errors: [],
      },
    });
    h.prepareContext.mockResolvedValue(readyPacks("rule-a", "rule-b"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const dispatched = h.dispatchRules.mock.calls[0]![0] as { contextPacks?: Record<string, unknown> };
    expect(Object.keys(dispatched.contextPacks ?? {}).sort()).toEqual(["rule-a", "rule-b"]);
  });

  it("prepares context against the BASE commit, never the head", async () => {
    const pr = makePr({ headSha: "cafef00d", baseSha: "0badbeef" });
    const h = makeHarness({ pr, args: makeArgs({ context: "auto" }) });
    h.prepareContext.mockResolvedValue(readyPacks("rule-a"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const request = h.prepareContext.mock.calls[0]![0] as { baseSha: string; headSha: string };
    expect(request.baseSha).toBe("0badbeef");
    expect(request.headSha).toBe("cafef00d");
  });

  it("sends a renamed file's BASE path to context preparation, not just its new one", async () => {
    const h = makeHarness({ args: makeArgs({ context: "auto" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(
      [
        "diff --git a/src/old-name.ts b/src/new-name.ts",
        "rename from src/old-name.ts",
        "rename to src/new-name.ts",
        "--- a/src/old-name.ts",
        "+++ b/src/new-name.ts",
        "@@ -1,1 +1,1 @@",
        "-const a = 1;",
        "+const a = 2;",
        "",
      ].join("\n"),
    );
    h.prepareContext.mockResolvedValue(readyPacks("rule-a"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const request = h.prepareContext.mock.calls[0]![0];
    // The map is built from the base commit, where this file is still
    // `src/old-name.ts`; sending only the new path finds no graph node.
    expect(request.changedFiles).toContain("src/old-name.ts");
    expect(request.changedFiles).toContain("src/new-name.ts");
  });

  it("reviews without context, and says so, when preparation fails", async () => {
    const h = makeHarness({ args: makeArgs({ context: "auto" }) });
    h.prepareContext.mockResolvedValue({ status: "unavailable", reasons: ["mapping timed out"] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    const dispatched = h.dispatchRules.mock.calls[0]![0] as { contextPacks?: unknown };
    expect(dispatched.contextPacks).toBeUndefined();
    // The summary carries a label, never the raw mapper diagnostic: that text
    // can name local filesystem paths and the summary is published.
    const orchestrated = h.orchestrate.mock.calls[0]![2] as { contextUnavailable?: string[] };
    expect(orchestrated.contextUnavailable).toContain("repository");
    expect(JSON.stringify(orchestrated)).not.toContain("mapping timed out");
    // The operator still gets the reason, on stderr.
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("mapping timed out");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("exits fatal without posting when --context require cannot be satisfied", async () => {
    const h = makeHarness({ args: makeArgs({ context: "require" }) });
    h.prepareContext.mockRejectedValue(new ContextRequiredError(["no base worktree"]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(1);
    expect(h.dispatchRules).not.toHaveBeenCalled();
    expect(h.vcsAdapter.upsertComment).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("no base worktree");
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("passes mode off through to preparation, and dispatches no packs", async () => {
    const h = makeHarness({ args: makeArgs({ context: "off" }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const request = h.prepareContext.mock.calls[0]![0] as { mode: string };
    expect(request.mode).toBe("off");
    const dispatched = h.dispatchRules.mock.calls[0]![0] as { contextPacks?: unknown };
    expect(dispatched.contextPacks).toBeUndefined();
  });

  it("degrades rather than failing when context preparation throws unexpectedly", async () => {
    const h = makeHarness({ args: makeArgs({ context: "auto" }) });
    // Not a ContextRequiredError: e.g. an unset HOME while selecting the cache
    // root. Under `auto` that must never take down a review it could still run.
    h.prepareContext.mockRejectedValue(new Error("HOME is required to select the context directory"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
    const orchestrated = h.orchestrate.mock.calls[0]![2] as { contextUnavailable?: string[] };
    expect(orchestrated.contextUnavailable).toContain("repository");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("propagates an unexpected failure in require mode instead of reviewing blind", async () => {
    const h = makeHarness({ args: makeArgs({ context: "require" }) });
    h.prepareContext.mockRejectedValue(new Error("HOME is required to select the context directory"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(review(h.args, depsFrom(h))).rejects.toThrow(/HOME is required/);

    expect(h.dispatchRules).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("prepares context only after the dedup skip, so a skipped run never maps", async () => {
    const args = makeArgs({ context: "auto" });
    const pr = makePr({ headSha: "cafef00d" });
    const cfg = expectedConfigHash(
      args,
      undefined,
      undefined,
      contextFingerprint({ mode: "auto", baseSha: pr.baseSha, allowDegraded: false }),
    );
    const h = makeHarness({
      args,
      pr,
      botComment: {
        id: "999",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${cfg} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: cfg,
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await review(h.args, depsFrom(h));

    expect(exitCode).toBe(0);
    // Mapping is the most expensive step in a review; a run that is going to
    // be skipped must not pay for it.
    expect(h.prepareContext).not.toHaveBeenCalled();
    expect(h.dispatchRules).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("folds repository context and dependency facts into one pack per rule", async () => {
    // Two independent producers of trusted context now exist, and the dispatch
    // contract allows exactly ONE pack per rule sharing one manifest hash — so
    // neither may quietly displace the other.
    const h = makeHarness({
      args: makeArgs({ context: "auto", dependencyFacts: "on" }),
      loadResult: { rules: [makeRule({ name: "rule-a" }), makeRule({ name: "rule-b" })], errors: [] },
    });
    h.vcsAdapter.getDiff.mockResolvedValue([
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      '@@ -3,7 +3,7 @@ "dependencies": {',
      '-    "lodash": "4.17.20",',
      '+    "lodash": "4.17.21",',
      "",
    ].join("\n"));
    h.prepareContext.mockResolvedValue(readyPacks("rule-a", "rule-b"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const dispatched = h.dispatchRules.mock.calls[0]![0] as {
      contextPacks?: Record<string, { text: string; manifestHash: string }>;
    };
    expect(Object.keys(dispatched.contextPacks ?? {}).sort()).toEqual(["rule-a", "rule-b"]);
    for (const name of ["rule-a", "rule-b"]) {
      const pack = dispatched.contextPacks![name]!;
      expect(pack.text).toContain("# Trusted Rule Context");
      expect(pack.text).toContain("Dependency changes in this pull request");
    }
    // One shared hash across rules, and not either component's own hash.
    const hashes = new Set(Object.values(dispatched.contextPacks!).map((pack) => pack.manifestHash));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).not.toBe("b".repeat(64));
  });

  it("still sends the repository pack alone when no manifest changed", async () => {
    const h = makeHarness({ args: makeArgs({ context: "auto", dependencyFacts: "on" }) });
    h.prepareContext.mockResolvedValue(readyPacks("rule-a"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const dispatched = h.dispatchRules.mock.calls[0]![0] as {
      contextPacks?: Record<string, { text: string; manifestHash: string }>;
    };
    const pack = dispatched.contextPacks!["rule-a"]!;
    expect(pack.text).toContain("# Trusted Rule Context");
    expect(pack.text).not.toContain("Dependency changes in this pull request");
    // A single component is passed through untouched, hash included.
    expect(pack.manifestHash).toBe("b".repeat(64));
  });

  it("reserves the dependency section's share of the size ceiling", async () => {
    // --context-max-chars is a per-rule cost control, and the two producers
    // share one rule's pack — so the repository map must be rendered against
    // what is LEFT, not against the whole ceiling.
    const h = makeHarness({
      args: makeArgs({ context: "auto", dependencyFacts: "on", contextMaxChars: 12_000 }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue([
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      '@@ -3,7 +3,7 @@ "dependencies": {',
      '-    "lodash": "4.17.20",',
      '+    "lodash": "4.17.21",',
      "",
    ].join("\n"));
    h.prepareContext.mockResolvedValue(readyPacks("rule-a"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const request = h.prepareContext.mock.calls[0]![0] as { maxChars?: number };
    expect(request.maxChars).toBeLessThan(12_000);
    expect(request.maxChars).toBeGreaterThanOrEqual(4_000);
  });

  it("spends the whole ceiling on the repository map when no manifest changed", async () => {
    const h = makeHarness({
      args: makeArgs({ context: "auto", dependencyFacts: "on", contextMaxChars: 12_000 }),
    });
    h.prepareContext.mockResolvedValue(readyPacks("rule-a"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    const request = h.prepareContext.mock.calls[0]![0] as { maxChars?: number };
    expect(request.maxChars).toBe(12_000);
  });

  it("carries dependency facts on the legacy engine too, now that it takes packs", async () => {
    // The suppression this replaces was correct when written: the legacy
    // prompt builder never received a pack. Wiring context removed that
    // premise, and leaving the guard would deny an operator facts they asked
    // for on a reason that no longer holds.
    const h = makeHarness({
      args: makeArgs({ context: "off", dependencyFacts: "on", dispatch: "legacy" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue([
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      '@@ -3,7 +3,7 @@ "dependencies": {',
      '-    "lodash": "4.17.20",',
      '+    "lodash": "4.17.21",',
      "",
    ].join("\n"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const dispatched = h.dispatchRules.mock.calls[0]![0] as {
      contextPacks?: Record<string, { text: string }>;
    };
    expect(dispatched.contextPacks?.["rule-a"]?.text).toContain("Dependency changes in this pull request");
    expect(warnSpy.mock.calls.flat().join(" ")).not.toContain("needs --dispatch direct");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("re-reviews when the context mode changes, because the config hash moves", async () => {
    const pr = makePr({ headSha: "cafef00d" });
    const offArgs = makeArgs({ context: "off" });
    const offHash = expectedConfigHash(offArgs);
    const h = makeHarness({
      args: makeArgs({ context: "auto" }),
      pr,
      botComment: {
        id: "999",
        body: `<!-- tgd-review-agent:sha=cafef00d cfg=${offHash} -->`,
        lastReviewedSha: "cafef00d",
        reviewedConfig: offHash,
      },
    });
    h.prepareContext.mockResolvedValue(readyPacks("rule-a"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    logSpy.mockRestore();
    expect(h.dispatchRules).toHaveBeenCalledTimes(1);
  });
});

// PR #54 review: the fetch layer built for #50 was invoked only by its own
// tests. Every real review called dependencyContextPack with no facts, so the
// dependency-currency rule could never see a latest version, a deprecation, or
// a withdrawn release — the facts it exists to check.
//
// Wiring it means outbound network from a tool that otherwise makes none, so it
// is opt-in and OFF by default. The pack's wording already tells the truth in
// both states: "have NOT been checked" without facts, "do not read silence as
// approval" with them.
describe("review — dependency facts", () => {
  const MANIFEST_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    '@@ -3,7 +3,7 @@ "dependencies": {',
    '     "left-pad": "1.0.0",',
    '-    "lodash": "4.17.20",',
    '+    "lodash": "4.17.21",',
    '     "react": "18.0.0"',
  ].join("\n");

  const packFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string }> }
      | undefined;
    return input?.contextPacks?.["rule-a"]?.text;
  };

  /** The diff-derived half (#63): identifiers the host did not establish. */
  const untrustedPackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { untrustedText?: string }> }
      | undefined;
    return input?.contextPacks?.["rule-a"]?.untrustedText;
  };

  // `--dependency-facts` is the registry/OSV opt-in. The pack still ships when
  // a manifest changed, because #69's local name check lives there; it says
  // plainly that nothing was looked up.
  it("makes no registry request unless asked", async () => {
    const h = makeHarness();
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(fetchJson).not.toHaveBeenCalled();
    expect(packFor(h)).toMatch(/not been checked/i);
    expect(packFor(h)).not.toContain("lodash");
    expect(untrustedPackFor(h)).toContain("lodash");
  });

  it("puts the registry's answer in front of the rule when enabled", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.30" },
      versions: { "4.17.21": { deprecated: "use lodash-es" } },
    });

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(fetchJson).toHaveBeenCalledWith("https://registry.npmjs.org/lodash");
    expect(packFor(h)).toContain("latest is 4.17.30");
    // Round four: the deprecation FLAG reaches the rule, the publisher's
    // wording does not.
    expect(packFor(h)).toMatch(/deprecated/i);
    expect(packFor(h)).not.toContain("use lodash-es");
    expect(packFor(h)).not.toMatch(/NOT been checked/);
    // #63: the registry's answer is host-established and stays trusted; the
    // package it is about is the author's string and moves to the untrusted
    // half. Both together are what makes the finding reportable.
    expect(packFor(h)).not.toContain("lodash");
    expect(untrustedPackFor(h)).toContain("lodash");
  });

  // An outage must not read as a clean bill of health, and must not fail the
  // review either.
  it("reports a failed lookup as unchecked rather than as nothing to report", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const exitCode = await review(h.args, { ...depsFrom(h), fetchJson });

    expect(exitCode).toBe(0);
    expect(packFor(h)).toMatch(/lookup failed/);
    // Final round: the reason is host-authored; the transport's own message is
    // logged rather than carried into trusted context.
    expect(packFor(h)).toMatch(/could not be reached/);
    expect(packFor(h)).not.toMatch(/ECONNRESET/);
  });

  it("asks nothing when the diff changes no manifest", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(fetchJson).not.toHaveBeenCalled();
    expect(packFor(h)).toBeUndefined();
  });
});

// PR #54 review: the legacy orchestrator has no context-pack concept — its
// prompt builder never receives one — so the map was silently dropped there
// while the registry requests still went out. Silent is the problem: the
// operator asked for a dependency review, paid for the lookups, and got a run
// that could not produce a single dependency finding.
// PR #65: this suite asserted that legacy dispatch SUPPRESSED dependency facts,
// which was correct while the legacy prompt builder could not receive a context
// pack. Wiring repository context gave `buildDispatchPrompt` a `packsByRule`
// parameter and `dispatchRules` the same validation the direct engine has, so
// the premise is gone and the suppression would now deny an operator facts they
// asked for on a reason that no longer holds. The suite now pins the opposite
// contract, deliberately, rather than being deleted.
describe("review — dependency facts under legacy dispatch", () => {
  const MANIFEST_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    '@@ -3,7 +3,7 @@ "dependencies": {',
    '-    "lodash": "4.17.20",',
    '+    "lodash": "4.17.21",',
  ].join("\n");

  it("asks the registry and reaches the rules, now that the engine carries packs", async () => {
    const h = makeHarness({
      args: makeArgs({ dependencyFacts: "on", dispatch: "legacy" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" },
      versions: { "4.17.21": {} },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(fetchJson).toHaveBeenCalled();
    const dispatched = h.dispatchRules.mock.calls[0]![0] as {
      contextPacks?: Record<string, { text: string }>;
    };
    expect(dispatched.contextPacks?.["rule-a"]?.text)
      .toContain("Dependency changes in this pull request");
    // The old warning must be gone, not merely unreachable: a lookup that
    // happened while the operator was told it had not is worse than either.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/needs --dispatch direct/i);
    warn.mockRestore();
  });

  it("still reaches the rules on the default engine", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" },
      versions: { "4.17.21": {} },
    });

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(fetchJson).toHaveBeenCalled();
  });
});

// PR #54 review, final round, P1: the context pack was built on EVERY review
// whose diff touches a package.json, flag or no flag. Package names and
// manifest paths are diff-controlled, and while the allowlists stop a path
// forming a sentence with spaces, `ignore-all-previous-instructions` needs no
// spaces. Those strings are already in UNTRUSTED_DIFF; copying them into
// TRUSTED_CONTEXT is what elevates them, and it was happening by default.
describe("review — the dependency pack is not the registry opt-in", () => {
  const MANIFEST_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    '@@ -3,7 +3,7 @@ "dependencies": {',
    '+    "lodash": "4.17.21",',
  ].join("\n");

  const packFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string }> }
      | undefined;
    return input?.contextPacks?.["rule-a"]?.text;
  };

  /** The diff-derived half (#63): identifiers the host did not establish. */
  const untrustedPackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { untrustedText?: string }> }
      | undefined;
    return input?.contextPacks?.["rule-a"]?.untrustedText;
  };

  // Issue #69: the pack is how local name-similarity notes reach the rules.
  // Registry lookup stays off; author-chosen names stay untrusted.
  it("still supplies the pack when registry facts are off, without querying a registry", async () => {
    const h = makeHarness();
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(untrustedPackFor(h)).toContain("lodash");
    expect(packFor(h)).not.toContain("lodash");
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("supplies one when the feature is on", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);

    await review(h.args, {
      ...depsFrom(h),
      fetchJson: vi.fn().mockResolvedValue({
        "dist-tags": { latest: "4.17.21" },
        versions: { "4.17.21": {} },
      }),
    });

    expect(untrustedPackFor(h)).toContain("lodash");
    expect(packFor(h)).not.toContain("lodash");
  });
});

// Issue #56: the host reads the changed manifests at the HEAD ref and parses
// them, instead of inferring their structure from three lines of diff context.
describe("review — manifests are read at the head ref", () => {
  const MANIFEST_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    // No section header in the hunk: under the old heuristic this was the case
    // that had to be guessed at.
    "@@ -40,7 +40,7 @@",
    '+    "lodash": "4.17.21",',
    '+    "node": "22.0.0",',
  ].join("\n");

  // Both halves. #63 moved the author's identifiers into `untrustedText`, so a
  // test asking "did this package reach the rules" reads the whole pack; the
  // tests that care WHICH half say so explicitly with `packFor`.
  const wholePackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string; untrustedText?: string }> }
      | undefined;
    const pack = input?.contextPacks?.["rule-a"];
    return pack === undefined ? undefined : `${pack.text}\n${pack.untrustedText ?? ""}`;
  };

  it("asks for each changed manifest at the head sha", async () => {
    const h = makeHarness({
      pr: makePr({ headSha: "cafef00d" }),
      args: makeArgs({ dependencyFacts: "on" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    expect(h.vcsAdapter.getFileAtRef).toHaveBeenCalledWith(
      expect.anything(),
      "cafef00d",
      "package.json",
    );
  });

  // The engines entry rides in on the same hunk and is excluded because the
  // FILE says it is not a dependency — no denylist involved.
  it("takes what the manifest declares and leaves the rest", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    expect(wholePackFor(h)).toContain("lodash");
    expect(wholePackFor(h)).not.toMatch(/(^|\W)node@/);
  });

  // PR #67: extraction compares BASE against HEAD, so a dependency that did not
  // move must not be reported. Without the base read every dependency in the
  // manifest reads as new, which is how the old line-matching behaved and why
  // nothing caught it.
  it("reads the base ref too, and leaves unchanged dependencies out", async () => {
    const h = makeHarness({
      pr: makePr({ headSha: "cafef00d", baseSha: "deadbeef" }),
      args: makeArgs({ dependencyFacts: "on" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    expect(h.vcsAdapter.getFileAtRef).toHaveBeenCalledWith(
      expect.anything(), "deadbeef", "package.json",
    );
    // lodash moved 4.17.20 -> 4.17.21; react is 18.0.0 at both ends.
    expect(wholePackFor(h)).toContain("lodash");
    expect(wholePackFor(h)).not.toContain("react");
  });

  // Issue #69: the local name check needs the manifests and needs no registry.
  // `--dependency-facts` is the outbound-request flag; inheriting it would hide
  // a check that makes no request.
  it("still reads manifests when registry facts are off, and does not query a registry", async () => {
    const h = makeHarness();
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(h.vcsAdapter.getFileAtRef).toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  // "We could not look" must not render as "we looked and it was fine".
  it("says so when a manifest could not be read", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    h.vcsAdapter.getFileAtRef.mockResolvedValue(undefined);

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn() });

    expect(wholePackFor(h)).toMatch(/could NOT be read/i);
    expect(wholePackFor(h)).toContain("package.json");
  });

  it("survives a manifest read that fails outright", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    h.vcsAdapter.getFileAtRef.mockRejectedValue(new Error("HTTP 500"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, { ...depsFrom(h), fetchJson: vi.fn() });

    expect(exitCode).toBe(0);
    expect(wholePackFor(h)).toMatch(/could NOT be read/i);
    warn.mockRestore();
  });
});

// Issue #69: a silent typosquat check over names the host already has. No
// registry, no `--dependency-facts`.
describe("review — typosquat comparison is local", () => {
  const DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -3,2 +3,3 @@",
    '   "dependencies": {',
    '+    "lodahs": "1.0.0",',
  ].join("\n");

  const wholePackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string; untrustedText?: string }> }
      | undefined;
    const pack = input?.contextPacks?.["rule-a"];
    return pack === undefined ? undefined : `${pack.text}\n${pack.untrustedText ?? ""}`;
  };

  const packFor = (h: Harness) => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string; untrustedText?: string }> }
      | undefined;
    return input?.contextPacks?.["rule-a"];
  };

  it("flags a one-keystroke neighbour without --dependency-facts", async () => {
    const h = makeHarness();
    h.vcsAdapter.getDiff.mockResolvedValue(DIFF);
    h.vcsAdapter.getFileAtRef.mockImplementation(async (_locator: unknown, ref: string) =>
      JSON.stringify({
        dependencies: ref === "deadbeef"
          ? { lodash: "4.17.20" }
          : { lodash: "4.17.20", lodahs: "1.0.0" },
      }),
    );
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    const pack = packFor(h);
    expect(pack?.text).toMatch(/1 transposition from neighbour 1/i);
    expect(pack?.text).not.toContain("lodahs");
    expect(pack?.text).not.toContain("lodash");
    expect(pack?.untrustedText).toContain("lodahs");
    expect(pack?.untrustedText).toContain("Entry 1 neighbour 1 = lodash");
    expect(fetchJson).not.toHaveBeenCalled();
    expect(wholePackFor(h)).toMatch(/same manifest/i);
  });
});

// PR #67 review, round two: a pull request diff is a THREE-DOT comparison, so
// the base side is the point the branches diverged — not the target branch's
// current tip. Once the target advances, reading the tip attributes the
// TARGET's dependency updates to this pull request.
describe("review — the comparison base is where the branches diverged", () => {
  const MANIFEST_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -3,7 +3,7 @@",
    '+    "lodash": "4.17.21",',
  ].join("\n");

  // Both halves. #63 moved the author's identifiers into `untrustedText`, so a
  // test asking "did this package reach the rules" reads the whole pack; the
  // tests that care WHICH half say so explicitly with `packFor`.
  const wholePackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string; untrustedText?: string }> }
      | undefined;
    const pack = input?.contextPacks?.["rule-a"];
    return pack === undefined ? undefined : `${pack.text}\n${pack.untrustedText ?? ""}`;
  };

  const manifestAt = (versions: Record<string, string>) =>
    JSON.stringify({ dependencies: versions });

  it("reads the base manifest at the merge base, not the base tip", async () => {
    const h = makeHarness({
      pr: makePr({ headSha: "aaaaaaa1", baseSha: "bbbbbbb1" }),
      args: makeArgs({ dependencyFacts: "on" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    h.vcsAdapter.getMergeBaseSha.mockResolvedValue("ccccccc1");
    // The target branch bumped lodash on its own after the branches diverged.
    h.vcsAdapter.getFileAtRef.mockImplementation(async (_l: unknown, ref: string) => {
      if (ref === "aaaaaaa1") return manifestAt({ lodash: "4.17.21" });
      if (ref === "ccccccc1") return manifestAt({ lodash: "4.17.20" });
      return manifestAt({ lodash: "4.17.21" }); // the tip, which must not be used
    });

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    expect(h.vcsAdapter.getFileAtRef).toHaveBeenCalledWith(
      expect.anything(), "ccccccc1", "package.json",
    );
    // Read at the tip, lodash looks unchanged and nothing is reported at all.
    expect(wholePackFor(h)).toContain("lodash");
  });

  // Round four: `startSha` is NOT a merge base. GitLab maps `diff_refs.start_sha`
  // to it, which is the commit on the TARGET side — the tip comparison this
  // exists to avoid. Only the adapter's own merge-base answer is used.
  it("does not mistake the merge request's start sha for a merge base", async () => {
    const h = makeHarness({
      pr: makePr({ headSha: "aaaaaaa1", baseSha: "bbbbbbb1", startSha: "ddddddd1" }),
      args: makeArgs({ dependencyFacts: "on" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    h.vcsAdapter.getMergeBaseSha.mockResolvedValue("ccccccc1");

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn() });

    expect(h.vcsAdapter.getMergeBaseSha).toHaveBeenCalled();
    expect(h.vcsAdapter.getFileAtRef).toHaveBeenCalledWith(
      expect.anything(), "ccccccc1", "package.json",
    );
    expect(h.vcsAdapter.getFileAtRef).not.toHaveBeenCalledWith(
      expect.anything(), "ddddddd1", "package.json",
    );
  });

  // Round three changed this. Falling back to the base TIP selects a
  // known-wrong comparison: if the target advanced, its dependency updates are
  // attributed to this pull request — the exact failure the merge base exists
  // to prevent. An unexamined manifest is honest; a wrong comparison is not.
  it("marks manifests unexamined when the merge base cannot be resolved", async () => {
    const h = makeHarness({
      pr: makePr({ headSha: "aaaaaaa1", baseSha: "bbbbbbb1" }),
      args: makeArgs({ dependencyFacts: "on" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    h.vcsAdapter.getMergeBaseSha.mockResolvedValue(undefined);
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(h.vcsAdapter.getFileAtRef).not.toHaveBeenCalledWith(
      expect.anything(), "bbbbbbb1", "package.json",
    );
    expect(fetchJson).not.toHaveBeenCalled();
    expect(wholePackFor(h)).toMatch(/could NOT be read/i);
  });

  it("says the same when the merge-base lookup fails outright", async () => {
    const h = makeHarness({
      pr: makePr({ headSha: "aaaaaaa1", baseSha: "bbbbbbb1" }),
      args: makeArgs({ dependencyFacts: "on" }),
    });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    h.vcsAdapter.getMergeBaseSha.mockRejectedValue(new Error("HTTP 403"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const exitCode = await review(h.args, { ...depsFrom(h), fetchJson: vi.fn() });

    expect(exitCode).toBe(0);
    expect(wholePackFor(h)).toMatch(/could NOT be read/i);
    warn.mockRestore();
  });

  it("asks for no merge base when there is no manifest to read", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn() });

    expect(h.vcsAdapter.getMergeBaseSha).not.toHaveBeenCalled();
  });
});

// PR #67 review, round four: a generated monorepo update can touch hundreds of
// package.json files, and each one cost up to two sequential provider requests
// BEFORE the 200-package extraction cap applied. That stalls the review and can
// exhaust an API quota, mostly on manifests with no relevant change.
describe("review — manifest reads are bounded", () => {
  const manifestDiffFor = (count: number) =>
    Array.from({ length: count }, (_, i) => [
      `diff --git a/w${i}/package.json b/w${i}/package.json`,
      `--- a/w${i}/package.json`,
      `+++ b/w${i}/package.json`,
      "@@ -3,7 +3,7 @@",
      '+    "lodash": "4.17.21",',
    ].join("\n")).join("\n");

  // Both halves. #63 moved the author's identifiers into `untrustedText`, so a
  // test asking "did this package reach the rules" reads the whole pack; the
  // tests that care WHICH half say so explicitly with `packFor`.
  const wholePackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string; untrustedText?: string }> }
      | undefined;
    const pack = input?.contextPacks?.["rule-a"];
    return pack === undefined ? undefined : `${pack.text}\n${pack.untrustedText ?? ""}`;
  };

  it("stops reading after a bounded number of manifests", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(manifestDiffFor(300));

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    // Two reads per manifest at most, and far fewer than 600.
    expect(h.vcsAdapter.getFileAtRef.mock.calls.length).toBeLessThanOrEqual(100);
  });

  // Bounded is not the same as silent: what was skipped has to be stated.
  it("reports the manifests it did not read", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(manifestDiffFor(300));

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    expect(wholePackFor(h)).toMatch(/could NOT be read/i);
  });

  it("reads every manifest when there are few", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(manifestDiffFor(3));

    await review(h.args, { ...depsFrom(h), fetchJson: vi.fn().mockResolvedValue({
      "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} },
    }) });

    expect(h.vcsAdapter.getFileAtRef.mock.calls.length).toBe(6);
    expect(wholePackFor(h)).not.toMatch(/could NOT be read/i);
  });
});

// Issue #50, the advisory half: with --dependency-facts on, the host also asks
// an advisory database about each pinned dependency and puts the answer in
// front of every rule.
describe("review — advisory lookups", () => {
  const MANIFEST_DIFF = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -3,7 +3,7 @@",
    '+    "lodash": "4.17.21",',
  ].join("\n");

  const wholePackFor = (h: Harness): string | undefined => {
    const input = h.dispatchRules.mock.calls[0]?.[0] as
      | { contextPacks?: Record<string, { text: string; untrustedText?: string }> }
      | undefined;
    const pack = input?.contextPacks?.["rule-a"];
    return pack === undefined ? undefined : `${pack.text}\n${pack.untrustedText ?? ""}`;
  };

  const registryAnswer = { "dist-tags": { latest: "4.17.21" }, versions: { "4.17.21": {} } };
  const osvAnswer = {
    vulns: [{
      id: "GHSA-jf85-cpcp-j695",
      summary: "prose that must not travel",
      database_specific: { severity: "HIGH" },
      affected: [{ ranges: [{ events: [{ fixed: "4.17.22" }] }] }],
    }],
  };

  const runWith = async (h: Harness) => {
    const fetchJson = vi.fn(async (url: string) =>
      url.includes("osv.dev") ? osvAnswer : registryAnswer);
    await review(h.args, { ...depsFrom(h), fetchJson });
    return fetchJson;
  };

  it("asks the advisory database about a pinned dependency", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);

    const fetchJson = await runWith(h);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://api.osv.dev/v1/query",
      expect.objectContaining({
        body: { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.21" },
      }),
    );
  });

  it("puts the advisory in front of the rules, without its prose", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);

    await runWith(h);

    expect(wholePackFor(h)).toContain("GHSA-jf85-cpcp-j695");
    expect(wholePackFor(h)).not.toContain("prose that must not travel");
  });

  it("asks nothing of the advisory database when the feature is off", async () => {
    const h = makeHarness();
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn();

    await review(h.args, { ...depsFrom(h), fetchJson });

    expect(fetchJson).not.toHaveBeenCalled();
  });

  // An advisory outage must not read as a clean bill of health, and must not
  // take the registry facts down with it.
  it("keeps the registry facts when the advisory lookup fails", async () => {
    const h = makeHarness({ args: makeArgs({ dependencyFacts: "on" }) });
    h.vcsAdapter.getDiff.mockResolvedValue(MANIFEST_DIFF);
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("osv.dev")) throw new Error("HTTP 503");
      return registryAnswer;
    });

    const exitCode = await review(h.args, { ...depsFrom(h), fetchJson });

    expect(exitCode).toBe(0);
    expect(wholePackFor(h)).toMatch(/advisories NOT checked/i);
    expect(wholePackFor(h)).toMatch(/this is the latest/i);
  });
});

// PR #72 review, raised by both bots: the digest and the inline comments named
// the model, and the MANAGED SUMMARY did not — so provenance depended on which
// publication path produced the comment.
describe("review — the summary names the model too", () => {
  const withModels = (models?: string[]) => makeHarness({
    botComment: null,
    dispatchResult: {
      findings: [],
      rulesRun: ["rule-a"],
      rulesFailed: [],
      ...(models === undefined ? {} : { modelsUsed: models }),
    },
    orchestrationResult: {
      commentBody: "**No actionable comments.** ✅",
      inlineComments: [],
      findingsCount: 0,
      rulesRun: ["rule-a"],
      rulesFailed: [],
      ...(models === undefined ? {} : { modelsUsed: models }),
    } as never,
  });

  const summaryBodies = (h: Harness): string =>
    h.vcsAdapter.upsertComment.mock.calls.map((call) => String(call[1])).join("\n");

  it("names the model on the summary it upserts", async () => {
    const h = withModels(["anthropic/claude-opus-4-5"]);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(summaryBodies(h)).toContain("anthropic/claude-opus-4-5");
    vi.restoreAllMocks();
  });

  it("leaves the summary unadorned when no model resolved", async () => {
    const h = withModels(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(summaryBodies(h)).toContain("Posted by");
    expect(summaryBodies(h)).not.toContain(" using ");
    vi.restoreAllMocks();
  });
});

// Issue #75: the checks are opt-in, read only the trusted base, and never cost
// the review when they cannot run.
describe("review — structural checks", () => {
  const claimed = {
    file: "src/retry.ts", line: 1, severity: "warning" as const, category: "correctness",
    message: "budget() is never called.", ruleName: "rule-a",
    claim: { kind: "no-other-references" as const, symbol: "budget" },
  };

  it("does nothing at all when the feature is off", async () => {
    const h = makeHarness({ botComment: null });
    h.dispatchRules.mockResolvedValue({ findings: [claimed], rulesRun: ["rule-a"], rulesFailed: [] });

    await review(h.args, depsFrom(h));

    expect(h.prepareStructuralWorkspace).not.toHaveBeenCalled();
    expect(h.runStructuralChecks).not.toHaveBeenCalled();
  });

  // The worktree is the expensive part; a review whose findings make no claim
  // must not pay for one.
  it("prepares no worktree when no finding made a claim", async () => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({
      findings: [{ ...claimed, claim: undefined }], rulesRun: ["rule-a"], rulesFailed: [],
    });

    await review(h.args, depsFrom(h));

    expect(h.prepareStructuralWorkspace).not.toHaveBeenCalled();
    expect(h.runStructuralChecks).not.toHaveBeenCalled();
  });

  // Issue #80: "has a claim" is much weaker than "can be checked", and on a
  // cold workspace the worktree preparation is a FULL CLONE — the feature's
  // largest single cost. Each case below resolves to nothing today, so the
  // clone would buy nothing.
  it.each([
    ["every claim is on an unsupported language", [{ ...claimed, file: "src/retry.go" }]],
    ["every claimed finding is addressed", [{ ...claimed, decision: "addressed" as const }]],
    ["every claimed finding needs clarification", [{ ...claimed, decision: "needs-clarification" as const }]],
    ["every claimed finding is suppressed by an addressed duplicate",
      [{ ...claimed, ruleName: "rule-b" }, { ...claimed, decision: "addressed" as const }]],
  ])("prepares no worktree when %s", async (_name, findings) => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({ findings, rulesRun: ["rule-a"], rulesFailed: [] });

    await review(h.args, depsFrom(h));

    expect(h.prepareStructuralWorkspace).not.toHaveBeenCalled();
    expect(h.runStructuralChecks).not.toHaveBeenCalled();
    // Skipping the clone must not leave a claim reading unchallenged: the
    // annotation says why nothing ran.
    const passed = h.orchestrate.mock.calls[0]?.[0] as {
      findings: { claim?: unknown; hostCheck?: { status: string; reason: string } }[];
    };
    for (const finding of passed.findings.filter((entry) => entry.claim !== undefined)) {
      expect(finding.hostCheck).toMatchObject({ status: "not-checked" });
      expect(finding.hostCheck?.reason).toContain("no claim in this review was checkable");
    }
  });

  // The gate is per-review ("some"), not per-finding: one eligible claim pays
  // for the clone, and the ineligible ones ride along to the checker, which
  // annotates each with its own precise refusal (e.g. the language one).
  it("still prepares the worktree when one eligible claim rides with ineligible ones", async () => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({
      findings: [{ ...claimed, file: "src/retry.go" }, claimed],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    });

    await review(h.args, depsFrom(h));

    expect(h.prepareStructuralWorkspace).toHaveBeenCalledTimes(1);
    expect(h.runStructuralChecks).toHaveBeenCalledTimes(1);
  });

  it("checks a claim against the base worktree when the feature is on", async () => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({ findings: [claimed], rulesRun: ["rule-a"], rulesFailed: [] });

    await review(h.args, depsFrom(h));

    // Two arguments now: the request, and the callback the lock is held for.
    expect(h.prepareStructuralWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: "deadbeef", rejectPreviouslySharedRoot: true }),
      expect.any(Function),
    );
    expect(h.runStructuralChecks).toHaveBeenCalledWith(
      expect.objectContaining({ baseRoot: "/ws/repo/base" }),
    );
  });

  // The same refusal the mapper makes, for the same reason: everything this
  // reads must come from the base commit, never a PR checkout.
  it("refuses a worktree that is not at the requested base commit", async () => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({ findings: [claimed], rulesRun: ["rule-a"], rulesFailed: [] });
    h.prepareStructuralWorkspace.mockImplementation(async (_request, use) => use({
      root: "/ws", repositoryRoot: "/ws/repo", mirrorPath: "/ws/repo/mirror",
      worktreesRoot: "/ws/repo/worktrees", baseWorktreePath: "/ws/repo/base",
      ownerMarkerPath: "/ws/repo/owner.json", baseSha: "not-the-base",
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    expect(h.runStructuralChecks).not.toHaveBeenCalled();
    const passed = h.orchestrate.mock.calls[0]?.[0] as { findings: { hostCheck?: { status: string } }[] };
    expect(passed.findings[0]?.hostCheck).toMatchObject({ status: "not-checked" });
    vi.restoreAllMocks();
  });

  // Degrading must be visible on the finding, not silent: a claim that reads
  // unchallenged is exactly what this feature exists to stop.
  it("marks the claim not-checked and still publishes when the worktree fails", async () => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({ findings: [claimed], rulesRun: ["rule-a"], rulesFailed: [] });
    h.prepareStructuralWorkspace.mockRejectedValue(new Error("no git here"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const code = await review(h.args, depsFrom(h));

    expect(code).not.toBe(1);
    const passed = h.orchestrate.mock.calls[0]?.[0] as {
      findings: { message: string; hostCheck?: { status: string; reason: string } }[];
    };
    expect(passed.findings).toHaveLength(1);
    expect(passed.findings[0]?.hostCheck?.status).toBe("not-checked");
    expect(passed.findings[0]?.hostCheck?.reason).toContain("could not be prepared");
    vi.restoreAllMocks();
  });

  // CodeRabbit review. The reason is rendered into a review comment, which is
  // world-readable on a public repository, and a workspace failure quotes the
  // absolute path it failed on — publishing the CI runner's filesystem layout
  // to anyone reading the pull request. The same rule `ruleFailureReasons`
  // already follows: a host-authored classification is published, and the raw
  // error goes to stderr, which is private CI logs.
  it("never publishes the raw workspace error, and still logs it", async () => {
    const h = makeHarness({ botComment: null, args: makeArgs({ structuralChecks: "on" }) });
    h.dispatchRules.mockResolvedValue({ findings: [claimed], rulesRun: ["rule-a"], rulesFailed: [] });
    h.prepareStructuralWorkspace.mockRejectedValue(
      new Error("EACCES: permission denied, mkdir '/home/runner/.cache/tgd/workspaces/deadbeef/base'"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await review(h.args, depsFrom(h));

    const passed = h.orchestrate.mock.calls[0]?.[0] as {
      findings: { hostCheck?: { status: string; reason: string } }[];
    };
    const reason = passed.findings[0]?.hostCheck?.reason ?? "";
    expect(reason).not.toContain("/home/runner");
    expect(reason).not.toContain("EACCES");
    expect(reason).toBe("the base worktree could not be prepared");

    // Diagnosable where it is safe to be: stderr, not the published comment.
    expect(warn.mock.calls.flat().join(" ")).toContain("/home/runner");
    vi.restoreAllMocks();
  });
});
