export type ReviewProvider = "github" | "gitlab";

export interface GitHubRepositoryRef {
  readonly provider: "github";
  readonly host: "github.com";
  readonly owner: string;
  readonly repo: string;
  readonly canonicalUrl: string;
}

export interface GitLabRepositoryRef {
  readonly provider: "gitlab";
  readonly host: string;
  readonly port?: number;
  readonly namespace: readonly string[];
  readonly repo: string;
  readonly canonicalUrl: string;
}

export type RepositoryRef = GitHubRepositoryRef | GitLabRepositoryRef;

export interface ReviewTarget {
  readonly provider: ReviewProvider;
  readonly repo: RepositoryRef;
  readonly number: number;
  readonly canonicalUrl: string;
}
