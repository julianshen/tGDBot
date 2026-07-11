#!/usr/bin/env node
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

/**
 * Parsed configuration for the `review` command, per SPEC.md's API Contract.
 */
export interface CliArgs {
  pr: string;
  vcs: "github" | "gitlab";
  rulesDir: string;
  disableBuiltinRule: boolean;
  advisor: "on" | "off";
  dryRun: boolean;
}

const DEFAULTS = {
  vcs: "github" as const,
  rulesDir: ".tgd-review/rules",
  disableBuiltinRule: false,
  advisor: "on" as const,
  dryRun: false,
};

/**
 * Parses CLI argv into a CliArgs object for the `review` command.
 *
 * AC-1.1: `review --pr 42` parses to the fully-defaulted CliArgs object.
 * AC-1.2: a missing `--pr` throws an Error naming `--pr` as required, which
 * `main()` translates into exit code 1 with a human-readable message.
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
      "dry-run": { type: "boolean" },
    },
  });

  if (!values.pr) {
    throw new Error(
      "Missing required argument: --pr <number> (usage: tgd-review-agent review --pr <number>)",
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

  return {
    pr: values.pr as string,
    vcs,
    rulesDir: (values["rules-dir"] as string | undefined) ?? DEFAULTS.rulesDir,
    disableBuiltinRule: (values["disable-builtin-rule"] as boolean | undefined) ?? DEFAULTS.disableBuiltinRule,
    advisor,
    dryRun: (values["dry-run"] as boolean | undefined) ?? DEFAULTS.dryRun,
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
  ) => Promise<DispatchResult>;
  orchestrate: (dispatchResult: DispatchResult) => OrchestrationResult;
}

interface StatusLog {
  status: "skipped" | "posted" | "partial";
  findingsCount: number;
  rulesRun: string[];
  rulesFailed: string[];
}

function logStatus(log: StatusLog): void {
  console.log(JSON.stringify(log));
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
  const dispatchRulesFn = deps.dispatchRules ?? dispatchRulesReal;
  const orchestrateFn = deps.orchestrate ?? orchestrateReal;

  const config = resolveConfigFn(args);
  const pr = await config.vcsAdapter.getPullRequest(config.pr);
  const botComment = await config.vcsAdapter.findBotComment(config.pr);

  // AC-8.1: sha match -> skip, exit 0, upsertComment is never called.
  if (decideDedup(pr, botComment) === "skip-no-new-commits") {
    logStatus({ status: "skipped", findingsCount: 0, rulesRun: [], rulesFailed: [] });
    return 0;
  }

  const diff = await config.vcsAdapter.getDiff(config.pr);
  const { rules, errors: loadErrors } = await loadRulesFn(config.rulesDir, !config.disableBuiltinRule);

  // AC-8.5: every rule failed to load -> exit 1 before any VCS write.
  if (rules.length === 0) {
    console.error(
      `tgd-review-agent: no rules could be loaded (${loadErrors.length} load error(s)); aborting before posting a comment`,
    );
    for (const loadError of loadErrors) {
      console.error(`  ${loadError.sourcePath}: ${loadError.message}`);
    }
    return 1;
  }

  const dispatchResult = await dispatchRulesFn(rules, diff, config.advisor === "on");
  const orchestration = orchestrateFn(dispatchResult);
  const body = `${orchestration.commentBody}\n\n${formatMarker(pr.headSha)}`;

  // AC-8.4: --dry-run prints the body instead of writing to the VCS.
  if (config.dryRun) {
    console.log(body);
  } else {
    await config.vcsAdapter.upsertComment(config.pr, body, botComment);
  }

  const hasFailure = loadErrors.length > 0 || orchestration.rulesFailed.length > 0;
  logStatus({
    status: hasFailure ? "partial" : "posted",
    findingsCount: orchestration.findingsCount,
    rulesRun: orchestration.rulesRun,
    rulesFailed: orchestration.rulesFailed,
  });

  // AC-8.6: some rules ran but at least one failed -> exit 2 (partial).
  // Zero rules ran at all -> exit 1 (fatal), even though a comment was
  // still posted (SPEC.md "Never fail silently" boundary).
  if (orchestration.rulesRun.length === 0) return 1;
  return hasFailure ? 2 : 0;
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
    process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported for tests).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  void main();
}
