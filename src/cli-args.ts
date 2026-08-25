import path from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { parseReviewTarget } from "./target/review-target.js";

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
  /** Controls whether findings may render committable suggestion blocks. */
  suggestions: "on" | "off";
  dryRun: boolean;
  /** Opts into loading rules from the local filesystem instead of the trusted base branch. */
  trustLocalRules: boolean;
  /** Selects direct deterministic rule dispatch or the temporary legacy orchestrator. */
  dispatch: "direct" | "legacy";
  /** Hard diff-size cost ceiling; absent means unlimited. */
  maxDiffChars?: number;
  stateDir?: string;
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
  suggestions: "on" as const,
  dryRun: false,
  trustLocalRules: false,
  dispatch: "direct" as const,
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
      suggestions: { type: "string" },
      model: { type: "string" },
      "dry-run": { type: "boolean" },
      "trust-local-rules": { type: "boolean" },
      "max-diff-chars": { type: "string" },
      dispatch: { type: "string" },
      "state-dir": { type: "string" },
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

  const stateDir = values["state-dir"] as string | undefined;
  if (stateDir !== undefined && (stateDir.length === 0 || !path.isAbsolute(stateDir))) {
    throw new Error(`Invalid --state-dir value: "${stateDir}" (expected an absolute path)`);
  }

  const shared: SharedReviewOptions = {
    repo: values.repo as string | undefined,
    vcs,
    model,
    maxDiffChars,
    dispatch,
    rulesDir: (values["rules-dir"] as string | undefined) ?? DEFAULTS.rulesDir,
    disableBuiltinRule: (values["disable-builtin-rule"] as boolean | undefined) ?? DEFAULTS.disableBuiltinRule,
    advisor,
    dependencyFacts,
    suggestions,
    dryRun: (values["dry-run"] as boolean | undefined) ?? DEFAULTS.dryRun,
    trustLocalRules: (values["trust-local-rules"] as boolean | undefined) ?? DEFAULTS.trustLocalRules,
    stateDir,
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
