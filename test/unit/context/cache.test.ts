import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextCache,
  ContextCacheConflictError,
  computeManifestHash,
} from "../../../src/context/cache.js";
import { digestArtifactInputs } from "../../../src/context/artifact-validator.js";
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

async function createStaging(
  root: string,
  options: { zeroDomains?: boolean; baseSha?: string } = {},
): Promise<string> {
  const staging = await mkdtemp(path.join(root, "staging-"));
  await mkdir(path.join(staging, ".understand-anything"), { recursive: true });
  await writeFile(path.join(staging, "CONTEXT.md"), "# Trusted context\n", "utf8");
  await writeFile(
    path.join(staging, ".understand-anything/knowledge-graph.json"),
    JSON.stringify({ nodes: [], edges: [] }),
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
      JSON.stringify({ domains: [] }),
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

  it("accepts the narrowly-defined zero-domain marker instead of a domain graph", async () => {
    const root = await tempRoot();
    const cache = new ContextCache(root);
    const staging = await createStaging(root, { zeroDomains: true });
    const zeroDomainInput = input({
      artifacts: [
        { kind: "context", path: "CONTEXT.md" },
        { kind: "knowledge-graph", path: ".understand-anything/knowledge-graph.json" },
        { kind: "zero-domains", path: ".understand-anything/zero-domains.json" },
        { kind: "mapping-metadata", path: ".understand-anything/mapping-metadata.json" },
      ],
    });

    const promoted = await cache.promoteContext(staging, zeroDomainInput);

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

  it.each(["../escape", "/absolute", "nested\\escape", "nested/../escape", "nul\0byte"])(
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

    expect(calls).toEqual([`rename:${staging}:${cache.entryPath(key)}`]);
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
