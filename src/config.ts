// Config resolution: turns the parsed CliArgs into a ResolvedConfig carrying
// a concrete VcsAdapter for the requested `--vcs` provider. See TASKS.md
// Task 8's technical design.
//
// v1 only implements the "github" provider (GitHubAdapter, `gh`-backed).
// GitLab is explicitly out of scope for this pass (SPEC.md/TASKS.md:
// "GitLab adapter excluded from this task list ... Phase 2 fast-follow") —
// requesting `--vcs gitlab` fails fast with a clear error rather than
// silently falling back to GitHub or constructing a non-functional adapter.
import type { CliArgs } from "./cli.js";
import type { VcsAdapter } from "./vcs/adapter.js";
import { GitHubAdapter } from "./vcs/github-adapter.js";

export interface ResolvedConfig extends CliArgs {
  vcsAdapter: VcsAdapter;
}

export function resolveConfig(args: CliArgs): ResolvedConfig {
  if (args.vcs === "gitlab") {
    throw new Error("GitLab support not yet implemented (Phase 2)");
  }

  // args.vcs is now narrowed to "github" — GitHubAdapter defaults its
  // execGh parameter to the real `gh`-CLI-backed implementation, so
  // production callers never need to pass one explicitly.
  return { ...args, vcsAdapter: new GitHubAdapter() };
}
