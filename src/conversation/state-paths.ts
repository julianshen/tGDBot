import type { Stats } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseRepositoryRef } from "../target/review-target.js";
import type { RepositoryRef } from "../target/types.js";
import { encodeWorkspaceAuthority, encodeWorkspaceComponent } from "../workspace/paths.js";

const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export interface StateRootSelection {
  readonly explicitStateDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface ConversationStatePaths {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly cursorPath: string;
  readonly eventsPath: string;
  readonly memoriesPath: string;
  readonly findingsPath: string;
  readonly pendingPath: string;
  readonly lockPath: string;
  readonly transactionIntentPath: string;
  readonly transactionRetiredPath: string;
  readonly journalHeadPath: string;
}

export interface ConversationPathFileSystem {
  lstat(candidate: string): Promise<Stats>;
  mkdir(candidate: string, options: { mode: number }): Promise<string | undefined>;
  chmod(candidate: string, mode: number): Promise<void>;
}

export interface ConversationPathDependencies {
  readonly fileSystem?: Partial<ConversationPathFileSystem>;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
}

export interface PreparedConversationStatePaths {
  readonly repositoryDirectoryIdentity: { readonly dev: number; readonly ino: number };
}

const realPathFileSystem: ConversationPathFileSystem = { lstat, mkdir, chmod };

function validateAbsoluteRoot(value: string, platform: NodeJS.Platform, source: string): string {
  if (value.length === 0 || value.trim() !== value || CONTROL_RE.test(value)) {
    throw new Error(`${source} must be a non-empty absolute path without control characters`);
  }
  const implementation = platform === "win32" ? path.win32 : path.posix;
  if (!implementation.isAbsolute(value)) throw new Error(`${source} must be an absolute path`);
  const resolved = implementation.resolve(value);
  if (resolved === implementation.parse(resolved).root) throw new Error(`${source} cannot be the filesystem root`);
  return resolved;
}

export function selectConversationStateRoot(options: StateRootSelection = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (options.explicitStateDir !== undefined) {
    return validateAbsoluteRoot(options.explicitStateDir, platform, "Explicit state directory");
  }
  if (env.TGD_REVIEW_STATE_DIR !== undefined) {
    return validateAbsoluteRoot(env.TGD_REVIEW_STATE_DIR, platform, "TGD_REVIEW_STATE_DIR");
  }
  if (platform === "win32") {
    if (env.LOCALAPPDATA === undefined) throw new Error("LOCALAPPDATA is required to select the state directory");
    const base = validateAbsoluteRoot(env.LOCALAPPDATA, platform, "LOCALAPPDATA");
    return path.win32.join(base, "tgd-review-agent", "state");
  }
  if (env.XDG_STATE_HOME !== undefined) {
    const base = validateAbsoluteRoot(env.XDG_STATE_HOME, platform, "XDG_STATE_HOME");
    return path.posix.join(base, "tgd-review-agent");
  }
  if (env.HOME === undefined) throw new Error("HOME is required to select the state directory");
  const home = validateAbsoluteRoot(env.HOME, platform, "HOME");
  return path.posix.join(home, ".local", "state", "tgd-review-agent");
}

function validateRepository(repo: RepositoryRef): void {
  if (repo.provider === "github") {
    if (repo.host !== "github.com" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(repo.owner) ||
      !/^[A-Za-z0-9._-]+$/u.test(repo.repo) || repo.repo === "." || repo.repo === ".." ||
      repo.canonicalUrl !== `https://github.com/${repo.owner}/${repo.repo}`) {
      throw new Error("Conversation state canonical repository identity is invalid");
    }
    const canonical = parseRepositoryRef(repo.canonicalUrl, "github");
    if (canonical.owner !== repo.owner || canonical.repo !== repo.repo || canonical.host !== repo.host) {
      throw new Error("Conversation state canonical repository identity is invalid");
    }
    return;
  }
  const validSegment = (value: string): boolean =>
    value.length > 0 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value);
  if (!validSegment(repo.host) || repo.namespace.length === 0 || !repo.namespace.every(validSegment) ||
    !validSegment(repo.repo) || (repo.port !== undefined &&
      (!Number.isSafeInteger(repo.port) || repo.port < 1 || repo.port > 65_535))) {
    throw new Error("Conversation state canonical repository identity is invalid");
  }
  const authority = repo.port === undefined ? repo.host : `${repo.host}:${repo.port}`;
  const canonicalPath = [...repo.namespace, repo.repo].map(encodeURIComponent).join("/");
  if (repo.canonicalUrl !== `https://${authority}/${canonicalPath}`) {
    throw new Error("Conversation state canonical repository identity is invalid");
  }
  const canonical = parseRepositoryRef(repo.canonicalUrl, "gitlab");
  if (canonical.host !== repo.host || canonical.port !== repo.port || canonical.repo !== repo.repo ||
    canonical.namespace.length !== repo.namespace.length ||
    canonical.namespace.some((segment, index) => segment !== repo.namespace[index])) {
    throw new Error("Conversation state canonical repository identity is invalid");
  }
}

