import { chmod, chown, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeManifestHash, ContextCache, ContextCacheConflictError, ContextCachePublicationInProgressError } from "../../../src/context/cache.js";
import {
  CONTEXT_GENERATION_CEILING,
  CONTEXT_MAPPER_VERSION,
  CONTEXT_POLICY_VERSION,
  CONTEXT_SCHEMA_VERSION,
  ContextRequiredError,
  contextCacheKey,
  contextFingerprint,
  prepareReviewContext,
} from "../../../src/context/prepare.js";
import type { ContextManifest } from "../../../src/context/types.js";
import type { ContextMapRequest, ContextMapper, MappingResult } from "../../../src/context/mapper.js";
import type { PrepareContextDependencies } from "../../../src/context/prepare.js";
import type { PreparedWorkspace } from "../../../src/workspace/types.js";
import type { GitHubRepositoryRef } from "../../../src/target/types.js";

const BASE_SHA = "def4567890def4567890def4567890def4567890";
const HEAD_SHA = "aaaa111122223333444455556666777788889999";

const repository: GitHubRepositoryRef = {
  provider: "github",
  host: "github.com",
  owner: "octo-org",
  repo: "octo-repo",
  canonicalUrl: "https://github.com/octo-org/octo-repo",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  // Resolved, because macOS makes `os.tmpdir()` `/var/folders/...` and `/var`
  // is a symlink to `private/var`. The code under test resolves the path it is
  // given — deliberately, since a symlink in a cache or workspace path is a
  // real hazard it refuses — so an unresolved root makes the test disagree
  // with production about what the same directory is called. That reads as a
  // product bug on macOS and passes on Linux, where /tmp is not a symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prepare-context-test-")));
  roots.push(root);
  return root;
}

function knowledgeGraph(gitCommitHash: string = BASE_SHA): Record<string, unknown> {
  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "octo-repo",
      languages: ["typescript"],
      frameworks: [],
      description: "Trusted test repository",
      analyzedAt: "2026-07-21T00:00:00.000Z",
      gitCommitHash,
    },
    nodes: [{
      id: "file:src/index.ts",
      type: "file",
      name: "index.ts",
      filePath: "src/index.ts",
      lineRange: [1, 8],
      summary: "Application entry point",
      tags: ["entry-point"],
      complexity: "simple",
    }],
    edges: [],
    layers: [],
    tour: [],
  };
}

/**
 * Writes the artifact layout a real `/tgd-map` run produces into the staging
 * directory the caller hands the mapper, and reports it exactly as
 * `TgdPiMapper` would.
 */
function stubMapper(overrides: {
  onMap?: (request: ContextMapRequest) => void;
  result?: (paths: string[]) => MappingResult;
} = {}): ContextMapper & { calls: ContextMapRequest[] } {
  const calls: ContextMapRequest[] = [];
  return {
    calls,
    async map(request: ContextMapRequest): Promise<MappingResult> {
      calls.push(request);
      overrides.onMap?.(request);
      const artifactPaths = [
        "CONTEXT.md",
        ".understand-anything/knowledge-graph.json",
        ".understand-anything/zero-domains.json",
        ".understand-anything/mapping-metadata.json",
      ];
      if (overrides.result !== undefined) return overrides.result(artifactPaths);
      await mkdir(path.join(request.outputRoot, ".understand-anything"), { recursive: true });
      await writeFile(path.join(request.outputRoot, "CONTEXT.md"), "# Trusted context\n", "utf8");
      await writeFile(
        path.join(request.outputRoot, ".understand-anything/knowledge-graph.json"),
        JSON.stringify(knowledgeGraph(request.baseSha)),
        "utf8",
      );
      await writeFile(
        path.join(request.outputRoot, ".understand-anything/zero-domains.json"),
        JSON.stringify({ version: 1, status: "zero-domains" }),
        "utf8",
      );
      await writeFile(
        path.join(request.outputRoot, ".understand-anything/mapping-metadata.json"),
        JSON.stringify({ version: 1, status: "complete", baseSha: request.baseSha }),
        "utf8",
      );
      return {
        status: "ready",
        manifestPath: path.join(request.outputRoot, ".understand-anything/mapping-metadata.json"),
        artifactPaths,
        analyzedFiles: 1,
        degradedReasons: [],
      };
    },
  };
}

/** A `prepareWorkspace` stand-in that hands back a directory at the base SHA. */
// Lock-SCOPED, like the real one: the consumer runs inside the callback, so a
// stub that merely returns the paths would let the tests pass against a version
// that reads the worktree after the lock is released (#78).
function stubWorkspace(worktreePath: string, reportedBaseSha?: string) {
  // Cast for the same reason as elsewhere: `vi.fn` cannot express the real
  // function's generic return. The stub honours the contract that matters here
  // — the consumer runs under the caller's control, inside the lock (#78).
  return vi.fn(async (
    request: { root: string; baseSha: string },
    use: (prepared: PreparedWorkspace) => Promise<unknown>,
  ) => use({
    root: request.root,
    repositoryRoot: path.join(request.root, "repo"),
    mirrorPath: path.join(request.root, "repo", "mirror"),
    worktreesRoot: path.join(request.root, "repo", "worktrees"),
    baseWorktreePath: worktreePath,
    ownerMarkerPath: path.join(request.root, "repo", "owner.json"),
    baseSha: reportedBaseSha ?? request.baseSha,
  } as PreparedWorkspace));
}

