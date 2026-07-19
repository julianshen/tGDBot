import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TgdPiMapper } from "../../../src/context/tgd-mapper.js";
import type { MappingSession } from "../../../src/context/tgd-mapper.js";

const baseSha = "def4567890def4567890def4567890def4567890";
const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
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
      analyzedAt: "2026-07-19T00:00:00.000Z",
      gitCommitHash: baseSha,
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

function domainGraph(): Record<string, unknown> {
  return {
    version: "1.0.0",
    project: {
      name: "octo-repo",
      languages: ["typescript"],
      frameworks: [],
      description: "Business domains",
      analyzedAt: "2026-07-19T00:00:00.000Z",
      gitCommitHash: baseSha,
    },
    nodes: [{
      id: "domain:reviews",
      type: "domain",
      name: "Reviews",
      summary: "Pull request review domain",
      tags: ["core"],
      complexity: "moderate",
    }],
    edges: [],
    layers: [],
    tour: [],
  };
}

async function writeReadyArtifacts(outputRoot: string): Promise<void> {
  const graphRoot = path.join(outputRoot, ".understand-anything");
  await mkdir(graphRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "CONTEXT.md"), "# Trusted base context\n", "utf8");
  await writeFile(path.join(graphRoot, "knowledge-graph.json"), JSON.stringify(knowledgeGraph()), "utf8");
  await writeFile(path.join(graphRoot, "domain-graph.json"), JSON.stringify(domainGraph()), "utf8");
}

async function writeTgdLayoutArtifacts(sourceRoot: string, outputRoot: string): Promise<void> {
  const graphRoot = path.join(outputRoot, ".scans", path.basename(sourceRoot), ".understand-anything");
  await mkdir(graphRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "CONTEXT.md"), "# Trusted base context\n", "utf8");
  await writeFile(path.join(graphRoot, "knowledge-graph.json"), JSON.stringify(knowledgeGraph()), "utf8");
  await writeFile(path.join(graphRoot, "domain-graph.json"), JSON.stringify(domainGraph()), "utf8");
}

function session(onPrompt: (prompt: string) => Promise<void>): MappingSession {
  return {
    prompt: onPrompt,
    getLastAssistantText: () => "untrusted mapper prose",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TgdPiMapper", () => {
  it("AC-6.1: maps only the detached base worktree and validates ready staging artifacts", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const prompts: string[] = [];
    const createSession = vi.fn(async (request: { sourceRoot: string; outputRoot: string }) => {
      expect(request).toEqual({ sourceRoot, outputRoot });
      return session(async (prompt) => {
        prompts.push(prompt);
        await writeReadyArtifacts(outputRoot);
      });
    });

    const result = await new TgdPiMapper({ createSession }).map({ sourceRoot, outputRoot, baseSha });

    expect(prompts).toEqual(["/tgd-map"]);
    expect(result).toMatchObject({
      status: "ready",
      analyzedFiles: 1,
      degradedReasons: [],
      artifactPaths: [
        "CONTEXT.md",
        ".understand-anything/knowledge-graph.json",
        ".understand-anything/domain-graph.json",
        ".understand-anything/mapping-metadata.json",
      ],
    });
    await expect(readFile(result.manifestPath, "utf8")).resolves.toContain(baseSha);
  });

  it("AC-6.2: returns a structured context-map failure when pi rejects", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const createSession = vi.fn(async () => session(async () => {
      throw new Error("provider unavailable");
    }));

    const result = await new TgdPiMapper({ createSession }).map({ sourceRoot, outputRoot, baseSha });

    expect(result).toMatchObject({
      status: "failed",
      artifactPaths: [],
      failure: { stage: "context-map", code: "pi-session-failed", message: "provider unavailable" },
    });
  });

  it("AC-6.2: aborts a timed-out pi session before returning the structured failure", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const abort = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({
      prompt: async () => new Promise<void>(() => undefined),
      getLastAssistantText: () => undefined,
      abort,
    }));

    const result = await new TgdPiMapper({ createSession, timeoutMs: 5 }).map({ sourceRoot, outputRoot, baseSha });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "pi-session-failed", message: expect.stringMatching(/timed out/i) },
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("AC-6.1: normalizes the installed tGD scan layout into cache artifact paths", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const createSession = vi.fn(async () => session(async () => {
      await writeTgdLayoutArtifacts(sourceRoot, outputRoot);
    }));

    const result = await new TgdPiMapper({ createSession }).map({ sourceRoot, outputRoot, baseSha });

    expect(result.status).toBe("ready");
    await expect(readFile(path.join(outputRoot, ".understand-anything/knowledge-graph.json"), "utf8"))
      .resolves.toContain(baseSha);
  });

  it("AC-6.2: rejects graph provenance for a different base SHA and removes completion metadata", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const createSession = vi.fn(async () => session(async () => {
      await writeReadyArtifacts(outputRoot);
    }));

    const result = await new TgdPiMapper({ createSession }).map({
      sourceRoot,
      outputRoot,
      baseSha: "abc4567890abc4567890abc4567890abc4567890",
    });

    expect(result).toMatchObject({ status: "failed", failure: { code: "invalid-artifacts" } });
    await expect(readFile(path.join(outputRoot, ".understand-anything/mapping-metadata.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-6.2: ignores success prose and fails when the knowledge graph is missing", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const createSession = vi.fn(async () => session(async () => {
      await writeFile(path.join(outputRoot, "CONTEXT.md"), "# Partial context\n", "utf8");
    }));

    const result = await new TgdPiMapper({ createSession }).map({ sourceRoot, outputRoot, baseSha });

    expect(result).toMatchObject({
      status: "failed",
      failure: { stage: "context-map", code: "invalid-artifacts" },
    });
    await expect(readFile(path.join(outputRoot, ".understand-anything/mapping-metadata.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-6.3: returns an explicit degraded result only when degraded context is allowed", async () => {
    const sourceRoot = await tempRoot("tgd-mapper-source-");
    const outputRoot = await tempRoot("tgd-mapper-output-");
    const createSession = vi.fn(async () => session(async () => {
      await writeFile(path.join(outputRoot, "CONTEXT.md"), "# Minimum trusted context\n", "utf8");
    }));

    const result = await new TgdPiMapper({ createSession }).map({
      sourceRoot,
      outputRoot,
      baseSha,
      allowDegradedContext: true,
    });

    expect(result).toMatchObject({
      status: "degraded",
      artifactPaths: ["CONTEXT.md", ".understand-anything/mapping-metadata.json"],
      analyzedFiles: 0,
      degradedReasons: ["knowledge-graph-unavailable"],
    });
  });
});
