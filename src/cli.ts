#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";

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
 * Entry point. Parses argv, prints the resolved config as JSON, and exits 0.
 * The actual `review` command logic (VCS fetch, rule dispatch, comment
 * posting) is implemented by later tasks, not here.
 */
export function main(argv: string[] = process.argv.slice(2)): void {
  try {
    const args = parseArgs(argv);
    console.log(JSON.stringify(args, null, 2));
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`tgd-review-agent: ${message}`);
    process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported for tests).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}