async function baseRequest(overrides: Record<string, unknown> = {}) {
  const root = await tempRoot();
  const worktree = path.join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  return {
    root,
    worktree,
    request: {
      mode: "auto" as const,
      repository,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      changedFiles: ["src/index.ts"],
      ruleNames: ["tgd-review"],
      allowDegraded: false,
      workspaceRoot: path.join(root, "workspaces"),
      cacheRoot: path.join(root, "cache"),
      ...overrides,
    },
  };
}

describe("contextFingerprint", () => {
  it("contributes nothing when context is off, so opting out costs no re-review", () => {
    expect(contextFingerprint({ mode: "off", baseSha: BASE_SHA, allowDegraded: false })).toBeUndefined();
    // Every other knob is irrelevant once the feature is off.
    expect(
      contextFingerprint({ mode: "off", baseSha: HEAD_SHA, maxChars: 9000, allowDegraded: true }),
    ).toBeUndefined();
  });

  it("changes when the base commit moves, so an advanced base re-reviews", () => {
    const before = contextFingerprint({ mode: "auto", baseSha: BASE_SHA, allowDegraded: false });
    const after = contextFingerprint({ mode: "auto", baseSha: HEAD_SHA, allowDegraded: false });
    expect(before).toBeTypeOf("string");
    expect(after).not.toBe(before);
  });

  it("separates each mode and size budget", () => {
    const auto = contextFingerprint({ mode: "auto", baseSha: BASE_SHA, allowDegraded: false });
    expect(contextFingerprint({ mode: "require", baseSha: BASE_SHA, allowDegraded: false })).not.toBe(auto);
    expect(contextFingerprint({ mode: "auto", baseSha: BASE_SHA, maxChars: 9000, allowDegraded: false }))
      .not.toBe(auto);
    expect(contextFingerprint({ mode: "auto", baseSha: BASE_SHA, allowDegraded: true })).not.toBe(auto);
  });
});

describe("contextCacheKey", () => {
  it("pins the schema, mapper and policy identity into the key", () => {
    // Issue #60: the key is an identity — the base commit is deliberately
    // absent, because the entry is the repository's living index.
    expect(contextCacheKey({ repository })).toEqual({
      provider: "github",
      host: "github.com",
      owner: "octo-org",
      repo: "octo-repo",
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      tgdVersion: CONTEXT_MAPPER_VERSION,
      policyVersion: CONTEXT_POLICY_VERSION,
    });
  });
});

