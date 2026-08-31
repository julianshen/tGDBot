// Issue #113: running one fixture through the real review flow and measuring
// what came out.
//
// The flow is the PRODUCTION one — `review()` itself, with the real
// orchestrator, anchoring, clustering and rendering. Only the edges are
// stubbed: the provider (a fixture is not a live pull request), the model
// under `--mode recorded`, and the two steps that need a git worktree. A
// harness that reimplemented the pipeline would measure the harness.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { review, type CliArgs } from "../cli.js";
import type { ResolvedConfig } from "../config.js";
import { resolveReviewLocator } from "../config.js";
import { orchestrate as orchestrateReal } from "../review/orchestrate.js";
import { buildTaskText } from "../review/dispatch-prompt.js";
import { dispatchRulesDirect } from "../review/direct-dispatch.js";
import type { DispatchResult, Finding, ReviewDispatchInput } from "../review/types.js";
import type { EffectiveRule } from "../rules/types.js";
import type { VcsAdapter } from "../vcs/adapter.js";
import type { PreparedWorkspace, WorkspaceRequest } from "../workspace/types.js";
import { matchFindings, qualityOf, roundMetric } from "./match.js";
import type { BaselineEntry, Fixture, FixtureRunResult } from "./types.js";

export type BenchmarkMode = "recorded" | "real";

/** Rules the benchmark pins, so a run is comparable to last month's run. */
export const BENCHMARK_RULES_DIR = "test/benchmark/rules";

/**
 * What the run measured about the prompt, captured from the dispatch input
 * the flow actually built rather than recomputed from the fixture.
 *
 * Recomputing would miss whatever the review flow decided to include — the
 * #59 intent section, a context pack, re-review conversation context — and so
 * would report a prompt cost no run ever paid.
 */
interface DispatchMeasurement {
  dispatchChars: number;
  diffChars: number;
  rulesDispatched: number;
}

