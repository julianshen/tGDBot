import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withRepositoryLock } from "./lock.js";
import { deriveWorkspacePaths } from "./paths.js";
import type {
  ExecWorkspaceCommand,
  PreparedWorkspace,
  WorkspaceDependencies,
  WorkspaceRequest,
} from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export const realExecWorkspaceCommand: ExecWorkspaceCommand = (tool, args, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(tool, args, {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    }, (error, stdout) => {
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

function execWorkspace(
  dependencies: WorkspaceDependencies,
  tool: "gh" | "git",
  args: string[],
): Promise<string> {
  return dependencies.commandTimeoutMs === undefined
    ? dependencies.exec(tool, args)
    : dependencies.exec(tool, args, dependencies.commandTimeoutMs);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function assertNoSymlinkedAncestors(root: string, candidates: readonly string[]): Promise<void> {
  const resolvedRoot = path.resolve(root);
  for (const candidate of [resolvedRoot, ...candidates]) {
    const relative = path.relative(resolvedRoot, candidate);
    const segments = relative === "" ? [] : relative.split(path.sep);
    let current = resolvedRoot;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) current = path.join(current, segments[index]!);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Managed workspace path contains a symbolic link: ${current}`);
        }
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
  }
}

async function physicalWorkspaceRoot(requestedRoot: string): Promise<string> {
  let existing = path.resolve(requestedRoot);
  try {
    await lstat(existing);
    return existing;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...suffix.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isExpectedOrigin(origin: string, owner: string, repo: string): boolean {
  const slug = `${owner}/${repo}`.toLowerCase();
  const normalized = origin.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.replace(/^\//, "") === slug
    ) {
      return true;
    }
  } catch {
    // SCP-style Git origins are not valid URLs and are checked below.
  }
  return normalized === `https://github.com/${slug}` ||
    normalized === `git@github.com:${slug}` ||
    normalized === `ssh://git@github.com/${slug}`;
}

/**
 * Prepare only tool-owned Git state. Detached worktree behavior follows:
 * https://git-scm.com/docs/git-worktree#Documentation/git-worktree.txt---detach
 */
async function prepareWorkspaceUnlocked(
  request: WorkspaceRequest,
  dependencies: WorkspaceDependencies,
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
      const parsed: unknown = JSON.parse(await readFile(paths.ownerMarkerPath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid ownership marker");
      }
      marker = parsed as typeof expectedMarker;
    } catch {
      throw new Error(`Refusing unmanaged worktree collision at ${paths.baseWorktreePath}`);
    }
    if (
      marker.version !== expectedMarker.version ||
      marker.repository !== expectedMarker.repository ||
      marker.baseSha !== expectedMarker.baseSha
    ) {
      throw new Error(`Refusing unmanaged worktree ownership mismatch at ${paths.baseWorktreePath}`);
    }
    const actualHead = (await execWorkspace(dependencies, "git", ["-C", paths.baseWorktreePath, "rev-parse", "HEAD"])).trim();
    if (!actualHead.toLowerCase().startsWith(expectedMarker.baseSha)) {
      throw new Error(`Managed worktree HEAD does not match requested base SHA at ${paths.baseWorktreePath}`);
    }
    await execWorkspace(dependencies, "git", ["-C", paths.baseWorktreePath, "reset", "--hard", "HEAD"]);
    await execWorkspace(dependencies, "git", ["-C", paths.baseWorktreePath, "clean", "-ffdx"]);
    return { ...paths, baseSha: expectedMarker.baseSha };
  }

  if (await exists(paths.ownerMarkerPath)) {
    throw new Error(`Refusing orphaned worktree ownership marker at ${paths.ownerMarkerPath}`);
  }

  await mkdir(paths.worktreesRoot, { recursive: true });
  await mkdir(path.dirname(paths.ownerMarkerPath), { recursive: true });

  if (!(await exists(paths.mirrorPath))) {
    await execWorkspace(dependencies, "gh", [
      "repo",
      "clone",
      `https://${request.repo.host}/${request.repo.owner}/${request.repo.repo}`,
      paths.mirrorPath,
      "--",
      "--mirror",
    ]);
  } else {
    const origin = await execWorkspace(dependencies, "git", ["-C", paths.mirrorPath, "remote", "get-url", "origin"]);
    if (!isExpectedOrigin(origin, request.repo.owner, request.repo.repo)) {
      throw new Error(`Managed mirror origin does not match ${request.repo.owner}/${request.repo.repo}`);
    }
    await execWorkspace(dependencies, "git", ["-C", paths.mirrorPath, "fetch", "--prune", "origin"]);
  }

  await execWorkspace(dependencies, "git", ["-C", paths.mirrorPath, "cat-file", "-e", `${request.baseSha}^{commit}`]);
  await execWorkspace(dependencies, "git", [
    "-C",
    paths.mirrorPath,
    "worktree",
    "add",
    "--detach",
    paths.baseWorktreePath,
    request.baseSha,
  ]);
  try {
    await writeFile(paths.ownerMarkerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    try {
      await execWorkspace(dependencies, "git", [
        "-C", paths.mirrorPath, "worktree", "remove", "--force", paths.baseWorktreePath,
      ]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to create ownership marker and clean up worktree`);
    }
    throw error;
  }

  return { ...paths, baseSha: expectedMarker.baseSha };
}

export async function prepareWorkspace(
  request: WorkspaceRequest,
  dependencies: WorkspaceDependencies = { exec: realExecWorkspaceCommand },
): Promise<PreparedWorkspace> {
  const paths = deriveWorkspacePaths({ ...request, root: await physicalWorkspaceRoot(request.root) });
  await mkdir(paths.root, { recursive: true });
  const lockPath = path.join(
    paths.root,
    ".locks",
    `${request.repo.host}-${request.repo.owner}-${request.repo.repo}.lock`,
  );
  await assertNoSymlinkedAncestors(
    paths.root,
    [lockPath, paths.repositoryRoot, paths.mirrorPath, paths.baseWorktreePath, paths.ownerMarkerPath],
  );
  return withRepositoryLock({
    lockPath,
    timeoutMs: dependencies.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    owner: { runId: randomUUID() },
  }, async () => {
    await assertNoSymlinkedAncestors(
      paths.root,
      [paths.repositoryRoot, paths.mirrorPath, paths.baseWorktreePath, paths.ownerMarkerPath],
    );
    return prepareWorkspaceUnlocked(request, dependencies);
  });
}
