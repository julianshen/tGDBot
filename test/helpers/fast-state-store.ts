// Issue #103: the volume-heavy poll fixtures are wall-clocked by fsync, not by
// the logic they exist to check. A 1100-event fixture spent most of two minutes
// in platter flushes, so its result depended on what else the machine was
// doing — 60s alone, 97s busy, past its ceiling with one concurrent vitest.
//
// This factory is the durability seam the issue asked for, built from two that
// already existed: PollDependencies.createStateStore and the store's own
// `dependencies.fileSystem`. It substitutes ONLY `sync()` — the platter flush.
// Reads, writes, renames, permission and identity validation all run against
// the real filesystem, so the fixture exercises the same code paths and sees
// the same bytes; it merely stops waiting for the disk to confirm each one.
//
// The constraint that keeps this seam safe: durability itself has dedicated
// tests, and they do NOT use this factory. If a test asserts something about
// fsync ordering, crash recovery across a flush boundary, or what survives a
// power cut, it must construct the real store. If you find yourself reaching
// for this helper to make such a test pass, the helper is the bug.
import { open as realOpen } from "node:fs/promises";
import {
  createConversationStateStore,
  type ConcreteConversationStateStore,
  type ConversationStateFileHandle,
  type ConversationStateStoreOptions,
} from "../../src/conversation/state-store.js";

function withoutFlush(handle: Awaited<ReturnType<typeof realOpen>>): ConversationStateFileHandle {
  return {
    stat: () => handle.stat(),
    readFile: () => handle.readFile(),
    writeFile: (data) => handle.writeFile(data),
    // The substitution. Everything else on this handle is real.
    sync: () => Promise.resolve(),
    close: () => handle.close(),
  };
}

export function createFastConversationStateStore(
  options: ConversationStateStoreOptions,
): ConcreteConversationStateStore {
  return createConversationStateStore({
    ...options,
    dependencies: {
      ...options.dependencies,
      fileSystem: {
        ...options.dependencies?.fileSystem,
        open: async (filePath, flags, mode) =>
          withoutFlush(await realOpen(filePath, flags, mode)),
      },
    },
  });
}