export async function runFixture(
  fixture: Fixture,
  mode: BenchmarkMode,
  model: string | undefined,
): Promise<FixtureRunResult> {
  const measurement: DispatchMeasurement = { dispatchChars: 0, diffChars: 0, rulesDispatched: 0 };
  let produced: readonly Finding[] = [];
  let inlineCount = 0;
  let renderedChars = 0;
  let modelsUsed: readonly string[] | undefined;

  // Isolated per run. Without this the flow opens the machine's real state
  // root (TGD_REVIEW_STATE_DIR / XDG_STATE_HOME / HOME), and any memory stored
  // there for the synthetic benchmark repository would enter the prompt —
  // making `dispatchChars` a function of local history rather than of the
  // fixture, which is the one thing a fixed benchmark cannot allow (Codex
  // review of PR #118).
  // `realpath` because the store refuses a state path containing a symbolic
  // link, and macOS puts the temp directory under /var, which is one.
  const stateDir = await mkdtemp(path.join(await realpath(os.tmpdir()), "tgd-benchmark-state-"));
  const args = { ...fixtureArgs(fixture, model), stateDir };
  const startedAt = performance.now();
  // The review prints a full dry-run preview of the comment it would post.
  // That is the right behaviour for `--dry-run` and pure noise here, where the
  // output IS the table. Only `console.log` is silenced: warnings and errors
  // still reach the terminal, because a fixture that degraded — a rule that
  // failed to load, a context step that gave up — must not do so quietly.
  // CAPTURED, not discarded. Under --dry-run the review prints exactly what it
  // would publish — the review digest, every inline body, and the composed
  // summary with its signature and marker. Measuring the orchestrator's
  // intermediate `commentBody` instead left the digest and the final
  // composition unmeasured, so a regression in either kept a clean baseline
  // (Codex review of PR #118). Reproducing that rendering here would be a
  // second implementation to keep in step; reading what the CLI printed is the
  // same bytes by construction.
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]) => { printed.push(parts.map(String).join(" ")); };
  let exitCode: number;
  try {
    exitCode = await review(args, {
      resolveConfig: () => fixtureConfig(args, fixture),
      dispatchRules: async (input) => {
        measure(measurement, input);
        const result = mode === "recorded" ? replay(fixture, input) : await dispatchRulesDirect(input, {});
        modelsUsed = result.modelsUsed;
        return result;
      },
      // The REAL orchestrator, wrapped only to observe.
      //
      // Scored on what it RETURNS, not on what it was handed. Reading
      // `dispatchResult.findings` measured raw dispatcher output, which
      // orchestration then filters — it drops `addressed` findings and
      // collapses duplicates into one per root cause. So the benchmark counted
      // findings no reader receives, and a change to the suppression or dedup
      // path moved nothing, even though covering that path is the whole claim
      // recorded mode makes (Codex review of PR #118).
      //
      // `allFindings` is the deduped set the summary counts: inline plus
      // unanchored, which together are everything a reader sees.
      orchestrate: (dispatchResult, diff, options) => {
        const result = orchestrateReal(dispatchResult, diff, options);
        produced = [...result.summaryInput.allFindings];
        inlineCount = result.inlineComments.length;
        return result;
      },
      // Neither step is what this benchmark measures, and both need a real git
      // worktree. Stubbed rather than disabled so the flow still takes the same
      // branches it takes in production.
      prepareContext: async () => ({ status: "off" }),
      runStructuralChecks: async (input) => [...input.findings],
      prepareStructuralWorkspace: (async (
        _request: WorkspaceRequest,
        use: (prepared: PreparedWorkspace) => Promise<unknown>,
      ) => use({
        root: "/benchmark", repositoryRoot: "/benchmark/repo", mirrorPath: "/benchmark/repo/mirror",
        worktreesRoot: "/benchmark/repo/worktrees", baseWorktreePath: "/benchmark/repo/base",
        ownerMarkerPath: "/benchmark/repo/owner.json", baseSha: fixture.pr.baseSha,
      })) as never,
      // A benchmark must never reach the network, in either mode. `--dependency-facts`
      // is off in `fixtureArgs`, so this is defence in depth rather than a seam
      // anything uses: if a future default turns lookups on, the run fails loudly
      // here instead of quietly measuring someone else's registry latency.
      fetchJson: async () => { throw new Error("the benchmark does not make network requests"); },
    });
  } finally {
    console.log = realLog;
    await rm(stateDir, { recursive: true, force: true });
  }
  const durationMs = performance.now() - startedAt;
  // The status lines are machine output ABOUT the run, not review a reader
  // receives, so they are excluded from the published byte count.
  renderedChars = printed
    .filter((line) => !line.startsWith("TGD_REVIEW_RESULT:") && !line.startsWith("TGD_REVIEW_SEVERITIES:"))
    .join("\n").length;
  // A review that failed produced no findings for a REASON, and scoring it as
  // "found nothing" turns a missing API key or an unloadable rule into false
  // negatives blamed on the model — while the benchmark still exits 0 (Codex
  // review). The caller reports this fixture as skipped instead.
  if (exitCode !== 0) throw new Error(`review exited ${exitCode}`);

  const match = matchFindings(fixture.expected, produced);
  const quality = qualityOf(match);
  const baseline: BaselineEntry = {
    fixture: fixture.name,
    quality: {
      ...quality,
      precision: roundMetric(quality.precision),
      recall: roundMetric(quality.recall),
      f1: roundMetric(quality.f1),
    },
    findingsCount: produced.length,
    severityMix: severityMix(produced),
    findingsPerRule: findingsPerRule(produced),
    dispatchChars: measurement.dispatchChars,
    diffChars: measurement.diffChars,
    findingTextChars: findingTextChars(produced),
    renderedChars,
    anchoredInline: inlineCount,
    missed: [...match.falseNegatives].sort(),
  };

  return {
    baseline,
    durationMs,
    ...(mode === "real" && modelsUsed !== undefined ? { modelsUsed } : {}),
    findings: produced,
    match,
  };
}

/**
 * The recorded model output, returned as if the model had just produced it.
 *
 * `rulesRun` comes from the recording rather than from the rules actually
 * loaded, because the recording is what the numbers describe. A recording made
 * against a rule set that no longer exists is a stale fixture, and saying so
 * is the fixture author's job — silently substituting today's rule names would
 * hide exactly that.
 */
function replay(fixture: Fixture, input: ReviewDispatchInput): DispatchResult {
  return {
    findings: (fixture.recordedFindings ?? []).map((finding) => ({ ...finding })),
    rulesRun: [...(fixture.recordedRulesRun ?? input.rules.map((rule) => rule.name))],
    rulesFailed: [],
  };
}

