// Issue #60: patching a cached entry's artifacts from a measured delta plus a
// scoped sub-map. The three-edit property is what these tests pin: drop nodes
// whose file changed, mark distance-1 neighbours stale, and merge ONLY the
// scoped nodes that name a delta path.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchEntryArtifacts, patchKnowledgeGraph, type GraphLike } from "../../../src/context/incremental.js";
import {
  CONTEXT_PATH,
  DOMAIN_PATH,
  KNOWLEDGE_PATH,
  METADATA_PATH,
} from "../../../src/context/artifact-paths.js";
import type { BaseDelta } from "../../../src/context/delta.js";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function delta(over: Partial<BaseDelta> = {}): BaseDelta {
  return {
    fromSha: FROM,
    toSha: TO,
    commitCount: 1,
    added: [],
    changed: [],
    deleted: [],
    ...over,
  };
}

function node(id: string, filePath?: string): Record<string, unknown> {
  return {
    id,
    type: "function",
    name: id,
    ...(filePath === undefined ? {} : { filePath }),
    lineRange: [1, 2],
    summary: `summary of ${id}`,
    tags: [],
    complexity: "simple",
  };
}

function edge(source: string, target: string, type = "calls"): Record<string, unknown> {
  return { source, target, type, direction: "forward", weight: 0.5 };
}

function knowledgeGraph(nodes: unknown[], edges: unknown[]): Record<string, unknown> {
  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "octo-repo",
      languages: ["typescript"],
      frameworks: [],
      description: "Trusted test repository",
      analyzedAt: "2026-07-21T00:00:00.000Z",
      gitCommitHash: FROM,
    },
    nodes,
    edges,
    layers: [{ id: "layer:all", name: "All", description: "Everything", nodeIds: ["fn:kept", "fn:dropped"] }],
    tour: [{ order: 1, title: "Tour", description: "d", nodeIds: ["fn:kept", "fn:only-in-tour", "fn:dropped"] }],
  };
}

describe("patchKnowledgeGraph", () => {
  it("drops nodes whose file changed or was deleted, and their edges", () => {
    const cached = {
      nodes: [
        node("fn:kept", "src/kept.ts"),
        node("fn:dropped", "src/changed.ts"),
        node("fn:unlinked", "src/gone.ts"),
      ],
      edges: [edge("fn:kept", "fn:dropped"), edge("fn:kept", "fn:unlinked")],
    };
    const patched = patchKnowledgeGraph(
      cached as unknown as GraphLike,
      delta({ changed: ["src/changed.ts"], deleted: ["src/gone.ts"] }),
      undefined,
    );
    expect(patched.graph.nodes.map((n) => n.id)).toEqual(["fn:kept"]);
    expect(patched.graph.edges).toEqual([]);
  });

  it("marks distance-1 neighbours of a dropped node stale, in both edge directions", () => {
    const cached = {
      nodes: [
        node("fn:neighbour", "src/kept.ts"),
        node("fn:dropped", "src/changed.ts"),
        node("fn:other-neighbour", "src/other.ts"),
      ],
      edges: [edge("fn:neighbour", "fn:dropped"), edge("fn:dropped", "fn:other-neighbour")],
    };
    const patched = patchKnowledgeGraph(cached as unknown as GraphLike, delta({ changed: ["src/changed.ts"] }), undefined);
    const byId = new Map(patched.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("fn:neighbour")?.stale).toBe(true);
    expect(byId.get("fn:other-neighbour")?.stale).toBe(true);
    expect(patched.staleMarked).toBe(2);
  });

  it("merges scoped nodes only when they name a delta path, and their edges to known nodes", () => {
    const cached = {
      nodes: [node("fn:kept", "src/kept.ts")],
      edges: [],
    };
    const scoped = {
      nodes: [
        node("fn:in-scope", "src/changed.ts"),
        node("fn:out-of-scope", "src/somewhere-else.ts"),
        node("fn:duplicate", "src/kept.ts"),
      ],
      edges: [edge("fn:in-scope", "fn:kept"), edge("fn:in-scope", "fn:out-of-scope")],
    };
    const patched = patchKnowledgeGraph(
      cached as unknown as GraphLike,
      delta({ changed: ["src/changed.ts"] }),
      scoped as unknown as GraphLike,
    );
    const ids = patched.graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["fn:in-scope", "fn:kept"]);
    expect(patched.merged).toBe(1);
    // The edge into the graph survives; the edge to a node outside the merged
    // graph is dropped.
    expect(patched.graph.edges).toEqual([edge("fn:in-scope", "fn:kept")]);
  });

  it("leaves a scoped node untouched when it is already stale-marked in the parent", () => {
    const cached = {
      nodes: [{ ...node("fn:kept", "src/kept.ts"), stale: true }],
      edges: [],
    };
    const patched = patchKnowledgeGraph(
      cached as unknown as GraphLike,
      delta({ changed: ["src/changed.ts"] }),
      { nodes: [node("fn:kept", "src/kept.ts")], edges: [] } as unknown as GraphLike,
    );
    expect(patched.graph.nodes).toHaveLength(1);
    expect(patched.graph.nodes[0]?.stale).toBe(true);
    expect(patched.merged).toBe(0);
  });
});

