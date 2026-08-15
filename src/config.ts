// Config resolution turns parsed CLI arguments into a normalized review
// locator and the concrete adapter for its provider.
//
// Both providers are selected only after target normalization: GitHub uses
// GitHubAdapter (`gh`-backed), and GitLab uses GitLabAdapter (`glab`-backed).
import type { ReviewArgs } from "./cli-args.js";
import { parseRepositoryRef, parseReviewTarget } from "./target/review-target.js";
import type { RepositoryRef } from "./target/types.js";
import type { ReviewLocator, VcsAdapter } from "./vcs/adapter.js";
import type { ConversationAdapter } from "./vcs/conversation-adapter.js";
import { GitHubAdapter } from "./vcs/github-adapter.js";
import { GitLabAdapter } from "./vcs/gitlab-adapter.js";

export type ReviewConfigArgs = Omit<ReviewArgs, "command"> & { command?: "review" };

export interface ResolvedConfig extends ReviewConfigArgs {
  readonly locator: ReviewLocator;
  readonly vcsAdapter: VcsAdapter;
}

type GitHubRepositoryEnvironment = Partial<Pick<
  NodeJS.ProcessEnv,
  "GH_REPO" | "GITHUB_REPOSITORY"
>>;

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

export function resolveReviewLocator(
  args: ReviewConfigArgs,
  environment: GitHubRepositoryEnvironment = process.env,
): ReviewLocator {
  if (/^\d+$/.test(args.pr)) {
    const number = Number(args.pr);
    const environmentRepo = args.vcs === "github"
      ? environment.GH_REPO ?? environment.GITHUB_REPOSITORY
      : undefined;
    const repository = args.repo ?? environmentRepo;
    if (repository !== undefined) {
      return {
        kind: "repository",
        repo: parseRepositoryRef(repository, args.vcs),
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

export function createProviderAdapter(repository: RepositoryRef): VcsAdapter & ConversationAdapter {
  if (repository.provider === "gitlab") {
    return new GitLabAdapter(undefined, repository);
  }
  return new GitHubAdapter(undefined, repository);
}

export function resolveConfig(args: ReviewConfigArgs): ResolvedConfig {
  const locator = resolveReviewLocator(args);
  if (locator.kind === "ambient") {
    return { ...args, locator, vcsAdapter: new GitHubAdapter() };
  }
  return { ...args, locator, vcsAdapter: createProviderAdapter(locator.repo) };
}
