// Config resolution turns parsed CLI arguments into a normalized review
// locator and the concrete adapter for its provider.
//
// Both providers are selected only after target normalization: GitHub uses
// GitHubAdapter (`gh`-backed), and GitLab uses GitLabAdapter (`glab`-backed).
import type { CliArgs } from "./cli.js";
import { parseRepositoryRef, parseReviewTarget } from "./target/review-target.js";
import type { RepositoryRef } from "./target/types.js";
import type { ReviewLocator, VcsAdapter } from "./vcs/adapter.js";
import { GitHubAdapter } from "./vcs/github-adapter.js";
import { GitLabAdapter } from "./vcs/gitlab-adapter.js";

export interface ResolvedConfig extends CliArgs {
  readonly locator: ReviewLocator;
  readonly vcsAdapter: VcsAdapter;
}

function repositoriesMatch(
  left: RepositoryRef,
  right: RepositoryRef,
): boolean {
  if (left.provider !== right.provider) return false;
  return left.provider === "github" && right.provider === "github"
    ? left.host === right.host &&
        left.owner.toLowerCase() === right.owner.toLowerCase() &&
        left.repo.toLowerCase() === right.repo.toLowerCase()
    : left.canonicalUrl === right.canonicalUrl;
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
    if (!repositoriesMatch(repo, target.repo)) {
      throw new Error("Review URL repository does not match explicit --repo");
    }
  }
  return { kind: "repository", repo: target.repo, number: target.number };
}

export function resolveConfig(args: CliArgs): ResolvedConfig {
  const locator = resolveReviewLocator(args);
  const provider = locator.kind === "ambient" ? locator.provider : locator.repo.provider;
  if (provider === "gitlab") {
    return { ...args, locator, vcsAdapter: new GitLabAdapter() };
  }

  // GitHubAdapter defaults to the real `gh`-backed executor.
  return { ...args, locator, vcsAdapter: new GitHubAdapter() };
}
