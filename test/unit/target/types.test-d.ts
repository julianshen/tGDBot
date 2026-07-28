import { expectTypeOf } from "vitest";
import type {
  GitHubRepositoryRef,
  GitLabRepositoryRef,
  ReviewTarget,
} from "../../../src/target/types.js";

declare const target: ReviewTarget;

if (target.provider === "github") {
  expectTypeOf(target.repo).toEqualTypeOf<GitHubRepositoryRef>();
} else {
  expectTypeOf(target.repo).toEqualTypeOf<GitLabRepositoryRef>();
}

declare const githubRepo: GitHubRepositoryRef;
declare const gitlabRepo: GitLabRepositoryRef;

// @ts-expect-error GitHub targets cannot contain GitLab repository references.
const mismatchedGitHubTarget: ReviewTarget = {
  provider: "github",
  repo: gitlabRepo,
  number: 1,
  canonicalUrl: "https://github.com/acme/project/pull/1",
};

// @ts-expect-error GitLab targets cannot contain GitHub repository references.
const mismatchedGitLabTarget: ReviewTarget = {
  provider: "gitlab",
  repo: githubRepo,
  number: 1,
  canonicalUrl: "https://gitlab.com/acme/project/-/merge_requests/1",
};

void mismatchedGitHubTarget;
void mismatchedGitLabTarget;
