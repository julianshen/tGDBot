#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { resolveConfig as resolveConfigReal } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { decideDedup, formatMarker } from "./review/dedup.js";
import { dispatchRules as dispatchRulesReal } from "./review/dispatch.js";
import { orchestrate as orchestrateReal } from "./review/orchestrate.js";
import type { OrchestrationResult } from "./review/orchestrate.js";
import type { DispatchResult } from "./review/types.js";
import { loadRules as loadRulesReal } from "./rules/loader.js";
import type { LoadResult } from "./rules/loader.js";
import type { RuleDefinition } from "./rules/types.js";
import type { PullRequestInfo } from "./vcs/adapter.js";

/**
 * Parsed configuration for the `review` command, per SPEC.md's API Contract.
 */
export interface CliArgs {
  pr: string;
  vcs: "github" | "gitlab";
  /**
   * Issue #1 (round 2): "<provider>/<model>" for the ORCHESTRATING session.
   * Optional. Resolution order is --model -> pi's settings default -> each
   * rule's own model -> pi's auth-aware default, and EVERY candidate must have
   * configured credentials on this machine (see resolveOrchestratorModel).
   */
  model?: string;
  rulesDir: string;
  disableBuiltinRule: boolean;
  advisor: "on" | "off";
  /**
   * ADR-007: whether to render committable ```suggestion blocks (one-click
   * "Commit suggestion"). Default on. `off` downgrades them to plain,
   * non-committable code blocks — for repos that do not want a one-click commit
   * path from text an automated reviewer derived from an untrusted diff.
   */
  suggestions: "on" | "off";
  dryRun: boolean;
  trustLocalRules: boolean;
}

const DEFAULTS = {
  vcs: "github" as const,
  rulesDir: ".tgd-review/rules",
  disableBuiltinRule: false,
  advisor: "on" as const,
  suggestions: "on" as const,
  dryRun: false,
  trustLocalRules: false,
};

