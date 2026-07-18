import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryRef } from "../../../src/vcs/adapter.js";
import { prepareWorkspace } from "../../../src/workspace/manager.js";

const repo: RepositoryRef = { host: "github.com", owner: "octo-org", repo: "octo-repo" };
const baseSha = "def4567890def4567890def4567890def4567890";
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-workspace-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prepareWorkspace", () => {
  it("AC-3.1: creates a managed mirror and detached base-SHA worktree on a cold root", async () => {
    const root = await tempRoot();
    const commands: { tool: "gh" | "git"; args: string[] }[] = [];
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      commands.push({ tool, args });
      if (tool === "gh" && args[0] === "repo" && args[1] === "clone") {
        await mkdir(args[3], { recursive: true });
      }
      if (tool === "git" && args.includes("worktree") && args.includes("add")) {
        await mkdir(args.at(-2) as string, { recursive: true });
      }
      return "";
    });

    const result = await prepareWorkspace({ root, repo, baseSha }, { exec });

    expect(result.baseSha).toBe(baseSha);
    expect(result.mirrorPath.startsWith(root + path.sep)).toBe(true);
    expect(result.baseWorktreePath.startsWith(root + path.sep)).toBe(true);
    expect(commands).toContainEqual({
      tool: "gh",
      args: ["repo", "clone", "octo-org/octo-repo", result.mirrorPath, "--", "--mirror"],
    });
    expect(commands).toContainEqual({
      tool: "git",
      args: ["-C", result.mirrorPath, "worktree", "add", "--detach", result.baseWorktreePath, baseSha],
    });
    await expect(readFile(result.ownerMarkerPath, "utf8")).resolves.toContain(baseSha);
  });

  it("AC-3.2: fetches an existing managed mirror and never discovers or mutates an arbitrary checkout", async () => {
    const root = await tempRoot();
    const unrelated = path.join(root, "unrelated-developer-checkout");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "keep.txt"), "unchanged", "utf8");

    const mirrorPath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "repository.git");
    await mkdir(mirrorPath, { recursive: true });
    const commands: { tool: "gh" | "git"; args: string[] }[] = [];
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      commands.push({ tool, args });
      if (args.includes("get-url")) return "https://github.com/octo-org/octo-repo.git\n";
      if (tool === "git" && args.includes("worktree") && args.includes("add")) {
        await mkdir(args.at(-2) as string, { recursive: true });
      }
      return "";
    });

    const result = await prepareWorkspace({ root, repo, baseSha }, { exec });

    expect(commands.some((command) => command.tool === "gh")).toBe(false);
    expect(commands).toContainEqual({
      tool: "git",
      args: ["-C", mirrorPath, "fetch", "--prune", "origin"],
    });
    expect(result.baseWorktreePath).not.toContain(unrelated);
    await expect(readFile(path.join(unrelated, "keep.txt"), "utf8")).resolves.toBe("unchanged");
  });

  it("AC-3.3: rejects unsafe repository components and unmanaged worktree collisions before destructive Git", async () => {
    const root = await tempRoot();
    const exec = vi.fn(async () => "");

    await expect(
      prepareWorkspace(
        { root, repo: { ...repo, owner: "../escape" }, baseSha },
        { exec },
      ),
    ).rejects.toThrow(/owner/i);
    expect(exec).not.toHaveBeenCalled();

    const worktreePath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "worktrees", baseSha);
    const mirrorPath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "repository.git");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(mirrorPath, { recursive: true });
    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/unmanaged/i);
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["remove", "--force"]));
  });

  it("AC-3.3: rejects an orphaned ownership marker before mutating Git state", async () => {
    const root = await tempRoot();
    const markerPath = path.join(
      root,
      "repos",
      "github.com",
      "octo-org",
      "octo-repo",
      "worktrees",
      ".owners",
      `${baseSha}.json`,
    );
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({ version: 1, repository: "github.com/octo-org/octo-repo", baseSha }));
    const exec = vi.fn(async () => "");

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/orphaned/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects a non-object ownership marker as an unmanaged collision", async () => {
    const root = await tempRoot();
    const worktreePath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "worktrees", baseSha);
    const markerPath = path.join(path.dirname(worktreePath), ".owners", `${baseSha}.json`);
    await mkdir(worktreePath, { recursive: true });
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "null\n", "utf8");
    const exec = vi.fn(async () => baseSha);

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(
      `Refusing unmanaged worktree collision at ${worktreePath}`,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("reuses a managed worktree when an abbreviated requested SHA matches HEAD", async () => {
    const root = await tempRoot();
    const abbreviatedSha = baseSha.slice(0, 8);
    const worktreePath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "worktrees", abbreviatedSha);
    const markerPath = path.join(path.dirname(worktreePath), ".owners", `${abbreviatedSha}.json`);
    await mkdir(worktreePath, { recursive: true });
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      repository: "github.com/octo-org/octo-repo",
      baseSha: abbreviatedSha,
    }));
    const exec = vi.fn(async () => `${baseSha}\n`);

    await expect(prepareWorkspace({ root, repo, baseSha: abbreviatedSha }, { exec })).resolves.toMatchObject({
      baseSha: abbreviatedSha,
      baseWorktreePath: worktreePath,
    });
  });

  it.each([
    "https://x-access-token:example-token@github.com/octo-org/octo-repo.git",
    "https://github.com/octo-org/octo-repo.git/",
  ])("accepts an equivalent managed mirror HTTPS origin: %s", async (origin) => {
    const root = await tempRoot();
    const mirrorPath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "repository.git");
    await mkdir(mirrorPath, { recursive: true });
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      if (args.includes("get-url")) return `${origin}\n`;
      if (tool === "git" && args.includes("worktree") && args.includes("add")) {
        await mkdir(args.at(-2) as string, { recursive: true });
      }
      return "";
    });

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).resolves.toMatchObject({ mirrorPath });
  });

  it("rejects an insecure HTTP managed mirror origin", async () => {
    const root = await tempRoot();
    const mirrorPath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "repository.git");
    await mkdir(mirrorPath, { recursive: true });
    const exec = vi.fn(async (_tool: "gh" | "git", args: string[]) => {
      if (args.includes("get-url")) return "http://github.com/octo-org/octo-repo.git\n";
      return "";
    });

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(
      "Managed mirror origin does not match octo-org/octo-repo",
    );
  });
});
