#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseCommandArgs } from "./cli-args.js";
import type { PollArgs, ReviewArgs } from "./cli-args.js";
import { resolveConfig as resolveConfigReal } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import {
  buildReviewPublicationGraph,
  childIsTerminal,
  executePublication,
  loadPublicationAction,
  reviewPublicationIdentity,
  type PublicationAction,
  type PublicationChild,
  type PublicationExecutorHooks,
  type PublicationWriteResult,
  type PublicationWriter,
} from "./conversation/publication-manifest.js";
import { computeContentDigest, computeRepositoryDigest, formatChildMarker, parseChildMarker } from "./conversation/markers.js";
import {
  bindFindingLedgerIdentity,
  prepareFindingLedgerEntry,
  type FindingLedgerEntry,
  type FindingReviewOptions,
} from "./conversation/state-schema.js";
import {
  buildConversationContext,
  MAX_REVIEW_CONTEXT_PAGES,
  rethrowIfIntegrityFailure,
} from "./conversation/context.js";
import type { ReviewIdentity } from "./conversation/types.js";
import type { ConversationAdapter, ReviewThreadSnapshot } from "./vcs/conversation-adapter.js";
import { canonicalStateRepositoryIdentity, selectConversationStateRoot } from "./conversation/state-paths.js";
import {
  createConversationStateStore,
  type ConversationStateStore,
} from "./conversation/state-store.js";
import { poll } from "./poll/poll.js";
import {
  computeReviewConfigHash,
  conversationDedupFingerprint,
  decideDedup,
  formatMarker,
  stateRootDomainIdentifier,
} from "./review/dedup.js";
import { changedFiles } from "./review/diff-anchors.js";
import {
  deriveInlineChildId,
  formatInlineRecoveryMarker,
  formatPendingMarker,
  replacePendingMarker,
} from "./review/comment-marker.js";
import type { TerminalReviewResult } from "./review/comment-marker.js";
import type { InlineRecoveryState } from "./review/comment-marker.js";
import { dispatchRulesDirect as dispatchRulesDirectReal } from "./review/direct-dispatch.js";
import { dispatchRules as dispatchRulesReal } from "./review/dispatch.js";
import { orchestrate as orchestrateReal, renderSummary } from "./review/orchestrate.js";
import type { OrchestrationResult } from "./review/orchestrate.js";
import type { DispatchResult, ReviewDispatchInput } from "./review/types.js";
import { extractRelatedWork, reconcileRelatedWork, relatedWorkFingerprint, safeRelatedWorkIdentifier } from "./review/related-work.js";
import type { RelatedWorkItem } from "./review/related-work.js";
import { loadRules as loadRulesReal } from "./rules/loader.js";
import type { LoadResult } from "./rules/loader.js";
import { parseRepositoryRef, parseReviewTarget } from "./target/review-target.js";
import type { RepositoryRef } from "./target/types.js";
import type { BotComment, PullRequestInfo, VcsAdapter } from "./vcs/adapter.js";
import { AmbiguousInlinePublishError, validateInlinePublishOutcomes } from "./vcs/adapter.js";

export type { CommandArgs, PollArgs, ReviewArgs, SharedReviewOptions } from "./cli-args.js";
export { parseCommandArgs } from "./cli-args.js";

/**
 * Parsed configuration for the `review` command, per SPEC.md's API Contract.
 */
export type CliArgs = Omit<ReviewArgs, "command">;

/**
 * Parses CLI argv into a CliArgs object for the `review` command.
 *
 * AC-1.1: `review --pr 42` parses to the fully-defaulted CliArgs object.
 * AC-1.2: a missing `--pr` throws an Error naming `--pr` as required, which
 * `main()` translates into exit code 1 with a human-readable message.
 *
 * `--rules-dir <path>` (default `.review/rules`): a REPO-RELATIVE path,
 * NOT a local filesystem path by default. `review()` passes it to
 * `vcsAdapter.getRuleFilesFromBase(locator, pr.baseSha, rulesDir)`, which fetches
 * `<rulesDir>/*.md` as it exists on the PR's BASE branch via the VCS
 * provider's API (`gh api` for GitHub) — never from whatever happens to be
 * checked out locally. This is what closes the rule-file trust-boundary gap
 * described in ADR-002: a PR cannot introduce or modify a rule that affects
 * its own review, and this holds true wherever the CLI runs — a developer's
 * own terminal, or any CI system with `gh` authenticated — without any
 * bespoke `git worktree`/checkout ceremony around it. See
 * `--trust-local-rules` below for the escape hatch back to the old
 * local-filesystem behavior.
 *
 * `--trust-local-rules` (default false): skips the base-branch-via-API
 * fetch entirely and reverts `--rules-dir` to its OLD meaning — a literal
 * local filesystem path, resolved relative to the current working
 * directory, read directly via `loadRules()`. This is primarily a
 * developer convenience for iterating on a rule file you haven't committed
 * yet (the base-branch fetch can only ever see committed content); it is
 * NOT a security bypass to reach for casually; for the `review` command's
 * actual PR-review flow — its whole purpose — leaving it off is what
 * enforces the trust boundary in the first place.
 */
export function parseArgs(argv: string[]): CliArgs {
  const parsed = parseCommandArgs(argv[0] === "review" ? argv : ["review", ...argv]);
  if (parsed.command !== "review") {
    throw new Error("parseArgs only supports the review command");
  }
  const { command, stateDir, ...reviewArgs } = parsed;
  void command;
  const result: CliArgs = stateDir === undefined ? reviewArgs : { ...reviewArgs, stateDir };
  Object.defineProperty(result, "vcsExplicit", {
    value: parsed.vcsExplicit,
    enumerable: false,
  });
  return result;
}

/**
 * Injectable dependencies for `review()` — mirrors the dependency-injection
 * seam `dispatchRules` (Task 5) uses for its session factory. Each defaults
 * to the real implementation; tests override some/all of them so `review()`
 * never has to shell out to `gh`, hit the network, or construct a real pi
 * SDK session.
 */
export interface ReviewDependencies {
  resolveConfig: (args: CliArgs) => ResolvedConfig;
  loadRules: (rulesDir: string, includeBuiltin: boolean) => Promise<LoadResult>;
  dispatchRules: (input: ReviewDispatchInput) => Promise<DispatchResult>;
  orchestrate: (
    dispatchResult: DispatchResult,
    diff?: string,
    options?: {
      inline?: boolean;
      suggestions?: boolean;
      relatedWork?: readonly RelatedWorkItem[];
      contextUnavailable?: readonly string[];
    },
  ) => OrchestrationResult;
  createStateStore?: typeof createConversationStateStore;
  publicationHooks?: PublicationExecutorHooks;
  now?: () => string;
}

function resolveRepositoryForReview(config: ResolvedConfig, pr: PullRequestInfo): RepositoryRef {
  if (config.locator.kind === "repository") return config.locator.repo;
  if (typeof config.repo === "string" && config.repo.length > 0) {
    return parseRepositoryRef(config.repo, config.vcs);
  }
  if (typeof pr.url === "string" && pr.url.length > 0) {
    try {
      return parseReviewTarget(pr.url).repo;
    } catch (error) {
      throw new Error("Cannot resolve a canonical repository identity for this review", { cause: error });
    }
  }
  throw new Error("Cannot resolve a canonical repository identity for this review");
}

function repositoryForReview(config: ResolvedConfig, pr: PullRequestInfo): RepositoryRef {
  return canonicalStateRepositoryIdentity(resolveRepositoryForReview(config, pr));
}

function storeBindingOf(store: ConversationStateStore | undefined, repository: RepositoryRef) {
  if (store !== undefined) return store.repositoryBinding;
  return {
    provider: repository.provider,
    repositoryDigest: repositoryDigestOf(repository),
  };
}

function reviewUrlFor(repository: RepositoryRef, reviewNumber: number): string {
  return `${repository.canonicalUrl}${repository.provider === "gitlab" ? "/-/merge_requests/" : "/pull/"}${reviewNumber}`;
}

function canonicalizeReviewIdentity(repository: RepositoryRef, identity: ReviewIdentity): ReviewIdentity {
  return {
    provider: repository.provider,
    repositoryDigest: computeRepositoryDigest(repository.provider, repository.canonicalUrl),
    reviewNumber: identity.reviewNumber,
    reviewId: identity.reviewId,
    url: reviewUrlFor(repository, identity.reviewNumber),
  };
}

