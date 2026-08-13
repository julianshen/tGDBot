import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import { deriveConversationStatePaths } from "../../../src/conversation/state-paths.js";
import {
  createConversationStateStore as createStoreRaw,
  type ConversationStateStoreOptions,
} from "../../../src/conversation/state-store.js";

const temporaryDirectories: string[] = [];
const repo = parseRepositoryRef("owner/repo", "github");
const testProcessInspector = {
  current: async () => ({ pid: 100, hostname: "unit-test-host", startIdentity: "unit-test-start" }),
  inspect: async () => ({ status: "unknown" as const }),
};

function createStore(options: ConversationStateStoreOptions) {
  return createStoreRaw({ ...options, dependencies: {
    processInspector: testProcessInspector,
    ...options.dependencies,
  } });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-state-store-")));
  temporaryDirectories.push(directory);
  return path.join(directory, "state");
}

describe("conversation state store", () => {
  test("rejects async and thenable transaction results without committing", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    await expect(store.transact((async (tx) => { tx.initializeIfAbsent(); }) as never))
      .rejects.toThrow(/synchronous|thenable|async/i);
    await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.transact(((tx: Parameters<Parameters<typeof store.transact>[0]>[0]) => {
      tx.initializeIfAbsent();
      return { then: () => undefined };
    }) as never)).rejects.toThrow(/synchronous|thenable|async/i);
    await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    "lock:create", "fsync-temp:lock-candidate", "fsync-lock-candidate-parent", "lock:link",
    "fsync-lock-linked-parent", "lock:unlink-candidate",
  ])("never publishes partial fixed lock metadata when acquisition fails at %s", async (stage) => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    let injected = false;
    const store = createStore({ root: stateRoot, repository: repo, dependencies: {
      onFileSystemOperation: (operation) => {
        if (!injected && operation === stage) { injected = true; throw new Error(`abrupt ${stage}`); }
      },
    } });
    await expect(store.readContextSnapshot()).rejects.toThrow(`abrupt ${stage}`);
    expect(injected).toBe(true);
    try {
      const metadata = JSON.parse(await readFile(paths.lockPath, "utf8")) as Record<string, unknown>;
      expect(metadata).toMatchObject({ version: 1, pid: 100, hostname: "unit-test-host",
        processStartIdentity: "unit-test-start" });
    } catch (error) {
      expect(error).toMatchObject({ code: "ENOENT" });
    }
    expect((await createStore({ root: stateRoot, repository: repo, dependencies: { processInspector: {
      current: testProcessInspector.current,
      inspect: async () => ({ status: "absent" }),
    } } }).readContextSnapshot()).cursor.version).toBe(1);
  });

  test("case-equivalent GitHub references share binding and state while renames form a new v1 domain", async () => {
    const stateRoot = await root();
    const mixed = createStore({ root: stateRoot, repository: parseRepositoryRef("Owner/Repo", "github") });
    const lower = createStore({ root: stateRoot, repository: parseRepositoryRef("owner/repo", "github") });
    expect(mixed.repositoryBinding).toEqual(lower.repositoryBinding);
    await mixed.transact((tx) => {
      tx.initializeIfAbsent();
      tx.replaceCursor({ ...tx.snapshot.cursor, initialized: true, initializedEpoch: 1 });
    });
    expect((await lower.readContextSnapshot()).cursor.initialized).toBe(true);
    const renamed = createStore({ root: stateRoot, repository: parseRepositoryRef("owner/new-repo", "github") });
    expect(renamed.repositoryBinding).not.toEqual(lower.repositoryBinding);
    expect((await renamed.readContextSnapshot()).cursor.initialized).toBe(false);
  });

  test("ignores POSIX mode bits for injected win32 lock, replacement, and intent files", async () => {
    const actualRoot = await root();
    const actualParent = path.dirname(actualRoot);
    const windowsRoot = "C:\\state";
    const mapPath = (candidate: string): string => {
      if (candidate === "C:\\") return actualParent;
      if (candidate === windowsRoot) return actualRoot;
      if (!candidate.startsWith(`${windowsRoot}\\`)) throw new Error(`Unexpected Windows path: ${candidate}`);
      return path.join(actualRoot, ...candidate.slice(windowsRoot.length + 1).split("\\"));
    };
    const nonPosixMode = (info: Stats): Stats => info.isFile()
      ? new Proxy(info, { get: (target, property, receiver) =>
        property === "mode" ? (target.mode & ~0o777) | 0o777 : Reflect.get(target, property, receiver) })
      : info;
    const operations: string[] = [];
    const store = createStore({ root: windowsRoot, repository: repo, dependencies: {
      platform: "win32",
      uid: 123,
      now: () => "2026-01-01T00:00:00.000Z",
      monotonicNow: () => 0,
      sleep: async () => undefined,
      randomId: (() => { let value = 0; return () => `windows-${++value}`; })(),
      processInspector: {
        current: async () => ({ pid: 7, hostname: "windows-host", startIdentity: "windows-start" }),
        inspect: async () => ({ status: "unknown" }),
      },
      onFileSystemOperation: (operation) => operations.push(operation),
      fileSystem: {
        lstat: async (candidate) => nonPosixMode(await lstat(mapPath(candidate))),
        mkdir: (candidate, options) => mkdir(mapPath(candidate), options),
        chmod: (candidate, mode) => chmod(mapPath(candidate), mode),
        rename: (from, to) => rename(mapPath(from), mapPath(to)),
        link: (from, to) => link(mapPath(from), mapPath(to)),
        unlink: (candidate) => unlink(mapPath(candidate)),
        open: async (candidate, flags, mode) => {
          const handle = await open(mapPath(candidate), flags, mode);
          return {
            stat: async () => nonPosixMode(await handle.stat()),
            readFile: () => handle.readFile(),
            writeFile: (data) => handle.writeFile(data),
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
      },
    } });
    await store.transact((tx) => { tx.initializeIfAbsent(); });
    expect(operations).toContain("lock:create");
    expect(operations).toContain("create-temp:cursor.json");
    expect(operations).toContain("create-temp:transaction-intent");
    expect((await store.readContextSnapshot()).cursor.version).toBe(1);
  });

  test("returns an isolated clean snapshot without creating state files", async () => {
    const stateRoot = await root();
    const store = createStore({ root: stateRoot, repository: repo });
    const first = await store.readContextSnapshot();
    expect(first.cursor.initialized).toBe(false);
    expect(first.events).toEqual([]);
    (first.cursor.reviews as unknown[]).push({});
    expect((await store.readContextSnapshot()).cursor.reviews).toEqual([]);
    const paths = deriveConversationStatePaths(stateRoot, repo);
    await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.transactionIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("initializes snapshots and persists owner-only files", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    await store.transact((tx) => {
      expect(tx.initializeIfAbsent()).toBe(true);
      expect(tx.initializeIfAbsent()).toBe(false);
    });
    expect(JSON.parse(await readFile(paths.cursorPath, "utf8"))).toMatchObject({ version: 1, initialized: false });
    expect(JSON.parse(await readFile(paths.pendingPath, "utf8"))).toMatchObject({ version: 1, clarifications: [] });
    expect((await readdir(paths.repositoryRoot)).filter((name) => name.endsWith(".tmp") || name.includes("transaction")))
      .toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(paths.cursorPath)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.pendingPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("writes nothing from a callback that rejects", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    await expect(store.transact((tx) => {
      tx.initializeIfAbsent();
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("prepares complete replacements, commits intent, and then installs all targets", async () => {
    const stateRoot = await root();
    const operations: string[] = [];
    const store = createStore({
      root: stateRoot,
      repository: repo,
      dependencies: { onFileSystemOperation: (operation) => operations.push(operation), randomId: () => "fixed" },
    });
    const binding = store.repositoryBinding;
    await store.transact((tx) => {
      tx.initializeIfAbsent();
      tx.appendMemory({ version: 1, repository: binding, operation: "create", id: `memory_${"1".repeat(32)}`,
        text: "remember this", attribution: "reviewer", source: "review", at: "2026-01-01T00:00:00.000Z" });
      tx.replaceCursor({ ...tx.snapshot.cursor, initialized: true, initializedEpoch: 1 });
    });
    const snapshot = await store.readContextSnapshot();
    expect(snapshot.memories).toHaveLength(1);
    expect(snapshot.cursor.initialized).toBe(true);
    expect(operations).not.toContain("append:memories.jsonl");
    expect(operations.findIndex((operation) => operation.startsWith("fsync-temp:memories.segment.")))
      .toBeLessThan(operations.indexOf("rename-intent"));
    expect(operations.indexOf("rename-intent")).toBeLessThan(operations.indexOf("rename-target:cursor.json"));
    expect(operations.indexOf("rename-target:cursor.json")).toBeLessThan(operations.indexOf("retire-intent"));
  });

  test("cleans an unrenamed snapshot temp after fsync failure", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo, dependencies: {
      randomId: () => "fsync-failure",
      onFileSystemOperation: (operation) => {
        if (operation === "fsync-temp:cursor.json") throw new Error("injected fsync failure");
      },
    } });
    await expect(store.transact((tx) => { tx.initializeIfAbsent(); })).rejects.toThrow("injected fsync failure");
    expect((await readdir(paths.repositoryRoot)).filter((name) => name.includes(".tmp"))).toEqual([]);
    await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("recovers the entire committed intent after a replacement rename reports failure", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    let targetRenames = 0;
    const store = createStore({ root: stateRoot, repository: repo, dependencies: {
      onFileSystemOperation: (operation) => {
        if (operation.startsWith("rename-target:") && ++targetRenames === 1) throw new Error("injected rename failure");
      },
    } });
    const binding = store.repositoryBinding;
    await expect(store.transact((tx) => {
      tx.initializeIfAbsent();
      tx.appendMemory({ version: 1, repository: binding, operation: "create", id: `memory_${"3".repeat(32)}`,
        text: "recover all files", attribution: "reviewer", source: "review", at: "2026-01-01T00:00:00.000Z" });
      tx.replaceCursor({ ...tx.snapshot.cursor, initialized: true, initializedEpoch: 1 });
    })).rejects.toThrow("injected rename failure");
    expect(await stat(paths.transactionIntentPath)).toBeDefined();
    const recovered = await createStore({ root: stateRoot, repository: repo }).readContextSnapshot();
    expect(recovered.cursor.initialized).toBe(true);
    expect(recovered.memories.map((memory) => memory.text)).toEqual(["recover all files"]);
    await expect(stat(paths.transactionIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("every commit-stage failure is either invisible or fully recovered", async () => {
    const stages = [
      "create-temp:cursor.json", "fsync-temp:cursor.json", "create-temp:pending.json", "fsync-temp:pending.json",
      "fsync-prepared-parent", "create-temp:transaction-intent", "fsync-temp:transaction-intent",
      "fsync-intent-temp-parent", "rename-intent", "fsync-intent-parent", "rename-target:cursor.json",
      "fsync-target-parent:cursor.json", "rename-target:pending.json", "fsync-target-parent:pending.json",
      "retire-intent", "fsync-retire-parent", "unlink-retired", "fsync-remove-parent",
    ] as const;
    const committedStages = new Set(stages.slice(stages.indexOf("fsync-intent-parent")));
    for (const stage of stages) {
      const stateRoot = await root();
      const paths = deriveConversationStatePaths(stateRoot, repo);
      let injected = false;
      let sequence = 0;
      const store = createStore({ root: stateRoot, repository: repo, dependencies: {
        randomId: () => `stage-${stage.replace(/[^A-Za-z0-9]/gu, "-")}-${++sequence}`,
        now: () => "2026-01-01T00:00:00.000Z",
        onFileSystemOperation: (operation) => {
          if (!injected && operation === stage) { injected = true; throw new Error(`failure at ${stage}`); }
        },
      } });
      await expect(store.transact((tx) => { tx.initializeIfAbsent(); })).rejects.toThrow(`failure at ${stage}`);
      expect(injected).toBe(true);
      if (committedStages.has(stage)) {
        const recovered = await createStore({ root: stateRoot, repository: repo }).readContextSnapshot();
        expect(recovered.cursor.version).toBe(1);
        expect(recovered.pending.version).toBe(1);
      } else {
        await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.transactionIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await readdir(paths.repositoryRoot)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      }
    }
  });

  test.each(["intent", "target", "retirement", "retired-unlink"] as const)(
    "recovers when %s mutation succeeds but the filesystem reports failure",
    async (failurePoint) => {
      const stateRoot = await root();
      const paths = deriveConversationStatePaths(stateRoot, repo);
      let injected = false;
      const store = createStore({ root: stateRoot, repository: repo, dependencies: { fileSystem: {
        rename: async (from, to) => {
          await rename(from, to);
          const matches = failurePoint === "intent" ? to === paths.transactionIntentPath :
            failurePoint === "target" ? path.basename(to) === "cursor.json" :
              failurePoint === "retirement" ? to === paths.transactionRetiredPath : false;
          if (!injected && matches) { injected = true; throw new Error(`post-${failurePoint} failure`); }
        },
        unlink: async (candidate) => {
          await unlink(candidate);
          if (!injected && failurePoint === "retired-unlink" && candidate === paths.transactionRetiredPath) {
            injected = true;
            throw new Error("post-retired-unlink failure");
          }
        },
      } } });
      await expect(store.transact((tx) => { tx.initializeIfAbsent(); }))
        .rejects.toThrow(`post-${failurePoint} failure`);
      expect(injected).toBe(true);
      const recovered = await createStore({ root: stateRoot, repository: repo }).readContextSnapshot();
      expect(recovered.cursor.version).toBe(1);
      expect(recovered.pending.version).toBe(1);
      await expect(stat(paths.transactionIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(paths.transactionRetiredPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("recovers correctly when each fsync succeeds but reports failure", async () => {
    const fsyncPoints = [
      "fsync-temp:cursor.json", "fsync-temp:pending.json", "fsync-prepared-parent",
      "fsync-temp:transaction-intent", "fsync-intent-temp-parent", "fsync-intent-parent",
      "fsync-target-parent:cursor.json", "fsync-target-parent:pending.json",
      "fsync-retire-parent", "fsync-remove-parent",
    ] as const;
    const committedPoints = new Set(fsyncPoints.slice(fsyncPoints.indexOf("fsync-intent-parent")));
    for (const point of fsyncPoints) {
      const stateRoot = await root();
      const paths = deriveConversationStatePaths(stateRoot, repo);
      let lastOperation = "";
      let injected = false;
      const store = createStore({ root: stateRoot, repository: repo, dependencies: {
        onFileSystemOperation: (operation) => { lastOperation = operation; },
        fileSystem: {
          open: async (candidate, flags, mode) => {
            const handle = await open(candidate, flags, mode);
            return {
              stat: () => handle.stat(),
              readFile: () => handle.readFile(),
              writeFile: (data) => handle.writeFile(data),
              close: () => handle.close(),
              sync: async () => {
                await handle.sync();
                if (!injected && lastOperation === point) {
                  injected = true;
                  throw new Error(`post-fsync failure at ${point}`);
                }
              },
            };
          },
        },
      } });
      await expect(store.transact((tx) => { tx.initializeIfAbsent(); }))
        .rejects.toThrow(`post-fsync failure at ${point}`);
      expect(injected).toBe(true);
      if (committedPoints.has(point)) {
        const recovered = await createStore({ root: stateRoot, repository: repo }).readContextSnapshot();
        expect(recovered.cursor.version).toBe(1);
        expect(recovered.pending.version).toBe(1);
      } else {
        await expect(readFile(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.transactionIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  test("fails closed when neither a committed target nor its prepared replacement matches", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    let failed = false;
    const store = createStore({ root: stateRoot, repository: repo, dependencies: {
      onFileSystemOperation: (operation) => {
        if (!failed && operation === "rename-target:cursor.json") { failed = true; throw new Error("pause recovery"); }
      },
    } });
    await expect(store.transact((tx) => { tx.initializeIfAbsent(); })).rejects.toThrow("pause recovery");
    const intent = JSON.parse(await readFile(paths.transactionIntentPath, "utf8")) as {
      replacements: Array<{ target: string; temporary: string }>;
    };
    const cursorReplacement = intent.replacements.find((entry) => entry.target === "cursor.json")!;
    await unlink(path.join(paths.repositoryRoot, cursorReplacement.temporary));
    await expect(createStore({ root: stateRoot, repository: repo }).readContextSnapshot())
      .rejects.toThrow(/missing|corrupt/i);
  });

  test.each([
    { label: "absent process", inspection: { status: "absent" as const } },
    { label: "reused PID", inspection: { status: "alive" as const, startIdentity: "new-start" } },
  ])("reclaims a same-host stale lock owned by an $label and recovers its intent", async ({ inspection }) => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    let interrupted = false;
    const first = createStore({ root: stateRoot, repository: repo, dependencies: {
      onFileSystemOperation: (operation) => {
        if (!interrupted && operation === "rename-target:cursor.json") {
          interrupted = true;
          throw new Error("simulated crash after intent");
        }
      },
    } });
    await expect(first.transact((tx) => { tx.initializeIfAbsent(); })).rejects.toThrow("simulated crash after intent");
    await writeFile(paths.lockPath, `${JSON.stringify({
      version: 1, pid: 4242, hostname: "test-host", processStartIdentity: "old-start",
      runId: "abandoned-run", createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    let inspectedPid: number | undefined;
    let random = 0;
    const recovered = createStore({ root: stateRoot, repository: repo, dependencies: {
      processInspector: {
        current: async () => ({ pid: 9001, hostname: "test-host", startIdentity: "current-start" }),
        inspect: async (pid) => { inspectedPid = pid; return inspection; },
      },
      randomId: () => `recovery-${++random}`,
      now: () => "2026-01-02T00:00:00.000Z",
    } });
    const snapshot = await recovered.readContextSnapshot();
    expect(inspectedPid).toBe(4242);
    expect(snapshot.cursor.version).toBe(1);
    expect(snapshot.pending.version).toBe(1);
    expect((await readdir(paths.repositoryRoot)).some((name) => name.startsWith(".conversation.lock.stale-"))).toBe(true);
  });

  test.each(["live", "foreign-host"] as const)("fails closed without reclaiming a %s lock", async (ownerKind) => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    await createStore({ root: stateRoot, repository: repo }).readContextSnapshot();
    const metadata = {
      version: 1, pid: 4242, hostname: ownerKind === "live" ? "test-host" : "other-host",
      processStartIdentity: "same-start", runId: "active-run", createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(paths.lockPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    let inspections = 0;
    let monotonic = 0;
    const blocked = createStore({ root: stateRoot, repository: repo, lockTimeoutMs: 2,
      lockPollMs: 1, dependencies: {
        processInspector: {
          current: async () => ({ pid: 9001, hostname: "test-host", startIdentity: "current-start" }),
          inspect: async () => { inspections += 1; return { status: "alive", startIdentity: "same-start" }; },
        },
        monotonicNow: () => monotonic++,
        sleep: async () => undefined,
      } });
    await expect(blocked.readContextSnapshot()).rejects.toThrow(/timed out|lock/i);
    expect(JSON.parse(await readFile(paths.lockPath, "utf8"))).toEqual(metadata);
    if (ownerKind === "live") expect(inspections).toBeGreaterThan(0);
    else expect(inspections).toBe(0);
  });

  test("validates caller records before cloning without invoking accessors", async () => {
    const stateRoot = await root();
    const store = createStore({ root: stateRoot, repository: repo });
    let getterCalls = 0;
    const event = {
      version: 1, repository: store.repositoryBinding, actionId: `action_${"1".repeat(32)}`,
      at: "2026-01-01T00:00:00.000Z", successorActionId: null, manifest: [],
    } as Record<string, unknown>;
    Object.defineProperty(event, "state", { enumerable: true, get: () => { getterCalls += 1; return "observed"; } });
    await expect(store.transact((tx) => {
      expect(() => tx.appendEvent(event as never)).toThrow(/accessor|data property/i);
    })).resolves.toBeUndefined();
    expect(getterCalls).toBe(0);

    for (const invalid of [
      { ...event, [Symbol("hidden")]: true },
      Object.defineProperty({ ...event, state: "observed" }, "hidden", { value: true, enumerable: false }),
      Object.assign(Object.create({ inherited: true }), { ...event, state: "observed" }),
    ]) {
      await expect(store.transact((tx) => { tx.appendEvent(invalid as never); })).rejects.toThrow();
    }
  });

  test("snapshots repository identity at construction and never exposes a mutable binding reference", async () => {
    const stateRoot = await root();
    const mutableRepo = { ...repo };
    const store = createStore({ root: stateRoot, repository: mutableRepo });
    const originalBinding = store.repositoryBinding;
    mutableRepo.owner = "changed";
    mutableRepo.canonicalUrl = "https://github.com/changed/repo";
    expect(() => { (store.repositoryBinding as { repositoryDigest: string }).repositoryDigest = "b".repeat(64); }).toThrow();
    expect(store.repositoryBinding).toEqual(originalBinding);
    await store.transact((tx) => { tx.initializeIfAbsent(); });
    expect((await store.readContextSnapshot()).cursor.repository).toEqual(originalBinding);
  });

  test("detects a candidate inode swap between lstat and descriptor open", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    await createStore({ root: stateRoot, repository: repo })
      .transact((tx) => { tx.initializeIfAbsent(); });
    const original = await readFile(paths.cursorPath);
    let swapped = false;
    const store = createStore({ root: stateRoot, repository: repo, dependencies: { fileSystem: {
      open: async (candidate, flags, mode) => {
        if (candidate === paths.cursorPath && !swapped && (flags & constants.O_ACCMODE) === constants.O_RDONLY) {
          swapped = true;
          await rename(candidate, `${candidate}.swapped`);
          await writeFile(candidate, original, { mode: 0o600 });
        }
        return open(candidate, flags, mode);
      },
    } } });
    await expect(store.readContextSnapshot()).rejects.toThrow(/identity|changed|inode/i);
  });

  test("detects a prepared replacement inode swap immediately before rename", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    let paused = false;
    const interrupted = createStore({ root: stateRoot, repository: repo, dependencies: {
      onFileSystemOperation: (operation) => {
        if (!paused && operation === "rename-target:cursor.json") { paused = true; throw new Error("pause before rename"); }
      },
    } });
    await expect(interrupted.transact((tx) => { tx.initializeIfAbsent(); })).rejects.toThrow("pause before rename");
    const intent = JSON.parse(await readFile(paths.transactionIntentPath, "utf8")) as {
      replacements: Array<{ target: string; temporary: string }>;
    };
    const temporary = path.join(paths.repositoryRoot,
      intent.replacements.find((entry) => entry.target === "cursor.json")!.temporary);
    const contents = await readFile(temporary);
    let temporaryLstats = 0;
    const recovery = createStore({ root: stateRoot, repository: repo, dependencies: { fileSystem: {
      lstat: async (candidate) => {
        if (candidate === temporary && ++temporaryLstats === 3) {
          await rename(candidate, `${candidate}.swapped`);
          await writeFile(candidate, contents, { mode: 0o600 });
        }
        return lstat(candidate);
      },
    } } });
    await expect(recovery.readContextSnapshot()).rejects.toThrow(/identity|changed|inode/i);
  });

  test("rejects malformed, unknown, oversized, and cross-repository files", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    await store.transact((tx) => { tx.initializeIfAbsent(); });
    const cursor = JSON.parse(await readFile(paths.cursorPath, "utf8"));
    await writeFile(paths.cursorPath, JSON.stringify({ ...cursor, unknown: true }));
    await expect(store.readContextSnapshot()).rejects.toThrow(/unknown/i);
    await writeFile(paths.cursorPath, JSON.stringify({ ...cursor, repository: { ...cursor.repository, repositoryDigest: "b".repeat(64) } }));
    await expect(store.readContextSnapshot()).rejects.toThrow(/repository/i);
    await writeFile(paths.cursorPath, "x".repeat(10_000_001));
    await expect(store.readContextSnapshot()).rejects.toThrow(/large|size/i);
  });

  test("a precomputed external wait does not hold the repository lock", async () => {
    const stateRoot = await root();
    const firstStore = createStore({ root: stateRoot, repository: repo, lockTimeoutMs: 2_000, lockPollMs: 5 });
    let monotonicCalls = 0;
    let sleepCalls = 0;
    let nowCalls = 0;
    let randomCalls = 0;
    let openCalls = 0;
    const secondStore = createStore({ root: stateRoot, repository: repo, lockTimeoutMs: 2_000,
      lockPollMs: 5, dependencies: {
        fileSystem: { open: async (candidate, flags, mode) => { openCalls += 1; return open(candidate, flags, mode); } },
        monotonicNow: () => monotonicCalls++ * 5,
        sleep: async () => { sleepCalls += 1; await new Promise((resolve) => setTimeout(resolve, 1)); },
        now: () => { nowCalls += 1; return "2026-01-01T00:00:00.000Z"; },
        randomId: () => `injected-${++randomCalls}`,
      } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = ["external-start"];
    const external = gate.then(() => { order.push("external-end"); return "prepared"; });
    await secondStore.transact(() => { order.push("short-transaction"); });
    expect(order).toEqual(["external-start", "short-transaction"]);
    release();
    const prepared = await external;
    await firstStore.transact(() => { order.push(prepared); });
    expect(order).toEqual(["external-start", "short-transaction", "external-end", "prepared"]);
    expect({ monotonicCalls, sleepCalls, nowCalls, randomCalls, openCalls })
      .toMatchObject({ sleepCalls: expect.any(Number), nowCalls: 1 });
    expect(monotonicCalls).toBeGreaterThan(0);
    expect(sleepCalls).toBe(0);
    expect(randomCalls).toBeGreaterThan(0);
    expect(openCalls).toBeGreaterThan(0);
  });

  test("never reads another repository state path", async () => {
    const stateRoot = await root();
    const otherRepo = parseRepositoryRef("owner/repo-extra", "github");
    const first = createStore({ root: stateRoot, repository: repo });
    const other = createStore({ root: stateRoot, repository: otherRepo });
    await first.transact((tx) => { tx.initializeIfAbsent(); tx.replaceCursor({ ...tx.snapshot.cursor, initialized: true, initializedEpoch: 1 }); });
    expect((await other.readContextSnapshot()).cursor.initialized).toBe(false);
  });

  test("rolls a large finding append into bounded immutable journal segments", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    const binding = store.repositoryBinding;
    await store.transact((tx) => {
      for (let index = 0; index < 205; index += 1) {
        tx.appendFinding({ version: 1, repository: binding,
          id: `finding_${index.toString(16).padStart(32, "0")}`, reviewNumber: 1, reviewId: "review-1",
          baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: "c".repeat(64),
          ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null,
          at: "2026-01-01T00:00:00.000Z" });
      }
    });
    const names = await readdir(paths.repositoryRoot);
    expect(names.filter((name) => /^findings\.segment\..+\.jsonl$/u.test(name)).length).toBeGreaterThan(1);
    expect(names.filter((name) => /^findings\.manifest\..+\.json$/u.test(name)).length).toBeGreaterThan(1);
    await expect(readFile(paths.findingsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.readContextSnapshot()).findings).toHaveLength(205);
  });

  test("reads many journal segments and fails closed for a missing referenced segment", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    const binding = store.repositoryBinding;
    for (let index = 0; index < 8; index += 1) {
      await store.transact((tx) => tx.appendFinding({ version: 1, repository: binding,
        id: `finding_${index.toString(16).padStart(32, "0")}`, reviewNumber: 1, reviewId: "review-1",
        baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: "c".repeat(64),
        ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null,
        at: "2026-01-01T00:00:00.000Z" }));
    }
    expect((await store.readContextSnapshot()).findings).toHaveLength(8);
    const head = JSON.parse(await readFile(paths.journalHeadPath, "utf8")) as {
      findings: { target: string };
    };
    const manifest = JSON.parse(await readFile(path.join(paths.repositoryRoot, head.findings.target), "utf8")) as {
      segment: { target: string };
    };
    await unlink(path.join(paths.repositoryRoot, manifest.segment.target));
    await expect(store.readContextSnapshot()).rejects.toThrow(/segment|missing|journal/i);
  });

  test("recovers all journal segments when rollover crashes before installing the checkpoint head", async () => {
    const stateRoot = await root();
    let interrupted = false;
    const store = createStore({ root: stateRoot, repository: repo, dependencies: {
      onFileSystemOperation: (operation) => {
        if (!interrupted && operation === "rename-target:journal-head.json") {
          interrupted = true;
          throw new Error("rollover crash");
        }
      },
    } });
    const binding = store.repositoryBinding;
    await expect(store.transact((tx) => {
      for (let index = 0; index < 101; index += 1) {
        tx.appendFinding({ version: 1, repository: binding,
          id: `finding_${index.toString(16).padStart(32, "0")}`, reviewNumber: 1, reviewId: "review-1",
          baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: "c".repeat(64),
          ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null,
          at: "2026-01-01T00:00:00.000Z" });
      }
    })).rejects.toThrow("rollover crash");
    expect((await createStore({ root: stateRoot, repository: repo }).readContextSnapshot()).findings)
      .toHaveLength(101);
  });

  test("retains every terminal action identity while checkpointing only whole recent summaries", async () => {
    const stateRoot = await root();
    const store = createStore({ root: stateRoot, repository: repo, dependencies: { indexLeafCapacity: 4 } });
    const binding = store.repositoryBinding;
    await store.transact((tx) => {
      for (let index = 0; index < 220; index += 1) {
        const actionId = `action_${index.toString(16).padStart(32, "0")}`;
        const identityDigest = index.toString(16).padStart(64, "0");
        for (const state of ["observed", "prepared", "manifest-ready", "published", "completed"] as const) {
          tx.appendEvent({ version: 1, repository: binding, actionId, identityDigest, reviewNumber: 1, state,
            at: "2026-01-01T00:00:00.000Z", successorActionId: null, manifest: [] });
        }
      }
      const actionId = `action_${"f".repeat(32)}`;
      tx.appendEvent({ version: 1, repository: binding, actionId, identityDigest: "f".repeat(64), reviewNumber: 1, state: "observed",
        at: "2026-01-01T00:00:00.000Z", successorActionId: null, manifest: [] });
      tx.appendEvent({ version: 1, repository: binding, actionId, identityDigest: "f".repeat(64), reviewNumber: 1, state: "prepared",
        at: "2026-01-01T00:00:00.000Z", successorActionId: null, manifest: [] });
    });
    const snapshot = await store.readContextSnapshot();
    expect(snapshot.events.map((entry) => entry.state)).toEqual(["observed", "prepared"]);
    expect(await store.findTerminalAction({ actionId: `action_${"0".repeat(32)}`, identityDigest: "0".repeat(64) }))
      .toMatchObject({ state: "completed" });
    expect(await store.findTerminalAction({ actionId: `action_${(219).toString(16).padStart(32, "0")}`,
      identityDigest: (219).toString(16).padStart(64, "0") })).toMatchObject({ state: "completed" });
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const head = JSON.parse(await readFile(paths.journalHeadPath, "utf8")) as {
      checkpoint: { terminalActions: unknown[] };
    };
    expect(head.checkpoint.terminalActions).toHaveLength(200);
    await expect(store.transact((tx) => tx.appendEvent({ version: 1, repository: binding,
      actionId: `action_${"0".repeat(32)}`, identityDigest: "0".repeat(64), reviewNumber: 1, state: "observed",
      at: "2026-01-01T00:00:00.000Z", successorActionId: null, manifest: [] })))
      .rejects.toThrow(/already terminal/i);
  }, 15_000);

  test("uses bounded persistent indexes for old memory and finding identities", async () => {
    const stateRoot = await root();
    const store = createStore({ root: stateRoot, repository: repo, dependencies: { indexLeafCapacity: 2 } });
    const binding = store.repositoryBinding;
    await store.transact((tx) => {
      for (let index = 0; index < 20; index += 1) {
        tx.appendMemory({ version: 1, repository: binding, operation: "create",
          id: `memory_${index.toString(16).padStart(32, "0")}`, text: `memory ${index}`, attribution: "test",
          source: "unit", at: "2026-01-01T00:00:00.000Z" });
        tx.appendFinding({ version: 1, repository: binding, id: `finding_${index.toString(16).padStart(32, "0")}`,
          reviewNumber: 1, reviewId: "review-1", baseSha: "a".repeat(40), headSha: "b".repeat(40),
          contentDigest: index.toString(16).padStart(64, "0"), ruleDigest: "d".repeat(64), ruleSnapshot: "rule",
          placement: null, at: "2026-01-01T00:00:00.000Z" });
      }
    });
    expect(await store.findMemory(`memory_${"0".repeat(32)}`)).toMatchObject({ status: "active" });
    expect(await store.findMemory(`memory_${(19).toString(16).padStart(32, "0")}`)).toMatchObject({ status: "active" });
    expect(await store.findFinding(`finding_${"0".repeat(32)}`)).toMatchObject({ reviewId: "review-1" });
    expect(await store.findFinding(`finding_${(19).toString(16).padStart(32, "0")}`))
      .toMatchObject({ contentDigest: (19).toString(16).padStart(64, "0") });
  });

  test("isolates corruption to the requested persistent-index branch", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo, dependencies: { indexLeafCapacity: 1 } });
    const binding = store.repositoryBinding;
    await store.transact((tx) => {
      for (let index = 0; index < 16; index += 1) tx.appendFinding({ version: 1, repository: binding,
        id: `finding_${index.toString(16).padStart(32, "0")}`, reviewNumber: 1, reviewId: "review-1",
        baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: index.toString(16).padStart(64, "0"),
        ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null, at: "2026-01-01T00:00:00.000Z" });
    });
    const head = JSON.parse(await readFile(paths.journalHeadPath, "utf8")) as {
      checkpoint: { findingIndex: { target: string } };
    };
    const rootNode = JSON.parse(await readFile(path.join(paths.repositoryRoot, head.checkpoint.findingIndex.target), "utf8")) as {
      children: Array<{ digit: string; reference: { target: string } }>;
    };
    const corrupt = rootNode.children[0]!;
    await writeFile(path.join(paths.repositoryRoot, corrupt.reference.target), "corrupt\n");
    const digit = (id: string) => createHash("sha256").update(id).digest("hex")[0];
    const requested = Array.from({ length: 16 }, (_, index) => `finding_${index.toString(16).padStart(32, "0")}`)
      .find((id) => digit(id) === corrupt.digit)!;
    const unaffected = Array.from({ length: 16 }, (_, index) => `finding_${index.toString(16).padStart(32, "0")}`)
      .find((id) => digit(id) !== corrupt.digit)!;
    await expect(store.readContextSnapshot()).resolves.toMatchObject({ findings: expect.any(Array) });
    await expect(store.findFinding(unaffected)).resolves.toMatchObject({ id: unaffected });
    await expect(store.findFinding(requested)).rejects.toThrow(/index node|corrupt|missing/i);
  });

  test("audit pages validate event fragments without requiring an observed record in each segment", async () => {
    const stateRoot = await root();
    const store = createStore({ root: stateRoot, repository: repo });
    const binding = store.repositoryBinding;
    const actionId = `action_${"9".repeat(32)}`;
    for (const state of ["observed", "prepared", "manifest-ready", "published", "completed"] as const) {
      await store.transact((tx) => tx.appendEvent({ version: 1, repository: binding, actionId,
        identityDigest: "9".repeat(64), reviewNumber: 1, state, at: "2026-01-01T00:00:00.000Z", successorActionId: null,
        manifest: [] }));
    }
    let cursor = null as Awaited<ReturnType<typeof store.readAuditPage>>["nextCursor"];
    const states: string[] = [];
    do {
      const page = await store.readAuditPage("events", cursor, 1);
      states.push(...(page.entries as Array<{ state: string }>).map((entry) => entry.state));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(states).toEqual(["completed", "published", "manifest-ready", "prepared", "observed"]);
    await expect(store.transact((tx) => tx.appendEvent({ version: 1, repository: binding,
      actionId: `action_${"8".repeat(32)}`, identityDigest: "8".repeat(64), reviewNumber: 1, state: "published",
      at: "2026-01-01T00:00:00.000Z", successorActionId: null, manifest: [] }))).rejects.toThrow(/first state|transition/i);
  });

  test("rejects a referenced journal segment whose digest is corrupt", async () => {
    const stateRoot = await root();
    const paths = deriveConversationStatePaths(stateRoot, repo);
    const store = createStore({ root: stateRoot, repository: repo });
    const binding = store.repositoryBinding;
    await store.transact((tx) => tx.appendFinding({ version: 1, repository: binding,
      id: `finding_${"e".repeat(32)}`, reviewNumber: 1, reviewId: "review-1",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: "c".repeat(64),
      ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null,
      at: "2026-01-01T00:00:00.000Z" }));
    const head = JSON.parse(await readFile(paths.journalHeadPath, "utf8")) as { findings: { target: string } };
    const manifestPath = path.join(paths.repositoryRoot, head.findings.target);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { segment: { target: string } };
    const segmentPath = path.join(paths.repositoryRoot, manifest.segment.target);
    const contents = await readFile(segmentPath);
    contents[0] = contents[0] === 0x7b ? 0x5b : 0x7b;
    await writeFile(segmentPath, contents);
    await expect(store.readContextSnapshot()).rejects.toThrow(/segment|digest|corrupt/i);
  });

  test("keeps hot-path reads bounded and pages old audit segments explicitly", async () => {
    const stateRoot = await root();
    const writer = createStore({ root: stateRoot, repository: repo });
    const binding = writer.repositoryBinding;
    for (let index = 0; index < 40; index += 1) {
      await writer.transact((tx) => tx.appendFinding({ version: 1, repository: binding,
        id: `finding_${index.toString(16).padStart(32, "0")}`, reviewNumber: 1, reviewId: "review-1",
        baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: "c".repeat(64),
        ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null,
        at: "2026-01-01T00:00:00.000Z" }));
    }
    let readOpens = 0;
    const observed = createStore({ root: stateRoot, repository: repo, dependencies: { fileSystem: {
      open: async (candidate, flags, mode) => {
        if ((flags & constants.O_ACCMODE) === constants.O_RDONLY &&
          /(?:journal-head|findings\.(?:manifest|segment))/u.test(candidate)) readOpens += 1;
        return open(candidate, flags, mode);
      },
    } } });
    expect((await observed.readContextSnapshot()).findings).toHaveLength(40);
    expect(readOpens).toBeLessThanOrEqual(3);
    readOpens = 0;
    await observed.transact((tx) => tx.appendFinding({ version: 1, repository: binding,
      id: `finding_${"f".repeat(32)}`, reviewNumber: 1, reviewId: "review-1",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), contentDigest: "e".repeat(64),
      ruleDigest: "d".repeat(64), ruleSnapshot: "rule", placement: null,
      at: "2026-01-01T00:00:00.000Z" }));
    expect(readOpens).toBeLessThanOrEqual(25);

    const newest = await observed.readAuditPage("findings", null, 1);
    expect(newest.entries).toHaveLength(1);
    expect(newest.nextCursor).not.toBeNull();
    const older = await observed.readAuditPage("findings", newest.nextCursor, 1);
    expect(older.entries).toHaveLength(1);
    const olderManifestPath = path.join(
      deriveConversationStatePaths(stateRoot, repo).repositoryRoot, newest.nextCursor!.manifest.target,
    );
    const olderManifest = JSON.parse(await readFile(olderManifestPath, "utf8")) as { segment: { target: string } };
    await writeFile(path.join(path.dirname(olderManifestPath), olderManifest.segment.target), "corrupt\n");
    expect((await observed.readContextSnapshot()).findings).toHaveLength(41);
    await expect(observed.readAuditPage("findings", newest.nextCursor, 1)).rejects.toThrow(/audit|segment|corrupt/i);
  }, 20_000);
});
