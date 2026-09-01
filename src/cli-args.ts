import path from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { parseReviewTarget } from "./target/review-target.js";
import { MAX_CONTEXT_MAX_CHARS, MIN_CONTEXT_MAX_CHARS } from "./context/context-pack.js";

export interface SharedReviewOptions {
  vcs: "github" | "gitlab";
  vcsExplicit?: boolean;
  repo?: string;
  /** Default model in "<provider>/<model>" form; individual rules may override it. */
  model?: string;
  /** Repository-relative base-branch rule path unless trustLocalRules is enabled. */
  rulesDir: string;
  disableBuiltinRule: boolean;
  advisor: "on" | "off";
  /**
   * Whether the host may ask the npm registry about changed dependencies.
   *
   * OFF by default: this is the only outbound request the tool makes, it
   * reveals which packages a private repository depends on, and a review must
   * not start talking to a third party because someone upgraded the CLI.
   */
  dependencyFacts: "on" | "off";
  /** Issue #75: check a finding's structural claim against the base tree. */
  structuralChecks: "on" | "off";
  /**
   * Issue #59: give the dispatched reviewer the PR's stated intent (title,
   * description, linked-reference titles/states) as untrusted evidence. Off
   * for anyone who would rather their reviewer never read author prose.
   */
  prIntent: "on" | "off";
  /** Controls whether findings may render committable suggestion blocks. */
  suggestions: "on" | "off";
  dryRun: boolean;
  /** Opts into loading rules from the local filesystem instead of the trusted base branch. */
  trustLocalRules: boolean;
  /** Selects direct deterministic rule dispatch or the temporary legacy orchestrator. */
  dispatch: "direct" | "legacy";
  /** Hard diff-size cost ceiling; absent means unlimited. */
  maxDiffChars?: number;
  /**
   * Whether to give the reviewing rules trusted-base repository context.
   * `auto` maps when it can and degrades to a context-free review when it
   * cannot; `require` refuses to review blind; `off` never maps, which also
   * means never paying for the first map of a large repository.
   */
  context: "off" | "auto" | "require";
  /**
   * Issue #62: which ContextMapper implementation builds the repository
   * index. "tgd" runs the model-driven /tgd-map session; "graphify" runs the
   * deterministic AST indexer as a subprocess and needs Python 3 + graphify.
   */
  contextMapper: "tgd" | "graphify";
  /** Per-rule context-pack size ceiling; absent uses the pack builder's default. */
  contextMaxChars?: number;
  /** Lets mapping publish a partial result instead of failing outright. */
  allowDegradedContext: boolean;
  /** Absolute root for the managed base worktree and the context cache. */
  contextDir?: string;
  stateDir?: string;
  /** Codex Security artifact produced by a separate, sandboxed job. */
  codexScanResults?: string;
}

export interface ReviewArgs extends SharedReviewOptions {
  command: "review";
  pr: string;
}

export interface PollArgs extends SharedReviewOptions {
  command: "poll";
  repo: string;
}

export type CommandArgs = ReviewArgs | PollArgs;

const DEFAULTS = {
  vcs: "github" as const,
  rulesDir: ".review/rules",
  disableBuiltinRule: false,
  advisor: "on" as const,
  dependencyFacts: "off" as const,
  // Off for v1: it needs a base worktree, which on a cold managed workspace
  // means a clone. Opt in until that cost is measured rather than assumed.
  structuralChecks: "off" as const,
  // On by default: intent is bounded, boundary-tokened untrusted evidence,
  // and a reviewer that cannot read what the PR says it is doing reports
  // deliberate behaviour changes as regressions (issue #59).
  prIntent: "on" as const,
  suggestions: "on" as const,
  dryRun: false,
  trustLocalRules: false,
  dispatch: "direct" as const,
  context: "auto" as const,
  allowDegradedContext: false,
};

