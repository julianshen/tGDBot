import { chmod, chown, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextCache, ContextCachePublicationInProgressError } from "../../../src/context/cache.js";
import {
  CONTEXT_MAPPER_VERSION,
  CONTEXT_POLICY_VERSION,
  CONTEXT_SCHEMA_VERSION,
  ContextRequiredError,
  contextCacheKey,
  contextFingerprint,
  prepareReviewContext,
} from "../../../src/context/prepare.js";
import type { ContextMapRequest, ContextMapper, MappingResult } from "../../../src/context/mapper.js";
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
  const root = await mkdtemp(path.join(os.tmpdir(), "prepare-context-test-"));
  roots.push(root);
  return root;
}

function knowledgeGraph(): Record<string, unknown> {
  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "octo-repo",
      languages: ["typescript"],
      frameworks: [],
      description: "Trusted test repository",
      analyzedAt: "2026-07-21T00:00:00.000Z",
      gitCommitHash: BASE_SHA,
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
        JSON.stringify(knowledgeGraph()),
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
function stubWorkspace(worktreePath: string, reportedBaseSha?: string) {
  return vi.fn(async (request: { root: string; baseSha: string }) => ({
    root: request.root,
    repositoryRoot: path.join(request.root, "repo"),
    mirrorPath: path.join(request.root, "repo", "mirror"),
    worktreesRoot: path.join(request.root, "repo", "worktrees"),
    baseWorktreePath: worktreePath,
    ownerMarkerPath: path.join(request.root, "repo", "owner.json"),
    baseSha: reportedBaseSha ?? request.baseSha,
  }));
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
    expect(contextCacheKey({ repository, baseSha: BASE_SHA })).toEqual({
      provider: "github",
      host: "github.com",
      owner: "octo-org",
      repo: "octo-repo",
      baseSha: BASE_SHA,
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
      prepareWorkspace: stubWorkspace(worktree),
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

  it("never maps the head commit — the mapper only ever sees the base", async () => {
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    const workspace = stubWorkspace(worktree);
    await prepareReviewContext(request, { prepareWorkspace: workspace, createMapper: () => mapper });

    expect(mapper.calls).toHaveLength(1);
    expect(mapper.calls[0]!.baseSha).toBe(BASE_SHA);
    expect(mapper.calls[0]!.baseSha).not.toBe(HEAD_SHA);
    expect(mapper.calls[0]!.sourceRoot).toBe(worktree);
    expect(workspace).toHaveBeenCalledWith(expect.objectContaining({ baseSha: BASE_SHA }));
    expect(JSON.stringify(workspace.mock.calls)).not.toContain(HEAD_SHA);
  });

  it("refuses to map a worktree that is not at the requested base commit", async () => {
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    // A worktree reporting some other commit must never be handed to a mapper
    // that can run bash: that is how a PR's own code would get executed.
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree, HEAD_SHA),
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    expect(mapper.calls).toHaveLength(0);
  });

  it("reuses a published entry without starting a second mapping session", async () => {
    const { worktree, request } = await baseRequest();
    const first = stubMapper();
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => first,
    });

    const second = stubMapper();
    const workspace = stubWorkspace(worktree);
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: workspace,
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(Object.keys(prepared.packs).sort()).toEqual(["  spaced  ", "plain"]);
  });

  it("keeps two names that differ only by whitespace as two packs", async () => {
    const { worktree, request } = await baseRequest({ ruleNames: ["dup", "dup "] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(Object.keys(prepared.packs).sort()).toEqual(["dup", "dup "]);
  });

  it("still rejects a rule name that is not usable at all", async () => {
    const { worktree, request } = await baseRequest({ ruleNames: ["   "] });
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("unavailable");
  });

  it("does nothing at all when context is off", async () => {
    const { worktree, request } = await baseRequest({ mode: "off" });
    const mapper = stubMapper();
    const workspace = stubWorkspace(worktree);
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: workspace,
      createMapper: () => mapper,
    });

    expect(prepared).toEqual({ status: "off" });
    expect(workspace).not.toHaveBeenCalled();
    expect(mapper.calls).toHaveLength(0);
  });

  it("degrades to a context-free review when mapping fails", async () => {
    const { worktree, request } = await baseRequest();
    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
    await expect(cache.lookupContext(contextCacheKey({ repository, baseSha: BASE_SHA })))
      .resolves.toBeUndefined();
  });

  it("passes allowDegraded through to the mapper only when asked", async () => {
    const permissive = await baseRequest({ allowDegraded: true });
    const permissiveMapper = stubMapper();
    await prepareReviewContext(permissive.request, {
      prepareWorkspace: stubWorkspace(permissive.worktree),
      createMapper: () => permissiveMapper,
    });
    expect(permissiveMapper.calls[0]!.allowDegradedContext).toBe(true);

    const strict = await baseRequest();
    const strictMapper = stubMapper();
    await prepareReviewContext(strict.request, {
      prepareWorkspace: stubWorkspace(strict.worktree),
      createMapper: () => strictMapper,
    });
    expect(strictMapper.calls[0]!.allowDegradedContext).toBeUndefined();
  });

  it("throws in require mode rather than reviewing blind, carrying the real reason", async () => {
    const { worktree, request } = await baseRequest({ mode: "require" });
    const thrown = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: workspace,
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    expect(mapper.calls).toHaveLength(0);
    expect(workspace).not.toHaveBeenCalled();
  });

  it("leaves no staging directory behind on either outcome", async () => {
    const success = await baseRequest();
    await prepareReviewContext(success.request, {
      prepareWorkspace: stubWorkspace(success.worktree),
      createMapper: () => stubMapper(),
    });
    await expect(readdir(path.join(success.request.cacheRoot as string, "staging")))
      .resolves.toEqual([]);

    const failure = await baseRequest();
    await prepareReviewContext(failure.request, {
      prepareWorkspace: stubWorkspace(failure.worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.packs["tgd-review"]!.text.length).toBeLessThanOrEqual(4000);
  });

  it("refuses a cache root owned by another user", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { worktree, request } = await baseRequest();
    const mapper = stubMapper();
    await mkdir(request.cacheRoot as string, { recursive: true });
    // Ownership is what supplies provenance: `lookupContext` checks an entry
    // against its own manifest, and a manifest says nothing about who wrote
    // it, so a root someone else can write is a root that can hand the
    // reviewing model attacker-authored `[TRUSTED_CONTEXT]`.
    await chown(request.cacheRoot as string, 65534, 65534).catch(() => undefined);

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => mapper,
    });

    expect(prepared.status).toBe("unavailable");
    expect(mapper.calls).toHaveLength(0);
  });

  it("makes the cache root private to the current user", async () => {
    if (process.platform === "win32") return;
    const { worktree, request } = await baseRequest();
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
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
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
    });

    expect(prepared.status).toBe("unavailable");
    if (prepared.status !== "unavailable") return;
    expect(prepared.reasons.join(" ")).toContain("owned by another user");
  });

  it("waits for a concurrent publication rather than giving up on one miss", async () => {
    const { worktree, request } = await baseRequest();
    // First run publishes normally, so a real entry exists to be found.
    await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
    });
    const published = await new ContextCache(request.cacheRoot as string)
      .lookupContext(contextCacheKey({ repository, baseSha: BASE_SHA }));
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
    } as unknown as ContextCache;

    const prepared = await prepareReviewContext(request, {
      prepareWorkspace: stubWorkspace(worktree),
      createMapper: () => stubMapper(),
      createCache: () => racing,
    });

    expect(prepared.status).toBe("ready");
  });
});