function repositoryDigestOf(repository: RepositoryRef): string {
  return createHash("sha256").update(repository.canonicalUrl, "utf8").digest("hex");
}

function reviewIdentityFor(repository: RepositoryRef, pr: PullRequestInfo): ReviewIdentity {
  const provider = repository.provider;
  return {
    provider,
    repositoryDigest: computeRepositoryDigest(provider, repository.canonicalUrl),
    reviewNumber: Number(pr.id),
    reviewId: pr.reviewId ?? String(pr.id),
    url: reviewUrlFor(repository, Number(pr.id)),
  };
}

async function resolveConversationIdentity(
  adapter: Partial<ConversationAdapter>,
  repository: RepositoryRef,
  pr: PullRequestInfo,
): Promise<{ identity?: ReviewIdentity; unavailable?: "discussion" }> {
  if (typeof adapter.resolveReviewIdentity === "function") {
    try {
      return {
        identity: canonicalizeReviewIdentity(repository, await adapter.resolveReviewIdentity(repository, Number(pr.id))),
      };
    } catch (error) {
      rethrowIfIntegrityFailure(error);
      return { unavailable: "discussion" };
    }
  }
  return { identity: reviewIdentityFor(repository, pr) };
}

function reviewOptionsSnapshot(config: ResolvedConfig): FindingReviewOptions {
  return {
    advisor: config.advisor,
    suggestions: config.suggestions,
    disableBuiltinRule: config.disableBuiltinRule,
    trustLocalRules: config.trustLocalRules,
    rulesDir: config.rulesDir,
    dispatch: config.dispatch,
    ...(config.model === undefined ? {} : { model: config.model }),
  };
}

function openConversationStore(
  createStore: typeof createConversationStateStore,
  config: ResolvedConfig,
  repository: RepositoryRef,
): ConversationStateStore | undefined {
  try {
    return createStore({
      root: selectConversationStateRoot({ explicitStateDir: config.stateDir }),
      repository,
    });
  } catch (error) {
    rethrowIfIntegrityFailure(error);
    return undefined;
  }
}

async function fetchReviewDiscussion(
  adapter: Partial<ConversationAdapter>,
  identity: ReviewIdentity,
): Promise<{ threads: readonly ReviewThreadSnapshot[]; unavailable?: "discussion" }> {
  if (typeof adapter.listReviewThreads !== "function" || typeof adapter.getReviewThread !== "function") {
    return { threads: [] };
  }
  try {
    const summaries = [];
    let pageToken = undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_REVIEW_CONTEXT_PAGES) {
        return { threads: [], unavailable: "discussion" };
      }
      const page = await adapter.listReviewThreads(identity, pageToken);
      summaries.push(...page.threads);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    if (typeof adapter.listReviewEvents === "function") {
      let eventToken = undefined;
      let eventPages = 0;
      do {
        eventPages += 1;
        if (eventPages > MAX_REVIEW_CONTEXT_PAGES) {
          return { threads: [], unavailable: "discussion" };
        }
        const page = await adapter.listReviewEvents(identity, undefined, eventToken);
        eventToken = page.nextPageToken;
      } while (eventToken !== undefined);
    }

    const threads: ReviewThreadSnapshot[] = [];
    for (const summary of summaries) {
      threads.push(await adapter.getReviewThread(identity, summary.threadId));
    }
    return { threads };
  } catch (error) {
    rethrowIfIntegrityFailure(error);
    return { threads: [], unavailable: "discussion" };
  }
}

async function loadOptionalReviewContext(options: {
  readonly adapter: Partial<ConversationAdapter>;
  readonly store: ConversationStateStore | undefined;
  readonly missingStore: boolean;
  readonly repository: RepositoryRef;
  readonly pr: PullRequestInfo;
  readonly diff: string;
  readonly stateRoot?: string;
  readonly identity?: ReviewIdentity;
  readonly identityUnavailable?: "discussion";
}): Promise<{
  conversationContext?: { text: string; digest: string };
  fingerprint?: string;
  unavailable: string[];
}> {
  const unavailable: string[] = [];
  const resolved = options.identity !== undefined || options.identityUnavailable !== undefined
    ? { identity: options.identity, unavailable: options.identityUnavailable }
    : await resolveConversationIdentity(options.adapter, options.repository, options.pr);
  if (resolved.unavailable !== undefined) unavailable.push("discussion");
  const discussion = resolved.identity === undefined
    ? { threads: [] as const, unavailable: "discussion" as const }
    : await fetchReviewDiscussion(options.adapter, resolved.identity);
  if (discussion.unavailable !== undefined && !unavailable.includes("discussion")) unavailable.push("discussion");

  let memories: readonly import("./conversation/state-schema.js").MemoryCreateEntry[] = [];
  let pending: readonly import("./conversation/state-schema.js").PendingClarification[] = [];
  let directions: readonly import("./conversation/state-schema.js").PendingDirection[] = [];
  if (options.missingStore || options.store === undefined) {
    unavailable.push("memory");
  } else {
    try {
      const snapshot = await options.store.readContextSnapshot();
      memories = snapshot.memories;
      pending = snapshot.pending.clarifications.filter((item) => item.reviewNumber === Number(options.pr.id));
      directions = snapshot.pending.directions.filter((item) => item.reviewNumber === Number(options.pr.id));
    } catch (error) {
      rethrowIfIntegrityFailure(error);
      unavailable.push("memory");
    }
  }

  const changedLines = changedFiles(options.diff).map((file) => ({ file }));
  const built = buildConversationContext({
    currentHeadSha: options.pr.headSha,
    changedLines,
    threads: discussion.threads,
    directions,
    pending,
    memories,
  });
  const fingerprintItems = {
    selectedDiscussion: built.selectedIds.flatMap((id) => {
      const thread = discussion.threads.find((item) => item.threadId === id);
      if (thread === undefined) return [];
      return (thread.events ?? [])
        .filter((event) => event.kind !== "thread-resolution")
        .map((event) => ({ id: thread.threadId, revisionId: event.revisionId }));
    }),
    pending: pending.map((item) => ({ id: item.id, headSha: item.headSha })),
    directions: directions.map((item) => ({ id: item.id, headSha: item.headSha })),
    memories: memories.map((item) => ({ id: item.id, revision: item.at })),
    stateRootDomain: options.stateRoot === undefined ? "" : stateRootDomainIdentifier(options.stateRoot),
  };
  const hasFingerprint = fingerprintItems.selectedDiscussion.length > 0 ||
    fingerprintItems.pending.length > 0 || fingerprintItems.directions.length > 0 ||
    fingerprintItems.memories.length > 0;
  return {
    ...(built.text.length > 0 ? { conversationContext: { text: built.text, digest: built.digest } } : {}),
    ...(hasFingerprint && options.stateRoot !== undefined
      ? { fingerprint: conversationDedupFingerprint(fingerprintItems) }
      : {}),
    unavailable,
  };
}

// Named exit codes (Task 8 review fix #3; refined by review fix #1) — see
// SPEC.md's exit code contract: 0 = clean run, 1 = fatal (a PRE-WRITE
// failure: zero rules loaded, or a VCS fetch — getPullRequest/
// findBotComment/getDiff/getRuleFilesFromBase — rejects, before any comment
// write is attempted), 2 = partial (a comment write WAS attempted/happened,
// but something also failed — whether that's a rule failing to load, or
// every loaded rule failing at dispatch time).
const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_PARTIAL = 2;

interface StatusLog {
  status: "skipped" | "posted" | "partial";
  findingsCount: number;
  rulesRun: string[];
  rulesFailed: string[];
  // Design-review #13: distinguishes WHY a run was skipped. Only present for
  // the --max-diff-chars ceiling skip ("diff-too-large"); the original dedup
  // skip keeps its exact pre-existing shape (no reason field) so anyone
  // already parsing that line sees no change.
  reason?: string;
  // Task 8 review fix #1: only present (and non-empty) when one or more
  // rule files failed to LOAD (bad/missing frontmatter etc.) — distinct
  // from `rulesFailed`, which is dispatch-time-only. Omitted entirely
  // (via JSON.stringify dropping `undefined` values) when there were no
  // load errors, so the "skipped"/all-succeeded log shape is unchanged.
  loadErrors?: string[];
}

