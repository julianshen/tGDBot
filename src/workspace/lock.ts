import { hostname } from "node:os";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_POLL_MS = 100;

export interface LockOwner {
  runId: string;
  pid?: number;
  hostname?: string;
}

export interface RepositoryLockOptions {
  lockPath: string;
  timeoutMs: number;
  pollMs?: number;
  owner: LockOwner;
}

interface LockMetadata {
  version: number;
  pid: number;
  hostname: string;
  runId: string;
  createdAt: string;
}

interface LockFileIdentity {
  dev: number;
  ino: number;
}

interface AcquiredLock {
  identity: LockFileIdentity;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateOptions(options: RepositoryLockOptions): number {
  if (typeof options.lockPath !== "string" || options.lockPath.length === 0 || options.lockPath.includes("\0")) {
    throw new Error("Repository lock path must be a non-empty filesystem path");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("Repository lock timeout must be a non-negative finite number of milliseconds");
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("Repository lock poll interval must be a positive finite number of milliseconds");
  }
  if (typeof options.owner?.runId !== "string" || options.owner.runId.trim().length === 0) {
    throw new Error("Repository lock owner run ID must be non-empty");
  }
  if (options.owner.pid !== undefined && (!Number.isInteger(options.owner.pid) || options.owner.pid < 0)) {
    throw new Error("Repository lock owner PID must be a non-negative integer");
  }
  if (options.owner.hostname !== undefined && options.owner.hostname.trim().length === 0) {
    throw new Error("Repository lock owner hostname must be non-empty");
  }
  return pollMs;
}

function buildMetadata(owner: LockOwner): LockMetadata {
  return {
    version: LOCK_SCHEMA_VERSION,
    pid: owner.pid ?? process.pid,
    hostname: owner.hostname ?? hostname(),
    runId: owner.runId,
    createdAt: new Date().toISOString(),
  };
}

function safeOwnerDescription(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Existing lock owner metadata is unavailable or invalid.";
  }
  const metadata = value as Record<string, unknown>;
  if (
    metadata.version !== LOCK_SCHEMA_VERSION ||
    typeof metadata.pid !== "number" ||
    typeof metadata.hostname !== "string" ||
    typeof metadata.runId !== "string" ||
    typeof metadata.createdAt !== "string"
  ) {
    return "Existing lock owner metadata is unavailable or invalid.";
  }
  return `Existing lock owner metadata: ${JSON.stringify({
    version: metadata.version,
    pid: metadata.pid,
    hostname: metadata.hostname,
    runId: metadata.runId,
    createdAt: metadata.createdAt,
  })}.`;
}

async function timeoutError(lockPath: string, timeoutMs: number): Promise<Error> {
  let ownerDescription = "Existing lock owner metadata is unavailable.";
  try {
    ownerDescription = safeOwnerDescription(JSON.parse(await readFile(lockPath, "utf8")) as unknown);
  } catch {
    // Another process can release or replace the lock while diagnostics are collected.
  }
  return new Error(
    `Timed out acquiring repository lock at ${lockPath} after ${timeoutMs}ms. ${ownerDescription} ` +
    "Manual recovery: inspect the recorded owner and remove the lock manually only after confirming it is inactive.",
  );
}

function identityOf(stats: { dev: number; ino: number }): LockFileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function hasSameIdentity(left: LockFileIdentity, right: LockFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function releaseOwnedLock(lockPath: string, expectedIdentity: LockFileIdentity): Promise<void> {
  let currentIdentity: LockFileIdentity;
  try {
    currentIdentity = identityOf(await lstat(lockPath));
  } catch (error) {
    throw new Error(`Failed to release repository lock at ${lockPath}: could not verify ownership`, { cause: error });
  }
  if (!hasSameIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`Failed to release repository lock at ${lockPath}: lock file identity no longer matches this owner`);
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    throw new Error(`Failed to release repository lock at ${lockPath}`, { cause: error });
  }
}

async function tryAcquireLock(lockPath: string, contents: string): Promise<AcquiredLock | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) return null;
    throw error;
  }

  let identity: LockFileIdentity | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  let closeFailure: unknown;
  try {
    identity = identityOf(await handle.stat());
    await handle.writeFile(contents, "utf8");
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeFailure = error;
    }
  }

  if (!hasPrimaryFailure && closeFailure === undefined) {
    return { identity: identity as LockFileIdentity };
  }

  const cleanupFailures: unknown[] = [];
  if (identity === undefined) {
    cleanupFailures.push(new Error(`Failed to release repository lock at ${lockPath}: could not verify acquired file identity`));
  } else {
    try {
      await releaseOwnedLock(lockPath, identity);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (hasPrimaryFailure) {
    if (closeFailure !== undefined) cleanupFailures.unshift(closeFailure);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        `Failed to initialize repository lock at ${lockPath}`,
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [closeFailure, ...cleanupFailures],
      `Failed to close and release repository lock at ${lockPath}`,
    );
  }
  throw closeFailure;
}

/**
 * Runs work while exclusively owning a repository-specific lock file. The lock
 * is never treated as stale and is removed only when its filesystem identity
 * still matches the file exclusively created by this invocation.
 */
export async function withRepositoryLock<T>(
  options: RepositoryLockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const pollMs = validateOptions(options);
  if (typeof work !== "function") throw new Error("Repository lock work must be a function");

  const metadata = buildMetadata(options.owner);
  const contents = `${JSON.stringify(metadata)}\n`;
  const deadline = Date.now() + options.timeoutMs;

  await mkdir(path.dirname(options.lockPath), { recursive: true });
  while (true) {
    const acquiredLock = await tryAcquireLock(options.lockPath, contents);
    if (acquiredLock !== null) {
      const workResult = await Promise.resolve().then(work).then(
        (value) => ({ succeeded: true as const, value }),
        (error: unknown) => ({ succeeded: false as const, error }),
      );
      try {
        if (workResult.succeeded) return workResult.value;
        throw workResult.error;
      } finally {
        try {
          await releaseOwnedLock(options.lockPath, acquiredLock.identity);
        } catch (releaseError) {
          if (!workResult.succeeded) {
            throw new AggregateError(
              [workResult.error, releaseError],
              `Repository lock work failed and lock release also failed at ${options.lockPath}`,
            );
          }
          throw releaseError;
        }
      }
    }
    if (Date.now() >= deadline) throw await timeoutError(options.lockPath, options.timeoutMs);
    await delay(Math.min(pollMs, deadline - Date.now()));
  }
}
