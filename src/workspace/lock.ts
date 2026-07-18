import { hostname } from "node:os";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
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

async function releaseOwnedLock(lockPath: string, expectedContents: string): Promise<void> {
  let actualContents: string;
  try {
    actualContents = await readFile(lockPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to release repository lock at ${lockPath}: could not verify ownership`, { cause: error });
  }
  if (actualContents !== expectedContents) {
    throw new Error(`Failed to release repository lock at ${lockPath}: lock contents no longer match this owner`);
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    throw new Error(`Failed to release repository lock at ${lockPath}`, { cause: error });
  }
}

async function releaseUninitializedLock(lockPath: string, intendedContents: string): Promise<void> {
  let actualContents: string;
  try {
    actualContents = await readFile(lockPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to release uninitialized repository lock at ${lockPath}`, { cause: error });
  }
  if (!intendedContents.startsWith(actualContents)) {
    throw new Error(`Failed to release uninitialized repository lock at ${lockPath}: lock contents no longer match this owner`);
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    throw new Error(`Failed to release uninitialized repository lock at ${lockPath}`, { cause: error });
  }
}

/**
 * Runs work while exclusively owning a repository-specific lock file. The lock
 * is never treated as stale or removed unless its exact metadata was created by
 * this invocation.
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
    try {
      const handle = await open(options.lockPath, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
      } catch (error) {
        await handle.close();
        try {
          await releaseUninitializedLock(options.lockPath, contents);
        } catch (releaseError) {
          throw new AggregateError([error, releaseError], `Failed to initialize repository lock at ${options.lockPath}`);
        }
        throw error;
      }
      await handle.close();

      let workFailed = false;
      let workError: unknown;
      try {
        return await work();
      } catch (error) {
        workFailed = true;
        workError = error;
        throw error;
      } finally {
        try {
          await releaseOwnedLock(options.lockPath, contents);
        } catch (releaseError) {
          if (workFailed) {
            throw new AggregateError(
              [workError, releaseError],
              `Repository lock work failed and lock release also failed at ${options.lockPath}`,
            );
          }
          throw releaseError;
        }
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) throw await timeoutError(options.lockPath, options.timeoutMs);
      await delay(Math.min(pollMs, deadline - Date.now()));
    }
  }
}
