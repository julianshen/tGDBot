#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseCommandArgs } from "./cli-args.js";
import type { PollArgs, ReviewArgs } from "./cli-args.js";
import { resolveConfig as resolveConfigReal } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { computeReviewConfigHash, decideDedup, formatMarker } from "./review/dedup.js";
import {
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
import type { PullRequestInfo } from "./vcs/adapter.js";
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
    options?: { inline?: boolean; suggestions?: boolean; relatedWork?: readonly RelatedWorkItem[] },
  ) => OrchestrationResult;
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
          )
      : (input: ReviewDispatchInput) => dispatchRulesDirectReal(input, {}));
  const orchestrateFn = deps.orchestrate ?? orchestrateReal;

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

  // Config-aware dedup: a run is skipped only when this exact head SHA was
  // already reviewed WITH THE SAME review configuration. Computed from CLI flags
  // alone (no rule fetch), so the skip decision stays as cheap as before — see
  // computeReviewConfigHash for what is and isn't captured.
  const configHash = computeReviewConfigHash(config, relatedWorkFingerprint(extracted));

  if (botComment?.invalidPendingState === true) {
    throw new Error(
      "Invalid pending review recovery metadata; refusing to dispatch or write",
    );
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
  // Only a ready checkpoint for this exact SHA/config can represent an
  // interrupted current run. Once those two fields match, every remaining
  // binding is mandatory and a mismatch is corruption, not permission to
  // republish inline comments. A stale SHA/config intentionally falls through
  // to the normal re-review path for the new revision/configuration.
  if (
    botComment !== null &&
    recovery?.phase === "ready" &&
    recovery.headSha === pr.headSha &&
    recovery.configHash === configHash
  ) {
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

  // AC-8.1: sha + config match -> skip, exit 0, upsertComment is never called.
  if (decideDedup(pr, botComment, configHash) === "skip-no-new-commits") {
    logStatus({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [] });
    return EXIT_OK;
  }

  // Codex review fix (PR #5): a diff can be too large to even FETCH — the
  // GitHub adapter's execFile buffer is capped (10 MiB), and a bigger diff
  // makes getDiff() reject with a maxBuffer error BEFORE the length check
  // below could ever run. With --max-diff-chars set, that rejection is proof
  // positive the diff is over any expressible ceiling, so it gets the same
  // graceful skip the flag promises — hitting exactly the largest PRs the
  // ceiling exists to guard. Without the flag, the rejection stays fatal
  // (the pre-existing behavior: the user asked for no ceiling).
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

  // Design-review #13: hard cost ceiling. The dispatch prompt embeds the diff
  // once per rule (O(rules × diff) tokens); warnIfDiffCostRisk in dispatch.ts
  // only WARNS. When the user set a ceiling and this diff is over it, skip
  // loudly BEFORE fetching rules or spending a single model token — nothing is
  // posted (so no marker is written: a later run with a higher ceiling reviews
  // normally), and the status line says why.
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
  const orchestration = orchestrateFn(dispatchResult, diff, { inline: true, ...renderOpts, relatedWork });
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
    // ORDER MATTERS. The summary is durable and updatable; inline comments are
    // append-only.
    //
    // Write an explicit PENDING marker first. It makes the durable summary
    // rediscoverable without claiming this SHA/config is complete. Only after
    // inline outcomes and selective fallback are settled do we replace it with
    // the complete dedup marker, targeting the exact returned identity.
    let allInlineIds: Set<string> | undefined;
    let inlineRecovery: InlineRecoveryState | undefined;
    if (orchestration.inlineComments.length > 0) {
      allInlineIds = new Set(
        orchestration.inlineComments.map((comment) => comment.clientId),
      );
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

    const writtenSummary = await config.vcsAdapter.upsertComment(
      config.locator,
      buildBody(
        orchestration,
        noFallbackIds,
        formatPendingMarker({
          phase: "publishing",
          headSha: pr.headSha,
          configHash,
        }),
      ),
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
      throw new Error(
        "The VCS adapter did not return the exact identity of the pending summary note",
      );
    }

    let summaryIdentity = writtenSummary;
    if (orchestration.inlineComments.length > 0) {
      const checkpoint = await config.vcsAdapter.upsertComment(
        config.locator,
        buildBody(
          orchestration,
          allInlineIds!,
          formatPendingMarker({
            phase: "ready",
            headSha: pr.headSha,
            configHash,
            noteId: writtenSummary.id,
            terminalResult,
            inlineRecovery,
          }),
        ),
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
        throw new Error(
          "The VCS adapter could not confirm the exact ready recovery checkpoint",
        );
      }
      summaryIdentity = checkpoint;
    }

    // Design-review #10: collapse the PREVIOUS runs' inline threads before
    // posting this run's. Inline review comments are append-only, so without
    // this every past head SHA's comments accumulate uncollapsed forever.
    // Resolved threads stay visible as history — nothing is deleted, and only
    // threads the bot itself started are touched. Runs AFTER the pending write
    // (idempotency must never depend on cosmetic cleanup) and BEFORE the new
    // inline post (so this run's comments are the only unresolved ones left).
    // Strictly best-effort: a failure here must not abort or degrade the
    // review — warn and carry on.
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

    let finalFallbackIds = noFallbackIds;
    if (orchestration.inlineComments.length > 0) {
      let fallbackIds: Set<string> | undefined;
      let ambiguousInlineWrite = false;
      try {
        const outcomes = await config.vcsAdapter.createInlineReview(
          config.locator,
          pr.headSha,
          orchestration.inlineComments,
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
            orchestration.inlineComments,
            outcomes,
            config.locator.kind === "repository"
              ? { repo: config.locator.repo, reviewNumber: config.locator.number }
              : undefined,
          );
          fallbackIds = new Set(
            validated
              .filter((outcome) => outcome.status === "failed")
              .map((outcome) => outcome.clientId),
          );
        } catch (err) {
          console.warn(
            `tgd-review-agent: inline review returned invalid outcomes (${(err as Error).message}); ` +
              `rewriting the summary comment to carry every inline finding instead`,
          );
          fallbackIds = allInlineIds;
        }
      } catch (err) {
        if (err instanceof AmbiguousInlinePublishError && inlineRecovery !== undefined) {
          console.warn(
            `tgd-review-agent: GitHub may have accepted the inline review (${err.message}); ` +
              `not duplicating those findings into the summary; a later run will reconcile markers`,
          );
          fallbackIds = noFallbackIds;
          ambiguousInlineWrite = true;
        } else {
          console.warn(
            `tgd-review-agent: could not post inline review comments (${(err as Error).message}); ` +
              `rewriting the summary comment to carry every finding instead`,
          );
          fallbackIds = allInlineIds;
        }
      }

      if (fallbackIds && fallbackIds.size > 0) {
        finalFallbackIds = fallbackIds;
      }

      if (ambiguousInlineWrite) {
        const ambiguousCheckpoint = await config.vcsAdapter.upsertComment(
          config.locator,
          buildBody(orchestration, allInlineIds!, formatPendingMarker({ phase: "ambiguous", headSha: pr.headSha, configHash, noteId: summaryIdentity.id, terminalResult, inlineRecovery: inlineRecovery! })),
          summaryIdentity,
        );
        if (ambiguousCheckpoint.id !== summaryIdentity.id || ambiguousCheckpoint.pendingState?.phase !== "ambiguous") throw new Error("Could not persist ambiguous inline recovery checkpoint");
        logStatus({ status: "partial", findingsCount: orchestration.findingsCount, rulesRun: orchestration.rulesRun, rulesFailed: orchestration.rulesFailed, reason: "inline-publication-ambiguous" });
        return EXIT_PARTIAL;
      }

      const selectiveCheckpoint = await config.vcsAdapter.upsertComment(
        config.locator,
        buildBody(
          orchestration,
          finalFallbackIds,
          formatPendingMarker({
            phase: "ready",
            headSha: pr.headSha,
            configHash,
            noteId: summaryIdentity.id,
            terminalResult,
          }),
        ),
        summaryIdentity,
      );
      if (
        selectiveCheckpoint.id !== summaryIdentity.id ||
        selectiveCheckpoint.lastReviewedSha !== "" ||
        selectiveCheckpoint.reviewedConfig !== "" ||
        selectiveCheckpoint.pendingState?.phase !== "ready" ||
        selectiveCheckpoint.pendingState.headSha !== pr.headSha ||
        selectiveCheckpoint.pendingState.configHash !== configHash ||
        selectiveCheckpoint.pendingState.noteId !== summaryIdentity.id ||
        !sameTerminalResult(
          selectiveCheckpoint.pendingState.terminalResult,
          terminalResult,
        )
      ) {
        throw new Error(
          "The VCS adapter could not confirm the exact selective recovery checkpoint",
        );
      }
      summaryIdentity = selectiveCheckpoint;
    }
    const finalizedSummary = await config.vcsAdapter.upsertComment(
      config.locator,
      buildBody(orchestration, finalFallbackIds),
      summaryIdentity,
    );
    if (
      !finalizedSummary ||
      finalizedSummary.id !== summaryIdentity.id ||
      finalizedSummary.lastReviewedSha !== pr.headSha ||
      finalizedSummary.reviewedConfig !== configHash
    ) {
      throw new Error(
        "The VCS adapter could not confirm finalization of the exact completed summary note",
      );
    }
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
 * command's returned code. Poll currently uses an injectable seam whose
 * default throws PollNotImplementedError until its runtime is implemented.
 * Parse errors and unrecovered command errors are logged and exit 1.
 */
export class PollNotImplementedError extends Error {
  constructor() {
    super("The poll command runtime is not implemented");
    this.name = "PollNotImplementedError";
  }
}

async function runPollNotImplemented(args: PollArgs): Promise<number> {
  void args;
  throw new PollNotImplementedError();
}

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
      : await (dependencies.runPoll ?? runPollNotImplemented)(args);
    process.exit(exitCode);
  } catch (err) {
    const message = err instanceof PollNotImplementedError
      ? `${err.name}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.error(`tgd-review-agent: ${message}`);
    process.exit(EXIT_FATAL);
  }
}

// Only auto-run when executed directly (not when imported for tests).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  void main();
}