// Task 8 review fix #2: the final structured status line is always the
// LAST line this process writes to stdout, prefixed with a greppable
// marker. This matters specifically for `--dry-run`, where a multi-line
// Markdown comment preview is ALSO printed to stdout earlier in the same
// invocation — without a marker, a CI log scraper has no reliable way to
// tell the human-readable preview apart from the one line it actually
// wants to parse. Simpler than routing dry-run output to stderr (which
// would make local `--dry-run` previews awkward to read/pipe), and it
// keeps the JSON status line's own shape untouched for anyone already
// parsing it directly off the end of stdout.
const STATUS_LOG_PREFIX = "TGD_REVIEW_RESULT: ";

function logStatus(log: StatusLog): void {
  console.log(`${STATUS_LOG_PREFIX}${JSON.stringify(log)}`);
}

function selectedFallbackIds(action: PublicationAction): Set<string> {
  const ids = new Set<string>();
  for (const child of action.children) {
    if (child.kind !== "fallback" || child.status !== "fallback-selected") continue;
    const inline = child.replacesId === undefined
      ? undefined
      : action.children.find((entry) => entry.id === child.replacesId);
    ids.add(inline === undefined ? child.replacesId ?? child.id : clientIdOf(inline));
  }
  return ids;
}

function clientIdOf(child: PublicationChild): string {
  return child.placement.kind === "inline" && child.placement.clientId !== undefined
    ? child.placement.clientId
    : child.id;
}

function composeFrozenSummary(action: PublicationAction, fallbackIds: ReadonlySet<string>, marker: string): string {
  const summary = action.children.find((child) => child.kind === "summary");
  if (summary === undefined) throw new Error("publication manifest is missing the summary child");
  const extras = action.children
    .filter((child) => {
      if (child.kind !== "fallback") return false;
      if (child.status === "fallback-selected") return true;
      const inline = child.replacesId === undefined
        ? undefined
        : action.children.find((entry) => entry.id === child.replacesId);
      const key = inline === undefined ? child.replacesId : clientIdOf(inline);
      return key !== undefined && fallbackIds.has(key);
    })
    .map((child) => child.body);
  const suffix = extras.length === 0 ? marker : `${extras.join("\n\n")}\n\n${marker}`;
  return extras.length === 0 ? `${summary.body}${summary.body.endsWith("\n") ? "" : "\n\n"}${marker}` :
    `${summary.body.trimEnd()}\n\n${suffix}`;
}

function sameTerminalResult(
  actual: TerminalReviewResult | undefined,
  expected: TerminalReviewResult,
): boolean {
  return actual?.status === expected.status &&
    actual.findingsCount === expected.findingsCount &&
    actual.exitCode === expected.exitCode &&
    actual.rulesRun.length === expected.rulesRun.length &&
    actual.rulesRun.every((rule, index) => rule === expected.rulesRun[index]) &&
    actual.rulesFailed.length === expected.rulesFailed.length &&
    actual.rulesFailed.every((rule, index) => rule === expected.rulesFailed[index]) &&
    (actual.loadErrors?.length ?? 0) === (expected.loadErrors?.length ?? 0) &&
    (actual.loadErrors ?? []).every(
      (error, index) => error === expected.loadErrors?.[index],
    );
}

// Task 8 review fix #1: renders a visible section naming every rule file
// that failed to LOAD (as opposed to `orchestrate.ts`'s own "Rules that
// failed" section, which only covers dispatch-time failures) — mirrors
// orchestrate.ts's renderFailedRulesSection formatting for consistency.
function renderLoadErrorsSection(loadErrors: LoadResult["errors"]): string {
  const items = loadErrors.map((e) => `- \`${e.sourcePath}\`: ${e.message}`).join("\n");
  return `### ⚠️ Rule files that failed to load\n\nThe following rule files were skipped because they failed to load:\n\n${items}`;
}

// Review fix (defense-in-depth, non-blocking hardening item): `file.path`
// comes from the VCS provider's API response (GitHub's Contents API `name`
// field for GitHubAdapter) and is used to build a filesystem write path
// under the temp rules dir. Not currently exploitable — per ADR-002's own
// threat model the base branch is not attacker-controlled, and
// GitHubAdapter's directory-listing `name` field can't itself contain a
// path separator — but this is cheap, good practice, and consistent with
// this project's existing defense-in-depth posture (e.g. --pr's format
// validation in parseArgs, added despite not being currently exploitable
// either). Guards against a "zip slip"-style escape: resolves `file.path`
// against `tempDir` and rejects anything whose resolved location isn't
// actually inside `tempDir` (relative traversal via `../`, or an absolute
// path that ignores `tempDir` entirely).
function resolveSafeRuleFilePath(tempDir: string, filePath: string): string | null {
  const dest = path.resolve(tempDir, filePath);
  const relative = path.relative(tempDir, dest);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return dest;
}

// Matches Node's child_process "output exceeded maxBuffer" rejection — the
// shape realExecGh's capped execFile produces when a diff is bigger than its
// buffer. Checked by CODE first (stable across Node versions since 12), with
// the message as a fallback for exec wrappers that re-throw plain Errors.
// Deliberately narrow: a network/auth failure from getDiff must NOT be
// mistaken for "diff too large" — only this specific shape converts to the
// --max-diff-chars skip; everything else stays fatal.
function isOutputBufferExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer .*exceeded/i.test(err.message);
}

/**
 * ADR-002 / CLI-native fix: resolves this run's rule files, honoring
 * `config.trustLocalRules`:
 *
 *  - Default (`trustLocalRules: false`): rules are sourced from the PR's
 *    BASE branch via `vcsAdapter.getRuleFilesFromBase` — never the PR's
 *    own, potentially attacker-controlled checkout, and never a literal
 *    local filesystem path. The fetched files are written into a fresh,
 *    isolated temp directory (same `mkdtemp`/`os.tmpdir()` convention
 *    `dispatch.ts`'s `createIsolatedSessionCwd` already uses for its own
 *    tool-restricted session cwd) so `loadRules()` — which only knows how
 *    to read a real filesystem directory — can keep working unchanged. The
 *    temp directory is always removed in a `finally` block, on both the
 *    success and error path, mirroring `dispatch.ts`'s own cleanup
 *    discipline.
 *  - `--trust-local-rules` (`trustLocalRules: true`): reverts to the OLD
 *    behavior — reads `config.rulesDir` directly off the local filesystem.
 *    See `parseArgs`'s JSDoc for the full rationale (developer convenience,
 *    not a security bypass to reach for lightly).
 */
async function loadRulesForReview(
  config: ResolvedConfig,
  pr: PullRequestInfo,
  loadRulesFn: ReviewDependencies["loadRules"],
): Promise<LoadResult> {
  const includeBuiltin = !config.disableBuiltinRule;

  if (config.trustLocalRules) {
    return loadRulesFn(config.rulesDir, includeBuiltin);
  }

  const ruleFiles = await config.vcsAdapter.getRuleFilesFromBase(
    config.locator,
    pr.baseSha,
    config.rulesDir,
  );
  const tempRulesDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-rules-"));
  try {
    // Written concurrently; v1's rule files are always a flat listing (see
    // GitHubAdapter.getRuleFilesFromBase's own doc comment), but each
    // destination's parent dir is still created defensively in case a
    // future adapter's `path` ever contains a subdirectory component.
    await Promise.all(
      ruleFiles.map(async (file) => {
        const dest = resolveSafeRuleFilePath(tempRulesDir, file.path);
        if (dest === null) {
          // Defense-in-depth: skip and warn, don't throw — one bad entry
          // must not abort the whole run, same "warn, don't throw"
          // philosophy used elsewhere in this file and in dispatch.ts.
          console.warn(
            `tgd-review-agent: skipping rule file with unsafe path "${file.path}" (resolves outside the rules directory)`,
          );
          return;
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, file.content, "utf-8");
      }),
    );
    return await loadRulesFn(tempRulesDir, includeBuiltin);
  } finally {
    // Never let a cleanup failure mask the real result/error above, or
    // itself throw out of loadRulesForReview — just warn, matching
    // dispatch.ts's existing "warn, don't throw" cleanup pattern.
    await rm(tempRulesDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(
        `tgd-review-agent: failed to remove temp rules directory ${tempRulesDir} (${(err as Error).message})`,
      );
    });
  }
}