/**
 * Canonical identity used only for local state isolation. GitHub repository
 * names are case-insensitive, so owner/repository are lowercased together
 * with their canonical URL. GitLab path case is retained. Without an
 * immutable provider repository ID, a repository rename intentionally forms
 * a new v1 local state domain; v1 performs no implicit rename migration.
 */
export function canonicalStateRepositoryIdentity(repo: RepositoryRef): RepositoryRef {
  validateRepository(repo);
  if (repo.provider === "gitlab") {
    return { ...repo, namespace: [...repo.namespace] };
  }
  const owner = repo.owner.toLowerCase();
  const repository = repo.repo.toLowerCase();
  return { provider: "github", host: "github.com", owner, repo: repository,
    canonicalUrl: `https://github.com/${owner}/${repository}` };
}

function assertInside(root: string, candidate: string, implementation: path.PlatformPath): void {
  const relative = implementation.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${implementation.sep}`) ||
    implementation.isAbsolute(relative)) {
    throw new Error(`Conversation state path escapes its repository root: ${candidate}`);
  }
}

export function deriveConversationStatePaths(
  root: string,
  repo: RepositoryRef,
  platform: NodeJS.Platform = process.platform,
): ConversationStatePaths {
  const resolvedRoot = validateAbsoluteRoot(root, platform, "Conversation state root");
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const canonicalRepository = canonicalStateRepositoryIdentity(repo);
  const repositorySegments = canonicalRepository.provider === "github"
    ? [encodeWorkspaceAuthority(canonicalRepository.host), encodeWorkspaceComponent(canonicalRepository.owner),
      encodeWorkspaceComponent(canonicalRepository.repo)]
    : [encodeWorkspaceAuthority(canonicalRepository.host, canonicalRepository.port),
      ...canonicalRepository.namespace.map(encodeWorkspaceComponent), encodeWorkspaceComponent(canonicalRepository.repo)];
  const repositoryRoot = implementation.join(
    resolvedRoot, "repositories", canonicalRepository.provider, ...repositorySegments,
  );
  const result: ConversationStatePaths = {
    root: resolvedRoot,
    repositoryRoot,
    cursorPath: implementation.join(repositoryRoot, "cursor.json"),
    eventsPath: implementation.join(repositoryRoot, "events.jsonl"),
    memoriesPath: implementation.join(repositoryRoot, "memories.jsonl"),
    findingsPath: implementation.join(repositoryRoot, "findings.jsonl"),
    pendingPath: implementation.join(repositoryRoot, "pending.json"),
    lockPath: implementation.join(repositoryRoot, ".conversation.lock"),
    transactionIntentPath: implementation.join(repositoryRoot, ".conversation-transaction.json"),
    transactionRetiredPath: implementation.join(repositoryRoot, ".conversation-transaction.retired.json"),
    journalHeadPath: implementation.join(repositoryRoot, "journal-head.json"),
  };
  for (const candidate of [result.cursorPath, result.eventsPath, result.memoriesPath, result.findingsPath,
    result.pendingPath, result.lockPath, result.transactionIntentPath, result.transactionRetiredPath, result.journalHeadPath]) {
    assertInside(repositoryRoot, candidate, implementation);
  }
  const rootRelative = implementation.relative(resolvedRoot, repositoryRoot);
  if (rootRelative === "" || rootRelative === ".." || rootRelative.startsWith(`..${implementation.sep}`) ||
    implementation.isAbsolute(rootRelative)) {
    throw new Error("Conversation repository path escapes state root");
  }
  return result;
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function inspectExistingPath(
  fs: ConversationPathFileSystem,
  candidate: string,
  requireDirectory: boolean,
  platform: NodeJS.Platform,
  uid: number | undefined,
): Promise<Stats | undefined> {
  try {
    const info = await fs.lstat(candidate);
    if (info.isSymbolicLink()) throw new Error(`Conversation state path contains a symbolic link: ${candidate}`);
    if (requireDirectory && !info.isDirectory()) {
      throw new Error(`Conversation state directory must be a real directory: ${candidate}`);
    }
    if (!requireDirectory && !info.isFile()) {
      throw new Error(`Conversation state file must be a real regular file: ${candidate}`);
    }
    if (platform !== "win32") {
      if (uid !== undefined && info.uid !== uid) throw new Error(`Conversation state path must be owner-owned: ${candidate}`);
      if ((info.mode & 0o022) !== 0) throw new Error(`Conversation state path has unsafe writable permissions: ${candidate}`);
    }
    return info;
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

function directoryChain(candidate: string, implementation: path.PlatformPath): string[] {
  const resolved = implementation.resolve(candidate);
  const parsed = implementation.parse(resolved);
  const relative = resolved.slice(parsed.root.length);
  const chain = [parsed.root];
  let current = parsed.root;
  for (const segment of relative.split(implementation.sep).filter((part) => part.length > 0)) {
    current = implementation.join(current, segment);
    chain.push(current);
  }
  return chain;
}

async function preparePhysicalAncestors(
  fs: ConversationPathFileSystem,
  root: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
  implementation: path.PlatformPath,
): Promise<void> {
  const chain = directoryChain(root, implementation);
  for (let index = 0; index < chain.length - 1; index += 1) {
    const candidate = chain[index]!;
    try {
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`Conversation state path contains a symbolic link: ${candidate}`);
      if (!info.isDirectory()) throw new Error(`Conversation state ancestor is not a directory: ${candidate}`);
      if (platform !== "win32") {
        const writableByOthers = (info.mode & 0o022) !== 0;
        const sticky = (info.mode & 0o1000) !== 0;
        if (writableByOthers && !sticky) {
          throw new Error(`Conversation state parent can be replaced by another user: ${candidate}`);
        }
      }
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = implementation.dirname(candidate);
      const parentInfo = await fs.lstat(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        throw new Error(`Conversation state ancestor is unsafe: ${parent}`);
      }
      try {
        await fs.mkdir(candidate, { mode: 0o700 });
      } catch (createError) {
        if (!(typeof createError === "object" && createError !== null && "code" in createError &&
          (createError as NodeJS.ErrnoException).code === "EEXIST")) {
          throw createError;
        }
      }
      await inspectExistingPath(fs, candidate, true, platform, uid);
    }
  }
}

async function protectDirectory(
  fs: ConversationPathFileSystem,
  directory: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
): Promise<Stats> {
  let before = await inspectExistingPath(fs, directory, true, platform, uid);
  if (before === undefined) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST")) {
        throw error;
      }
    }
    before = await inspectExistingPath(fs, directory, true, platform, uid);
  }
  if (before === undefined) throw new Error(`Conversation state directory was not created: ${directory}`);
  if (platform !== "win32") {
    await fs.chmod(directory, 0o700);
    const after = await inspectExistingPath(fs, directory, true, platform, uid);
    if (after === undefined || after.dev !== before.dev || after.ino !== before.ino || (after.mode & 0o077) !== 0) {
      throw new Error(`Conversation state directory changed while being protected: ${directory}`);
    }
    return after;
  }
  return before;
}

export async function prepareConversationStatePaths(
  paths: ConversationStatePaths,
  dependencies: ConversationPathDependencies = {},
): Promise<PreparedConversationStatePaths> {
  const fs = { ...realPathFileSystem, ...dependencies.fileSystem };
  const platform = dependencies.platform ?? process.platform;
  const uid = dependencies.uid ?? process.getuid?.();
  const implementation = platform === "win32" ? path.win32 : path.posix;
  await preparePhysicalAncestors(fs, paths.root, platform, uid, implementation);
  const relativeRepository = implementation.relative(paths.root, paths.repositoryRoot);
  if (relativeRepository === "" || relativeRepository === ".." ||
    relativeRepository.startsWith(`..${implementation.sep}`) || implementation.isAbsolute(relativeRepository)) {
    throw new Error("Conversation repository path escapes state root");
  }
  const managedDirectories = [paths.root];
  let current = paths.root;
  for (const segment of relativeRepository.split(implementation.sep)) {
    current = implementation.join(current, segment);
    managedDirectories.push(current);
  }
  let repositoryInfo: Stats | undefined;
  for (const directory of managedDirectories) {
    repositoryInfo = await protectDirectory(fs, directory, platform, uid);
  }
  for (const candidate of [paths.cursorPath, paths.eventsPath, paths.memoriesPath, paths.findingsPath,
    paths.pendingPath, paths.lockPath, paths.transactionIntentPath, paths.transactionRetiredPath, paths.journalHeadPath]) {
    await inspectExistingPath(fs, candidate, false, platform, uid);
  }
  if (repositoryInfo === undefined) throw new Error("Conversation repository directory was not prepared");
  return { repositoryDirectoryIdentity: { dev: repositoryInfo.dev, ino: repositoryInfo.ino } };
}
