import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextCache,
  ContextCacheConflictError,
  computeManifestHash,
} from "../../../src/context/cache.js";
import type { ContextCacheDependencies } from "../../../src/context/cache.js";
import { ContextValidationError, digestArtifactInputs } from "../../../src/context/artifact-validator.js";
import type {
  ContextCacheKey,
  ContextManifest,
  ContextManifestInput,
} from "../../../src/context/types.js";

const key: ContextCacheKey = {
  provider: "github",
  host: "github.com",
  owner: "octo-org",
  repo: "octo-repo",
  baseSha: "def4567890def4567890def4567890def4567890",
  schemaVersion: 1,
  tgdVersion: "0.1.0",
  policyVersion: "2026-07-18",
};
const createdAt = "2026-07-18T08:00:00.000Z";
const roots: string[] = [];

function knowledgeGraph(): Record<string, unknown> {
  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "octo-repo",
      languages: ["typescript"],
      frameworks: [],
      description: "Trusted test repository",
      analyzedAt: createdAt,
      gitCommitHash: key.baseSha,
    },
    nodes: [
      {
        id: "file:src/index.ts",
        type: "file",
        name: "index.ts",
        filePath: "src/index.ts",
        lineRange: [1, 8],
        summary: "Application entry point",
        tags: ["entry-point"],
        complexity: "simple",
      },
      {
        id: "function:main",
        type: "function",
        name: "main",
        filePath: "src/index.ts",
        lineRange: [2, 7],
        summary: "Runs the application",
        tags: [],
        complexity: "simple",
      },
    ],
    edges: [
      {
        source: "file:src/index.ts",
        target: "function:main",
        type: "contains",
        direction: "forward",
        weight: 1,
      },
    ],
    layers: [
      { id: "layer:entry", name: "Entry", description: "Entry points", nodeIds: ["file:src/index.ts"] },
    ],
    tour: [
      { order: 1, title: "Start", description: "Read the entry point", nodeIds: ["file:src/index.ts"] },
    ],
  };
}