export function parseCommandArgs(argv: string[]): CommandArgs {
  const legacyReview = argv[0]?.startsWith("-") === true;
  const command = legacyReview ? "review" : argv[0];
  if (command !== "review" && command !== "poll") {
    throw new Error('Expected argv[0] to be the "review" or "poll" command');
  }

  const { values, positionals } = nodeParseArgs({
    args: legacyReview ? argv : argv.slice(1),
    allowPositionals: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      vcs: { type: "string" },
      "rules-dir": { type: "string" },
      "disable-builtin-rule": { type: "boolean" },
      advisor: { type: "string" },
      "dependency-facts": { type: "string" },
      "structural-checks": { type: "string" },
      "pr-intent": { type: "string" },
      suggestions: { type: "string" },
      model: { type: "string" },
      "dry-run": { type: "boolean" },
      "trust-local-rules": { type: "boolean" },
      "max-diff-chars": { type: "string" },
      dispatch: { type: "string" },
      context: { type: "string" },
      "context-mapper": { type: "string" },
      "context-max-chars": { type: "string" },
      "allow-degraded-context": { type: "boolean" },
      "context-dir": { type: "string" },
      "state-dir": { type: "string" },
      "codex-scan-results": { type: "string" },
    },
  });

  if (positionals.length !== 0) {
    throw new Error(`Unexpected positional argument: "${positionals[0]}"`);
  }

  if (command === "review" && !values.pr) {
    throw new Error(
      "Missing required argument: --pr <number> (usage: tgd-review-agent review --pr <number>)",
    );
  }
  if (command === "poll" && !values.repo) {
    throw new Error(
      "Missing required argument: --repo <owner/repo> (usage: tgd-review-agent poll --repo <owner/repo>)",
    );
  }
  if (command === "poll" && values.pr !== undefined) {
    throw new Error("Invalid argument for poll: --pr is only supported by the review command");
  }

  if (command === "review" && !/^\d+$/.test(values.pr as string)) {
    try {
      parseReviewTarget(values.pr as string);
    } catch {
      throw new Error(
        `Invalid --pr value: "${values.pr as string}" (expected a positive integer or complete GitHub/GitLab review URL)`,
      );
    }
  }

  const vcs = (values.vcs as string | undefined) ?? DEFAULTS.vcs;
  if (vcs !== "github" && vcs !== "gitlab") {
    throw new Error(`Invalid --vcs value: "${vcs}" (expected "github" or "gitlab")`);
  }

  const advisor = (values.advisor as string | undefined) ?? DEFAULTS.advisor;
  if (advisor !== "on" && advisor !== "off") {
    throw new Error(`Invalid --advisor value: "${advisor}" (expected "on" or "off")`);
  }

  const dependencyFacts =
    (values["dependency-facts"] as string | undefined) ?? DEFAULTS.dependencyFacts;
  if (dependencyFacts !== "on" && dependencyFacts !== "off") {
    throw new Error(
      `Invalid --dependency-facts value: "${dependencyFacts}" (expected "on" or "off")`,
    );
  }

  const structuralChecks =
    (values["structural-checks"] as string | undefined) ?? DEFAULTS.structuralChecks;
  if (structuralChecks !== "on" && structuralChecks !== "off") {
    throw new Error(
      `Invalid --structural-checks value: "${structuralChecks}" (expected "on" or "off")`,
    );
  }

  const prIntent = (values["pr-intent"] as string | undefined) ?? DEFAULTS.prIntent;
  if (prIntent !== "on" && prIntent !== "off") {
    throw new Error(`Invalid --pr-intent value: "${prIntent}" (expected "on" or "off")`);
  }

  const suggestions = (values.suggestions as string | undefined) ?? DEFAULTS.suggestions;
  if (suggestions !== "on" && suggestions !== "off") {
    throw new Error(`Invalid --suggestions value: "${suggestions}" (expected "on" or "off")`);
  }

  const dispatch = (values.dispatch as string | undefined) ?? DEFAULTS.dispatch;
  if (dispatch !== "direct" && dispatch !== "legacy") {
    throw new Error(`Invalid --dispatch value: "${dispatch}" (expected "direct" or "legacy")`);
  }

  const model = values.model as string | undefined;
  if (model !== undefined) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error(
        `Invalid --model value: "${model}" (expected "<provider>/<model>", e.g. "openai-codex/gpt-5.6-terra")`,
      );
    }
  }

  const maxDiffCharsRaw = values["max-diff-chars"] as string | undefined;
  let maxDiffChars: number | undefined;
  if (maxDiffCharsRaw !== undefined) {
    if (!/^\d+$/.test(maxDiffCharsRaw) || Number(maxDiffCharsRaw) === 0) {
      throw new Error(
        `Invalid --max-diff-chars value: "${maxDiffCharsRaw}" (expected a positive integer, e.g. --max-diff-chars 500000)`,
      );
    }
    maxDiffChars = Number(maxDiffCharsRaw);
  }

  const context = (values.context as string | undefined) ?? DEFAULTS.context;
  if (context !== "off" && context !== "auto" && context !== "require") {
    throw new Error(`Invalid --context value: "${context}" (expected "off", "auto" or "require")`);
  }

  // Issue #62: which ContextMapper implementation builds the index. "tgd" is
  // the model-driven default; "graphify" is the deterministic AST backend and
  // needs Python 3 + graphify on PATH.
  const contextMapper = (values["context-mapper"] as string | undefined) ?? "tgd";
  if (contextMapper !== "tgd" && contextMapper !== "graphify") {
    throw new Error(`Invalid --context-mapper value: "${contextMapper}" (expected "tgd" or "graphify")`);
  }

  const contextMaxCharsRaw = values["context-max-chars"] as string | undefined;
  let contextMaxChars: number | undefined;
  if (contextMaxCharsRaw !== undefined) {
    // Bounds are enforced by the pack builder itself; rejecting them here too
    // means an out-of-range value fails at the flag, naming the flag, instead
    // of surfacing later as a context that silently went unavailable.
    if (!/^\d+$/.test(contextMaxCharsRaw)) {
      throw new Error(
        `Invalid --context-max-chars value: "${contextMaxCharsRaw}" (expected a positive integer)`,
      );
    }
    contextMaxChars = Number(contextMaxCharsRaw);
    if (contextMaxChars < MIN_CONTEXT_MAX_CHARS || contextMaxChars > MAX_CONTEXT_MAX_CHARS) {
      throw new Error(
        `Invalid --context-max-chars value: "${contextMaxCharsRaw}" (expected ${MIN_CONTEXT_MAX_CHARS}-${MAX_CONTEXT_MAX_CHARS})`,
      );
    }
  }

  const contextDir = values["context-dir"] as string | undefined;
  if (contextDir !== undefined && (contextDir.length === 0 || !path.isAbsolute(contextDir))) {
    throw new Error(`Invalid --context-dir value: "${contextDir}" (expected an absolute path)`);
  }

  const stateDir = values["state-dir"] as string | undefined;
  if (stateDir !== undefined && (stateDir.length === 0 || !path.isAbsolute(stateDir))) {
    throw new Error(`Invalid --state-dir value: "${stateDir}" (expected an absolute path)`);
  }

  const codexScanResults = values["codex-scan-results"] as string | undefined;
  if (codexScanResults !== undefined && codexScanResults.length === 0) {
    throw new Error('Invalid --codex-scan-results value: expected a path');
  }

  const shared: SharedReviewOptions = {
    repo: values.repo as string | undefined,
    vcs,
    model,
    maxDiffChars,
    dispatch,
    context,
    contextMapper,
    contextMaxChars,
    allowDegradedContext:
      (values["allow-degraded-context"] as boolean | undefined) ?? DEFAULTS.allowDegradedContext,
    contextDir,
    rulesDir: (values["rules-dir"] as string | undefined) ?? DEFAULTS.rulesDir,
    disableBuiltinRule: (values["disable-builtin-rule"] as boolean | undefined) ?? DEFAULTS.disableBuiltinRule,
    advisor,
    dependencyFacts,
    structuralChecks,
    prIntent,
    suggestions,
    dryRun: (values["dry-run"] as boolean | undefined) ?? DEFAULTS.dryRun,
    trustLocalRules: (values["trust-local-rules"] as boolean | undefined) ?? DEFAULTS.trustLocalRules,
    stateDir,
    ...(codexScanResults === undefined ? {} : { codexScanResults }),
  };
  const result: CommandArgs = command === "review"
    ? { command, pr: values.pr as string, ...shared }
    : { command, ...shared, repo: values.repo as string };
  Object.defineProperty(result, "vcsExplicit", {
    value: values.vcs !== undefined,
    enumerable: false,
  });
  return result;
}
