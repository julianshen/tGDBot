// Issue #60: patch a cached context entry instead of re-deriving it.
//
// The property that makes this honest: the merged graph differs from the
// parent by exactly three kinds of edit, each traceable to the measured
// delta —
//
//   1. nodes whose file is gone or changed are DROPPED (a stale node whose
//      file changed is worse than no node: it names a shape the tree no
//      longer has),
//   2. distance-1 neighbours of a dropped node are marked `stale` (their own
//      file is untouched, but a summary written before a neighbour changed
//      may name relationships that no longer hold — the reviewer weighs the
//      marker),
//   3. nodes for the changed/added paths come from a mapper session SCOPED to
//      those paths, and ONLY nodes naming a delta path are merged in — a
//      scoped session that overreaches cannot widen the graph beyond the
//      delta.
//
// The domain graph is never patched: the classification gate refuses the
// incremental path when any delta path is named by a flow step, so the cached
// domain graph is untouched by construction. When that gate is wrong, the
// cost is a stale domain statement inside a pack that is otherwise correct —
// the failure mode the issue weighs against publishing nothing.
//
// Provenance is carried, not laundered: the published manifest names the SHA
// the graphs were ORIGINALLY built from where that is still true, and the
// header says so. A reviewer who knows a node is stale can weigh it; a
// reviewer given a silently-outdated graph as trusted context cannot.

import { Buffer } from "node:buffer";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { MAX_JSON_ARTIFACT_BYTES } from "./artifact-validator.js";
import path from "node:path";
import { CONTEXT_PATH, DOMAIN_PATH, KNOWLEDGE_PATH, METADATA_PATH, ZERO_DOMAINS_PATH } from "./artifact-paths.js";
import type { BaseDelta } from "./delta.js";

export interface GraphNodeLike {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly summary: string;
  readonly filePath?: string;
  readonly stale?: boolean;
}

export interface GraphLike {
  readonly nodes: GraphNodeLike[];
  readonly edges: ReadonlyArray<{ source: string; target: string; type: string; weight: number }>;
}

export interface IncrementalPatchInput {
  /** The published entry the cached graphs are read from. */
  readonly entryRoot: string;
  /** Fresh staging directory the patched artifacts are written into. */
  readonly stagingPath: string;
  readonly manifest: {
    readonly builtFromSha: string;
  };
  readonly delta: BaseDelta;
  /**
   * True when the delta contained paths that needed a scoped re-map (added or
   * changed). A deletion-only delta legitimately runs no scoped session, so
   * it must not be labelled as one that failed (PR #107 review, round three).
   */
  readonly scopedMapRequired?: boolean;
  /**
   * True when the cached entry carries the explicit zero-domains marker
   * instead of a domain graph (#60 — PR #107 review). The patch then carries
   * the marker forward untouched: there is no domain statement to gate or
   * repin, and the knowledge graph is patched exactly as always.
   */
  readonly zeroDomains?: boolean;
  /**
   * Present when the cached CONTEXT.md is SYNTHESIZED from the graph (the
   * graphify mapper, #62): the patch regenerates it from the patched graph
   * instead of carrying forward counts and a provenance sentence that
   * describe the parent entry. Absent means carry forward verbatim, which is
   * right for a hand- or agent-authored document.
   */
  readonly synthesizeContext?: (input: {
    readonly graph: GraphLike;
    readonly toSha: string;
  }) => string;
  /**
   * The scoped sub-map's knowledge graph — nodes and edges the mapper produced
   * for the delta paths at the NEW base. May be undefined when the scoped
   * session degraded; the patch then ships dropped-and-marked, and says so.
   */
  readonly scopedGraph?: GraphLike;
}

export interface IncrementalPatchResult {
  readonly artifactPaths: readonly string[];
  readonly degradedReasons: readonly string[];
  /** Count of nodes marked stale — for the progress log, not the pack. */
  readonly staleMarked: number;
  /** Count of nodes merged from the scoped sub-map. */
  readonly merged: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Repository-relative POSIX normalization for delta and graph paths, matching
 * how the pack normalizes node file paths — the join key between "what the
 * delta touched" and "which nodes describe that file" must be computed the
 * same way on both sides or a stale node reads as current.
 */
function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^[a-z]:/iu.test(normalized) ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}

export function domainStepPaths(graph: GraphLike): Set<string> {
  const steps = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type === "step" && node.filePath !== undefined) {
      const normalized = normalizePath(node.filePath);
      if (normalized !== undefined) steps.add(normalized);
    }
  }
  return steps;
}

/**
 * The domain-graph flow-step paths of a cached entry, for the delta gate.
 * An EMPTY set is a valid answer — a zero-domains entry names no flow steps,
 * so nothing can cross the gate. `undefined` means the domain state could not
 * be read — the caller cannot verify the gate and must take the full-map path
 * rather than assume it.
 */