describe("patchEntryArtifacts", () => {
  it("writes the full artifact layout with repinned provenance and pruned references", async () => {
    const entryRoot = await tempRoot("incremental-entry-");
    const stagingPath = await tempRoot("incremental-staging-");
    await mkdir(path.join(entryRoot, ".understand-anything"), { recursive: true });
    await writeFile(path.join(entryRoot, KNOWLEDGE_PATH), JSON.stringify(
      knowledgeGraph(
        [node("fn:kept", "src/kept.ts"), node("fn:dropped", "src/changed.ts"), node("fn:only-in-tour", "src/only.ts")],
        [],
      ),
    ));
    await writeFile(path.join(entryRoot, DOMAIN_PATH), JSON.stringify({
      version: "1.0.0",
      project: { name: "octo-repo", gitCommitHash: FROM },
      nodes: [{ id: "step:s", type: "step", name: "s", filePath: "src/kept.ts", summary: "s" }],
      edges: [], layers: [], tour: [],
    }));
    await writeFile(path.join(entryRoot, CONTEXT_PATH), "# Trusted context\n", "utf8");

    const result = await patchEntryArtifacts({
      entryRoot,
      stagingPath,
      manifest: { builtFromSha: FROM },
      delta: delta({ changed: ["src/changed.ts"] }),
      scopedGraph: { nodes: [node("fn:new", "src/changed.ts")], edges: [] } as unknown as GraphLike,
    });

    expect(result.artifactPaths).toEqual([CONTEXT_PATH, DOMAIN_PATH, KNOWLEDGE_PATH, METADATA_PATH]);
    expect(result.degradedReasons).toEqual([]);
    expect(result.merged).toBe(1);

    const patchedKnowledge = JSON.parse(await readFile(path.join(stagingPath, KNOWLEDGE_PATH), "utf8"));
    // The document pins the commit its STATE corresponds to, and the layers
    // and tour no longer name a node the delta erased.
    expect(patchedKnowledge.project.gitCommitHash).toBe(TO);
    expect(patchedKnowledge.layers[0].nodeIds).toEqual(["fn:kept"]);
    expect(patchedKnowledge.tour[0].nodeIds).toEqual(["fn:kept", "fn:only-in-tour"]);
    expect(patchedKnowledge.nodes.map((n: { id: string }) => n.id).sort()).toEqual([
      "fn:kept", "fn:new", "fn:only-in-tour",
    ]);

    // The domain graph was not touched by the gate, but its provenance pin is
    // rewritten to match the published manifest.
    const patchedDomain = JSON.parse(await readFile(path.join(stagingPath, DOMAIN_PATH), "utf8"));
    expect(patchedDomain.project.gitCommitHash).toBe(TO);
    expect(patchedDomain.nodes[0].filePath).toBe("src/kept.ts");

    const metadata = JSON.parse(await readFile(path.join(stagingPath, METADATA_PATH), "utf8"));
    expect(metadata).toEqual({ version: 1, status: "complete", baseSha: TO });
    await expect(readFile(path.join(stagingPath, CONTEXT_PATH), "utf8")).resolves.toBe("# Trusted context\n");
  });

  it("states the missing scoped re-map as a degraded reason rather than silently dropping it", async () => {
    const entryRoot = await tempRoot("incremental-entry-");
    const stagingPath = await tempRoot("incremental-staging-");
    await mkdir(path.join(entryRoot, ".understand-anything"), { recursive: true });
    await writeFile(path.join(entryRoot, KNOWLEDGE_PATH), JSON.stringify(
      knowledgeGraph([node("fn:kept", "src/kept.ts")], []),
    ));
    await writeFile(path.join(entryRoot, DOMAIN_PATH), JSON.stringify({
      version: "1.0.0", project: { name: "octo-repo", gitCommitHash: FROM }, nodes: [], edges: [], layers: [], tour: [],
    }));
    await writeFile(path.join(entryRoot, CONTEXT_PATH), "# Trusted context\n", "utf8");

    const result = await patchEntryArtifacts({
      entryRoot,
      stagingPath,
      manifest: { builtFromSha: FROM },
      delta: delta({ changed: ["src/changed.ts"] }),
    });

    expect(result.merged).toBe(0);
    expect(result.degradedReasons.join(" ")).toMatch(/scoped re-map/i);
  });
});