describe("prepareReviewContext", () => {
  it("maps, publishes and packs on a cold cache", async () => {
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.cacheHit).toBe(false);
    expect(Object.keys(prepared.packs)).toEqual(["tgd-review"]);
    expect(prepared.packs["tgd-review"]!.text).toContain("# Trusted Rule Context");
    expect(prepared.packs["tgd-review"]!.text).toContain("src/index.ts");
    expect(prepared.packs["tgd-review"]!.manifestHash).toBe(prepared.manifestHash);
  });

  // PR #99 review: with the mapping now inside the lock, a second review of the
  // same base waits for the first and would then pay for an identical mapping.
  // The first has published by the time the lock is released.
  it("takes a cache entry published while it waited, instead of mapping again", async () => {
    const { worktree, request } = await baseRequest();
    // A concurrent review already mapped and published this exact base.
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    const mapper = stubMapper();
    const real = new ContextCache(request.cacheRoot as string);
    let lookups = 0;
    // Misses before the lock, hits inside it — the entry a concurrent review
    // published while this one waited.
    const racing = Object.assign(Object.create(ContextCache.prototype) as ContextCache, {
      root: real.root,
      entryPath: (k: Parameters<ContextCache["entryPath"]>[0]) => real.entryPath(k),
      promoteContext: (
        staging: string, input: Parameters<ContextCache["promoteContext"]>[1],
      ) => real.promoteContext(staging, input),
      // The first lookup happens BEFORE the lock and misses, as it did for the
      // concurrent review too; the second happens after and finds what that
      // review published in the meantime.
      lookupContext: async (k: Parameters<ContextCache["lookupContext"]>[0]) => {
        lookups += 1;
        return lookups === 1 ? undefined : await real.lookupContext(k);
      },
    }) as ContextCache;

    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      createCache: () => racing,
    });

    // Twice: once before taking the lock, once after — and the second is what
    // finds the entry the concurrent review published while this one waited.
    expect(lookups).toBe(2);
    // THE point: the expensive step never ran.
    expect(mapper.calls).toHaveLength(0);
  });

  it("never maps the head commit — the mapper only ever sees the base", async () => {
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    const workspace = stubWorkspace(worktree);
    await prepareReviewContext(request, { prepareWorkspace: workspace as unknown as PrepareContextDependencies["prepareWorkspace"], createMapper: () => mapper });

    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.baseSha).toBe(BASE_SHA);
    expect(mapper.calls[0]!.baseSha).not.toBe(HEAD_SHA);
    expect(mapper.calls[0]!.sourceRoot).toBe(worktree);
    // Two arguments now: the request, and the callback the lock is held for.
    expect(workspace).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: BASE_SHA }), expect.any(Function));
    expect(JSON.stringify(workspace.mock.calls)).not.toContain(HEAD_SHA);
  });

  it("refuses to map a worktree that is not at the requested base commit", async () => {
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    // A worktree reporting some other commit must never be handed to a mapper
    // that can run bash: that is how a PR's own code would get executed.
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree, HEAD_SHA) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    expect(mapper.calls).toHaveLength(0);
  });

  it("reuses a published entry without starting a second mapping session", async () => {
    const { worktree, request } = await baseRequest();
    const first = stubMapper();
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => first,
    });

    const second = stubMapper();
    const workspace = stubWorkspace(worktree);
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: workspace as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => second,
    });

    expect(second.calls).toHaveLength(0);
    expect(workspace).not.toHaveBeenCalled();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.cacheHit).toBe(true);
  });

  it("builds one pack per rule from a single selection, all sharing one manifest hash", async () => {
    const { worktree, request } = await baseRequest({
      ruleNames: ["tgd-review", "security-audit", "naming"],
    });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(Object.keys(prepared.packs).sort()).toEqual(["naming", "security-audit", "tgd-review"]);
    const hashes = new Set(Object.values(prepared.packs).map((pack) => pack.manifestHash));
    expect(hashes.size).toBe(1);
    // Each pack names its own rule, and nothing else differs between them.
    expect(prepared.packs["naming"]!.text).toContain("Rule: naming");
    expect(prepared.packs["security-audit"]!.text).toContain("Rule: security-audit");
    expect(prepared.packs["naming"]!.text.replace("Rule: naming", "Rule: security-audit"))
      .toBe(prepared.packs["security-audit"]!.text);
  });

  it("gives each rule its own truncation accounting rather than a shared counter", async () => {
    const { worktree, request } = await baseRequest({ ruleNames: ["one", "two"] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const [first, second] = [prepared.packs["one"]!, prepared.packs["two"]!];
    expect(first.sources).not.toBe(second.sources);
    expect(first.sources.map((source) => source.includedItems))
      .toEqual(second.sources.map((source) => source.includedItems));
  });

  it("finds a renamed file's nodes via its base-side path", async () => {
    // The graph is mapped from the base commit, where the file is still
    // `src/index.ts`. A PR that renames it to `src/entry.ts` sends BOTH paths
    // (see changedFilesWithRenameSources); matching only the new one would
    // return a ready pack with no graph nodes at all.
    const { worktree, request } = await baseRequest({
      changedFiles: ["src/entry.ts", "src/index.ts"],
    });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const text = prepared.packs["tgd-review"]!.text;
    expect(text).toContain("src/index.ts");
    expect(text).not.toContain("No graph nodes matched the changed files.");
  });

  it("reports no match when only the head-side path of a rename is sent", async () => {
    // The defect this guards: the new path does not exist at the base.
    const { worktree, request } = await baseRequest({ changedFiles: ["src/entry.ts"] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.packs["tgd-review"]!.text)
      .toContain("No graph nodes matched the changed files.");
  });

  it("keys each pack by the rule name the caller passed, untrimmed", async () => {
    // `loadRules` stores a rule's frontmatter name verbatim and
    // `validateDispatchContext` looks the pack up by that exact string, so a
    // trimmed key would leave the rule unable to find its pack and fail the
    // whole dispatch.
    const { worktree, request } = await baseRequest({ ruleNames: ["  spaced  ", "plain"] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(Object.keys(prepared.packs).sort()).toEqual(["  spaced  ", "plain"]);
  });

  it("keeps two names that differ only by whitespace as two packs", async () => {
    const { worktree, request } = await baseRequest({ ruleNames: ["dup", "dup "] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(Object.keys(prepared.packs).sort()).toEqual(["dup", "dup "]);
  });

  it("still rejects a rule name that is not usable at all", async () => {
    const { worktree, request } = await baseRequest({ ruleNames: ["   "] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("unavailable");
  });

  it("does nothing at all when context is off", async () => {
    const { worktree, request } = await baseRequest({ mode: "off" });
    const mapper = stubMapper();
    const workspace = stubWorkspace(worktree);
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: workspace as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
    });

    expect(prepared).toEqual({ status: "off" });
    expect(workspace).not.toHaveBeenCalled();
    expect(mapper.calls).toHaveLength(0);
  });

  it("degrades to a context-free review when mapping fails", async () => {
    const { worktree, request } = await baseRequest();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper({
        result: () => ({
          status: "failed",
          manifestPath: "",
          artifactPaths: [],
          analyzedFiles: 0,
          degradedReasons: [],
          failure: { stage: "context-map", code: "pi-session-failed", message: "mapping timed out" },
        }),
      }),
    });

    expect(prepared).toEqual({ status: "unavailable", reasons: ["mapping timed out"] });
  });

  it("degrades when the mapper throws instead of returning a failure", async () => {
    const { worktree, request } = await baseRequest();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => ({
        map: () => Promise.reject(new Error("session crashed")),
      }),
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") return;
    expect(prepared.reasons.join(" ")).toContain("session crashed");
  });

  it("degrades when the base worktree cannot be prepared", async () => {
    const { request } = await baseRequest();
    const mapper = stubMapper();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: vi.fn(() => Promise.reject(new Error("git mirror unreachable"))),
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") return;
    expect(prepared.reasons.join(" ")).toContain("git mirror unreachable");
    expect(mapper.calls).toHaveLength(0);
  });

  it("reports a degraded map by what is missing, and publishes nothing", async () => {
    const { worktree, request } = await baseRequest({ allowDegraded: true });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper({
        result: () => ({
          status: "degraded",
          manifestPath: "",
          artifactPaths: [],
          analyzedFiles: 0,
          degradedReasons: ["knowledge-graph-unavailable"],
        }),
      }),
    });

    // A degraded map has no knowledge graph, and a pack without one is not
    // something a rule can reason over — so it is reported, not published.
    expect(prepared).toEqual({
      status: "unavailable",
      reasons: ["knowledge-graph-unavailable"],
    });
    const cache = new ContextCache(request.cacheRoot as string);
    await expect(cache.lookupContext(contextCacheKey({ repository })))
      .resolves.toBeUndefined();
  });

  it("passes allowDegraded through to the mapper only when asked", async () => {
    const permissive = await baseRequest({ allowDegraded: true });
    const permissiveMapper = stubMapper();
    await prepareReviewContext(permissive.request, {
      prepareWorkspace: stubWorkspace(permissive.worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => permissiveMapper,
    });
    expect(permissiveMapper.calls[0]!.allowDegradedContext).toBe(true);

    const strict = await baseRequest();
    const strictMapper = stubMapper();
    await prepareReviewContext(strict.request, {
      prepareWorkspace: stubWorkspace(strict.worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => strictMapper,
    });
    expect(strictMapper.calls[0]!.allowDegradedContext).toBeUndefined();
  });

  it("throws in require mode rather than reviewing blind, carrying the real reason", async () => {
    const { worktree, request } = await baseRequest({ mode: "require" });
    const thrown = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper({
        result: () => ({
          status: "failed",
          manifestPath: "",
          artifactPaths: [],
          analyzedFiles: 0,
          degradedReasons: [],
          failure: { stage: "context-map", code: "pi-session-failed", message: "no model available" },
        }),
      }),
    }).then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(ContextRequiredError);
    // `unavailable()` throws under `require`, and that throw happens where the
    // mapping catch could see it. If the catch wraps its own error, `reasons`
    // degrades to one concatenated string carrying a nested message, and the
    // caller loses the mapper's actual reason.
    expect((thrown as ContextRequiredError).reasons).toEqual(["no model available"]);
    expect((thrown as ContextRequiredError).message).not.toContain("--context require was set but no trusted-base context could be prepared: --context require");
  });

  it("throws the degraded reasons intact in require mode", async () => {
    const { worktree, request } = await baseRequest({ mode: "require", allowDegraded: true });
    const thrown = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper({
        result: () => ({
          status: "degraded",
          manifestPath: "",
          artifactPaths: [],
          analyzedFiles: 0,
          degradedReasons: ["knowledge-graph-unavailable", "domain-context-unavailable"],
        }),
      }),
    }).then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(ContextRequiredError);
    expect((thrown as ContextRequiredError).reasons)
      .toEqual(["knowledge-graph-unavailable", "domain-context-unavailable"]);
  });

  it("reports a mapper crash against the map stage, not publish", async () => {
    const { worktree, request } = await baseRequest();
    const events: Array<{ stage: string; status: string }> = [];
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => ({ map: () => Promise.reject(new Error("session crashed")) }),
      onProgress: (event) => void events.push(event),
    });

    // It never reached publication, so saying "publish failed" would send a
    // reader to the wrong half of the pipeline.
    expect(events).toContainEqual({ stage: "map", status: "failed" });
    expect(events.some((event) => event.stage === "publish")).toBe(false);
  });

  it("never maps when there is no rule to hand a pack to", async () => {
    const { worktree, request } = await baseRequest({ ruleNames: [] });
    const mapper = stubMapper();
    const workspace = stubWorkspace(worktree);
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: workspace as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    expect(mapper.calls).toHaveLength(0);
    expect(workspace).not.toHaveBeenCalled();
  });

  it("leaves no staging directory behind on either outcome", async () => {
    const success = await baseRequest();
    await prepareReviewContext(success.request, {
      prepareWorkspace: stubWorkspace(success.worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });
    await expect(readdir(path.join(success.request.cacheRoot as string, "staging")))
      .resolves.toEqual([]);

    const failure = await baseRequest();
    await prepareReviewContext(failure.request, {
      prepareWorkspace: stubWorkspace(failure.worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper({
        result: () => ({
          status: "failed",
          manifestPath: "",
          artifactPaths: [],
          analyzedFiles: 0,
          degradedReasons: [],
          failure: { stage: "context-map", code: "invalid-artifacts", message: "bad graph" },
        }),
      }),
    });
    await expect(readdir(path.join(failure.request.cacheRoot as string, "staging")))
      .resolves.toEqual([]);
  });

  it("honours the per-rule size ceiling", async () => {
    const { worktree, request } = await baseRequest({ maxChars: 4000 });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.packs["tgd-review"]!.text.length).toBeLessThanOrEqual(4000);
  });

  it("refuses a cache root owned by another user", async () => {
    if (process.platform === "win32" || process.getuid?.() === undefined) return;
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    await mkdir(request.cacheRoot as string, { recursive: true });
    // Ownership is what supplies provenance: `lookupContext` checks an entry
    // against its own manifest, and a manifest says nothing about who wrote
    // it, so a root someone else can write is a root that can hand the
    // reviewing model attacker-authored `[TRUSTED_CONTEXT]`.
    //
    // Giving a directory away requires privilege, so this is one of the few
    // tests that needs MORE of it, not less — and it must skip when it cannot
    // set itself up. It previously swallowed the failed `chown` and asserted
    // the refusal against a root that had never changed hands, which meant it
    // could not pass for an unprivileged user and was skipped for a privileged
    // one: no configuration ran it, and the refusal was never verified at all.
    // Same shape as the ancestor-ownership test below.
    const gaveAway = await chown(request.cacheRoot as string, 65534, 65534)
      .then(() => true, () => false);
    if (!gaveAway) return;

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") throw new Error("unreachable");
    expect(prepared.reasons.join(" ")).toContain("must be owned by the current user");
    // The refusal has to land before the expensive, code-executing half of the
    // pipeline, not after it.
    expect(mapper.calls).toHaveLength(0);
  });

  it("makes the cache root private to the current user", async () => {
    if (process.platform === "win32") return;
    const { worktree, request } = await baseRequest();
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    const info = await stat(request.cacheRoot as string);
    expect(info.mode & 0o077).toBe(0);
  });

  it("resolves a symlinked ancestor of the cache root before trusting it", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const worktree = path.join(root, "worktree");
    const real = path.join(root, "real-cache-parent");
    const link = path.join(root, "linked-parent");
    await mkdir(worktree, { recursive: true });
    await mkdir(real, { recursive: true });
    await symlink(real, link);

    // The configured root reaches its directory THROUGH a symlink. The
    // ancestor walk in protectManagedRoot uses stat, which follows links and
    // so inspects the target's mode rather than noticing the link at all;
    // resolving first is what removes the retarget window.
    const request = {
      mode: "auto" as const,
      repository,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      changedFiles: ["src/index.ts"],
      ruleNames: ["tgd-review"],
      allowDegraded: false,
      workspaceRoot: path.join(root, "workspaces"),
      cacheRoot: path.join(link, "cache"),
    };
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    // The entry must live under the resolved directory, not be reachable only
    // through the link.
    await expect(readdir(path.join(real, "cache", "contexts"))).resolves.not.toEqual([]);
  });

  it("refuses a cache root that other users could previously write", async () => {
    if (process.platform === "win32") return;
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    // Owned by us now, but it was world-writable, so another user may already
    // have put an entry inside. chmod 0700 would lock the door on their files
    // and `lookupContext` would then read one as trusted-base context.
    await mkdir(request.cacheRoot as string, { recursive: true });
    await chmod(request.cacheRoot as string, 0o777);

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") return;
    expect(prepared.reasons.join(" ")).toContain("writable by other users");
    expect(mapper.calls).toHaveLength(0);
  });

  it("creates its own cache root 0700, so a fresh one is never refused", async () => {
    if (process.platform === "win32") return;
    // Guards the umask-0 false positive: the root is created mode 0700 rather
    // than inheriting a permissive umask and then failing its own check.
    const { worktree, request } = await baseRequest();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
  });

  it("refuses a cache root whose ancestor another user owns", async () => {
    if (process.platform === "win32" || process.getuid?.() === undefined) return;
    const root = await tempRoot();
    const worktree = path.join(root, "worktree");
    const parent = path.join(root, "someone-elses");
    await mkdir(worktree, { recursive: true });
    await mkdir(path.join(parent, "cache"), { recursive: true });
    // Mode 0755 and owned by another user passes every write-bit test —
    // owner-write is not in 0o022 — yet that owner can rename the protected
    // root after the last check and drop their own directory in its place.
    const chowned = await chown(parent, 65534, 65534).then(() => true, () => false);
    if (!chowned) return;

    const prepared = await prepareReviewContext({
      mode: "auto" as const,
      repository,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      changedFiles: ["src/index.ts"],
      ruleNames: ["tgd-review"],
      allowDegraded: false,
      workspaceRoot: path.join(root, "workspaces"),
      cacheRoot: path.join(parent, "cache"),
    }, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") return;
    expect(prepared.reasons.join(" ")).toContain("owned by another user");
  });

  // The cache key covers the base commit, the schema, the mapper and the policy
  // — nothing about the pack renderer. So an entry that promotes cleanly and
  // then cannot be rendered is NOT self-correcting: every later run at that base
  // finds it, re-pays the same failing build and degrades, until
  // CONTEXT_SCHEMA_VERSION moves. The run that created it is the one that knows,
  // so it is the one that throws it away.
  it("discards its own freshly published entry when the entry cannot render", async () => {
    const { worktree, request } = await baseRequest();
    const cache = new ContextCache(request.cacheRoot as string);
    const key = contextCacheKey({ repository });

    // Publication validates the artifacts against the same schema the renderer
    // parses, so a malformed graph never gets this far. What CAN get here is an
    // entry that promotes intact and is then unreadable at render time — a lost
    // artifact, a resource limit, a renderer that grew stricter than the
    // publisher. Reproduced by promoting for real and then removing an artifact
    // the pack build needs.
    const breaking = new ContextCache(request.cacheRoot as string);
    const breakingProxy = Object.assign(Object.create(ContextCache.prototype) as ContextCache, {
      root: breaking.root,
      entryPath: (k: Parameters<ContextCache["entryPath"]>[0]) => breaking.entryPath(k),
      lookupContext: (k: Parameters<ContextCache["lookupContext"]>[0]) => breaking.lookupContext(k),
      promoteContext: async (
        staging: string,
        input: Parameters<ContextCache["promoteContext"]>[1],
      ) => {
        const manifest = await breaking.promoteContext(staging, input);
        await rm(path.join(breaking.entryPath(input.key), ".understand-anything"), {
          recursive: true,
          force: true,
        });
        return manifest;
      },
    }) as ContextCache;

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
      createCache: () => breakingProxy,
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") throw new Error("unreachable");
    expect(prepared.reasons.join(" ")).toContain("context pack could not be built");
    expect(prepared.reasons.join(" ")).toContain("discarded");
    // Gone from disk, not merely unreadable: the next run re-maps.
    await expect(stat(cache.entryPath(key))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cache.lookupContext(key)).toBeUndefined();
  });

  // The mirror image. An entry a CONCURRENT run published is not this run's to
  // throw away — the pack failure may be local to this process, and deleting it
  // would destroy work this run did not do and cannot redo any better.
  it("leaves a concurrently published entry alone when the pack build fails", async () => {
    const { worktree, request } = await baseRequest();
    const key = contextCacheKey({ repository });
    // A real, complete entry, published by "another run".
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });
    const cache = new ContextCache(request.cacheRoot as string);
    const winner = await cache.lookupContext(key);
    expect(winner).toBeDefined();

    // This run loses the race, and then cannot render what the winner published.
    const losing = {
      root: cache.root,
      entryPath: () => path.join(request.cacheRoot as string, "empty-entry"),
      lookupContext: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(winner),
      promoteContext: () => Promise.reject(new ContextCacheConflictError("taken")),
    } as unknown as ContextCache;

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
      createCache: () => losing,
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") throw new Error("unreachable");
    expect(prepared.reasons.join(" ")).toContain("context pack could not be built");
    expect(prepared.reasons.join(" ")).not.toContain("discarded");
    // The winner's entry survives untouched.
    expect(await cache.lookupContext(key)).toBeDefined();
  });

  // Under `require`, `unavailable()` THROWS. A `pack()` call made inside the
  // lookup's own try was therefore caught by that lookup's catch and re-wrapped
  // as "context cache lookup failed: … context pack could not be built: …" —
  // the wrong stage, with the real reason demoted to a nested string. The
  // operator was sent to the wrong half of the pipeline.
  it("reports a cache-hit pack failure as a pack failure, not a lookup failure", async () => {
    const { worktree, request } = await baseRequest({ mode: "require" });
    // Publish a real entry so a genuine manifest exists to hand back.
    await prepareReviewContext({ ...request, mode: "auto" }, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });
    const cache = new ContextCache(request.cacheRoot as string);
    const manifest = await cache.lookupContext(contextCacheKey({ repository }));
    expect(manifest).toBeDefined();

    // A hit whose artifacts are not where the renderer will look for them.
    const hitting = {
      root: cache.root,
      entryPath: () => path.join(request.cacheRoot as string, "not-an-entry"),
      lookupContext: async () => manifest,
      promoteContext: () => {
        throw new Error("must not be reached: this run took the cache hit");
      },
    } as unknown as ContextCache;

    const error = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
      createCache: () => hitting,
    }).then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ContextRequiredError);
    expect((error as Error).message).toContain("context pack could not be built");
    expect((error as Error).message).not.toContain("cache lookup failed");
  });

  // Left unhandled, one crashed publisher breaks a base commit forever: nothing
  // else ever creates the entry, so every later review re-maps (the most
  // expensive step there is), finds the claim still held, waits out the full
  // publication timeout and returns unavailable — a non-zero exit under
  // `--context require` — until an operator deletes the directory by hand.
  it("publishes past a claim abandoned by a crashed publisher", async () => {
    const { worktree, request } = await baseRequest();
    const cache = new ContextCache(request.cacheRoot as string);
    const key = contextCacheKey({ repository });
    // Exactly what a crash mid-`promoteContext` leaves behind: the claim, with
    // the staged entry still inside it, and no process coming back for either.
    const claim = `${cache.entryPath(key)}.publishing`;
    await mkdir(path.join(claim, "entry"), { recursive: true });
    await writeFile(path.join(claim, "entry", "CONTEXT.md"), "# abandoned\n", "utf8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(claim, twoHoursAgo, twoHoursAgo);

    const started = Date.now();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("unreachable");
    expect(prepared.cacheHit).toBe(false);
    // The abandoned claim is gone and a real entry stands in its place.
    await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cache.lookupContext(key)).toBeDefined();
    // Reclaimed BEFORE the publication wait, not after it: polling for an entry
    // no process will ever write is the full timeout burned on every review of
    // this base commit. Bounded well under the wait's own 30 seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("waits for a concurrent publication rather than giving up on one miss", async () => {
    const { worktree, request } = await baseRequest();
    // First run publishes normally, so a real entry exists to be found.
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
    });
    const published = await new ContextCache(request.cacheRoot as string)
      .lookupContext(contextCacheKey({ repository }));
    expect(published).toBeDefined();

    // Now simulate the loser of a race: promotion reports the winner still
    // holds the claim, and the entry only becomes visible a moment later.
    let lookups = 0;
    const cache = new ContextCache(request.cacheRoot as string);
    const racing = {
      root: cache.root,
      entryPath: (key: Parameters<ContextCache["entryPath"]>[0]) => cache.entryPath(key),
      lookupContext: async (key: Parameters<ContextCache["lookupContext"]>[0]) => {
        lookups += 1;
        // Miss on the first two lookups (the initial cache check, and the
        // immediate post-conflict one), then let it land.
        return lookups <= 2 ? undefined : cache.lookupContext(key);
      },
      promoteContext: () => Promise.reject(new ContextCachePublicationInProgressError("busy")),
      // A LIVE publisher holds this claim, so there is nothing to reclaim and
      // the wait below is the whole point of the test.
      reclaimStaleClaim: () => Promise.resolve(false),
    } as unknown as ContextCache;

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubMapper(),
      createCache: () => racing,
    });

    expect(prepared.status).toBe("ready");
  });
});

