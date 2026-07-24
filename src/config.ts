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
import { parseRepositoryRef, parseReviewTarget } from "./target/review-target.js";
import type { ReviewLocator, VcsAdapter } from "./vcs/adapter.js";
import { GitHubAdapter } from "./vcs/github-adapter.js";

export interface ResolvedConfig extends CliArgs {
  readonly locator: ReviewLocator;
  readonly vcsAdapter: VcsAdapter;
}

export function resolveReviewLocator(args: CliArgs): ReviewLocator {
  if (/^\d+$/.test(args.pr)) {
    const number = Number(args.pr);
    if (args.repo !== undefined) {
      return {
        kind: "repository",
        repo: parseRepositoryRef(args.repo, args.vcs),
        number,
      };
    }
    if (args.vcs === "gitlab") {
      throw new Error("Numeric GitLab review targets require --repo");
    }
    return { kind: "ambient", provider: "github", number };
  }

  const target = parseReviewTarget(args.pr);
  if (args.vcsExplicit === true && args.vcs !== target.provider) {
    throw new Error(
      `Review URL provider ${target.provider} does not match explicit --vcs ${args.vcs}`,
    );
  }
  if (args.repo !== undefined) {
    const repoProvider = args.vcsExplicit === true ? args.vcs : target.provider;
    const repo = parseRepositoryRef(args.repo, repoProvider);
    if (repo.provider !== target.repo.provider || repo.canonicalUrl !== target.repo.canonicalUrl) {
      throw new Error("Review URL repository does not match explicit --repo");
    }
  }
  return { kind: "repository", repo: target.repo, number: target.number };
}

export function resolveConfig(args: CliArgs): ResolvedConfig {
  const locator = resolveReviewLocator(args);
  const provider = locator.kind === "ambient" ? locator.provider : locator.repo.provider;
  if (provider === "gitlab") {
    throw new Error("GitLab support not yet implemented (Phase 2)");
  }

  // args.vcs is now narrowed to "github" — GitHubAdapter defaults its
  // execGh parameter to the real `gh`-CLI-backed implementation, so
  // production callers never need to pass one explicitly.
  return { ...args, locator, vcsAdapter: new GitHubAdapter() };
}