function measure(into: DispatchMeasurement, input: ReviewDispatchInput): void {
  into.diffChars = input.diff.length;
  into.rulesDispatched = input.rules.length;
  for (const rule of input.rules) {
    // `buildTaskText` wants an EffectiveRule — a rule with its model resolved.
    // The resolution does not reach the task text, so a placeholder measures
    // the same string the dispatcher would build, and keeps this measurement
    // independent of whether a model was configured at all.
    const effective = { ...rule, provider: "benchmark", model: "benchmark" } as EffectiveRule;
    into.dispatchChars += buildTaskText(
      effective,
      input.diff,
      input.contextPacks?.[rule.name],
      input.conversationContext,
      input.prIntent,
    ).length;
  }
}

function severityMix(findings: readonly Finding[]): BaselineEntry["severityMix"] {
  const mix = { blocking: 0, warning: 0, suggestion: 0 };
  for (const finding of findings) mix[finding.severity] += 1;
  return mix;
}

/** Sorted by key, so the committed JSON does not reorder between runs. */
function findingsPerRule(findings: readonly Finding[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.ruleName, (counts.get(finding.ruleName) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function findingTextChars(findings: readonly Finding[]): number {
  return findings.reduce(
    (total, finding) =>
      total + (finding.title?.length ?? 0) + finding.message.length + (finding.suggestion?.length ?? 0),
    0,
  );
}

/**
 * The CLI arguments every fixture runs under.
 *
 * `dryRun` is what keeps the run from publishing; the stub provider below
 * would accept a write, and a benchmark that exercised the publication path
 * would be measuring the wrong thing and writing to a fake at the same time.
 * The rest are pinned rather than defaulted: a benchmark whose configuration
 * moves with the CLI's defaults cannot compare a run against last month's
 * baseline.
 */
function fixtureArgs(fixture: Fixture, model: string | undefined): CliArgs {
  return {
    pr: fixture.pr.id,
    vcs: "github",
    repo: "benchmark/fixture",
    // PINNED to the benchmark's own rules, not the repository's `.review/rules`.
    // A baseline that moved whenever someone edited their local rules would
    // compare two different reviewers and call the difference a regression.
    // The builtin rule stays ON: it ships with the product, so a change to it
    // is exactly the kind of prompt change this benchmark exists to measure.
    rulesDir: BENCHMARK_RULES_DIR,
    disableBuiltinRule: false,
    advisor: "off",
    prIntent: "on",
    suggestions: "on",
    dependencyFacts: "off",
    dryRun: true,
    trustLocalRules: true,
    dispatch: "direct",
    structuralChecks: "off",
    context: "off",
    allowDegradedContext: false,
    ...(model === undefined ? {} : { model }),
  } as CliArgs;
}

function fixtureConfig(args: CliArgs, fixture: Fixture): ResolvedConfig {
  const pr = {
    id: fixture.pr.id,
    title: fixture.pr.title,
    description: fixture.pr.description,
    baseSha: fixture.pr.baseSha,
    headSha: fixture.pr.headSha,
    url: fixture.pr.url,
  };
  const adapter = {
    getPullRequest: async () => pr,
    getDiff: async () => fixture.diff,
    getMergeBaseSha: async () => fixture.pr.baseSha,
    // No bot comment: every fixture run is a FIRST review of that pull
    // request. Re-review suppression is real behaviour worth measuring one
    // day, but it would need a fixture that carries a previous review, and
    // faking one here would quietly change what every fixture measures.
    findBotComment: async () => null,
    upsertComment: async () => { throw new Error("the benchmark runs dry and does not publish"); },
    createInlineReview: async () => { throw new Error("the benchmark runs dry and does not publish"); },
    getRuleFilesFromBase: async () => [],
    // Serves the fixture's own manifests. Returning an empty string made every
    // manifest UNREADABLE, and the dependency pack is not gated on
    // `--dependency-facts` — it is built whenever there are dependency changes
    // OR unreadable manifests. So the fixture named for a dependency change was
    // dispatching a degraded "could not read this" pack instead of the parsed
    // changes, in recorded and real mode alike (Codex review of PR #118).
    // Measured: serving the manifests moves that fixture's `dispatchChars` by
    // 360, and no other fixture's, since only this one changes a manifest.
    getFileAtRef: async (_locator: unknown, ref: string, at: string) =>
      (ref === fixture.pr.headSha ? fixture.headFiles : fixture.baseFiles)?.[at] ?? "",
    resolveRelatedWork: async (references: unknown) => references,
    resolveStaleReviewThreads: async () => 0,
    findPublishedMarker: async () => null,
    findBotChildMarker: async () => null,
  };
  return { ...args, locator: resolveReviewLocator(args), vcsAdapter: adapter as unknown as VcsAdapter };
}
