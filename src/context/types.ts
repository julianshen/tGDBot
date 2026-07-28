import type { RepositoryRef } from "../target/types.js";

export interface GitHubContextCacheKey {
  provider: "github";
  host: string;
  owner: string;
  repo: string;
  baseSha: string;
  schemaVersion: number;
  tgdVersion: string;
  policyVersion: string;
}

export interface GitLabContextCacheKey {
  provider: "gitlab";
  host: string;
  port?: number;
  namespace: readonly string[];
  repo: string;
  baseSha: string;
  schemaVersion: number;
  tgdVersion: string;
  policyVersion: string;
}

export type ContextCacheKey = GitHubContextCacheKey | GitLabContextCacheKey;

export type ContextCacheVersionIdentity = Pick<
  ContextCacheKey,
  "baseSha" | "schemaVersion" | "tgdVersion" | "policyVersion"
>;

type RepositoryLabelIdentity =
  | Pick<Extract<RepositoryRef | ContextCacheKey, { provider: "github" }>, "provider" | "host" | "owner" | "repo">
  | Pick<
      Extract<RepositoryRef | ContextCacheKey, { provider: "gitlab" }>,
      "provider" | "host" | "port" | "namespace" | "repo"
    >;

export function repositoryLabel(repository: RepositoryLabelIdentity): string {
  if (repository.provider === "github") {
    return `${repository.host}/${repository.owner}/${repository.repo}`;
  }
  const authority = repository.port === undefined ? repository.host : `${repository.host}:${repository.port}`;
  return `${authority}/${[...repository.namespace, repository.repo].join("/")}`;
}

export function contextCacheKeyForRepository(
  repository: RepositoryRef,
  identity: ContextCacheVersionIdentity,
): ContextCacheKey {
  if (repository.provider === "github") {
    return {
      provider: repository.provider,
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
      ...identity,
    };
  }
  return {
    provider: repository.provider,
    host: repository.host,
    ...(repository.port === undefined ? {} : { port: repository.port }),
    namespace: repository.namespace,
    repo: repository.repo,
    ...identity,
  };
}

export type ArtifactKind =
  | "context"
  | "knowledge-graph"
  | "domain-graph"
  | "zero-domains"
  | "mapping-metadata";

export interface ArtifactInput {
  kind: ArtifactKind;
  path: string;
}

export interface ArtifactRecord extends ArtifactInput {
  sha256: string;
}

export interface DocumentInput {
  kind: "business-reference";
  path: string;
}

export interface DocumentRecord extends DocumentInput {
  sha256: string;
}

export interface ContextManifestInput {
  key: ContextCacheKey;
  /** Stable producer timestamp. It participates in manifestHash. */
  createdAt: string;
  artifacts: ArtifactInput[];
  documents?: DocumentInput[];
  degradedReasons?: string[];
}

export interface ContextManifest {
  version: 1;
  status: "ready";
  key: ContextCacheKey;
  createdAt: string;
  manifestHash: string;
  artifacts: ArtifactRecord[];
  documents: DocumentRecord[];
  degradedReasons: string[];
}

export interface ContextLookupOptions {
  /** Return a miss without deleting or mutating a reusable entry. */
  forceRemap?: boolean;
}

/**
 * Mapping completion marker produced alongside the graphs.
 * The analyzed base SHA is the provenance link to ContextCacheKey.baseSha.
 */
export interface MappingMetadata {
  version: 1;
  status: "complete";
  baseSha: string;
}

/** Explicit alternative to producing a domain graph. */
export interface ZeroDomainsMarker {
  version: 1;
  status: "zero-domains";
}