async function bindPublishedFindingIdentities(
  store: ConversationStateStore,
  published: PublicationAction,
  preparedFindings?: readonly FindingLedgerEntry[],
): Promise<void> {
  const existing = (await store.readContextSnapshot()).findings;
  const prepared = preparedFindings ?? existing;
  const bound: FindingLedgerEntry[] = [];
  for (const child of published.children) {
    if (child.kind !== "inline" || child.identity === undefined) continue;
    const source = prepared.find((entry) => entry.id === child.id) ?? existing.find((entry) => entry.id === child.id);
    if (source === undefined || source.identity !== undefined) continue;
    if (existing.find((entry) => entry.id === source.id)?.identity !== undefined) continue;
    bound.push(bindFindingLedgerIdentity(source, child.identity));
  }
  if (bound.length === 0) return;
  await store.transact((tx) => {
    for (const entry of bound) tx.appendFinding(entry);
  });
}

async function publishReviewFromManifest(options: {
  readonly action: PublicationAction;
  readonly store: ConversationStateStore;
  readonly config: ResolvedConfig;
  readonly pr: PullRequestInfo;
  readonly configHash: string;
  readonly botComment: BotComment | null;
  readonly provider: "github" | "gitlab";
  readonly hooks?: PublicationExecutorHooks;
  readonly now: () => string;
  readonly orchestration?: OrchestrationResult;
  readonly loadErrors?: LoadResult["errors"];
  readonly buildBody?: (
    o: OrchestrationResult,
    failedIds: ReadonlySet<string>,
    marker?: string,
    providerLimit?: boolean,
  ) => string;
  readonly terminalResult?: TerminalReviewResult;
  readonly inlineRecovery?: InlineRecoveryState;
  readonly preparedFindings?: readonly FindingLedgerEntry[];
  readonly identity?: ReviewIdentity;
}): Promise<number> {
  const {
    store, config, pr, configHash, provider, hooks, now, orchestration, buildBody,
  } = options;
  const reviewIdentity = options.identity ?? reviewIdentityFor(repositoryForReview(config, pr), pr);
  let botComment = options.botComment;
  const summaryPlacement = options.action.children.find((child) => child.kind === "summary")?.placement;
  const terminalResult = options.terminalResult ??
    (summaryPlacement?.kind === "summary" ? summaryPlacement.terminalResult : undefined) ??
    botComment?.pendingState?.terminalResult ?? {
      status: "posted" as const,
      findingsCount: options.action.children.filter((child) => child.kind === "inline").length,
      rulesRun: [],
      rulesFailed: [],
      exitCode: 0 as const,
    };
  const inlineRecovery = options.inlineRecovery ?? botComment?.pendingState?.inlineRecovery;
  const githubInlineResults = new Map<string, PublicationWriteResult>();
  let staleCleaned = false;

  const bodyFor = (action: PublicationAction, failedIds: ReadonlySet<string>, marker: string): string => {
    if (orchestration !== undefined && buildBody !== undefined) {
      return buildBody(orchestration, failedIds, marker);
    }
    return composeFrozenSummary(action, failedIds, marker);
  };

  const summaryIdentityOf = (comment: BotComment) => ({
    provider,
    commentId: comment.id,
    url: provider === "github"
      ? `${repositoryUrl(config, pr)}/pull/${Number(pr.id)}#issuecomment-${comment.id}`
      : `${repositoryUrl(config, pr)}/-/merge_requests/${Number(pr.id)}#note_${comment.id}`,
  });

  async function cleanStaleThreads(): Promise<void> {
    if (staleCleaned) return;
    staleCleaned = true;
    try {
      const resolved = await config.vcsAdapter.resolveStaleReviewThreads(config.locator);
      if (resolved > 0) {
        console.log(`tgd-review-agent: resolved ${resolved} stale inline comment thread(s) from previous runs`);
      }
    } catch (err) {
      console.warn(
        `tgd-review-agent: could not resolve stale inline comment threads (${(err as Error).message}); ` +
          `continuing — old threads stay expanded but this run is unaffected`,
      );
    }
  }

  function toInlineComment(child: PublicationChild) {
    const markerSuffix = provider === "gitlab" ? `\n${child.marker}` : "";
    return {
      clientId: clientIdOf(child),
      path: child.placement.kind === "inline" ? child.placement.file : "",
      line: child.placement.kind === "inline" ? child.placement.line : 1,
      ...(child.placement.kind === "inline" && child.placement.startLine !== undefined
        ? { startLine: child.placement.startLine }
        : {}),
      position: child.placement.kind === "inline" && child.placement.position !== undefined
        ? child.placement.position
        : {
            oldPath: child.placement.kind === "inline" ? child.placement.file : "",
            newPath: child.placement.kind === "inline" ? child.placement.file : "",
            start: { type: "new" as const, newLine: child.placement.kind === "inline" ? child.placement.line : 1 },
            end: { type: "new" as const, newLine: child.placement.kind === "inline" ? child.placement.line : 1 },
            sameHunk: true as const,
          },
      body: `${child.body}${markerSuffix}`,
    };
  }

  async function publishInlines(
    action: PublicationAction,
    children: readonly PublicationChild[],
  ): Promise<Map<string, PublicationWriteResult>> {
    const comments = children.map(toInlineComment);
    const results = new Map<string, PublicationWriteResult>();
    try {
      const outcomes = await config.vcsAdapter.createInlineReview(
        config.locator,
        pr.headSha,
        comments,
        inlineRecovery,
      );
      try {
        const shapesValid = (outcomes as readonly unknown[]).every((outcome) => {
          if (typeof outcome !== "object" || outcome === null) return false;
          const candidate = outcome as Record<string, unknown>;
          return typeof candidate.clientId === "string" &&
            (candidate.status === "posted" || candidate.status === "failed") &&
            (candidate.reason === undefined || typeof candidate.reason === "string");
        });
        if (!shapesValid) throw new Error("malformed inline publish outcome");
        const validated = validateInlinePublishOutcomes(
          comments,
          outcomes,
          config.locator.kind === "repository"
            ? { repo: repositoryForReview(config, pr), reviewNumber: config.locator.number }
            : undefined,
        );
        for (const child of children) {
          const outcome = validated.find((entry) => entry.clientId === clientIdOf(child));
          results.set(child.id, outcome?.status === "posted"
            ? { status: "posted", identity: outcome.identity }
            : { status: "failed" });
        }
      } catch (err) {
        console.warn(
          `tgd-review-agent: inline review returned invalid outcomes (${(err as Error).message}); ` +
            `rewriting the summary comment to carry every inline finding instead`,
        );
        for (const child of children) results.set(child.id, { status: "failed" });
      }
    } catch (err) {
      if (err instanceof AmbiguousInlinePublishError && inlineRecovery !== undefined) {
        console.warn(
          `tgd-review-agent: GitHub may have accepted the inline review (${err.message}); ` +
            `not duplicating those findings into the summary; a later run will reconcile markers`,
        );
        if (botComment === null) throw new Error("Review publication is missing the summary identity");
        const ambiguousCheckpoint = await config.vcsAdapter.upsertComment(
          config.locator,
          bodyFor(action, new Set(children.map((child) => clientIdOf(child))), formatPendingMarker({
            phase: "ambiguous",
            headSha: pr.headSha,
            configHash,
            noteId: botComment.id,
            terminalResult,
            inlineRecovery,
          })),
          botComment,
        );
        if (ambiguousCheckpoint.id !== botComment.id || ambiguousCheckpoint.pendingState?.phase !== "ambiguous") {
          throw new Error("Could not persist ambiguous inline recovery checkpoint");
        }
        throw Object.assign(err, { publicationHalt: true });
      }
      console.warn(
        `tgd-review-agent: could not post inline review comments (${(err as Error).message}); ` +
          `rewriting the summary comment to carry every finding instead`,
      );
      throw err;
    }
    return results;
  }

  const writer: PublicationWriter = {
    async lookupChild(child) {
      if (config.vcsAdapter.findPublishedMarker !== undefined) {
        const found = await config.vcsAdapter.findPublishedMarker(config.locator, child.marker);
        if (found !== null) return found;
      }
      const findBotChildMarker = (config.vcsAdapter as VcsAdapter & Partial<ConversationAdapter>).findBotChildMarker;
      const parsed = parseChildMarker(child.marker)
        ?? parseChildMarker((child.body.split(/\r?\n/u).at(-1) ?? "").trim());
      if (typeof findBotChildMarker === "function" && parsed !== null) {
        const found = await findBotChildMarker(reviewIdentity, {
          provider: reviewIdentity.provider,
          repositoryDigest: parsed.repositoryDigest,
          reviewNumber: parsed.reviewNumber,
          kind: parsed.kind,
          parentId: parsed.parentId,
          childId: parsed.childId,
          contentDigest: parsed.contentDigest,
        });
        if (found !== null) return found;
      }
      if (
        child.kind === "summary" &&
        botComment !== null &&
        botComment.pendingState?.headSha === pr.headSha &&
        botComment.pendingState.configHash === configHash
      ) {
        return summaryIdentityOf(botComment);
      }
      return null;
    },
    async writeChild(child, action) {
      if (child.kind === "summary") {
        const inlineChildren = action.children.filter((entry) => entry.kind === "inline");
        const noFallbackIds = new Set<string>();
        const allInlineIds = new Set(inlineChildren.map((entry) => clientIdOf(entry)));
        if (inlineChildren.length > 0 && provider === "github") {
          if (inlineChildren.length > 100) throw new Error("GitHub inline review exceeds the safe atomic comment count");
          const payloadChars = inlineChildren.reduce((total, entry, index) =>
            total + entry.body.length + (inlineRecovery?.children[index]?.marker.length ?? entry.marker.length) + 256, 0);
          if (payloadChars > 1_000_000 || inlineChildren.some((entry, index) =>
            entry.body.length + (inlineRecovery?.children[index]?.marker.length ?? entry.marker.length) + 128 > 65_536)) {
            throw new Error("GitHub inline review exceeds the safe atomic payload size");
          }
        }
        const writtenSummary = await config.vcsAdapter.upsertComment(
          config.locator,
          bodyFor(action, noFallbackIds, formatPendingMarker({ phase: "publishing", headSha: pr.headSha, configHash })),
          botComment,
        );
        if (
          !writtenSummary ||
          typeof writtenSummary.id !== "string" ||
          writtenSummary.id.length === 0 ||
          writtenSummary.lastReviewedSha !== "" ||
          writtenSummary.reviewedConfig !== "" ||
          writtenSummary.pendingState?.phase !== "publishing" ||
          writtenSummary.pendingState.headSha !== pr.headSha ||
          writtenSummary.pendingState.configHash !== configHash
        ) {
          throw new Error("The VCS adapter did not return the exact identity of the pending summary note");
        }
        let summaryIdentity = writtenSummary;
        botComment = writtenSummary;
        if (inlineChildren.length > 0) {
          const checkpoint = await config.vcsAdapter.upsertComment(
            config.locator,
            bodyFor(action, allInlineIds, formatPendingMarker({
              phase: "ready",
              headSha: pr.headSha,
              configHash,
              noteId: writtenSummary.id,
              terminalResult,
              inlineRecovery,
            })),
            writtenSummary,
          );
          if (
            checkpoint.id !== writtenSummary.id ||
            checkpoint.lastReviewedSha !== "" ||
            checkpoint.reviewedConfig !== "" ||
            checkpoint.pendingState?.phase !== "ready" ||
            checkpoint.pendingState.headSha !== pr.headSha ||
            checkpoint.pendingState.configHash !== configHash ||
            checkpoint.pendingState.noteId !== writtenSummary.id ||
            !sameTerminalResult(checkpoint.pendingState.terminalResult, terminalResult)
          ) {
            throw new Error("The VCS adapter could not confirm the exact ready recovery checkpoint");
          }
          summaryIdentity = checkpoint;
          botComment = checkpoint;
        }
        await cleanStaleThreads();
        return { status: "posted", identity: summaryIdentityOf(summaryIdentity) };
      }
      if (child.kind === "inline") {
        await cleanStaleThreads();
        if (provider === "github") {
          const cached = githubInlineResults.get(child.id);
          if (cached !== undefined) return cached;
          const pending = action.children.filter((entry) =>
            entry.kind === "inline" && entry.status === "pending" && !githubInlineResults.has(entry.id));
          const posted = await publishInlines(action, pending);
          for (const [id, result] of posted) githubInlineResults.set(id, result);
          return githubInlineResults.get(child.id) ?? { status: "failed" };
        }
        const posted = await publishInlines(action, [child]);
        return posted.get(child.id) ?? { status: "failed" };
      }
      return { status: "failed" };
    },
  };

  const finalizePublishedSummary = async (action: PublicationAction): Promise<void> => {
    const finalFallbackIds = selectedFallbackIds(action);
    if (botComment === null) {
      const postedSummary = action.children.find((child) => child.kind === "summary" && child.identity !== undefined);
      if (postedSummary?.identity !== undefined) {
        botComment = {
          id: postedSummary.identity.commentId,
          body: postedSummary.body,
          lastReviewedSha: "",
          reviewedConfig: "",
        };
      }
    }
    if (botComment === null) {
      if (action.state === "completed" || action.state === "superseded") return;
      throw new Error("Review publication is missing the summary identity");
    }
    if (action.children.some((child) => child.kind === "inline")) {
      const selectiveCheckpoint = await config.vcsAdapter.upsertComment(
        config.locator,
        bodyFor(action, finalFallbackIds, formatPendingMarker({
          phase: "ready",
          headSha: pr.headSha,
          configHash,
          noteId: botComment.id,
          terminalResult,
        })),
        botComment,
      );
      if (
        selectiveCheckpoint.id !== botComment.id ||
        selectiveCheckpoint.lastReviewedSha !== "" ||
        selectiveCheckpoint.reviewedConfig !== "" ||
        selectiveCheckpoint.pendingState?.phase !== "ready" ||
        selectiveCheckpoint.pendingState.headSha !== pr.headSha ||
        selectiveCheckpoint.pendingState.configHash !== configHash ||
        selectiveCheckpoint.pendingState.noteId !== botComment.id ||
        !sameTerminalResult(selectiveCheckpoint.pendingState.terminalResult, terminalResult)
      ) {
        throw new Error("The VCS adapter could not confirm the exact selective recovery checkpoint");
      }
      botComment = selectiveCheckpoint;
    }
    const finalizedSummary = await config.vcsAdapter.upsertComment(
      config.locator,
      bodyFor(action, finalFallbackIds, formatMarker(pr.headSha, configHash)),
      botComment,
    );
    if (
      !finalizedSummary ||
      finalizedSummary.id !== botComment.id ||
      finalizedSummary.lastReviewedSha !== pr.headSha ||
      finalizedSummary.reviewedConfig !== configHash
    ) {
      throw new Error("The VCS adapter could not confirm finalization of the exact completed summary note");
    }
    botComment = finalizedSummary;
  };

  let published: PublicationAction;
  try {
    published = await executePublication({
      store,
      action: options.action,
      writer,
      hooks,
      now,
      strategy: provider === "github" ? "github-atomic" : "gitlab-selective",
      finalize: finalizePublishedSummary,
    });
  } catch (error) {
    if (error instanceof AmbiguousInlinePublishError) {
      logStatus({
        status: "partial",
        findingsCount: terminalResult.findingsCount,
        rulesRun: [...terminalResult.rulesRun],
        rulesFailed: [...terminalResult.rulesFailed],
        reason: "inline-publication-ambiguous",
      });
      return EXIT_PARTIAL;
    }
    throw error;
  }

  await bindPublishedFindingIdentities(store, published, options.preparedFindings);

  if ((published.state === "completed" || published.state === "superseded") &&
    published.children.length === 0) {
    if (
      botComment !== null &&
      botComment.lastReviewedSha === pr.headSha &&
      botComment.reviewedConfig === configHash
    ) {
      logStatus({
        status: terminalResult.status,
        findingsCount: terminalResult.findingsCount,
        rulesRun: [...terminalResult.rulesRun],
        rulesFailed: [...terminalResult.rulesFailed],
        loadErrors: terminalResult.loadErrors === undefined ? undefined : [...terminalResult.loadErrors],
        ...(options.orchestration === undefined ? { reason: "recovered-pending-review" } : {}),
      });
      return terminalResult.exitCode;
    }
    throw new Error("completed publication is missing its frozen manifest; refusing to finalize a conservative ready summary");
  }

  const completed = published.state === "completed" ||
    published.children.every((child) => child.status === "posted" || child.status === "failed" ||
      child.status === "fallback-selected");
  if (!completed) return EXIT_PARTIAL;
  logStatus({
    status: terminalResult.status,
    findingsCount: terminalResult.findingsCount,
    rulesRun: [...terminalResult.rulesRun],
    rulesFailed: [...terminalResult.rulesFailed],
    loadErrors: terminalResult.loadErrors === undefined ? undefined : [...terminalResult.loadErrors],
    ...(options.orchestration === undefined ? { reason: "recovered-pending-review" } : {}),
  });
  return terminalResult.exitCode;
}

