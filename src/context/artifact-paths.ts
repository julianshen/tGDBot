// The mapping artifact layout, shared by the producer (`tgd-mapper.ts`) and the
// consumer (`prepare.ts`). Both need to agree on which relative path carries
// which `ArtifactKind`: the mapper writes them, and promotion has to declare a
// kind for every path it publishes. `MappingResult.artifactPaths` is a bare
// string list, so deriving the kind from the path — rather than from the order
// the mapper happened to emit them in — keeps the two sides honest.
import type { ArtifactInput, ArtifactKind } from "./types.js";

export const CONTEXT_PATH = "CONTEXT.md";
export const GRAPH_ROOT = ".understand-anything";
export const KNOWLEDGE_PATH = `${GRAPH_ROOT}/knowledge-graph.json`;
export const DOMAIN_PATH = `${GRAPH_ROOT}/domain-graph.json`;
export const ZERO_DOMAINS_PATH = `${GRAPH_ROOT}/zero-domains.json`;
export const METADATA_PATH = `${GRAPH_ROOT}/mapping-metadata.json`;

const KIND_BY_PATH: ReadonlyMap<string, ArtifactKind> = new Map([
  [CONTEXT_PATH, "context"],
  [KNOWLEDGE_PATH, "knowledge-graph"],
  [DOMAIN_PATH, "domain-graph"],
  [ZERO_DOMAINS_PATH, "zero-domains"],
  [METADATA_PATH, "mapping-metadata"],
]);

export function artifactKindForPath(artifactPath: string): ArtifactKind | undefined {
  return KIND_BY_PATH.get(artifactPath);
}

/**
 * Declares each mapped path with its kind, in the deterministic order
 * promotion digests them in. Throws on a path the layout does not define
 * rather than guessing a kind: an artifact published under the wrong kind
 * would be read back as the wrong thing.
 */
export function declareMappedArtifacts(artifactPaths: readonly string[]): ArtifactInput[] {
  return [...artifactPaths].sort().map((artifactPath) => {
    const kind = artifactKindForPath(artifactPath);
    if (kind === undefined) {
      throw new Error(`Mapping produced an artifact with no declared kind: ${artifactPath}`);
    }
    return { kind, path: artifactPath };
  });
}