// Issue #60: the entry is the repository's living index. A review at a newer
// base with a warm entry from an older base measures the delta and decides
// between an exact hit, an incremental patch, and a full re-map.
describe("prepareReviewContext — the warm index (#60)", () => {
  const NEW_SHA = "c".repeat(40);

  /** A mapper stub that writes a domain-bearing graph pinned to the mapped commit. */
  function stubDomainMapper(): ContextMapper & { calls: ContextMapRequest[] } {
    const calls: ContextMapRequest[] = [];
    return {
      calls,
      async map(request: ContextMapRequest): Promise<MappingResult> {
        calls.push(request);
        const artifactPaths = [
          "CONTEXT.md",
          ".understand-anything/knowledge-graph.json",
          ".understand-anything/domain-graph.json",
          ".understand-anything/mapping-metadata.json",
        ];
        await mkdir(path.join(request.outputRoot, ".understand-anything"), { recursive: true });
        await writeFile(path.join(request.outputRoot, "CONTEXT.md"), "# Trusted context\n", "utf8");
        const graph = knowledgeGraph(request.baseSha);
        await writeFile(
          path.join(request.outputRoot, ".understand-anything/knowledge-graph.json"),
          JSON.stringify(graph),
          "utf8",
        );
        await writeFile(
          path.join(request.outputRoot, ".understand-anything/domain-graph.json"),
          JSON.stringify({
            version: "1.0.0",
            project: { name: "octo-repo", languages: ["typescript"], frameworks: [], description: "domains", analyzedAt: "2026-07-21T00:00:00.000Z", gitCommitHash: request.baseSha },
            nodes: [{ id: "domain:core", type: "domain", name: "core", summary: "Core domain", tags: [], complexity: "simple" }],
            edges: [],
            layers: [],
            tour: [],
          }),
          "utf8",
        );
        await writeFile(
          path.join(request.outputRoot, ".understand-anything/mapping-metadata.json"),
          JSON.stringify({ version: 1, status: "complete", baseSha: request.baseSha }),
          "utf8",
        );
        return {
          status: "ready",
          manifestPath: path.join(request.outputRoot, ".understand-anything/mapping-metadata.json"),
          artifactPaths,
          analyzedFiles: 1,
          degradedReasons: [],
        };
      },
    };
  }

  /** A mapper stub that writes the explicit zero-domains marker. */
  function stubZeroDomainsMapper(): ContextMapper & { calls: ContextMapRequest[] } {
    const calls: ContextMapRequest[] = [];
    return {
      calls,
      async map(request: ContextMapRequest): Promise<MappingResult> {
        calls.push(request);
        const artifactPaths = [
          "CONTEXT.md",
          ".understand-anything/knowledge-graph.json",
          ".understand-anything/zero-domains.json",
          ".understand-anything/mapping-metadata.json",
        ];
        await mkdir(path.join(request.outputRoot, ".understand-anything"), { recursive: true });
        await writeFile(path.join(request.outputRoot, "CONTEXT.md"), "# Trusted context\n", "utf8");
        await writeFile(
          path.join(request.outputRoot, ".understand-anything/knowledge-graph.json"),
          JSON.stringify(knowledgeGraph(request.baseSha)),
          "utf8",
        );
        await writeFile(
          path.join(request.outputRoot, ".understand-anything/zero-domains.json"),
          JSON.stringify({ version: 1, status: "zero-domains" }),
          "utf8",
        );
        await writeFile(
          path.join(request.outputRoot, ".understand-anything/mapping-metadata.json"),
          JSON.stringify({ version: 1, status: "complete", baseSha: request.baseSha }),
          "utf8",
        );
        return {
          status: "ready",
          manifestPath: path.join(request.outputRoot, ".understand-anything/mapping-metadata.json"),
          artifactPaths,
          analyzedFiles: 1,
          degradedReasons: [],
        };
      },
    };
  }

  function incrementalDelta(overrides: Record<string, unknown> = {}) {
    return {
      delta: {
        fromSha: BASE_SHA,
        toSha: NEW_SHA,
        commitCount: 1,
        added: [],
        changed: ["src/index.ts"],
        deleted: [],
        ...overrides,
      },
      kind: "incremental" as const,
    };
  }

  async function warmCacheAtBase(request: Record<string, unknown>, baseSha: string = BASE_SHA): Promise<void> {
    await prepareReviewContext({ ...request, baseSha } as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace((request as { workspaceRoot: string }).workspaceRoot) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubDomainMapper(),
    });
  }

  it("reuses the cached graph on a small delta and re-maps ONLY the changed files", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const mapper = stubDomainMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.resolve(incrementalDelta()),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.incremental).toBe(true);
    expect(prepared.cacheHit).toBe(false);
    // Exactly one scoped session, at the NEW base, scoped to the delta — and
    // no full mapping session.
    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.scopePaths).toEqual(["src/index.ts"]);
    expect(mapper.calls[0]!.baseSha).toBe(NEW_SHA);
    expect(mapper.calls[0]!.outputRoot).not.toBe(path.join((request.cacheRoot as string), "staging"));
  });

  it("does not start a scoped session at all when the delta only deletes", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const mapper = stubDomainMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.resolve(incrementalDelta({ changed: [], deleted: ["src/old.ts"] })),
    });

    expect(prepared.status).toBe("ready");
    expect(mapper.calls).toHaveLength(0);
    if (prepared.status !== "ready") return;
    expect(prepared.incremental).toBe(true);
    // PR #107 review, round three: a deletion-only delta runs no scoped
    // session, so it must not be labelled as one that failed — that reason
    // would be inherited by every later patch.
    expect(prepared.degradedReasons).toEqual([]);
  });

  it("performs a full remap when the delta is large", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const mapper = stubDomainMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.resolve({
        delta: { fromSha: BASE_SHA, toSha: NEW_SHA, commitCount: 40, added: [], changed: [], deleted: [] },
        kind: "full",
        reason: "too many commits",
      }),
    });

    expect(prepared.status).toBe("ready");
    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.scopePaths).toBeUndefined();
    if (prepared.status !== "ready") return;
    expect(prepared.incremental).toBe(false);
    expect(prepared.cacheHit).toBe(false);
  });

  it("performs a full remap when the delta crosses a domain-graph flow file", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const mapper = stubDomainMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.resolve({
        delta: { fromSha: BASE_SHA, toSha: NEW_SHA, commitCount: 1, added: [], changed: ["src/flow.ts"], deleted: [] },
        kind: "full",
        reason: "a file named by a domain-graph flow step changed",
      }),
    });

    expect(prepared.status).toBe("ready");
    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.scopePaths).toBeUndefined();
  });

  it("performs a full remap once the generation ceiling is reached", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const real = new ContextCache(request.cacheRoot as string);
    const key = contextCacheKey({ repository });
    const entry = await real.lookupContext(key);
    expect(entry).toBeDefined();
    // Artificially age the entry past the ceiling, re-signing the manifest the
    // way buildManifest does so the only variable is the generation count.
    const aged = { ...entry!, generation: CONTEXT_GENERATION_CEILING };
    const agedManifest = aged as ContextManifest;
    agedManifest.manifestHash = computeManifestHash(agedManifest);
    await writeFile(
      path.join(real.entryPath(key), "manifest.json"),
      JSON.stringify(agedManifest),
      "utf8",
    );

    const mapper = stubDomainMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.resolve(incrementalDelta()),
    });

    expect(prepared.status).toBe("ready");
    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.scopePaths).toBeUndefined();
  });

  it("degrades to a full remap when the delta cannot be computed at all", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const mapper = stubDomainMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.reject(new Error("git mirror unreadable")),
    });

    expect(prepared.status).toBe("ready");
    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.scopePaths).toBeUndefined();
  });

  // PR #107 review: a zero-domains entry is a supported normal output — it
  // must patch like any other, not be locked out by the domain-graph gate.
  it("takes the incremental path for a zero-domains entry, carrying the marker forward", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await prepareReviewContext({ ...request, baseSha: BASE_SHA } as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubZeroDomainsMapper(),
    });

    const mapper = stubZeroDomainsMapper();
    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => mapper,
      computeDelta: () => Promise.resolve(incrementalDelta()),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.incremental).toBe(true);
    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.scopePaths).toEqual(["src/index.ts"]);

    const patched = await new ContextCache(request.cacheRoot as string)
      .lookupContext(contextCacheKey({ repository }));
    expect(patched).toBeDefined();
    if (patched === undefined) return;
    expect(patched.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "context", "knowledge-graph", "mapping-metadata", "zero-domains",
    ]);
    expect(patched.builtFromSha).toBe(NEW_SHA);
    expect(patched.generation).toBe(1);
  });

  it("publishes the patch atomically with parent provenance and a new manifest hash", async () => {
    const { worktree, request } = await baseRequest({ baseSha: NEW_SHA });
    await warmCacheAtBase(request, BASE_SHA);

    const real = new ContextCache(request.cacheRoot as string);
    const key = contextCacheKey({ repository });
    const parent = await real.lookupContext(key);
    expect(parent).toBeDefined();

    const prepared = await prepareReviewContext(request as unknown as Parameters<typeof prepareReviewContext>[0], {
      prepareWorkspace: stubWorkspace(worktree) as unknown as PrepareContextDependencies["prepareWorkspace"],
      createMapper: () => stubDomainMapper(),
      computeDelta: () => Promise.resolve(incrementalDelta()),
    });
    expect(prepared.status).toBe("ready");

    const patched = await real.lookupContext(key);
    expect(patched).toBeDefined();
    if (patched === undefined || parent === undefined) return;
    expect(patched.builtFromSha).toBe(NEW_SHA);
    expect(patched.parentManifestHash).toBe(parent.manifestHash);
    expect(patched.generation).toBe(parent.generation + 1);
    expect(patched.manifestHash).not.toBe(parent.manifestHash);
  });
});
