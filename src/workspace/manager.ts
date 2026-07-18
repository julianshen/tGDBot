import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveWorkspacePaths } from "./paths.js";
import type {
  ExecWorkspaceCommand,
  PreparedWorkspace,
  WorkspaceDependencies,
  WorkspaceRequest,
} from "./types.js";

export const realExecWorkspaceCommand: ExecWorkspaceCommand = (tool, args) =>
  new Promise((resolve, reject) => {
    execFile(tool, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isExpectedOrigin(origin: string, owner: string, repo: string): boolean {
  const normalized = origin.trim().replace(/\.git$/i, "").toLowerCase();
  const slug = `${owner}/${repo}`.toLowerCase();
  return normalized === `https://github.com/${slug}` ||
    normalized === `git@github.com:${slug}` ||
    normalized === `ssh://git@github.com/${slug}`;
}

/**
 * Prepare only tool-owned Git state. Detached worktree behavior follows:
 * https://git-scm.com/docs/git-worktree#Documentation/git-worktree.txt---detach
 */
export async function prepareWorkspace(
  request: WorkspaceRequest,
  dependencies: WorkspaceDependencies = { exec: realExecWorkspaceCommand },
): Promise<PreparedWorkspace> {
  const paths = deriveWorkspacePaths(request);
  const expectedMarker = {
    version: 1,
    repository: `${request.repo.host}/${request.repo.owner}/${request.repo.repo}`,
    baseSha: request.baseSha.toLowerCase(),
  };

  if (await exists(paths.baseWorktreePath)) {
    let marker: typeof expectedMarker;
    try {
      marker = JSON.parse(await readFile(paths.ownerMarkerPath, "utf8")) as typeof expectedMarker;
    } catch {
      throw new Error(`Refusing unmanaged worktree collision at ${paths.baseWorktreePath}`);
    }
    if (marker.repository !== expectedMarker.repository || marker.baseSha !== expectedMarker.baseSha) {
      throw new Error(`Refusing unmanaged worktree ownership mismatch at ${paths.baseWorktreePath}`);
    }
    const actualHead = (await dependencies.exec("git", ["-C", paths.baseWorktreePath, "rev-parse", "HEAD"])).trim();
    if (actualHead.toLowerCase() !== expectedMarker.baseSha) {
      throw new Error(`Managed worktree HEAD does not match requested base SHA at ${paths.baseWorktreePath}`);
    }
    return { ...paths, baseSha: expectedMarker.baseSha };
  }

  if (await exists(paths.ownerMarkerPath)) {
    throw new Error(`Refusing orphaned worktree ownership marker at ${paths.ownerMarkerPath}`);
  }

  await mkdir(paths.worktreesRoot, { recursive: true });
  await mkdir(path.dirname(paths.ownerMarkerPath), { recursive: true });

  if (!(await exists(paths.mirrorPath))) {
    await dependencies.exec("gh", [
      "repo",
      "clone",
      `${request.repo.owner}/${request.repo.repo}`,
      paths.mirrorPath,
      "--",
      "--mirror",
    ]);
  } else {
    const origin = await dependencies.exec("git", ["-C", paths.mirrorPath, "remote", "get-url", "origin"]);
    if (!isExpectedOrigin(origin, request.repo.owner, request.repo.repo)) {
      throw new Error(`Managed mirror origin does not match ${request.repo.owner}/${request.repo.repo}`);
    }
    await dependencies.exec("git", ["-C", paths.mirrorPath, "fetch", "--prune", "origin"]);
  }

  await dependencies.exec("git", ["-C", paths.mirrorPath, "cat-file", "-e", `${request.baseSha}^{commit}`]);
  await dependencies.exec("git", [
    "-C",
    paths.mirrorPath,
    "worktree",
    "add",
    "--detach",
    paths.baseWorktreePath,
    request.baseSha,
  ]);
  await writeFile(paths.ownerMarkerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return { ...paths, baseSha: expectedMarker.baseSha };
}