export async function loadDomainStepPaths(
  entryRoot: string,
  options: { readonly zeroDomains?: boolean } = {},
): Promise<Set<string> | undefined> {
  if (options.zeroDomains === true) return new Set();
  try {
    return domainStepPaths(await readGraph(path.join(entryRoot, DOMAIN_PATH)));
  } catch {
    return undefined;
  }
}

async function readGraph(graphPath: string): Promise<GraphLike> {
  const contents = await readFile(graphPath, "utf8");
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error(`Cached graph is not a node/edge document: ${graphPath}`);
  }
  return parsed as unknown as GraphLike;
}

async function writeGraph(graphPath: string, graph: GraphLike): Promise<void> {
  // Serialized COMPACTLY and bounded before writing: pretty-printing added
  // enough whitespace that a graph whose compact form sat just under the
  // validator's ceiling crossed it on the next incremental rewrite, and
  // every later patch then failed publication the same way (PR #116 review,
  // round two). The error is deliberately a clear failure, not a silent
  // skip: prepare reports it and the review proceeds without context.
  const serialized = `${JSON.stringify(graph)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_ARTIFACT_BYTES) {
    throw new Error(`patched graph exceeds the ${MAX_JSON_ARTIFACT_BYTES}-byte safe-size limit; a full re-map is required`);
  }
  await mkdir(path.dirname(graphPath), { recursive: true });
  await writeFile(graphPath, serialized, "utf8");
}

/**
 * Patches the cached knowledge graph for one delta and merges the scoped
 * sub-map in. See the module comment for the three-edit property.
 */
export function patchKnowledgeGraph(
  cached: GraphLike,
  delta: BaseDelta,
  scopedGraph: GraphLike | undefined,
): { graph: GraphLike; droppedIds: ReadonlySet<string>; staleMarked: number; merged: number } {
  const changedPaths = new Set<string>(
    [...delta.added, ...delta.changed, ...delta.deleted]
      .map((filePath) => normalizePath(filePath))
      .filter((filePath): filePath is string => filePath !== undefined),
  );

  const droppedIds = new Set(
    cached.nodes
      .filter((node) => node.filePath !== undefined && changedPaths.has(normalizePath(node.filePath) ?? "\u0000"))
      .map((node) => node.id),
  );
  // Neighbours BEFORE edges are dropped: distance 1 to anything the delta
  // erased, regardless of edge direction.
  const neighbourIds = new Set<string>();
  for (const edge of cached.edges) {
    if (droppedIds.has(edge.source) && !droppedIds.has(edge.target)) neighbourIds.add(edge.target);
    if (droppedIds.has(edge.target) && !droppedIds.has(edge.source)) neighbourIds.add(edge.source);
  }

  const nodes = cached.nodes
    .filter((node) => !droppedIds.has(node.id))
    .map((node) => (neighbourIds.has(node.id) && node.stale !== true ? { ...node, stale: true } : node));
  const staleMarked = nodes.filter((node) => node.stale === true).length;
  const edgeKey = (edge: { source: string; target: string; type: string }): string =>
    `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
  // Seeded from the RETAINED edges, not all cached ones: an edge that touched
  // a dropped node has been removed, and a scoped session that re-creates the
  // dropped node under the same id must be able to reconnect it — seeding
  // from the cached set would treat the new edge as a duplicate and silently
  // leave the remapped node disconnected (PR #107 review).
  const edges = cached.edges.filter((edge) => !droppedIds.has(edge.source) && !droppedIds.has(edge.target));
  const seenEdges = new Set(edges.map(edgeKey));

  // Merge the scoped sub-map: only nodes naming a delta path enter, so an
  // overreaching scoped session cannot widen the graph beyond the delta.
  let merged = 0;
  const knownIds = new Set(nodes.map((node) => node.id));
  const scopedNodes: GraphNodeLike[] = [];
  // The ids actually admitted from the scoped map. Edge admission requires one
  // of these as an endpoint: both-endpoints-cached edges would let an
  // overreaching scoped session fabricate relationships between unchanged
  // files — graph regions the delta never touched (PR #107 review, round four).
  const scopedNodeIds = new Set<string>();
  for (const node of scopedGraph?.nodes ?? []) {
    if (node.filePath === undefined) continue;
    const normalized = normalizePath(node.filePath);
    if (normalized === undefined || !changedPaths.has(normalized)) continue;
    if (knownIds.has(node.id)) continue;
    knownIds.add(node.id);
    scopedNodeIds.add(node.id);
    scopedNodes.push(node);
    merged += 1;
  }
  for (const edge of scopedGraph?.edges ?? []) {
    if (seenEdges.has(edgeKey(edge))) continue;
    if (!knownIds.has(edge.source) || !knownIds.has(edge.target)) continue;
    if (!scopedNodeIds.has(edge.source) && !scopedNodeIds.has(edge.target)) continue;
    seenEdges.add(edgeKey(edge));
    edges.push(edge);
  }

  return {
    graph: { nodes: [...nodes, ...scopedNodes], edges },
    droppedIds,
    staleMarked,
    merged,
  };
}