/**
 * Parses CLI argv into a CliArgs object for the `review` command.
 *
 * AC-1.1: `review --pr 42` parses to the fully-defaulted CliArgs object.
 * AC-1.2: a missing `--pr` throws an Error naming `--pr` as required, which
 * `main()` translates into exit code 1 with a human-readable message.
 *
 * `--rules-dir <path>` (default `.tgd-review/rules`): a REPO-RELATIVE path,
 * NOT a local filesystem path by default. `review()` passes it to
 * `vcsAdapter.getRuleFilesFromBase(pr.baseSha, rulesDir)`, which fetches
 * `<rulesDir>/*.md` as it exists on the PR's BASE branch via the VCS
 * provider's API (`gh api` for GitHub) — never from whatever happens to be
 * checked out locally. This is what closes the rule-file trust-boundary gap
 * described in ADR-002: a PR cannot introduce or modify a rule that affects
 * its own review, and this now holds true wherever the CLI runs (a
 * developer's own terminal, any CI system with `gh` authenticated), not
 * just inside a GitHub Actions workflow with a bespoke `git worktree`
 * step. See `--trust-local-rules` below for the escape hatch back to the
 * old local-filesystem behavior.
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
  const { values } = nodeParseArgs({
    args: argv,
    // Allow (and ignore) the leading positional `review` command token.
    allowPositionals: true,
    options: {
      pr: { type: "string" },
      vcs: { type: "string" },
      "rules-dir": { type: "string" },
      "disable-builtin-rule": { type: "boolean" },
      advisor: { type: "string" },
      suggestions: { type: "string" },
      model: { type: "string" },
      "dry-run": { type: "boolean" },
      "trust-local-rules": { type: "boolean" },
    },
  });

  if (!values.pr) {
    throw new Error(
      "Missing required argument: --pr <number> (usage: tgd-review-agent review --pr <number>)",
    );
  }

  // Defense-in-depth (DEBT.md security item, Low): --pr is interpolated
  // into `gh api repos/{owner}/{repo}/issues/${id}/comments`-style paths in
  // github-adapter.ts. Not currently exploitable — execFile is invoked with
  // array args (no shell), and the shipped workflow only ever passes
  // `github.event.pull_request.number`, a genuine integer — but a plain
  // positive-integer check costs nothing and closes off any future
  // path/query-string interpolation from accepting non-numeric input.
  if (!/^\d+$/.test(values.pr as string)) {
    throw new Error(
      `Invalid --pr value: "${values.pr as string}" (expected a positive integer, e.g. --pr 42)`,
    );
  }

  const vcs = (values.vcs as string | undefined) ?? DEFAULTS.vcs;
  if (vcs !== "github" && vcs !== "gitlab") {
    throw new Error(`Invalid --vcs value: "${vcs}" (expected "github" or "gitlab")`);
  }

  const advisor = (values.advisor as string | undefined) ?? DEFAULTS.advisor;
  if (advisor !== "on" && advisor !== "off") {
    throw new Error(`Invalid --advisor value: "${advisor}" (expected "on" or "off")`);
  }

  const suggestions = (values.suggestions as string | undefined) ?? DEFAULTS.suggestions;
  if (suggestions !== "on" && suggestions !== "off") {
    throw new Error(`Invalid --suggestions value: "${suggestions}" (expected "on" or "off")`);
  }

  // Issue #1 (round 2), review fix: validate --model HERE, like --vcs/--advisor.
  // `??` is nullish-only, so an EMPTY string would otherwise sail past the
  // rule-derived default and land back on pi's ambient default — silently
  // restoring the exact coupling this flag exists to remove (realistic trigger:
  // a workflow passing `--model "${{ inputs.model }}"` with the input unset).
  const model = values.model as string | undefined;
  if (model !== undefined) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error(
        `Invalid --model value: "${model}" (expected "<provider>/<model>", e.g. "openai-codex/gpt-5.6-terra")`,
      );
    }
  }

  return {
    pr: values.pr as string,
    vcs,
    model,
    rulesDir: (values["rules-dir"] as string | undefined) ?? DEFAULTS.rulesDir,
    disableBuiltinRule: (values["disable-builtin-rule"] as boolean | undefined) ?? DEFAULTS.disableBuiltinRule,
    advisor,
    suggestions,
    dryRun: (values["dry-run"] as boolean | undefined) ?? DEFAULTS.dryRun,
    trustLocalRules: (values["trust-local-rules"] as boolean | undefined) ?? DEFAULTS.trustLocalRules,
  };
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
  dispatchRules: (
    rules: RuleDefinition[],
    diff: string,
    useAdvisor: boolean,
    orchestratorModel?: string,
  ) => Promise<DispatchResult>;
  orchestrate: (
    dispatchResult: DispatchResult,
    diff?: string,
    options?: { inline?: boolean; suggestions?: boolean },
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

  const ruleFiles = await config.vcsAdapter.getRuleFilesFromBase(pr.baseSha, config.rulesDir);
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
  // The adapter exists because `dispatchRulesReal` (whose 4th positional param
  // is its injectable session FACTORY, with `orchestratorModel` only 5th) is not
  // assignable to ReviewDependencies["dispatchRules"], whose 4th param IS the
  // model. tsc rejects both the direct assignment and the slot-swapped call, so
  // this is a plain shape mismatch, not a silent landmine — but the awkwardness
  // is real, and is why the tests below pin the exact argument positions.
  // Passing `undefined` for the factory keeps dispatchRules' real default.
  const dispatchRulesFn =
    deps.dispatchRules ??
    ((rules: RuleDefinition[], diff: string, useAdvisor: boolean, orchestratorModel?: string) =>
      dispatchRulesReal(rules, diff, useAdvisor, undefined, orchestratorModel));
  const orchestrateFn = deps.orchestrate ?? orchestrateReal;

  const config = resolveConfigFn(args);
  const pr = await config.vcsAdapter.getPullRequest(config.pr);
  const botComment = await config.vcsAdapter.findBotComment(config.pr);

  // AC-8.1: sha match -> skip, exit 0, upsertComment is never called.
  if (decideDedup(pr, botComment) === "skip-no-new-commits") {
    logStatus({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [] });
    return EXIT_OK;
  }

  const diff = await config.vcsAdapter.getDiff(config.pr);
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

  const dispatchResult = await dispatchRulesFn(rules, diff, config.advisor === "on", config.model);

  // Findings are anchored to the diff and posted as INLINE review comments; only
  // what can't be anchored (no line number, or a line outside this PR's hunks)
  // goes in the summary body. Passing the diff is what makes that decision safe —
  // see orchestrate()/diff-anchors.
  // Only an explicit "off" disables them — an absent value means the documented
  // default (on), never a silent downgrade.
  const renderOpts = { suggestions: config.suggestions !== "off" };
  let orchestration = orchestrateFn(dispatchResult, diff, { inline: true, ...renderOpts });

  const buildBody = (o: OrchestrationResult): string => {
    const bodyParts = [o.commentBody];
    if (loadErrors.length > 0) bodyParts.push(renderLoadErrorsSection(loadErrors));
    bodyParts.push(formatMarker(pr.headSha));
    return bodyParts.join("\n\n");
  };

  // AC-8.4: --dry-run prints instead of writing to the VCS — including a preview
  // of the inline comments it WOULD have posted, so a dry run shows the whole
  // review, not just half of it.
  if (config.dryRun) {
    for (const comment of orchestration.inlineComments) {
      console.log(`\n----- inline comment: ${comment.path}:${comment.line} -----`);
      console.log(comment.body);
    }
    if (orchestration.inlineComments.length > 0) console.log("\n----- summary comment -----");
    console.log(buildBody(orchestration));
  } else {
    // ORDER MATTERS (review finding). Idempotency rests entirely on the SHA
    // marker, which lives in the SUMMARY comment: decideDedup skips the whole run
    // when the marker already names this head SHA. Inline review comments, by
    // contrast, are append-only — there is no upsert for them.
    //
    // So the marker is written FIRST. If the inline post then fails, we edit the
    // summary to carry every finding. If we posted inline first and the summary
    // write then threw, no marker would exist, and the next run on the same SHA
    // would post every inline comment a SECOND time — a duplicate-comment storm
    // strictly worse than the old behavior.
    await config.vcsAdapter.upsertComment(config.pr, buildBody(orchestration), botComment);

    if (orchestration.inlineComments.length > 0) {
      try {
        await config.vcsAdapter.createInlineReview(
          config.pr,
          pr.headSha,
          orchestration.inlineComments,
        );
      } catch (err) {
        // Recoverable by design: GitHub rejects the WHOLE review if any single
        // anchor is off-diff. Rather than lose every finding to that, re-render
        // the summary with all of them inline-in-body and edit it in place. A
        // finding is only ever RELOCATED, never lost.
        console.warn(
          `tgd-review-agent: could not post inline review comments (${(err as Error).message}); ` +
            `rewriting the summary comment to carry every finding instead`,
        );
        orchestration = orchestrateFn(dispatchResult, diff, { inline: false, ...renderOpts });
        const existing = await config.vcsAdapter.findBotComment(config.pr);
        await config.vcsAdapter.upsertComment(config.pr, buildBody(orchestration), existing);
      }
    }
  }

  const hasFailure = loadErrors.length > 0 || orchestration.rulesFailed.length > 0;
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
 * Entry point. Parses argv, runs the `review` command, and exits with its
 * returned code. Parse errors and any error `review()` doesn't itself
 * recover from are logged and exit 1.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseArgs(argv);
    const exitCode = await review(args);
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