function repositoryUrl(config: ResolvedConfig, pr: PullRequestInfo): string {
  return repositoryForReview(config, pr).canonicalUrl;
}

/**
 * The actual `review` command flow: resolve config, fetch the PR + existing
 * bot comment, decide dedup, load + dispatch rules, orchestrate the merged
 * findings, and upsert (or dry-run print) the final comment.
 *
 * Kept separate from `main()`'s `process.exit()` call so it's directly
 * testable — see TASKS.md Task 8, AC-8.1 through AC-8.6.
 */
export async function review(
  args: CliArgs,
  deps: Partial<ReviewDependencies> = {},
): Promise<number> {
  const resolveConfigFn = deps.resolveConfig ?? resolveConfigReal;
  const loadRulesFn = deps.loadRules ?? loadRulesReal;
  // Task 3: both engines share one object-shaped CLI seam. The legacy adapter
  // remains positional internally until Task 4 migrates its orchestration.
  const dispatchRulesFn =
    deps.dispatchRules ??
    (args.dispatch === "legacy"
      ? (input: ReviewDispatchInput) =>
          dispatchRulesReal(
            input.rules,
            input.diff,
            input.useAdvisor,
            undefined,
            input.orchestratorModel,
            input.conversationContext,
          )
      : (input: ReviewDispatchInput) => dispatchRulesDirectReal(input, {}));
  const orchestrateFn = deps.orchestrate ?? orchestrateReal;
  const createStore = deps.createStateStore ?? createConversationStateStore;
  const publicationHooks = deps.publicationHooks;
  const now = deps.now ?? (() => new Date().toISOString());

  const config = resolveConfigFn(args);
  const pr = await config.vcsAdapter.getPullRequest(config.locator);
  const provider = config.locator.kind === "ambient"
    ? config.locator.provider
    : config.locator.repo.provider;
  const relatedWorkInput = {
    provider,
    reviewUrl: pr.url ?? "",
    title: pr.title,
    description: pr.description,
  };
  const extracted = extractRelatedWork(relatedWorkInput);

  // Design-review item #9: name the RESOLVED review target up front. The VCS
  // adapter infers owner/repo from ambient context (`gh`'s git-remote /
  // GH_REPO/GITHUB_REPOSITORY inference — see GitHubAdapter's class doc), so a
  // misconfigured environment could silently review the wrong repo. The PR's
  // canonical URL carries the resolved identity; logging it turns that failure
  // mode from silent into obvious. Printed BEFORE the dedup decision so even a
  // skipped run says what it inspected. (Goes to stdout like the other
  // informational output; the TGD_REVIEW_RESULT marker below exists precisely
  // so log scrapers can pick the status line out regardless.)
  console.log(`tgd-review-agent: reviewing ${pr.url ?? `PR #${config.pr}`} (head ${pr.headSha})`);

  const botComment = await config.vcsAdapter.findBotComment(config.locator);

  if (botComment?.invalidPendingState === true) {
    throw new Error(
      "Invalid pending review recovery metadata; refusing to dispatch or write",
    );
  }

  const repository = repositoryForReview(config, pr);
  let missingStore = false;
  let stateRoot: string | undefined;
  try {
    stateRoot = selectConversationStateRoot({ explicitStateDir: config.stateDir });
  } catch (error) {
    rethrowIfIntegrityFailure(error);
    missingStore = true;
  }
  const stateStore = missingStore ? undefined : openConversationStore(createStore, config, repository);
  if (stateStore === undefined) missingStore = true;

  let diff: string;
  try {
    diff = await config.vcsAdapter.getDiff(config.locator);
  } catch (err) {
    if (config.maxDiffChars === undefined || !isOutputBufferExceededError(err)) throw err;
    console.warn(
      `tgd-review-agent: the diff is too large to fetch within the VCS adapter's output buffer ` +
        `(${(err as Error).message}); with --max-diff-chars ${config.maxDiffChars} set, treating ` +
        `this as over the ceiling and skipping the review (nothing was posted).`,
    );
    logStatus({
      status: "skipped",
      findingsCount: 0,
      rulesRun: [],
      rulesFailed: [],
      reason: "diff-too-large",
    });
    return EXIT_OK;
  }
  if (config.maxDiffChars !== undefined && diff.length > config.maxDiffChars) {
    console.warn(
      `tgd-review-agent: diff is ${diff.length} chars, over the --max-diff-chars ceiling of ` +
        `${config.maxDiffChars}; skipping the review (nothing was posted). Raise or drop the ` +
        `flag to review this PR.`,
    );
    logStatus({
      status: "skipped",
      findingsCount: 0,
      rulesRun: [],
      rulesFailed: [],
      reason: "diff-too-large",
    });
    return EXIT_OK;
  }

  const resolvedIdentity = await resolveConversationIdentity(
    config.vcsAdapter as Partial<ConversationAdapter>,
    repository,
    pr,
  );
  const reviewIdentity = resolvedIdentity.identity ?? reviewIdentityFor(repository, pr);
  const loadedContext = await loadOptionalReviewContext({
    adapter: config.vcsAdapter as Partial<ConversationAdapter>,
    store: stateStore,
    missingStore,
    repository,
    pr,
    diff,
    stateRoot,
    identity: resolvedIdentity.identity,
    identityUnavailable: resolvedIdentity.unavailable,
  });
  const configHash = computeReviewConfigHash(config, relatedWorkFingerprint(extracted), loadedContext.fingerprint);
  const storeBinding = storeBindingOf(stateStore, repository);
  const publicationIdentity = reviewPublicationIdentity({
    repository: storeBinding,
    reviewNumber: Number(pr.id),
    headSha: pr.headSha,
    configHash,
  });
  if (stateStore !== undefined) {
    const existing = loadPublicationAction(
      (await stateStore.readContextSnapshot()).events,
      publicationIdentity,
    );
    if (
      existing !== undefined &&
      existing.children.length > 0 &&
      existing.children.every((child) => childIsTerminal(child, existing.children))
    ) {
      return publishReviewFromManifest({
        action: existing,
        store: stateStore,
        config,
        pr,
        configHash,
        botComment,
        provider,
        hooks: publicationHooks,
        now,
        identity: reviewIdentity,
      });
    }
  }

  // A ready checkpoint means a previous process already made the conservative
  // all-inline fallback durable before attempting any inline writes. If that
  // process died during the final marker update, finalize the exact same note
  // without dispatching again or risking duplicate inline POSTs.
  const recovery = botComment?.pendingState;
  if (
    botComment !== null &&
    (recovery?.phase === "ambiguous" || (recovery?.phase === "ready" && recovery.inlineRecovery !== undefined)) &&
    recovery.headSha === pr.headSha && recovery.configHash === configHash
  ) {
    if (recovery.noteId !== botComment.id || recovery.terminalResult === undefined || recovery.inlineRecovery === undefined || config.vcsAdapter.recoverInlineReview === undefined) {
      throw new Error("Invalid current inline recovery binding; refusing to dispatch or write");
    }
    if (config.dryRun) return EXIT_PARTIAL;
    const status = await config.vcsAdapter.recoverInlineReview(config.locator, recovery.inlineRecovery);
    if (status !== "complete") {
      // A durable ready/ambiguous checkpoint is written before the atomic POST.
      // An empty marker lookup after that point is not proof of rejection:
      // GitHub's REST/GraphQL views may lag an accepted write. Keep the full
      // fallback visible and permanently suppress reposting this action until
      // exact authenticated markers reconcile it.
      logStatus({ status: "partial", findingsCount: recovery.terminalResult.findingsCount, rulesRun: recovery.terminalResult.rulesRun, rulesFailed: recovery.terminalResult.rulesFailed, reason: status === "none" ? "inline-publication-awaiting-consistency" : "inline-publication-still-ambiguous" });
      return EXIT_PARTIAL;
    }
    const finalizedBody = `${recovery.inlineRecovery.noFallbackBody.trimEnd()}\n\n${formatMarker(pr.headSha, configHash)}`;
    const finalized = await config.vcsAdapter.upsertComment(config.locator, finalizedBody, botComment);
    if (finalized.id !== botComment.id || finalized.lastReviewedSha !== pr.headSha || finalized.reviewedConfig !== configHash) throw new Error("Could not finalize ambiguous inline recovery checkpoint");
    logStatus({ status: recovery.terminalResult.status, findingsCount: recovery.terminalResult.findingsCount, rulesRun: recovery.terminalResult.rulesRun, rulesFailed: recovery.terminalResult.rulesFailed, reason: "recovered-ambiguous-inline-review" });
    return recovery.terminalResult.exitCode;
  }
  // A ready checkpoint for this exact SHA/config is an interrupted current run.
  // Binding mismatches are corruption. Dry-run reproduces the stored result
  // without writing. Crash recovery consults the frozen manifest below instead
  // of finalizing the conservative pending summary here.
  const readyCurrent = botComment !== null &&
    recovery?.phase === "ready" &&
    recovery.headSha === pr.headSha &&
    recovery.configHash === configHash;
  if (readyCurrent) {
    if (
      recovery.noteId !== botComment.id ||
      recovery.terminalResult === undefined
    ) {
      throw new Error(
        "Invalid current pending review recovery binding; refusing to dispatch or write",
      );
    }
    if (config.dryRun) {
      logStatus({
        status: recovery.terminalResult.status,
        findingsCount: recovery.terminalResult.findingsCount,
        rulesRun: recovery.terminalResult.rulesRun,
        rulesFailed: recovery.terminalResult.rulesFailed,
        loadErrors: recovery.terminalResult.loadErrors,
        reason: "recovered-pending-review-dry-run",
      });
      return recovery.terminalResult.exitCode;
    }
  }

  // AC-8.1: sha + config match -> skip, exit 0, upsertComment is never called.
  if (decideDedup(pr, botComment, configHash) === "skip-no-new-commits") {
    logStatus({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [] });
    return EXIT_OK;
  }

  if (stateStore !== undefined) {
    const existing = loadPublicationAction(
      (await stateStore.readContextSnapshot()).events,
      publicationIdentity,
    );
    if (existing !== undefined && (existing.state === "manifest-ready" || existing.state === "published" || existing.state === "completed")) {
      return publishReviewFromManifest({
        action: existing,
        store: stateStore,
        config,
        pr,
        configHash,
        botComment,
        provider,
        hooks: publicationHooks,
        now,
        identity: reviewIdentity,
      });
    }
  }

  if (readyCurrent && botComment !== null && recovery?.terminalResult !== undefined) {
    const finalizedBody = replacePendingMarker(
      botComment.body,
      formatMarker(pr.headSha, configHash),
    );
    const finalized = await config.vcsAdapter.upsertComment(
      config.locator,
      finalizedBody,
      botComment,
    );
    if (
      finalized.id !== botComment.id ||
      finalized.lastReviewedSha !== pr.headSha ||
      finalized.reviewedConfig !== configHash
    ) {
      throw new Error(
        "The VCS adapter could not confirm recovery of the exact completed summary note",
      );
    }
    logStatus({
      status: recovery.terminalResult.status,
      findingsCount: recovery.terminalResult.findingsCount,
      rulesRun: recovery.terminalResult.rulesRun,
      rulesFailed: recovery.terminalResult.rulesFailed,
      loadErrors: recovery.terminalResult.loadErrors,
      reason: "recovered-pending-review",
    });
    return recovery.terminalResult.exitCode;
  }

  const { rules, errors: loadErrors } = await loadRulesForReview(config, pr, loadRulesFn);

  // Task 8 review fix #1: surface load errors via console.error whenever
  // ANY rule file failed to load — not just when every rule failed. A
  // partial load failure must still be visible (SPEC.md: "every non-zero
  // exit must include a human-readable reason").
  if (loadErrors.length > 0) {
    console.error(`tgd-review-agent: ${loadErrors.length} rule file(s) failed to load:`);
    for (const loadError of loadErrors) {
      console.error(`  ${loadError.sourcePath}: ${loadError.message}`);
    }
  }

  // AC-8.5: every rule failed to load -> exit 1 before any VCS write.
  if (rules.length === 0) {
    console.error("tgd-review-agent: no rules could be loaded; aborting before posting a comment");
    return EXIT_FATAL;
  }

  const dispatchResult = await dispatchRulesFn({
    rules,
    diff,
    useAdvisor: config.advisor === "on",
    orchestratorModel: config.model,
    ...(loadedContext.conversationContext === undefined
      ? {}
      : { conversationContext: loadedContext.conversationContext }),
  });

  if (extracted.omittedCount > 0) {
    console.warn(`tgd-review-agent: ${extracted.omittedCount} additional related-work reference(s) omitted`);
  }
  let relatedWork: readonly RelatedWorkItem[] = extracted.references;
  if (extracted.references.length > 0) {
    try {
      const output: unknown = await config.vcsAdapter.resolveRelatedWork(extracted.references);
      relatedWork = reconcileRelatedWork(extracted.references, output);
    } catch {
      for (const reference of extracted.references) {
        console.warn(`tgd-review-agent: related-work lookup failed for ${provider} ${safeRelatedWorkIdentifier(reference)}; using unresolved reference`);
      }
    }
  }

  // Findings are anchored to the diff and posted as INLINE review comments; only
  // what can't be anchored (no line number, or a line outside this PR's hunks)
  // goes in the summary body. Passing the diff is what makes that decision safe —
  // see orchestrate()/diff-anchors.
  // Only an explicit "off" disables them — an absent value means the documented
  // default (on), never a silent downgrade.
  const renderOpts = { suggestions: config.suggestions !== "off" };
  const orchestration = orchestrateFn(dispatchResult, diff, {
    inline: true,
    ...renderOpts,
    relatedWork,
    ...(loadedContext.unavailable.length === 0 ? {} : { contextUnavailable: loadedContext.unavailable }),
  });
  const hasFailure = loadErrors.length > 0 || orchestration.rulesFailed.length > 0;
  const terminalResult = {
    status: hasFailure ? "partial" as const : "posted" as const,
    findingsCount: orchestration.findingsCount,
    rulesRun: orchestration.rulesRun,
    rulesFailed: orchestration.rulesFailed,
    ...(loadErrors.length === 0
      ? {}
      : { loadErrors: loadErrors.map((error) => `${error.sourcePath}: ${error.message}`) }),
    exitCode: hasFailure ? EXIT_PARTIAL as 2 : EXIT_OK as 0,
  };

  const buildBody = (
    o: OrchestrationResult,
    failedIds: ReadonlySet<string>,
    marker = formatMarker(pr.headSha, configHash),
    providerLimit = true,
  ): string => {
    const suffixParts: string[] = [];
    if (loadErrors.length > 0) suffixParts.push(renderLoadErrorsSection(loadErrors));
    suffixParts.push(marker);
    const suffix = `\n\n${suffixParts.join("\n\n")}`;
    const maxSummaryLength = providerLimit ? 65_536 - suffix.length : Number.MAX_SAFE_INTEGER;
    if (providerLimit && maxSummaryLength <= 0) {
      throw new Error("Review metadata is too large for a provider comment");
    }
    const commentBody = o.summaryInput
      ? renderSummary(o, failedIds, maxSummaryLength)
      : o.commentBody;
    const body = `${commentBody}${suffix}`;
    if (providerLimit && body.length > 65_536) {
      throw new Error("Review comment exceeds the provider size limit");
    }
    return body;
  };
  const noFallbackIds = new Set<string>();

  // AC-8.4: --dry-run prints instead of writing to the VCS — including a preview
  // of the inline comments it WOULD have posted, so a dry run shows the whole
  // review, not just half of it.
  if (config.dryRun) {
    for (const comment of orchestration.inlineComments) {
      console.log(`\n----- inline comment: ${comment.path}:${comment.line} -----`);
      console.log(comment.body);
    }
    if (orchestration.inlineComments.length > 0) console.log("\n----- summary comment -----");
    console.log(buildBody(orchestration, noFallbackIds, undefined, false));
  } else {
    if (stateStore === undefined) throw new Error("Review publication requires a conversation state store");
    let inlineRecovery: InlineRecoveryState | undefined;
    const allInlineIds = new Set(orchestration.inlineComments.map((comment) => comment.clientId));
    if (orchestration.inlineComments.length > 0) {
      if (config.vcsAdapter.prepareInlineReviewRecovery !== undefined) {
        const actionIdentity = createHash("sha256").update(JSON.stringify({ configHash, headSha: pr.headSha,
          children: orchestration.inlineComments.map((comment) => ({ clientId: comment.clientId, path: comment.path, line: comment.line, startLine: comment.startLine ?? null, body: comment.body })) }), "utf8").digest("hex");
        const prepared = await config.vcsAdapter.prepareInlineReviewRecovery(config.locator, pr.headSha, orchestration.inlineComments, `${configHash}:${actionIdentity}`);
        inlineRecovery = { ...prepared, noFallbackBody: buildBody(orchestration, noFallbackIds, "") };
      }
      // The provider assigns the real note identity on the first write, but
      // every already-known recovery field must be representable before that
      // write. A safe placeholder exercises the exact same bounded encoder.
      if (provider === "github") {
        if (orchestration.inlineComments.length > 100) throw new Error("GitHub inline review exceeds the safe atomic comment count");
        const payloadChars = orchestration.inlineComments.reduce((total, comment, index) => total + comment.body.length + (inlineRecovery?.children[index]?.marker.length ?? 0) + 256, 0);
        if (payloadChars > 1_000_000 || orchestration.inlineComments.some((comment, index) => comment.body.length + (inlineRecovery?.children[index]?.marker.length ?? 0) + 128 > 65_536)) {
          throw new Error("GitHub inline review exceeds the safe atomic payload size");
        }
      }
      const readyPreflight = formatPendingMarker({
        phase: "ready",
        headSha: pr.headSha,
        configHash,
        noteId: "preflight",
        terminalResult,
        inlineRecovery,
      });
      buildBody(orchestration, allInlineIds, readyPreflight);
      if (inlineRecovery !== undefined) {
        buildBody(orchestration, allInlineIds, formatPendingMarker({ phase: "ambiguous", headSha: pr.headSha, configHash, noteId: "preflight", terminalResult, inlineRecovery }));
      }
    }

    const parentId = `act_${publicationIdentity.actionId.slice("action_".length)}`;
    const publicRepositoryDigest = computeRepositoryDigest(repository.provider, repository.canonicalUrl);
    const preparedFindings: FindingLedgerEntry[] = [];
    const inlines = orchestration.inlineComments.map((comment, index) => {
      const recovered = inlineRecovery?.children[index];
      const contentDigest = recovered?.contentDigest ?? computeContentDigest(comment.body);
      const placementDigest = recovered?.placementDigest ?? createHash("sha256").update(JSON.stringify({
        path: comment.path, line: comment.line, startLine: comment.startLine ?? null,
      }), "utf8").digest("hex");
      const childId = recovered?.childId ?? deriveInlineChildId(parentId, comment.clientId, contentDigest, placementDigest);
      const recoveryMarker = recovered?.marker ?? formatInlineRecoveryMarker({
        kind: "finding",
        parentId,
        childId,
        repositoryDigest: publicationIdentity.identityDigest,
        reviewNumber: Number(pr.id),
        contentDigest,
        headSha: pr.headSha,
        placementDigest,
      });
      const findingMarker = formatChildMarker({
        kind: "finding",
        parentId,
        childId,
        repositoryDigest: publicRepositoryDigest,
        reviewNumber: Number(pr.id),
        contentDigest,
      });
      const publishedBody = `${comment.body}${comment.body.endsWith("\n") ? "" : "\n"}${findingMarker}`;
      const finding = orchestration.findingByClientId?.get(comment.clientId);
      if (finding !== undefined) {
        const rule = rules.find((item) => item.name === finding.ruleName);
        preparedFindings.push(prepareFindingLedgerEntry({
          repository: storeBinding,
          id: childId,
          reviewNumber: Number(pr.id),
          reviewId: reviewIdentity.reviewId,
          baseSha: pr.baseSha,
          headSha: pr.headSha,
          finding,
          ruleSnapshot: rule?.body ?? finding.ruleName,
          reviewOptions: reviewOptionsSnapshot(config),
          placement: {
            file: comment.path,
            line: comment.line,
            side: "new",
            originalHeadSha: pr.headSha,
            currentHeadSha: pr.headSha,
            outdated: false,
          },
          body: comment.body,
          publishedBody,
          at: now(),
        }));
      }
      return {
        clientId: comment.clientId,
        childId,
        body: publishedBody,
        marker: recoveryMarker,
        file: comment.path,
        line: comment.line,
        startLine: comment.startLine,
        position: comment.position,
      };
    });
    const frozenChildren = buildReviewPublicationGraph({
      actionId: publicationIdentity.actionId,
      summaryBody: buildBody(orchestration, noFallbackIds, ""),
      headSha: pr.headSha,
      configHash,
      terminalResult,
      inlines,
      fallbacks: inlines.map((inline) => ({ replacesId: inline.childId, body: inline.body })),
    });
    const preparedAction: PublicationAction = {
      ...publicationIdentity,
      reviewNumber: Number(pr.id),
      repository: storeBinding,
      state: "manifest-ready",
      successorActionId: null,
      children: frozenChildren,
    };
    if (preparedFindings.length > 0) {
      const existing = (await stateStore.readContextSnapshot()).findings;
      await stateStore.transact((tx) => {
        tx.initializeIfAbsent();
        for (const entry of preparedFindings) {
          if (!existing.some((item) => item.id === entry.id)) tx.appendFinding(entry);
        }
      });
    }
    return publishReviewFromManifest({
      action: preparedAction,
      store: stateStore,
      config,
      pr,
      configHash,
      botComment,
      provider,
      hooks: publicationHooks,
      now,
      orchestration,
      loadErrors,
      buildBody,
      terminalResult,
      inlineRecovery,
      preparedFindings,
      identity: reviewIdentity,
    });
  }

  logStatus({
    status: hasFailure ? "partial" : "posted",
    findingsCount: orchestration.findingsCount,
    rulesRun: orchestration.rulesRun,
    rulesFailed: orchestration.rulesFailed,
    loadErrors: loadErrors.length > 0 ? loadErrors.map((e) => `${e.sourcePath}: ${e.message}`) : undefined,
  });

  // AC-8.6 / Task 8 review fix #1: EXIT_FATAL is reserved strictly for
  // pre-write cases — zero rules loaded (handled above, before any VCS
  // write is attempted) or a getPullRequest/findBotComment/getDiff
  // rejection (propagates past this function entirely; see review()'s
  // lack of a try/catch and main()'s outer catch-all). By this point a
  // comment has already been posted (or, for --dry-run, printed) above,
  // so exit code must reflect "was a write attempted", not "did every
  // rule produce a result": even a total dispatch-time wipeout (e.g. every
  // rule failing due to a provider outage, `dispatchRules`'s fallback
  // returning `rulesRun: []`) is a partial failure (exit 2), not fatal
  // (exit 1) — a CI consumer must not read exit 1 here as "nothing was
  // written to the VCS", since a comment WAS posted.
  return hasFailure ? EXIT_PARTIAL : EXIT_OK;
}

/**
 * Entry point. Parses argv, dispatches `review` or `poll`, and exits with the
 * command's returned code. `poll` defaults to the classification-only runtime
 * and remains injectable for tests. Parse errors and unrecovered command
 * errors are logged and exit 1.
 */
export interface MainDependencies {
  runPoll?: (args: PollArgs) => Promise<number>;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: MainDependencies = {},
): Promise<void> {
  try {
    const args = parseCommandArgs(argv);
    const exitCode = args.command === "review"
      ? await review(args)
      : await (dependencies.runPoll ?? poll)(args);
    process.exit(exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`tgd-review-agent: ${message}`);
    process.exit(EXIT_FATAL);
  }
}

// Only auto-run when executed directly (not when imported for tests).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  void main();
}
