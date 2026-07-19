import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryRef } from "../../../src/vcs/adapter.js";
import { prepareWorkspace, realExecWorkspaceCommand } from "../../../src/workspace/manager.js";
import { deriveWorkspacePaths } from "../../../src/workspace/paths.js";

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
  it.skipIf(process.platform === "win32")("runs real workspace commands non-interactively", async () => {
    const root = await tempRoot();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const fakeGit = path.join(bin, "git");
    await writeFile(fakeGit, "#!/bin/sh\nprintf '%s' \"$GIT_TERMINAL_PROMPT:$GH_PROMPT_DISABLED\"\n", "utf8");
    await chmod(fakeGit, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    try {
      await expect(realExecWorkspaceCommand("git", [])).resolves.toBe("0:1");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it.skipIf(process.platform === "win32")("removes Git repository-location overrides from command environments", async () => {
    const root = await tempRoot();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const fakeGit = path.join(bin, "git");
    await writeFile(
      fakeGit,
      "#!/bin/sh\nprintf '%s' \"${GIT_DIR-unset}:${GIT_WORK_TREE-unset}:${GIT_COMMON_DIR-unset}:${GIT_OBJECT_DIRECTORY-unset}:${GIT_INDEX_FILE-unset}\"\n",
      "utf8",
    );
    await chmod(fakeGit, 0o700);
    const previous = { ...process.env };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.GIT_DIR = "/tmp/attacker.git";
    process.env.GIT_WORK_TREE = "/tmp/attacker-tree";
    process.env.GIT_COMMON_DIR = "/tmp/attacker-common";
    process.env.GIT_OBJECT_DIRECTORY = "/tmp/attacker-objects";
    process.env.GIT_INDEX_FILE = "/tmp/attacker-index";
    try {
      await expect(realExecWorkspaceCommand("git", [])).resolves.toBe("unset:unset:unset:unset:unset");
    } finally {
      process.env = previous;
    }
  });

  it.skipIf(process.platform === "win32")("terminates a workspace command after its configured timeout", async () => {
    const root = await tempRoot();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const fakeGit = path.join(bin, "git");
    await writeFile(fakeGit, "#!/bin/sh\nsleep 1\n", "utf8");
    await chmod(fakeGit, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    try {
      await expect(realExecWorkspaceCommand("git", [], 10)).rejects.toMatchObject({ killed: true });
    } finally {
      process.env.PATH = originalPath;
    }
  });

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
      args: [
        "repo",
        "clone",
        "https://github.com/octo-org/octo-repo",
        result.mirrorPath,
        "--",
        "--mirror",
      ],
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
    const mirrorPath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "repository.git");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(mirrorPath, { recursive: true });
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      repository: "github.com/octo-org/octo-repo",
      baseSha: abbreviatedSha,
    }));
    const exec = vi.fn(async (_tool: "gh" | "git", args: string[]) =>
      args.includes("--git-common-dir") ? `${mirrorPath}\n` : `${baseSha}\n`);

    await expect(prepareWorkspace({ root, repo, baseSha: abbreviatedSha }, { exec })).resolves.toMatchObject({
      baseSha: abbreviatedSha,
      baseWorktreePath: worktreePath,
    });
    expect(exec).toHaveBeenCalledWith("git", ["-C", worktreePath, "reset", "--hard", "HEAD"]);
    expect(exec).toHaveBeenCalledWith("git", ["-C", worktreePath, "clean", "-ffdx"]);
  });

  it("rejects a forged marker for a checkout not registered to the managed mirror", async () => {
    const root = await tempRoot();
    const paths = deriveWorkspacePaths({ root, repo, baseSha });
    const foreignCommonDir = path.join(root, "foreign.git");
    await mkdir(paths.baseWorktreePath, { recursive: true });
    await mkdir(paths.mirrorPath, { recursive: true });
    await mkdir(foreignCommonDir);
    await mkdir(path.dirname(paths.ownerMarkerPath), { recursive: true });
    await writeFile(paths.ownerMarkerPath, JSON.stringify({
      version: 1,
      repository: "github.com/octo-org/octo-repo",
      baseSha,
    }));
    const exec = vi.fn(async (_tool: "gh" | "git", args: string[]) =>
      args.includes("--git-common-dir") ? `${foreignCommonDir}\n` : `${baseSha}\n`);

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/managed mirror/i);
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["reset"]));
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["clean"]));
  });

  it("rejects a worktree replaced by a symlink between managed Git command boundaries", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const paths = deriveWorkspacePaths({ root, repo, baseSha });
    const parkedWorktree = `${paths.baseWorktreePath}.parked`;
    await mkdir(paths.baseWorktreePath, { recursive: true });
    await mkdir(paths.mirrorPath, { recursive: true });
    await mkdir(path.dirname(paths.ownerMarkerPath), { recursive: true });
    await writeFile(paths.ownerMarkerPath, JSON.stringify({
      version: 1,
      repository: "github.com/octo-org/octo-repo",
      baseSha,
    }));
    const exec = vi.fn(async (_tool: "gh" | "git", args: string[]) => {
      if (args.includes("--git-common-dir")) {
        await rename(paths.baseWorktreePath, parkedWorktree);
        await symlink(outside, paths.baseWorktreePath);
        return `${paths.mirrorPath}\n`;
      }
      return `${baseSha}\n`;
    });

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/symbolic link/i);
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["reset"]));
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["clean"]));
  });

  it("rejects an unsupported managed-worktree marker version", async () => {
    const root = await tempRoot();
    const worktreePath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "worktrees", baseSha);
    const markerPath = path.join(path.dirname(worktreePath), ".owners", `${baseSha}.json`);
    await mkdir(worktreePath, { recursive: true });
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      version: 2,
      repository: "github.com/octo-org/octo-repo",
      baseSha,
    }));
    const exec = vi.fn(async () => `${baseSha}\n`);

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/ownership mismatch/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("serializes concurrent preparation of the same repository and base SHA", async () => {
    const root = await tempRoot();
    const paths = deriveWorkspacePaths({ root, repo, baseSha });
    let releaseClone!: () => void;
    const cloneBlocked = new Promise<void>((resolve) => { releaseClone = resolve; });
    let cloneStarted!: () => void;
    const cloneEntered = new Promise<void>((resolve) => { cloneStarted = resolve; });
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      if (tool === "gh") {
        cloneStarted();
        await cloneBlocked;
        await mkdir(args[3]!, { recursive: true });
      }
      if (tool === "git" && args.includes("worktree") && args.includes("add")) {
        await mkdir(args.at(-2)!, { recursive: true });
      }
      if (args.includes("--git-common-dir")) return `${paths.mirrorPath}\n`;
      if (args.includes("rev-parse")) return `${baseSha}\n`;
      return "";
    });

    const first = prepareWorkspace({ root, repo, baseSha }, { exec });
    await cloneEntered;
    const second = prepareWorkspace({ root, repo, baseSha }, { exec });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exec.mock.calls.filter(([tool]) => tool === "gh")).toHaveLength(1);
    releaseClone();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(exec.mock.calls.filter(([tool]) => tool === "gh")).toHaveLength(1);
  });

  it("does not serialize distinct repositories whose hyphenated components flatten identically", async () => {
    const root = await tempRoot();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    let secondEntered!: () => void;
    const secondStarted = new Promise<void>((resolve) => { secondEntered = resolve; });
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      if (tool === "gh") {
        const target = args[3]!;
        await mkdir(target, { recursive: true });
        if (args[2]?.includes("/a-b/c")) {
          firstEntered();
          await firstBlocked;
        } else {
          secondEntered();
        }
      }
      if (tool === "git" && args.includes("add")) await mkdir(args.at(-2)!, { recursive: true });
      return "";
    });

    const first = prepareWorkspace({ root, repo: { ...repo, owner: "a-b", repo: "c" }, baseSha }, { exec });
    await firstStarted;
    const second = prepareWorkspace({ root, repo: { ...repo, owner: "a", repo: "b-c" }, baseSha }, { exec });
    const overlapped = await Promise.race([
      secondStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(overlapped).toBe(true);
  });

  it("rejects a symlinked managed-path ancestor before filesystem or Git mutation", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, path.join(root, "repos"));
    const exec = vi.fn(async () => "");

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/symbolic link/i);
    expect(exec).not.toHaveBeenCalled();
    await expect(readFile(path.join(outside, "github.com", "octo-org", "octo-repo", "repository.git")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("canonicalizes a symlinked ancestor above the configured workspace root", async () => {
    const parent = await tempRoot();
    const outside = await tempRoot();
    const linkedParent = path.join(parent, "linked");
    await symlink(outside, linkedParent);
    const root = path.join(linkedParent, "workspace");
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      if (tool === "gh") await mkdir(args[3]!, { recursive: true });
      if (args.includes("add")) await mkdir(args.at(-2)!, { recursive: true });
      return "";
    });

    const result = await prepareWorkspace({ root, repo, baseSha }, { exec });
    expect(await realpath(result.root)).toBe(await realpath(path.join(outside, "workspace")));
    expect(result.repositoryRoot.startsWith(`${result.root}${path.sep}`)).toBe(true);
  });

  it("removes a newly-created worktree when ownership-marker creation fails", async () => {
    const root = await tempRoot();
    const paths = deriveWorkspacePaths({ root, repo, baseSha });
    const exec = vi.fn(async (tool: "gh" | "git", args: string[]) => {
      if (tool === "gh") await mkdir(paths.mirrorPath, { recursive: true });
      if (args.includes("add")) {
        await mkdir(paths.baseWorktreePath, { recursive: true });
        await mkdir(paths.ownerMarkerPath);
      }
      if (args.includes("remove")) await rm(paths.baseWorktreePath, { recursive: true, force: true });
      return "";
    });

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow();
    expect(exec).toHaveBeenCalledWith("git", [
      "-C", paths.mirrorPath, "worktree", "remove", "--force", paths.baseWorktreePath,
    ]);
    await expect(lstat(paths.baseWorktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["mirrorPath", "ownerMarkerPath"] as const)(
    "rejects a symlink at the managed %s before filesystem or Git mutation",
    async (candidateName) => {
      const root = await tempRoot();
      const outside = await tempRoot();
      const paths = deriveWorkspacePaths({ root, repo, baseSha });
      await mkdir(path.dirname(paths[candidateName]), { recursive: true });
      await symlink(outside, paths[candidateName]);
      const exec = vi.fn(async () => "");

      await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(/symbolic link/i);
      expect(exec).not.toHaveBeenCalled();
    },
  );

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

  it("rejects a GitHub HTTPS mirror origin with a custom port", async () => {
    const root = await tempRoot();
    const mirrorPath = path.join(root, "repos", "github.com", "octo-org", "octo-repo", "repository.git");
    await mkdir(mirrorPath, { recursive: true });
    const exec = vi.fn(async (_tool: "gh" | "git", args: string[]) => {
      if (args.includes("get-url")) return "https://github.com:444/octo-org/octo-repo.git\n";
      return "";
    });

    await expect(prepareWorkspace({ root, repo, baseSha }, { exec })).rejects.toThrow(
      "Managed mirror origin does not match octo-org/octo-repo",
    );
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["fetch"]));
  });
});
