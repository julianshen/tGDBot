import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withRepositoryLock } from "./lock.js";
import { assertNoSymlinkedAncestors, protectManagedRoot } from "./protect.js";
import {
  deriveWorkspacePaths,
  encodeWorkspaceAuthority,
  encodeWorkspaceComponent,
} from "./paths.js";
import type {
  ExecWorkspaceCommand,
  PreparedWorkspace,
  WorkspaceDependencies,
  WorkspaceRequest,
  WorkspaceTool,
} from "./types.js";
import type { RepositoryRef } from "../target/types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const GIT_PATH_OVERRIDE_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_QUARANTINE_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
] as const;

function workspaceCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_PATH_OVERRIDE_VARIABLES) delete env[name];
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete env[name];
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export const realExecWorkspaceCommand: ExecWorkspaceCommand = (tool, args, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(tool, args, {
      env: workspaceCommandEnvironment(),
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
  tool: WorkspaceTool,
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

// Resolves to a path with NO symlink component, so that everything downstream —
// the ancestor walk, the lock, the mirror, the worktree — operates on the same
// physical directory it inspected. A root that already exists must be resolved
// too: `lstat` succeeding proves only that something is there, not that the
// path reaching it is stable. Returning the logical path in that case left a
// mutable ancestor link (say under /tmp) in place, and the ancestor checks then
// FOLLOW it — so it can be retargeted after the checks pass, at a prebuilt
// mirror whose `hooks/post-checkout` runs on the next `git worktree add`.
// `realpath` removes that by construction; a link swapped afterwards no longer
// names the directory this function returned.
async function physicalWorkspaceRoot(requestedRoot: string): Promise<string> {
  let existing = path.resolve(requestedRoot);
  try {
    await lstat(existing);
    return await realpath(existing);
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

function repositoryPath(repo: RepositoryRef): string {
  return repo.provider === "github"
    ? `${repo.owner}/${repo.repo}`
    : [...repo.namespace, repo.repo].join("/");
}

function repositoryIdentity(repo: RepositoryRef): string {
  return repo.canonicalUrl;
}

function normalizedOriginPath(pathname: string): string | undefined {
  const trimmed = pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "");
  if (trimmed === "" || trimmed.includes("//")) return undefined;
  try {
    const segments = trimmed.split("/").map(decodeURIComponent);
    if (
      segments.some((segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        /[\u0000-\u001f\u007f]/u.test(segment))
    ) return undefined;
    return segments.join("/");
  } catch {
    return undefined;
  }
}

function explicitOriginPort(origin: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/u.exec(origin)?.[1];
  if (authority === undefined) return "";
  const withoutCredentials = authority.slice(authority.lastIndexOf("@") + 1);
  return /:(\d+)$/u.exec(withoutCredentials)?.[1] ?? "";
}

function isExpectedOrigin(origin: string, repo: RepositoryRef): boolean {
  const slug = repositoryPath(repo).toLowerCase();
  const normalized = origin.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  if (repo.provider === "github") {
    try {
      const parsed = new URL(normalized);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "github.com" &&
        parsed.port === "" &&
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
  const expectedHost = repo.host.toLowerCase();
  const expectedHttpsPort = repo.port === undefined ? "" : String(repo.port);
  const gitLabOrigin = origin.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(gitLabOrigin);
    if (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.toLowerCase() === expectedHost &&
      explicitOriginPort(gitLabOrigin) === expectedHttpsPort &&
      parsed.search === "" &&
      parsed.hash === "" &&
      normalizedOriginPath(parsed.pathname) === repositoryPath(repo)
    ) {
      return true;
    }
    if (
      parsed.protocol === "ssh:" &&
      parsed.username === "git" &&
      parsed.password === "" &&
      parsed.hostname.toLowerCase() === expectedHost &&
      parsed.search === "" &&
      parsed.hash === "" &&
      normalizedOriginPath(parsed.pathname) === repositoryPath(repo)
    ) {
      return true;
    }
  } catch {
    // SCP-style Git origins are not valid URLs and are checked below.
  }
  const scp = /^git@([^:/]+):(.+)$/u.exec(gitLabOrigin);
  return scp !== null &&
    scp[1]!.toLowerCase() === expectedHost &&
    normalizedOriginPath(scp[2]!) === repositoryPath(repo);
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
  const execManaged = async (tool: WorkspaceTool, args: string[]): Promise<string> => {
    await assertNoSymlinkedAncestors(
      paths.root,
      [paths.repositoryRoot, paths.mirrorPath, paths.baseWorktreePath, paths.ownerMarkerPath],
    );
    return execWorkspace(dependencies, tool, args);
  };
  const expectedMarker = {
    version: 1,
    provider: request.repo.provider,
    repository: repositoryIdentity(request.repo),
    baseSha: request.baseSha.toLowerCase(),
  };
  const legacyGitHubRepository = request.repo.provider === "github"
    ? `${request.repo.host}/${request.repo.owner}/${request.repo.repo}`
    : undefined;

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
    const currentMarkerMismatch =
      marker.version !== expectedMarker.version ||
      marker.provider !== expectedMarker.provider ||
      marker.repository !== expectedMarker.repository ||
      marker.baseSha !== expectedMarker.baseSha;
    const isLegacyGitHubMarker =
      legacyGitHubRepository !== undefined &&
      Object.keys(marker).sort().join(",") === "baseSha,repository,version" &&
      marker.version === expectedMarker.version &&
      marker.repository === legacyGitHubRepository &&
      marker.baseSha === expectedMarker.baseSha;
    if (currentMarkerMismatch && !isLegacyGitHubMarker) {
      throw new Error(`Refusing unmanaged worktree ownership mismatch at ${paths.baseWorktreePath}`);
    }
    const commonDir = (await execManaged("git", [
      "-C",
      paths.baseWorktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    const [actualCommonDir, expectedCommonDir] = await Promise.all([
      realpath(commonDir),
      realpath(paths.mirrorPath),
    ]);
    if (actualCommonDir !== expectedCommonDir) {
      throw new Error(`Managed worktree is not registered to the expected managed mirror at ${paths.mirrorPath}`);
    }
    const actualHead = (await execManaged("git", ["-C", paths.baseWorktreePath, "rev-parse", "HEAD"])).trim();
    if (!actualHead.toLowerCase().startsWith(expectedMarker.baseSha)) {
      throw new Error(`Managed worktree HEAD does not match requested base SHA at ${paths.baseWorktreePath}`);
    }
    await execManaged("git", ["-C", paths.baseWorktreePath, "reset", "--hard", "HEAD"]);
    await execManaged("git", ["-C", paths.baseWorktreePath, "clean", "-ffdx"]);
    return { ...paths, baseSha: expectedMarker.baseSha };
  }

  if (await exists(paths.ownerMarkerPath)) {
    throw new Error(`Refusing orphaned worktree ownership marker at ${paths.ownerMarkerPath}`);
  }

  await mkdir(paths.worktreesRoot, { recursive: true });
  await mkdir(path.dirname(paths.ownerMarkerPath), { recursive: true });

  if (!(await exists(paths.mirrorPath))) {
    if (request.repo.provider === "github") {
      await execManaged("gh", [
        "repo",
        "clone",
        `https://${request.repo.host}/${request.repo.owner}/${request.repo.repo}`,
        paths.mirrorPath,
        "--",
        "--mirror",
      ]);
    } else {
      await execManaged("glab", [
        "repo",
        "clone",
        request.repo.canonicalUrl,
        paths.mirrorPath,
        "--",
        "--mirror",
      ]);
    }
  } else {
    const origin = await execManaged("git", ["-C", paths.mirrorPath, "remote", "get-url", "origin"]);
    if (!isExpectedOrigin(origin, request.repo)) {
      throw new Error(`Managed mirror origin does not match ${repositoryPath(request.repo)}`);
    }
    await execManaged("git", ["-C", paths.mirrorPath, "fetch", "--prune", "origin"]);
  }

  await execManaged("git", ["-C", paths.mirrorPath, "cat-file", "-e", `${request.baseSha}^{commit}`]);
  await execManaged("git", [
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
      await execManaged("git", [
        "-C", paths.mirrorPath, "worktree", "remove", "--force", paths.baseWorktreePath,
      ]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to create ownership marker and clean up worktree`);
    }
    throw error;
  }

  return { ...paths, baseSha: expectedMarker.baseSha };
}

/**
 * Prepares the workspace and holds the repository lock for `use`.
 *
 * `prepareWorkspace` releases the lock before it returns, so every caller read
 * the shared worktree unlocked: the `reset --hard` and `clean -ffdx` that run
 * inside the lock cannot protect a later reader, and two jobs on the same
 * repository and base could have one rewriting the tree while the other read
 * it (#78). That was tolerable while the readers produced CONTEXT, which is
 * framed as untrusted and which a reader weighs. A structural check derives a
 * host-authored fact — the one line a reader is invited to trust without
 * re-deriving — so the same race can now publish "the name occurs at
 * src/x.ts:88" for a line that only ever existed in another job's scratch edit.
 *
 * The cost is real and deliberate: a long consumer now serialises other jobs
 * against the same repository and base. That is what the lock was always for.
 */
export async function withPreparedWorkspace<T>(
  request: WorkspaceRequest,
  use: (prepared: PreparedWorkspace) => Promise<T>,
  dependencies: WorkspaceDependencies = { exec: realExecWorkspaceCommand },
): Promise<T> {
  return prepareWorkspaceLocked(request, dependencies, use);
}

export async function prepareWorkspace(
  request: WorkspaceRequest,
  dependencies: WorkspaceDependencies = { exec: realExecWorkspaceCommand },
): Promise<PreparedWorkspace> {
  return prepareWorkspaceLocked(request, dependencies, async (prepared) => prepared);
}

async function prepareWorkspaceLocked<T>(
  request: WorkspaceRequest,
  dependencies: WorkspaceDependencies,
  use: (prepared: PreparedWorkspace) => Promise<T>,
): Promise<T> {
  const paths = deriveWorkspacePaths({ ...request, root: await physicalWorkspaceRoot(request.root) });
  const normalizedRequest = { ...request, root: paths.root };
  await mkdir(paths.root, { recursive: true });
  await protectManagedRoot(paths.root, "Managed workspace", {
    ...(request.rejectPreviouslySharedRoot === true ? { rejectPreviouslyShared: true } : {}),
  });
  const lockPath = request.repo.provider === "github"
    ? path.join(paths.root, ".locks", request.repo.host, request.repo.owner, `${request.repo.repo}.lock`)
    : path.join(
      paths.root,
      ".locks",
      encodeWorkspaceAuthority(request.repo.host, request.repo.port),
      ...request.repo.namespace.map(encodeWorkspaceComponent),
      `${encodeWorkspaceComponent(request.repo.repo)}.lock`,
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
    // The consumer runs INSIDE the lock, so what it reads is what preparation
    // just guaranteed.
    return use(await prepareWorkspaceUnlocked(normalizedRequest, dependencies));
  });
}