function domainGraph(): Record<string, unknown> {
  return {
    version: "1.0.0",
    project: {
      name: "octo-repo",
      languages: ["typescript"],
      frameworks: [],
      description: "Business domains",
      analyzedAt: createdAt,
      gitCommitHash: key.baseSha,
    },
    nodes: [
      {
        id: "domain:reviews",
        type: "domain",
        name: "Reviews",
        summary: "Pull request review domain",
        tags: ["core"],
        complexity: "moderate",
      },
      {
        id: "flow:review-pr",
        type: "flow",
        name: "Review PR",
        summary: "Reviews a pull request",
        tags: ["review"],
        complexity: "moderate",
        domainMeta: { entryPoint: "review", entryType: "cli" },
      },
      {
        id: "step:load-context",
        type: "step",
        name: "Load Context",
        filePath: "src/context/cache.ts",
        lineRange: [1, 10],
        summary: "Loads trusted context",
        tags: ["cache"],
        complexity: "simple",
      },
    ],
    edges: [
      {
        source: "domain:reviews",
        target: "flow:review-pr",
        type: "contains_flow",
        direction: "forward",
        weight: 1,
      },
      {
        source: "flow:review-pr",
        target: "step:load-context",
        type: "flow_step",
        direction: "forward",
        weight: 1,
      },
    ],
    layers: [],
    tour: [],
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-context-cache-test-"));
  roots.push(root);
  return root;
}

function input(overrides: Partial<ContextManifestInput> = {}): ContextManifestInput {
  return {
    key,
    createdAt,
    artifacts: [
      { kind: "context", path: "CONTEXT.md" },
      { kind: "knowledge-graph", path: ".understand-anything/knowledge-graph.json" },
      { kind: "domain-graph", path: ".understand-anything/domain-graph.json" },
      { kind: "mapping-metadata", path: ".understand-anything/mapping-metadata.json" },
    ],
    documents: [],
    degradedReasons: [],
    ...overrides,
  };
}

function zeroDomainInput(): ContextManifestInput {
  return input({
    artifacts: [
      { kind: "context", path: "CONTEXT.md" },
      { kind: "knowledge-graph", path: ".understand-anything/knowledge-graph.json" },
      { kind: "zero-domains", path: ".understand-anything/zero-domains.json" },
      { kind: "mapping-metadata", path: ".understand-anything/mapping-metadata.json" },
    ],
  });
}

async function createStaging(
  root: string,
  options: { zeroDomains?: boolean; baseSha?: string } = {},
): Promise<string> {
  const staging = await mkdtemp(path.join(root, "staging-"));
  await mkdir(path.join(staging, ".understand-anything"), { recursive: true });
  await writeFile(path.join(staging, "CONTEXT.md"), "# Trusted context\n", "utf8");
  await writeFile(
    path.join(staging, ".understand-anything/knowledge-graph.json"),
    JSON.stringify(knowledgeGraph()),
    "utf8",
  );
  if (options.zeroDomains) {
    await writeFile(
      path.join(staging, ".understand-anything/zero-domains.json"),
      JSON.stringify({ version: 1, status: "zero-domains" }),
      "utf8",
    );
  } else {
    await writeFile(
      path.join(staging, ".understand-anything/domain-graph.json"),
      JSON.stringify(domainGraph()),
      "utf8",
    );
  }
  await writeFile(
    path.join(staging, ".understand-anything/mapping-metadata.json"),
    JSON.stringify({ version: 1, status: "complete", baseSha: options.baseSha ?? key.baseSha }),
    "utf8",
  );
  return staging;
}

async function promoteValid(root: string, overrides: Partial<ContextManifestInput> = {}): Promise<ContextManifest> {
  const cache = new ContextCache(root);
  const staging = await createStaging(root);
  return cache.promoteContext(staging, input(overrides));
}

async function manifestPath(root: string, cacheKey: ContextCacheKey = key): Promise<string> {
  return path.join(new ContextCache(root).entryPath(cacheKey), "manifest.json");
}

async function replaceStoredArtifact(
  root: string,
  artifactPath: string,
  contents: unknown,
): Promise<void> {
  const file = await manifestPath(root);
  const manifest = JSON.parse(await readFile(file, "utf8")) as ContextManifest;
  const serialized = JSON.stringify(contents);
  await writeFile(path.join(path.dirname(file), artifactPath), serialized, "utf8");
  manifest.artifacts = manifest.artifacts.map((artifact) =>
    artifact.path === artifactPath
      ? { ...artifact, sha256: createHash("sha256").update(serialized).digest("hex") }
      : artifact,
  );
  manifest.manifestHash = computeManifestHash(manifest);
  await writeFile(file, JSON.stringify(manifest), "utf8");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ContextCache", () => {
  it("promotes complete artifacts and returns a validated cache hit", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);

    const promoted = await cache.promoteContext(staging, input());
    const hit = await cache.lookupContext(key);

    expect(hit).toEqual(promoted);
    expect(promoted).toMatchObject({ version: 1, status: "ready", key, createdAt });
    expect(promoted.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(promoted.artifacts).toHaveLength(4);
    expect(promoted.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
    await expect(readFile(path.join(cache.entryPath(key), "CONTEXT.md"), "utf8")).resolves.toContain(
      "Trusted context",
    );
  });

  it.each([
    ["provider", "gitlab"],
    ["host", "ghe.example.com"],
    ["owner", "another-owner"],
    ["repo", "another-repo"],
    ["baseSha", "abc4567890abc4567890abc4567890abc4567890"],
    ["schemaVersion", 2],
    ["tgdVersion", "0.2.0"],
    ["policyVersion", "2026-08-01"],
  ] as const)("misses when the %s cache-key field differs", async (field, value) => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);

    await expect(cache.lookupContext({ ...key, [field]: value } as ContextCacheKey)).resolves.toBeUndefined();
  });

  it("treats force-remap as a non-destructive miss", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const promoted = await promoteValid(root);

    await expect(cache.lookupContext(key, { forceRemap: true })).resolves.toBeUndefined();
    await expect(cache.lookupContext(key)).resolves.toEqual(promoted);
  });

  it.each([
    ["corrupt", "{not-json"],
    ["null", "null"],
    ["preparing", JSON.stringify({ version: 1, status: "preparing" })],
    ["failed", JSON.stringify({ version: 1, status: "failed" })],
    ["wrong version", JSON.stringify({ version: 2, status: "ready" })],
  ])("treats a %s manifest as a miss", async (_label, contents) => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const file = await manifestPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");

    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("treats a missing manifest as a miss", async () => {
    const root = await tempRoot();
    await expect(new ContextCache(root).lookupContext(key)).resolves.toBeUndefined();
  });

  it("treats an oversized unreadable ready manifest as a bounded cache miss", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const file = await manifestPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{}");
    await truncate(file, 1024 * 1024 + 1);
    await chmod(file, 0o000);
    try {
      await expect(cache.lookupContext(key)).resolves.toBeUndefined();
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("rejects a manifest whose embedded key does not exactly match", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const file = await manifestPath(root);
    const manifest = JSON.parse(await readFile(file, "utf8")) as ContextManifest;
    manifest.key = { ...manifest.key, policyVersion: "tampered" };
    manifest.manifestHash = computeManifestHash(manifest);
    await writeFile(file, JSON.stringify(manifest), "utf8");

    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("misses when a required artifact is missing or its digest differs", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const entry = cache.entryPath(key);

    await writeFile(path.join(entry, "CONTEXT.md"), "tampered\n", "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    await rm(path.join(entry, "CONTEXT.md"));
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("misses for an invalid graph or mapping metadata", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const entry = cache.entryPath(key);
    const manifest = JSON.parse(await readFile(path.join(entry, "manifest.json"), "utf8")) as ContextManifest;

    await writeFile(path.join(entry, ".understand-anything/knowledge-graph.json"), "null", "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    await writeFile(
      path.join(entry, ".understand-anything/knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
      "utf8",
    );
    await writeFile(
      path.join(entry, ".understand-anything/mapping-metadata.json"),
      JSON.stringify({ version: 1, status: "complete", baseSha: "wrong" }),
      "utf8",
    );
    manifest.artifacts = manifest.artifacts.map((artifact) => ({ ...artifact, sha256: "0".repeat(64) }));
    manifest.manifestHash = computeManifestHash(manifest);
    await writeFile(path.join(entry, "manifest.json"), JSON.stringify(manifest), "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it.each([
    ["empty knowledge graph", "knowledge-graph.json", {}],
    [
      "malformed knowledge node",
      "knowledge-graph.json",
      { ...knowledgeGraph(), nodes: [{ id: "bad", type: "file", tags: "not-an-array" }] },
    ],
    ["empty domain graph", "domain-graph.json", {}],
    [
      "malformed domain edge",
      "domain-graph.json",
      { ...domainGraph(), edges: [{ source: "domain:reviews", target: 42, type: "contains_flow" }] },
    ],
  ])("rejects a schema-invalid %s during promotion", async (_label, filename, graph) => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    await writeFile(path.join(staging, ".understand-anything", filename), JSON.stringify(graph), "utf8");

    await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
    await expect(new ContextCache(root).lookupContext(key)).resolves.toBeUndefined();
  });

  it("misses when stored graph content has a valid digest but an invalid schema", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);

    await replaceStoredArtifact(root, ".understand-anything/knowledge-graph.json", {});
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    await replaceStoredArtifact(root, ".understand-anything/knowledge-graph.json", knowledgeGraph());
    await replaceStoredArtifact(root, ".understand-anything/domain-graph.json", {
      ...domainGraph(),
      nodes: [{ id: "domain:bad", type: "domain", name: 42 }],
    });
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("rejects an otherwise schema-valid knowledge graph with zero nodes", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const emptyGraph = { ...knowledgeGraph(), nodes: [], edges: [], layers: [], tour: [] };
    await writeFile(
      path.join(staging, ".understand-anything/knowledge-graph.json"),
      JSON.stringify(emptyGraph),
      "utf8",
    );
    await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);

    const hitRoot = await tempRoot();
    const hitCache = new ContextCache(hitRoot);
    await promoteValid(hitRoot);
    await replaceStoredArtifact(hitRoot, ".understand-anything/knowledge-graph.json", emptyGraph);
    await expect(hitCache.lookupContext(key)).resolves.toBeUndefined();
  });

  it.each([
    ["duplicate node IDs", (graph: Record<string, unknown>) => {
      const nodes = graph.nodes as Record<string, unknown>[];
      nodes[1] = { ...nodes[1], id: nodes[0]?.id };
    }],
    ["a dangling edge source", (graph: Record<string, unknown>) => {
      (graph.edges as Record<string, unknown>[])[0]!.source = "file:missing.ts";
    }],
    ["a dangling edge target", (graph: Record<string, unknown>) => {
      (graph.edges as Record<string, unknown>[])[0]!.target = "function:missing";
    }],
    ["a dangling layer reference", (graph: Record<string, unknown>) => {
      (graph.layers as Record<string, unknown>[])[0]!.nodeIds = ["file:missing.ts"];
    }],
    ["a dangling tour reference", (graph: Record<string, unknown>) => {
      (graph.tour as Record<string, unknown>[])[0]!.nodeIds = ["file:missing.ts"];
    }],
  ])("rejects %s", async (_label, mutate) => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const graph = knowledgeGraph();
    mutate(graph);
    await writeFile(
      path.join(staging, ".understand-anything/knowledge-graph.json"),
      JSON.stringify(graph),
      "utf8",
    );

    await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
  });

  it.each(["edges", "layers", "tour"])("rejects a non-array graph %s field with a validation error", async (field) => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const graph = { ...knowledgeGraph(), [field]: {} };
    await writeFile(
      path.join(staging, ".understand-anything/knowledge-graph.json"),
      JSON.stringify(graph),
      "utf8",
    );

    await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
  });

  it.each(["knowledge-graph.json", "domain-graph.json"])(
    "rejects %s when its project commit differs from the cache key",
    async (filename) => {
      const root = await tempRoot();
      const staging = await createStaging(root);
      const graph = filename === "knowledge-graph.json" ? knowledgeGraph() : domainGraph();
      (graph.project as Record<string, unknown>).gitCommitHash = "a".repeat(40);
      await writeFile(path.join(staging, ".understand-anything", filename), JSON.stringify(graph), "utf8");

      await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
    },
  );

  it.each([
    "",
    "   ",
    "nul\0path.ts",
    "/absolute/path.ts",
    ".",
    "..",
    "src/../secret.ts",
    "src\\..\\secret.ts",
    "src/\\../secret.ts",
    "C:/absolute.ts",
    "C:\\absolute.ts",
    "C:drive-relative.ts",
    "\\\\server\\share\\file.ts",
    "\\\\?\\C:\\device.ts",
    "src//empty-segment.ts",
    "src\\\\empty-segment.ts",
  ])("rejects unsafe graph-node filePath provenance %j", async (filePath) => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const graph = knowledgeGraph();
    (graph.nodes as Record<string, unknown>[])[0]!.filePath = filePath;
    await writeFile(
      path.join(staging, ".understand-anything/knowledge-graph.json"),
      JSON.stringify(graph),
      "utf8",
    );

    await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
  });

  it("applies safe filePath provenance to domain nodes and accepts both normal separators", async () => {
    const invalidRoot = await tempRoot();
    const invalidStaging = await createStaging(invalidRoot);
    const invalidDomain = domainGraph();
    (invalidDomain.nodes as Record<string, unknown>[])[2]!.filePath = "src\\..\\escape.ts";
    await writeFile(
      path.join(invalidStaging, ".understand-anything/domain-graph.json"),
      JSON.stringify(invalidDomain),
      "utf8",
    );
    await expect(new ContextCache(invalidRoot).promoteContext(invalidStaging, input())).rejects.toThrow(
      /graph schema/i,
    );

    for (const filePath of ["src/context/cache.ts", "src\\context\\cache.ts"]) {
      const root = await tempRoot();
      const staging = await createStaging(root);
      const graph = domainGraph();
      (graph.nodes as Record<string, unknown>[])[2]!.filePath = filePath;
      await writeFile(
        path.join(staging, ".understand-anything/domain-graph.json"),
        JSON.stringify(graph),
        "utf8",
      );
      await expect(new ContextCache(root).promoteContext(staging, input())).resolves.toMatchObject({
        status: "ready",
      });
    }
  });

  it("rejects oversized sparse JSON graphs before reading or parsing them", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const graphPath = path.join(staging, ".understand-anything/knowledge-graph.json");
    await truncate(graphPath, 64 * 1024 * 1024 + 1);
    await chmod(graphPath, 0o000);
    try {
      await expect(cache.promoteContext(staging, input())).rejects.toThrow(/maximum.*size/i);
    } finally {
      await chmod(graphPath, 0o600);
    }
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    const hitRoot = await tempRoot();
    const hitCache = new ContextCache(hitRoot);
    await promoteValid(hitRoot);
    await truncate(path.join(hitCache.entryPath(key), ".understand-anything/knowledge-graph.json"), 64 * 1024 * 1024 + 1);
    await expect(hitCache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("rejects malformed optional node metadata and non-object graph entries", async () => {
    const base = knowledgeGraph();
    const validNode = (base.nodes as Record<string, unknown>[])[0]!;
    const invalidNodes: unknown[] = [
      null,
      { ...validNode, domainMeta: "invalid" },
      { ...validNode, domainMeta: { entities: "invalid" } },
      { ...validNode, domainMeta: { entities: [], businessRules: "invalid" } },
      { ...validNode, domainMeta: { entities: [], businessRules: [], crossDomainInteractions: "invalid" } },
      { ...validNode, knowledgeMeta: "invalid" },
      { ...validNode, knowledgeMeta: { wikilinks: "invalid" } },
      { ...validNode, knowledgeMeta: { wikilinks: [], backlinks: "invalid" } },
      { ...validNode, knowledgeMeta: { wikilinks: [], backlinks: [], category: 42 } },
      { ...validNode, knowledgeMeta: { wikilinks: [], backlinks: [], category: "ok", content: 42 } },
    ];
    for (const invalidNode of invalidNodes) {
      const root = await tempRoot();
      const staging = await createStaging(root);
      await writeFile(
        path.join(staging, ".understand-anything/knowledge-graph.json"),
        JSON.stringify({ ...base, nodes: [invalidNode] }),
        "utf8",
      );
      await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
    }

    for (const invalidEdge of [null, { source: "file:src/index.ts" }]) {
      const root = await tempRoot();
      const staging = await createStaging(root);
      await writeFile(
        path.join(staging, ".understand-anything/knowledge-graph.json"),
        JSON.stringify({ ...base, edges: [invalidEdge] }),
        "utf8",
      );
      await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/graph schema/i);
    }
  });

  it("accepts the vendor knowledge graph kind", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    await writeFile(
      path.join(staging, ".understand-anything/knowledge-graph.json"),
      JSON.stringify({ ...knowledgeGraph(), kind: "knowledge" }),
      "utf8",
    );
    await expect(new ContextCache(root).promoteContext(staging, input())).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps alternative-probe I/O errors diagnosable", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const artifactDirectory = path.join(staging, ".understand-anything");
    await chmod(artifactDirectory, 0o000);
    try {
      await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(artifactDirectory, 0o700);
    }
  });

  it("rejects an undeclared domain alternative during promotion", async () => {
    const root = await tempRoot();
    const domainStaging = await createStaging(root);
    await writeFile(
      path.join(domainStaging, ".understand-anything/zero-domains.json"),
      JSON.stringify({ version: 1, status: "zero-domains" }),
      "utf8",
    );
    await expect(new ContextCache(root).promoteContext(domainStaging, input())).rejects.toThrow(/alternative/i);

    const zeroStaging = await createStaging(root, { zeroDomains: true });
    await writeFile(
      path.join(zeroStaging, ".understand-anything/domain-graph.json"),
      JSON.stringify(domainGraph()),
      "utf8",
    );
    await expect(new ContextCache(root).promoteContext(zeroStaging, zeroDomainInput())).rejects.toThrow(/alternative/i);
  });

  it("misses when an undeclared domain alternative appears in a ready entry", async () => {
    const domainRoot = await tempRoot();
    const domainCache = new ContextCache(domainRoot);
    await promoteValid(domainRoot);
    await writeFile(
      path.join(domainCache.entryPath(key), ".understand-anything/zero-domains.json"),
      JSON.stringify({ version: 1, status: "zero-domains" }),
      "utf8",
    );
    await expect(domainCache.lookupContext(key)).resolves.toBeUndefined();

    const zeroRoot = await tempRoot();
    const zeroCache = new ContextCache(zeroRoot);
    const zeroStaging = await createStaging(zeroRoot, { zeroDomains: true });
    await zeroCache.promoteContext(zeroStaging, zeroDomainInput());
    await writeFile(
      path.join(zeroCache.entryPath(key), ".understand-anything/domain-graph.json"),
      JSON.stringify(domainGraph()),
      "utf8",
    );
    await expect(zeroCache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("accepts the narrowly-defined zero-domain marker instead of a domain graph", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root, { zeroDomains: true });
    const promoted = await cache.promoteContext(staging, zeroDomainInput());

    await expect(cache.lookupContext(key)).resolves.toEqual(promoted);
  });

  it("digests and validates optional business-reference documents", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    await mkdir(path.join(staging, "business"));
    await writeFile(path.join(staging, "business/ticket.md"), "# TICKET-42\n", "utf8");

    const promoted = await cache.promoteContext(
      staging,
      input({ documents: [{ kind: "business-reference", path: "business/ticket.md" }] }),
    );
    expect(promoted.documents[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(cache.lookupContext(key)).resolves.toEqual(promoted);

    await writeFile(path.join(cache.entryPath(key), "business/ticket.md"), "changed", "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("streams optional business documents and computes a correct multi-chunk digest", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const contents = Buffer.alloc(256 * 1024 + 17);
    for (let index = 0; index < contents.length; index += 1) contents[index] = index % 251;
    await writeFile(path.join(staging, "business.bin"), contents);

    const promoted = await cache.promoteContext(
      staging,
      input({ documents: [{ kind: "business-reference", path: "business.bin" }] }),
    );

    expect(promoted.documents[0]?.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
    await expect(cache.lookupContext(key)).resolves.toEqual(promoted);
  });

  it("propagates document path I/O faults before opening a stream", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const businessDirectory = path.join(staging, "business");
    await mkdir(businessDirectory);
    await writeFile(path.join(businessDirectory, "ticket.md"), "ticket", "utf8");
    await chmod(businessDirectory, 0o000);
    try {
      await expect(
        new ContextCache(root).promoteContext(
          staging,
          input({ documents: [{ kind: "business-reference", path: "business/ticket.md" }] }),
        ),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(businessDirectory, 0o700);
    }
  });

  it("preserves streamed text semantics when the decoder flushes a final replacement character", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    await writeFile(path.join(staging, "CONTEXT.md"), Buffer.from([0x20, 0xe2]));

    await expect(new ContextCache(root).promoteContext(staging, input())).resolves.toMatchObject({ status: "ready" });
  });

  it.each([
    "../escape",
    "/absolute",
    "nested\\escape",
    "nested/../escape",
    "nul\0byte",
    "C:/absolute",
    "C:\\absolute",
    "C:drive-relative",
    "\\\\server\\share\\artifact",
    "\\\\?\\C:\\device-path",
    "\\\\.\\device",
  ])(
    "rejects unsafe artifact path %s",
    async (unsafePath) => {
      const root = await tempRoot();
      const cache = new ContextCache(root);
      const staging = await createStaging(root);
      const artifacts = input().artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, path: unsafePath } : artifact,
      );

      await expect(cache.promoteContext(staging, input({ artifacts }))).rejects.toThrow(/path/i);
      await expect(cache.lookupContext(key)).resolves.toBeUndefined();
    },
  );

  it.each(["owner", "repo", "host", "baseSha", "tgdVersion", "policyVersion"] as const)(
    "rejects unsafe %s key components",
    async (field) => {
      const root = await tempRoot();
      const cache = new ContextCache(root);
      expect(() => cache.entryPath({ ...key, [field]: "../escape" })).toThrow(new RegExp(field, "i"));
    },
  );

  it("rejects non-object, unsupported-provider, invalid-version, and extra-field keys", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    expect(() => cache.entryPath(null as unknown as ContextCacheKey)).toThrow(/key/i);
    expect(() => cache.entryPath({ ...key, provider: "gitlab" } as ContextCacheKey)).toThrow(/provider/i);
    expect(() => cache.entryPath({ ...key, schemaVersion: 0 })).toThrow(/schemaVersion/i);
    expect(() => cache.entryPath({ ...key, unexpected: true } as ContextCacheKey)).toThrow(/key/i);
    await expect(cache.lookupContext(null as unknown as ContextCacheKey)).resolves.toBeUndefined();
  });

  it("requires an absolute explicit cache root", async () => {
    expect(() => new ContextCache("relative-cache")).toThrow(/absolute/i);
  });

  it("rejects duplicate artifact kinds and paths across all records", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);

    await expect(
      cache.promoteContext(staging, input({ artifacts: [...input().artifacts, input().artifacts[0]!] })),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      cache.promoteContext(
        staging,
        input({ documents: [{ kind: "business-reference", path: "CONTEXT.md" }] }),
      ),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      cache.promoteContext(
        staging,
        input({
          artifacts: input().artifacts.map((artifact) =>
            artifact.kind === "knowledge-graph" ? { ...artifact, path: "CONTEXT.md" } : artifact,
          ),
        }),
      ),
    ).rejects.toThrow(/duplicate artifact path/i);
  });

  it("reserves manifest and internal cache-control paths from document records", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const diagnostic = JSON.stringify({ version: 1, status: "preparing" });
    await writeFile(path.join(staging, "manifest.json"), diagnostic, "utf8");

    await expect(
      cache.promoteContext(
        staging,
        input({ documents: [{ kind: "business-reference", path: "manifest.json" }] }),
      ),
    ).rejects.toThrow(/reserved/i);
    await expect(readFile(path.join(staging, "manifest.json"), "utf8")).resolves.toBe(diagnostic);
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    const internalStaging = await createStaging(root);
    await mkdir(path.join(internalStaging, ".tgd-cache"));
    await writeFile(path.join(internalStaging, ".tgd-cache/control.json"), "{}", "utf8");
    await expect(
      cache.promoteContext(
        internalStaging,
        input({ documents: [{ kind: "business-reference", path: ".tgd-cache/control.json" }] }),
      ),
    ).rejects.toThrow(/reserved/i);
  });

  it("rejects symlinked artifacts, including symlink escapes", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    await writeFile(path.join(outside, "CONTEXT.md"), "outside\n", "utf8");
    await rm(path.join(staging, "CONTEXT.md"));
    await symlink(path.join(outside, "CONTEXT.md"), path.join(staging, "CONTEXT.md"));

    await expect(cache.promoteContext(staging, input())).rejects.toThrow(/symbolic link/i);
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("rejects a symlink in an artifact parent directory", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    await mkdir(path.join(outside, "business"));
    await writeFile(path.join(outside, "business/ticket.md"), "outside\n", "utf8");
    await symlink(path.join(outside, "business"), path.join(staging, "business"));

    await expect(
      cache.promoteContext(
        staging,
        input({ documents: [{ kind: "business-reference", path: "business/ticket.md" }] }),
      ),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects promotion staging outside the configured cache scope", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(outside);

    await expect(cache.promoteContext(staging, input())).rejects.toThrow(/staging/i);
  });

  it("rejects a relative staging path without consulting cwd", async () => {
    const root = await tempRoot();
    await expect(new ContextCache(root).promoteContext("relative-staging", input())).rejects.toThrow(/absolute/i);
  });

  it("rejects non-canonical mapping and zero-domain marker schemas", async () => {
    const root = await tempRoot();
    const mappingStaging = await createStaging(root);
    await writeFile(
      path.join(mappingStaging, ".understand-anything/mapping-metadata.json"),
      JSON.stringify({ version: 1, status: "complete", baseSha: key.baseSha, unexpected: true }),
      "utf8",
    );
    await expect(new ContextCache(root).promoteContext(mappingStaging, input())).rejects.toThrow(/metadata/i);

    const markerStaging = await createStaging(root, { zeroDomains: true });
    await writeFile(
      path.join(markerStaging, ".understand-anything/zero-domains.json"),
      JSON.stringify({ version: 1, status: "zero-domains", unexpected: true }),
      "utf8",
    );
    await expect(
      new ContextCache(root).promoteContext(
        markerStaging,
        input({
          artifacts: [
            { kind: "context", path: "CONTEXT.md" },
            { kind: "knowledge-graph", path: ".understand-anything/knowledge-graph.json" },
            { kind: "zero-domains", path: ".understand-anything/zero-domains.json" },
            { kind: "mapping-metadata", path: ".understand-anything/mapping-metadata.json" },
          ],
        }),
      ),
    ).rejects.toThrow(/zero-domain/i);
  });

  it("requires exactly one domain result and non-empty normal/document artifacts", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const withoutDomain = input({
      artifacts: input().artifacts.filter((artifact) => artifact.kind !== "domain-graph"),
    });
    await expect(cache.promoteContext(staging, withoutDomain)).rejects.toThrow(/exactly one/i);

    const zeroStaging = await createStaging(root, { zeroDomains: true });
    await writeFile(path.join(zeroStaging, ".understand-anything/domain-graph.json"), "{}", "utf8");
    await expect(
      cache.promoteContext(
        zeroStaging,
        input({
          artifacts: [
            ...input().artifacts,
            { kind: "zero-domains", path: ".understand-anything/zero-domains.json" },
          ],
        }),
      ),
    ).rejects.toThrow(/exactly one/i);

    const emptyContextStaging = await createStaging(root);
    await writeFile(path.join(emptyContextStaging, "CONTEXT.md"), " \n", "utf8");
    await expect(cache.promoteContext(emptyContextStaging, input())).rejects.toThrow(/non-empty/i);

    const emptyDocumentStaging = await createStaging(root);
    await writeFile(path.join(emptyDocumentStaging, "ticket.md"), "", "utf8");
    await expect(
      cache.promoteContext(
        emptyDocumentStaging,
        input({ documents: [{ kind: "business-reference", path: "ticket.md" }] }),
      ),
    ).rejects.toThrow(/empty/i);
  });

  it("rejects unexpected manifest fields instead of silently trusting a lossy parse", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const file = await manifestPath(root);
    const manifest = JSON.parse(await readFile(file, "utf8")) as ContextManifest & { unexpected?: boolean };
    manifest.unexpected = true;
    await writeFile(file, JSON.stringify(manifest), "utf8");

    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("treats malformed ready-manifest fields as corruption", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const file = await manifestPath(root);
    const original = JSON.parse(await readFile(file, "utf8")) as ContextManifest;
    const malformed: unknown[] = [
      { ...original, createdAt: "yesterday" },
      { ...original, manifestHash: "not-a-hash" },
      { ...original, artifacts: null },
      { ...original, documents: null },
      { ...original, degradedReasons: [""] },
      { ...original, artifacts: [{ path: "CONTEXT.md", kind: "unknown", sha256: "0".repeat(64) }] },
    ];

    for (const candidate of malformed) {
      await writeFile(file, JSON.stringify(candidate), "utf8");
      await expect(cache.lookupContext(key)).resolves.toBeUndefined();
    }
  });

  it("rejects malformed promotion input lists with a validation error", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const malformed = { ...input(), artifacts: null } as unknown as ContextManifestInput;
    await expect(new ContextCache(root).promoteContext(staging, malformed)).rejects.toThrow(/artifact/i);

    const stagingWithNullDocuments = await createStaging(root);
    const nullDocuments = { ...input(), documents: null } as unknown as ContextManifestInput;
    await expect(new ContextCache(root).promoteContext(stagingWithNullDocuments, nullDocuments)).rejects.toThrow(
      /document/i,
    );

    const directStage = await createStaging(root);
    await expect(
      digestArtifactInputs(
        directStage,
        key,
        input().artifacts,
        null as unknown as ContextManifestInput["documents"],
      ),
    ).rejects.toThrow(/document/i);
  });

  it("rejects invalid record shapes, fixed-path substitutions, and non-file artifacts", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const invalidArtifactStage = await createStaging(root);
    await expect(
      cache.promoteContext(
        invalidArtifactStage,
        input({ artifacts: [null, ...input().artifacts] as unknown as ContextManifestInput["artifacts"] }),
      ),
    ).rejects.toThrow(/artifact record/i);

    const invalidDocumentStage = await createStaging(root);
    await expect(
      cache.promoteContext(
        invalidDocumentStage,
        input({ documents: [{ kind: "other", path: "ticket.md" }] as unknown as ContextManifestInput["documents"] }),
      ),
    ).rejects.toThrow(/document record/i);

    const wrongPathStage = await createStaging(root);
    await writeFile(path.join(wrongPathStage, "RENAMED.md"), "context", "utf8");
    await expect(
      cache.promoteContext(
        wrongPathStage,
        input({
          artifacts: input().artifacts.map((artifact) =>
            artifact.kind === "context" ? { ...artifact, path: "RENAMED.md" } : artifact,
          ),
        }),
      ),
    ).rejects.toThrow(/must use/i);

    const directoryStage = await createStaging(root);
    await rm(path.join(directoryStage, "CONTEXT.md"));
    await mkdir(path.join(directoryStage, "CONTEXT.md"));
    await expect(cache.promoteContext(directoryStage, input())).rejects.toThrow(/regular file/i);

    const nonDirectoryParentStage = await createStaging(root);
    await rm(path.join(nonDirectoryParentStage, ".understand-anything"), { recursive: true });
    await writeFile(path.join(nonDirectoryParentStage, ".understand-anything"), "not a directory", "utf8");
    await expect(cache.promoteContext(nonDirectoryParentStage, input())).rejects.toThrow(/missing artifact/i);
  });

  it("requires every normal artifact kind", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    await expect(
      new ContextCache(root).promoteContext(
        staging,
        input({ artifacts: input().artifacts.filter((artifact) => artifact.kind !== "knowledge-graph") }),
      ),
    ).rejects.toThrow(/missing required.*knowledge-graph/i);
  });

  it("misses for malformed stored digests and document records", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const file = await manifestPath(root);
    const original = JSON.parse(await readFile(file, "utf8")) as ContextManifest;

    const badDigest = { ...original, artifacts: original.artifacts.map((record) => ({ ...record })) };
    badDigest.artifacts[0]!.sha256 = "invalid";
    badDigest.manifestHash = computeManifestHash(badDigest);
    await writeFile(file, JSON.stringify(badDigest), "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    const badDocument = { ...original, documents: [null] } as unknown as ContextManifest;
    badDocument.manifestHash = computeManifestHash(badDocument);
    await writeFile(file, JSON.stringify(badDocument), "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    const badArtifact = { ...original, artifacts: [null] } as unknown as ContextManifest;
    badArtifact.manifestHash = "0".repeat(64);
    await writeFile(file, JSON.stringify(badArtifact), "utf8");
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("does not swallow manifest permission errors", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const file = await manifestPath(root);
    await chmod(file, 0o000);

    await expect(cache.lookupContext(key)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not swallow artifact permission errors", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    await chmod(path.join(cache.entryPath(key), "CONTEXT.md"), 0o000);

    await expect(cache.lookupContext(key)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("misses for symlinked entries or manifests", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const cache = new ContextCache(root);
    const entry = cache.entryPath(key);
    await mkdir(path.dirname(entry), { recursive: true });
    await symlink(outside, entry);
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();

    await rm(entry);
    await mkdir(entry);
    await writeFile(path.join(outside, "manifest.json"), "{}", "utf8");
    await symlink(path.join(outside, "manifest.json"), path.join(entry, "manifest.json"));
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("misses when an entry escapes through a symlinked cache parent", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await promoteValid(outside);
    await symlink(path.join(outside, "contexts"), path.join(root, "contexts"));

    await expect(new ContextCache(root).lookupContext(key)).resolves.toBeUndefined();
  });

  it("rejects staging symlinks, the final destination as staging, and escaped destination parents", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const cache = new ContextCache(root);
    const realStage = await createStaging(root);
    const linkedStage = path.join(root, "linked-staging");
    await symlink(realStage, linkedStage);
    await expect(cache.promoteContext(linkedStage, input())).rejects.toThrow(/real directory/i);

    const destination = cache.entryPath(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(realStage, destination);
    await expect(cache.promoteContext(destination, input())).rejects.toThrow(/outside.*destination/i);

    await rm(path.join(root, "contexts"), { recursive: true });
    const escapedStage = await createStaging(root);
    await symlink(outside, path.join(root, "contexts"));
    await expect(cache.promoteContext(escapedStage, input())).rejects.toThrow(/destination escapes/i);
  });

  it("rejects a staging directory replaced by a symlink while it is moved under the publication claim", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const staging = await createStaging(root);
    const outsideManifest = path.join(outside, "manifest.json");
    await writeFile(outsideManifest, "outside sentinel\n", "utf8");
    const dependencies = {
      claimRename: async (source: string, destination: string) => {
        await rm(source, { recursive: true, force: true });
        await symlink(outside, source);
        await rename(source, destination);
      },
    } satisfies ContextCacheDependencies;

    await expect(new ContextCache(root, dependencies).promoteContext(staging, input())).rejects.toThrow(
      /staging.*real directory/i,
    );
    await expect(readFile(outsideManifest, "utf8")).resolves.toBe("outside sentinel\n");
  });

  it("rejects a staging manifest symlink without writing outside staging", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const staging = await createStaging(root);
    const outsideFile = path.join(outside, "keep.json");
    await writeFile(outsideFile, "keep", "utf8");
    await symlink(outsideFile, path.join(staging, "manifest.json"));

    await expect(new ContextCache(root).promoteContext(staging, input())).rejects.toThrow(/manifest.*symbolic link/i);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("keep");
    await expect(new ContextCache(root).lookupContext(key)).resolves.toBeUndefined();
  });

  it("conflicts with an existing corrupt destination", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    await mkdir(cache.entryPath(key), { recursive: true });

    await expect(cache.promoteContext(staging, input())).rejects.toBeInstanceOf(ContextCacheConflictError);
    await expect(readFile(path.join(staging, "CONTEXT.md"), "utf8")).resolves.toContain("Trusted context");
  });

  it("rechecks an exact entry that wins a publication race", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const cache = new ContextCache(root, {
      rename: async (source, destination) => {
        await rename(source, destination);
        throw Object.assign(new Error("race"), { code: "EEXIST" });
      },
    });

    const promoted = await cache.promoteContext(staging, input());
    await expect(cache.lookupContext(key)).resolves.toEqual(promoted);
  });

  it("reports a conflict when a corrupt entry wins a publication race", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const cache = new ContextCache(root, {
      rename: async (_source, destination) => {
        await mkdir(destination);
        throw Object.assign(new Error("race"), { code: "EEXIST" });
      },
    });

    await expect(cache.promoteContext(staging, input())).rejects.toBeInstanceOf(ContextCacheConflictError);
    await expect(readFile(path.join(staging, "manifest.json"), "utf8")).resolves.toContain('"status":"ready"');
  });

  it("serializes conforming promoters across destination check and publication", async () => {
    const root = await tempRoot();
    const firstStaging = await createStaging(root);
    const secondStaging = await createStaging(root);
    await writeFile(path.join(secondStaging, "CONTEXT.md"), "# Losing context\n", "utf8");
    let signalRename!: () => void;
    const renameReached = new Promise<void>((resolve) => {
      signalRename = resolve;
    });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const firstCache = new ContextCache(root, {
      rename: async (source, destination) => {
        signalRename();
        await renameGate;
        await rename(source, destination);
      },
    });
    const secondCache = new ContextCache(root);

    const firstPromotion = firstCache.promoteContext(firstStaging, input());
    await renameReached;
    const secondOutcome = await secondCache.promoteContext(secondStaging, input()).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    releaseRename();
    const firstOutcome = await firstPromotion.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    expect(secondOutcome.status).toBe("rejected");
    if (secondOutcome.status === "rejected") {
      expect(secondOutcome.reason).toBeInstanceOf(Error);
      expect((secondOutcome.reason as Error).message).toMatch(/publication.*progress/i);
    }
    expect(firstOutcome.status).toBe("fulfilled");
    await expect(readFile(path.join(secondStaging, "CONTEXT.md"), "utf8")).resolves.toContain("Losing");
    await expect(secondCache.lookupContext(key)).resolves.toMatchObject(firstOutcome.status === "fulfilled" ? {
      manifestHash: firstOutcome.value.manifestHash,
    } : {});
  });

  it("preserves a pre-existing publication claim instead of guessing that it is stale", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const claim = `${cache.entryPath(key)}.publishing`;
    await mkdir(path.dirname(claim), { recursive: true });
    await mkdir(claim);

    await expect(cache.promoteContext(staging, input())).rejects.toThrow(/publication.*progress/i);
    await expect(lstat(claim)).resolves.toMatchObject({});
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
  });

  it("reuses an exact ready entry observed behind another publisher's claim", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const ready = await promoteValid(root);
    const claim = `${cache.entryPath(key)}.publishing`;
    await mkdir(claim);
    const staging = await createStaging(root);

    await expect(cache.promoteContext(staging, input())).resolves.toEqual(ready);
    await expect(lstat(claim)).resolves.toMatchObject({});
  });

  it("reports a conflicting ready entry observed behind another publisher's claim", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    await promoteValid(root);
    const claim = `${cache.entryPath(key)}.publishing`;
    await mkdir(claim);
    const staging = await createStaging(root);
    await writeFile(path.join(staging, "CONTEXT.md"), "# Conflicting context\n", "utf8");

    await expect(cache.promoteContext(staging, input())).rejects.toBeInstanceOf(ContextCacheConflictError);
    await expect(lstat(claim)).resolves.toMatchObject({});
  });

  it("propagates claim-acquisition permission errors without publishing", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const parent = path.dirname(cache.entryPath(key));
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o500);
    try {
      await expect(cache.promoteContext(staging, input())).rejects.toMatchObject({ code: "EACCES" });
      await expect(cache.lookupContext(key)).resolves.toBeUndefined();
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it("preserves staging and propagates a non-collision rename failure", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const cache = new ContextCache(root, {
      rename: async () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
    });

    await expect(cache.promoteContext(staging, input())).rejects.toMatchObject({ code: "EXDEV" });
    await expect(readFile(path.join(staging, "manifest.json"), "utf8")).resolves.toContain('"status":"ready"');
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
    await expect(lstat(`${cache.entryPath(key)}.publishing`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the publication failure when cleanup also finds a replaced staging path", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const publicationError = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const cache = new ContextCache(root, {
      rename: async () => {
        await mkdir(staging);
        throw publicationError;
      },
    });

    const result = await cache.promoteContext(staging, input()).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(publicationError);
    expect((result as AggregateError).errors[1]).toBeInstanceOf(ContextValidationError);
    expect(((result as AggregateError).errors[1] as Error).message).toMatch(/replaced/i);
  });

  it("computes a deterministic manifest hash independent of object and record order", async () => {
    const rootA = await tempRoot();
    const rootB = await tempRoot();
    const stagingA = await createStaging(rootA);
    const stagingB = await createStaging(rootB);
    const normal = input();
    const reversed = input({ artifacts: [...normal.artifacts].reverse() });

    const first = await new ContextCache(rootA).promoteContext(stagingA, normal);
    const second = await new ContextCache(rootB).promoteContext(stagingB, reversed);
    const reorderedObject = {
      degradedReasons: first.degradedReasons,
      documents: first.documents,
      artifacts: first.artifacts,
      manifestHash: first.manifestHash,
      createdAt: first.createdAt,
      key: first.key,
      status: first.status,
      version: first.version,
    } as ContextManifest;

    expect(first.manifestHash).toBe(second.manifestHash);
    expect(computeManifestHash(reorderedObject)).toBe(first.manifestHash);
    expect(computeManifestHash({ ...first, artifacts: [...first.artifacts].reverse() })).toBe(first.manifestHash);
  });

  it("uses deterministic empty defaults and validates degraded-reason input", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root);
    const defaults = input();
    delete defaults.documents;
    delete defaults.degradedReasons;

    const promoted = await cache.promoteContext(staging, defaults);
    expect(promoted.documents).toEqual([]);
    expect(promoted.degradedReasons).toEqual([]);

    const otherRoot = await tempRoot();
    const otherStaging = await createStaging(otherRoot);
    const invalid = { ...input(), degradedReasons: null } as unknown as ContextManifestInput;
    await expect(new ContextCache(otherRoot).promoteContext(otherStaging, invalid)).rejects.toThrow(/degraded/i);
  });

  it("overwrites a regular diagnostic staging manifest but rejects a directory", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify({ version: 1, status: "preparing" }), "utf8");
    const promoted = await new ContextCache(root).promoteContext(staging, input());
    expect(promoted.status).toBe("ready");

    const otherRoot = await tempRoot();
    const otherStaging = await createStaging(otherRoot);
    await mkdir(path.join(otherStaging, "manifest.json"));
    await expect(new ContextCache(otherRoot).promoteContext(otherStaging, input())).rejects.toThrow(/regular file/i);
  });

  it("writes the ready manifest before the single atomic publication rename", async () => {
    const root = await tempRoot();
    const staging = await createStaging(root);
    const calls: string[] = [];
    const cache = new ContextCache(root, {
      rename: async (source, destination) => {
        const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")) as ContextManifest;
        expect(manifest.status).toBe("ready");
        calls.push(`rename:${source}:${destination}`);
        await rename(source, destination);
      },
    });

    const promoted = await cache.promoteContext(staging, input());

    expect(calls).toEqual([
      `rename:${cache.entryPath(key)}.publishing${path.sep}entry:${cache.entryPath(key)}`,
    ]);
    await expect(cache.lookupContext(key)).resolves.toEqual(promoted);
  });

  it("does not publish an invalid promotion", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root, { baseSha: "wrong-sha" });

    await expect(cache.promoteContext(staging, input())).rejects.toThrow(/base sha/i);
    await expect(cache.lookupContext(key)).resolves.toBeUndefined();
    await expect(readFile(path.join(staging, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses an exact existing ready entry without overwriting it", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const first = await promoteValid(root);
    const staging = await createStaging(root);

    const second = await cache.promoteContext(staging, input());

    expect(second).toEqual(first);
    await expect(readFile(path.join(staging, "CONTEXT.md"), "utf8")).resolves.toContain("Trusted context");
  });

  it("reports a conflict and preserves a different existing ready entry", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const first = await promoteValid(root);
    const staging = await createStaging(root);
    await writeFile(path.join(staging, "CONTEXT.md"), "# Different trusted context\n", "utf8");

    await expect(cache.promoteContext(staging, input())).rejects.toBeInstanceOf(ContextCacheConflictError);
    await expect(cache.lookupContext(key)).resolves.toEqual(first);
    await expect(readFile(path.join(staging, "CONTEXT.md"), "utf8")).resolves.toContain("Different");
  });
});
