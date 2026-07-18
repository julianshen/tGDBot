import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRepositoryLock } from "../../../src/workspace/lock.js";

const mockedFs = vi.hoisted(() => ({
  open: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  unlink: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));
const mockedClock = vi.hoisted(() => ({ now: undefined as undefined | (() => number) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: unknown[]) => mockedFs.open === undefined ? actual.open(...args as Parameters<typeof actual.open>) : mockedFs.open(...args),
    unlink: (...args: unknown[]) => mockedFs.unlink === undefined ? actual.unlink(...args as Parameters<typeof actual.unlink>) : mockedFs.unlink(...args),
  };
});

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    performance: { now: () => mockedClock.now === undefined ? actual.performance.now() : mockedClock.now() },
  };
});

const roots: string[] = [];
const owner = { runId: "run-123" };

async function tempLockPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-lock-test-"));
  roots.push(root);
  return path.join(root, "repository.lock");
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockedFs.open = undefined;
  mockedFs.unlink = undefined;
  mockedClock.now = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("withRepositoryLock", () => {
  it("rejects unsafe lock options before creating a file", async () => {
    const lockPath = await tempLockPath();
    const work = async () => "unreachable";

    await expect(withRepositoryLock({ lockPath: "", timeoutMs: 1, owner }, work)).rejects.toThrow(/path/i);
    await expect(withRepositoryLock({ lockPath, timeoutMs: -1, owner }, work)).rejects.toThrow(/timeout/i);
    await expect(withRepositoryLock({ lockPath, timeoutMs: 1, pollMs: 0, owner }, work)).rejects.toThrow(/poll/i);
    await expect(withRepositoryLock({ lockPath, timeoutMs: 1, owner: { runId: "" } }, work)).rejects.toThrow(/run ID/i);
    await expect(withRepositoryLock({ lockPath, timeoutMs: 1, owner: { runId: "run", pid: -1 } }, work))
      .rejects.toThrow(/PID/i);
    await expect(withRepositoryLock({ lockPath, timeoutMs: 1, owner: { runId: "run", hostname: "" } }, work))
      .rejects.toThrow(/hostname/i);
    await expect(withRepositoryLock({ lockPath, timeoutMs: 1, owner }, undefined as never)).rejects.toThrow(/work/i);

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-4.1: serializes callers using the same repository lock path", async () => {
    vi.useFakeTimers();
    mockedClock.now = () => Date.now();
    const lockPath = await tempLockPath();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondWork = vi.fn(async () => "second");

    const first = withRepositoryLock({ lockPath, timeoutMs: 100, pollMs: 1, owner }, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;

    const second = withRepositoryLock({ lockPath, timeoutMs: 100, pollMs: 1, owner: { runId: "run-456" } }, secondWork);
    await vi.advanceTimersByTimeAsync(1);
    expect(secondWork).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe("second");
    expect(secondWork).toHaveBeenCalledOnce();
  });

  it("times out before a delayed retry can acquire a released lock", async () => {
    vi.useFakeTimers();
    let now = 0;
    mockedClock.now = () => now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const lockPath = await tempLockPath();
    await writeFile(lockPath, "contended", "utf8");
    const work = vi.fn(async () => "must not run");
    const firstContention = deferred();
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    mockedFs.open = async (...args) => {
      try {
        return await realOpen(...args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") firstContention.resolve();
        throw error;
      }
    };

    const waiting = withRepositoryLock({ lockPath, timeoutMs: 20, pollMs: 5, owner }, work);
    await firstContention.promise;
    await vi.advanceTimersByTimeAsync(0);
    now = 60;
    await rm(lockPath);
    const rejection = expect(waiting).rejects.toThrow(/Timed out acquiring repository lock/);
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(work).not.toHaveBeenCalled();
  });

  it("allows the immediate acquisition attempt when timeout is zero", async () => {
    const lockPath = await tempLockPath();

    await expect(withRepositoryLock({ lockPath, timeoutMs: 0, owner }, async () => "acquired"))
      .resolves.toBe("acquired");
  });

  it("records non-secret owner metadata while the lock is held and releases after success", async () => {
    const lockPath = await tempLockPath();

    await withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      const metadata = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(metadata).toMatchObject({ version: 1, pid: process.pid, runId: owner.runId });
      expect(metadata.hostname).toEqual(expect.any(String));
      expect(metadata.createdAt).toEqual(expect.any(String));
    });

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses explicitly supplied PID and hostname metadata", async () => {
    const lockPath = await tempLockPath();

    await withRepositoryLock({
      lockPath,
      timeoutMs: 100,
      owner: { runId: "run-456", pid: 456, hostname: "ci-worker" },
    }, async () => {
      const metadata = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(metadata).toMatchObject({ pid: 456, hostname: "ci-worker" });
    });
  });

  it("releases its owned lock after work throws", async () => {
    const lockPath = await tempLockPath();
    const workError = new Error("review failed");

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      throw workError;
    })).rejects.toBe(workError);

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases its owned lock when work throws an undefined value", async () => {
    const lockPath = await tempLockPath();

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      throw undefined;
    })).rejects.toBeUndefined();

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates an EEXIST error from work unchanged without retrying work", async () => {
    const lockPath = await tempLockPath();
    const workError = Object.assign(new Error("work EEXIST"), { code: "EEXIST" });
    const work = vi.fn(async () => {
      if (work.mock.calls.length === 1) throw workError;
      return "must not run again";
    });

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, work)).rejects.toBe(workError);
    expect(work).toHaveBeenCalledOnce();
  });

  it("leaves a replacement lock in place and surfaces the release failure", async () => {
    const lockPath = await tempLockPath();
    const replacement = "a lock created by another owner\n";

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      await rm(lockPath);
      await writeFile(lockPath, replacement, "utf8");
    })).rejects.toThrow(/Failed to release repository lock/);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
  });

  it("does not unlink an identical-content replacement lock", async () => {
    const lockPath = await tempLockPath();

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      const contents = await readFile(lockPath, "utf8");
      await rm(lockPath);
      await writeFile(lockPath, contents, "utf8");
    })).rejects.toThrow(/Failed to release repository lock/);

    await expect(readFile(lockPath, "utf8")).resolves.toContain(owner.runId);
  });

  it("preserves the work failure when releasing the owned lock also fails", async () => {
    const lockPath = await tempLockPath();
    const workError = new Error("review failed");

    const result = await withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      await rm(lockPath);
      await writeFile(lockPath, "replacement lock\n", "utf8");
      throw workError;
    }).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(workError);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement lock\n");
  });

  it("surfaces an ownership-verification failure when work has already removed the lock", async () => {
    const lockPath = await tempLockPath();

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => {
      await rm(lockPath);
    })).rejects.toThrow(/could not verify ownership/);
  });

  it("removes its newly-created lock when writing metadata fails", async () => {
    const lockPath = await tempLockPath();
    const reference = await open(path.join(path.dirname(lockPath), "reference"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(reference) as { writeFile: (value: string) => Promise<void> };
    await reference.close();
    vi.spyOn(fileHandlePrototype, "writeFile").mockRejectedValueOnce(new Error("disk full"));

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => "unreachable"))
      .rejects.toThrow("disk full");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves an empty replacement lock in place when metadata writing fails", async () => {
    const lockPath = await tempLockPath();
    const reference = await open(path.join(path.dirname(lockPath), "reference"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(reference) as { writeFile: (value: string) => Promise<void> };
    await reference.close();
    vi.spyOn(fileHandlePrototype, "writeFile").mockImplementationOnce(async () => {
      await rm(lockPath);
      await writeFile(lockPath, "", "utf8");
      throw new Error("disk full");
    });

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => "unreachable"))
      .rejects.toThrow(/Failed to initialize repository lock/);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("releases its lock when closing after metadata creation fails", async () => {
    const lockPath = await tempLockPath();
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    mockedFs.open = async (...args) => {
      const handle = await realOpen(...args);
      return Object.assign(Object.create(handle), {
        close: async () => {
          await handle.close();
          throw new Error("close failed");
        },
      });
    };

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => "must not run"))
      .rejects.toThrow("close failed");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps metadata-write failure primary when closing and cleanup also fail", async () => {
    const lockPath = await tempLockPath();
    const writeFailure = new Error("disk full");
    const closeFailure = new Error("close failed");
    const reference = await open(path.join(path.dirname(lockPath), "reference"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(reference) as { writeFile: (value: string) => Promise<void> };
    await reference.close();
    vi.spyOn(fileHandlePrototype, "writeFile").mockImplementationOnce(async () => {
      await rm(lockPath);
      await writeFile(lockPath, "", "utf8");
      throw writeFailure;
    });
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    mockedFs.open = async (...args) => {
      const handle = await realOpen(...args);
      return Object.assign(Object.create(handle), {
        close: async () => {
          await handle.close();
          throw closeFailure;
        },
      });
    };

    const result = await withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => "must not run")
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(writeFailure);
    expect((result as AggregateError).errors[1]).toBe(closeFailure);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("reports an unlink failure instead of silently claiming release", async () => {
    const lockPath = await tempLockPath();
    mockedFs.unlink = async () => { throw new Error("permission denied"); };

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => undefined))
      .rejects.toThrow(/Failed to release repository lock/);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(owner.runId);
  });

  it("allows unrelated repository lock paths to proceed independently", async () => {
    const firstPath = await tempLockPath();
    const secondPath = await tempLockPath();
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = withRepositoryLock({ lockPath: firstPath, timeoutMs: 100, owner }, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    await expect(withRepositoryLock({ lockPath: secondPath, timeoutMs: 100, owner }, async () => "second"))
      .resolves.toBe("second");
    releaseFirst.resolve();
    await first;
  });

  it("times out deterministically, reports safe existing-owner metadata, and never deletes it", async () => {
    vi.useFakeTimers();
    mockedClock.now = () => Date.now();
    const lockPath = await tempLockPath();
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 9876,
      hostname: "build-host",
      runId: "other-run",
      createdAt: "2026-07-18T00:00:00.000Z",
      secret: "must-not-appear",
    }));
    const work = vi.fn(async () => "unreachable");

    const waiting = withRepositoryLock({ lockPath, timeoutMs: 25, pollMs: 5, owner }, work);
    const rejection = expect(waiting).rejects.toThrow(/Timed out acquiring repository lock/);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(24);
    await rejection;

    await expect(waiting).rejects.toThrow(/other-run/);
    await expect(waiting).rejects.toThrow(/manual recovery/i);
    await expect(waiting).rejects.not.toThrow(/must-not-appear/);
    expect(work).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("must-not-appear");
  });

  it("does not echo malformed existing lock contents in timeout diagnostics", async () => {
    vi.useFakeTimers();
    mockedClock.now = () => Date.now();
    const lockPath = await tempLockPath();
    await writeFile(lockPath, "sensitive malformed lock contents");

    const waiting = withRepositoryLock({ lockPath, timeoutMs: 1, pollMs: 1, owner }, async () => "unreachable");
    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting).rejects.toThrow(/metadata is unavailable/i);
    await expect(waiting).rejects.not.toThrow(/sensitive malformed/i);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("sensitive malformed lock contents");
  });

  it.each(["null", JSON.stringify({ version: 1 })])("reports invalid parsed owner metadata safely: %s", async (contents) => {
    const lockPath = await tempLockPath();
    await writeFile(lockPath, contents, "utf8");

    await expect(withRepositoryLock({ lockPath, timeoutMs: 0, owner }, async () => "unreachable"))
      .rejects.toThrow(/metadata is unavailable or invalid/i);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(contents);
  });

  it("propagates a non-contention acquisition error without running work", async () => {
    const lockPath = await tempLockPath();
    const acquisitionError = Object.assign(new Error("read-only filesystem"), { code: "EACCES" });
    mockedFs.open = async () => { throw acquisitionError; };
    const work = vi.fn(async () => "unreachable");

    await expect(withRepositoryLock({ lockPath, timeoutMs: 100, owner }, work)).rejects.toBe(acquisitionError);
    expect(work).not.toHaveBeenCalled();
  });

  it("leaves the lock in place when identity capture fails after exclusive open", async () => {
    const lockPath = await tempLockPath();
    const identityFailure = new Error("fstat failed");
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    mockedFs.open = async (...args) => {
      const handle = await realOpen(...args);
      return Object.assign(Object.create(handle), {
        stat: async () => { throw identityFailure; },
      });
    };

    const result = await withRepositoryLock({ lockPath, timeoutMs: 100, owner }, async () => "unreachable")
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(identityFailure);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("aggregates close and cleanup failures after successful metadata creation", async () => {
    const lockPath = await tempLockPath();
    const closeFailure = new Error("close failed");
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    mockedFs.open = async (...args) => {
      const handle = await realOpen(...args);
      return Object.assign(Object.create(handle), {
        close: async () => {
          await handle.close();
          await rm(lockPath);
          await writeFile(lockPath, "replacement", "utf8");
          throw closeFailure;
        },
      });
    };
    const work = vi.fn(async () => "unreachable");

    const result = await withRepositoryLock({ lockPath, timeoutMs: 100, owner }, work).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBe(closeFailure);
    expect(work).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement");
  });
});