/**
 * Rewrites the document-level base-commit pins and prunes dangling
 * references, so the patched graphs pass the same schema validation the
 * mapper's output passes: `project.gitCommitHash` must equal the manifest's
 * provenance SHA, and every `layers`/`tour` entry must reference a surviving
 * node. Content is otherwise untouched — layers and tour keep their order and
 * membership for everything that survived the delta.
 */
function repinGraphDocument(document: Record<string, unknown>, toSha: string, droppedIds: ReadonlySet<string>): void {
  if (isRecord(document.project)) {
    document.project.gitCommitHash = toSha;
  }
  for (const key of ["layers", "tour"] as const) {
    const groups = document[key];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !isStringArray(group.nodeIds)) continue;
      group.nodeIds = group.nodeIds.filter((id) => !droppedIds.has(id));
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Produces a patched artifact set in `stagingPath` from the cached entry and
 * the scoped sub-map. The returned paths use the same layout the mapper
 * writes, so promotion declares them identically.
 */
export async function patchEntryArtifacts(
  input: IncrementalPatchInput,
): Promise<IncrementalPatchResult> {
  const cachedKnowledgeDocument = JSON.parse(
    await readFile(path.join(input.entryRoot, KNOWLEDGE_PATH), "utf8"),
  ) as Record<string, unknown>;
  if (!isRecord(cachedKnowledgeDocument) || !Array.isArray(cachedKnowledgeDocument.nodes) || !Array.isArray(cachedKnowledgeDocument.edges)) {
    throw new Error("Cached knowledge graph is not a node/edge document");
  }
  const patched = patchKnowledgeGraph(
    cachedKnowledgeDocument as unknown as GraphLike,
    input.delta,
    input.scopedGraph,
  );
  const knowledgeDocument = cachedKnowledgeDocument as Record<string, unknown>;
  knowledgeDocument.nodes = patched.graph.nodes;
  knowledgeDocument.edges = patched.graph.edges;
  repinGraphDocument(knowledgeDocument, input.delta.toSha, patched.droppedIds);
  // Written from the FULL document — project, layers and tour travel with it
  // — not the trimmed nodes/edges pair.
  await writeGraph(path.join(input.stagingPath, KNOWLEDGE_PATH), knowledgeDocument as unknown as GraphLike);

  // The domain half is carried, not patched: with a domain graph the
  // classification gate guarantees no flow-step file changed, so the document
  // is content-identical and only its provenance pin moves. A zero-domains
  // entry has no domain statement at all — the marker travels verbatim
  // (PR #107 review: zero-domain repositories must not be locked out of the
  // incremental path).
  if (input.zeroDomains === true) {
    await copyFile(
      path.join(input.entryRoot, ZERO_DOMAINS_PATH),
      path.join(input.stagingPath, ZERO_DOMAINS_PATH),
    );
  } else {
    const domainDocument = JSON.parse(
      await readFile(path.join(input.entryRoot, DOMAIN_PATH), "utf8"),
    ) as Record<string, unknown>;
    if (!isRecord(domainDocument)) {
      throw new Error("Cached domain graph is not a JSON object");
    }
    repinGraphDocument(domainDocument, input.delta.toSha, new Set());
    await writeGraph(path.join(input.stagingPath, DOMAIN_PATH), domainDocument as unknown as GraphLike);
  }
  if (input.synthesizeContext === undefined) {
    await copyFile(path.join(input.entryRoot, CONTEXT_PATH), path.join(input.stagingPath, CONTEXT_PATH));
  } else {
    // A synthesized document must describe the PATCHED graph: regenerate it
    // from the merged nodes and edges, or its counts and provenance sentence
    // keep describing the parent entry forever (PR #116 review, round two).
    await writeFile(
      path.join(input.stagingPath, CONTEXT_PATH),
      input.synthesizeContext({ graph: patched.graph, toSha: input.delta.toSha }),
      "utf8",
    );
  }
  await writeFile(
    path.join(input.stagingPath, METADATA_PATH),
    `${JSON.stringify({ version: 1, status: "complete", baseSha: input.delta.toSha }, null, 2)}\n`,
    "utf8",
  );

  // Only a delta that NEEDED a scoped re-map can have failed to produce one.
  // A deletion-only delta runs no session at all, and labelling it degraded
  // would poison every later patch, which inherits this manifest's reasons.
  const degradedReasons = input.scopedGraph === undefined && input.scopedMapRequired === true
    ? ["incremental-patch: the scoped re-map did not produce a usable graph; changed files are represented only by stale marks"]
    : [];
  return {
    artifactPaths: input.zeroDomains === true
      ? [CONTEXT_PATH, ZERO_DOMAINS_PATH, KNOWLEDGE_PATH, METADATA_PATH]
      : [CONTEXT_PATH, DOMAIN_PATH, KNOWLEDGE_PATH, METADATA_PATH],
    degradedReasons,
    staleMarked: patched.staleMarked,
    merged: patched.merged,
  };
}
