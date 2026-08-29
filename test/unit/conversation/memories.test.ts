import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_MEMORIES,
  encodeMemoryPublicId,
  listMemories,
  planForget,
  planRemember,
} from "../../../src/conversation/memories.js";
import type { MemoryCreateEntry } from "../../../src/conversation/state-schema.js";
import type { RepositoryBinding } from "../../../src/conversation/types.js";

const binding: RepositoryBinding = {
  provider: "github",
  repositoryDigest: "a".repeat(64),
};

const base = {
  binding,
  actionId: `action_${"1".repeat(32)}`,
  attribution: "octocat",
  source: "https://github.com/owner/repo/pull/42#issuecomment-1",
  at: "2026-08-14T00:00:00.000Z",
  activeMemories: [],
};

function activeMemories(count: number): readonly MemoryCreateEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    version: 1 as const,
    repository: binding,
    operation: "create" as const,
    id: `memory_${index.toString(16).padStart(32, "0")}`,
    text: `lesson ${index}`,
    attribution: "octocat",
    source: base.source,
    at: "2026-08-13T00:00:00.000Z",
  }));
}

describe("planRemember", () => {
  it("creates an append-only entry bound to the repository with the lesson as its text", () => {
    const plan = planRemember({ ...base, lesson: "prefer explicit null checks" });

    expect(plan.kind).toBe("created");
    if (plan.kind !== "created") throw new Error("expected created");
    expect(plan.entry).toMatchObject({
      version: 1,
      repository: binding,
      operation: "create",
      text: "prefer explicit null checks",
      attribution: "octocat",
      at: "2026-08-14T00:00:00.000Z",
    });
  });

  // The crash window: the memory was durably appended but the acknowledgement
  // never posted. The retry must recognise its own earlier write and report it
  // as already applied, so the reply is published once and the memory once.
  it("reports an already-applied create when the retry sees its own earlier entry", () => {
    const first = planRemember({ ...base, lesson: "prefer explicit null checks" });
    if (first.kind !== "created") throw new Error("expected created");

    const retry = planRemember({
      ...base,
      lesson: "prefer explicit null checks",
      activeMemories: [first.entry],
    });

    expect(retry.kind).toBe("already-created");
    if (retry.kind !== "already-created") throw new Error("expected already-created");
    expect(retry.entry.id).toBe(first.entry.id);
  });

  it("refuses a new lesson once the active memory ceiling is reached", () => {
    const plan = planRemember({
      ...base,
      lesson: "one lesson too many",
      activeMemories: activeMemories(MAX_ACTIVE_MEMORIES),
    });

    expect(plan.kind).toBe("at-capacity");
  });

  // Ordering matters: a crash-retry of a create that already succeeded must
  // still be recognised as its own write, even though the store is now full.
  // Checking capacity first would turn a completed remember into a refusal.
  it("still reports an already-applied create at capacity", () => {
    const mine = planRemember({ ...base, lesson: "prefer explicit null checks" });
    if (mine.kind !== "created") throw new Error("expected created");

    const retry = planRemember({
      ...base,
      lesson: "prefer explicit null checks",
      activeMemories: [mine.entry, ...activeMemories(MAX_ACTIVE_MEMORIES)],
    });

    expect(retry.kind).toBe("already-created");
  });
});

describe("planForget", () => {
  it("tombstones the memory whose public id was named", () => {
    const created = planRemember({ ...base, lesson: "prefer explicit null checks" });
    if (created.kind !== "created") throw new Error("expected created");

    const plan = planForget({
      binding,
      actionId: `action_${"2".repeat(32)}`,
      publicId: encodeMemoryPublicId(created.entry.id),
      at: "2026-08-14T01:00:00.000Z",
      ledger: [created.entry],
    });

    expect(plan.kind).toBe("tombstoned");
    if (plan.kind !== "tombstoned") throw new Error("expected tombstoned");
    expect(plan.entry).toMatchObject({
      version: 1,
      repository: binding,
      operation: "tombstone",
      id: created.entry.id,
      at: "2026-08-14T01:00:00.000Z",
    });
  });

  // Same crash window as remember, but the failure mode is worse: the memory is
  // already gone, so a naive retry reports "not found" and the one event yields
  // two different answers. It has to recognise its own tombstone.
  it("reports an already-applied forget when the retry sees its own tombstone", () => {
    const created = planRemember({ ...base, lesson: "prefer explicit null checks" });
    if (created.kind !== "created") throw new Error("expected created");
    const forgetInput = {
      binding,
      actionId: `action_${"2".repeat(32)}`,
      publicId: encodeMemoryPublicId(created.entry.id),
      at: "2026-08-14T01:00:00.000Z",
      ledger: [created.entry],
    };
    const first = planForget(forgetInput);
    if (first.kind !== "tombstoned") throw new Error("expected tombstoned");

    const retry = planForget({ ...forgetInput, ledger: [created.entry, first.entry] });

    expect(retry.kind).toBe("already-tombstoned");
  });

  it("gives an unknown id the same answer as one from another repository", () => {
    const unknown = planForget({
      binding,
      actionId: `action_${"3".repeat(32)}`,
      publicId: encodeMemoryPublicId(`memory_${"9".repeat(32)}`),
      at: "2026-08-14T01:00:00.000Z",
      ledger: [],
    });

    expect(unknown.kind).toBe("not-found");
  });
});

describe("listMemories", () => {
  it("lists only active memories, by public id", () => {
    const kept = planRemember({ ...base, lesson: "kept lesson" });
    const dropped = planRemember({
      ...base,
      actionId: `action_${"7".repeat(32)}`,
      lesson: "dropped lesson",
    });
    if (kept.kind !== "created" || dropped.kind !== "created") throw new Error("expected creates");
    const forgotten = planForget({
      binding,
      actionId: `action_${"8".repeat(32)}`,
      publicId: encodeMemoryPublicId(dropped.entry.id),
      at: "2026-08-14T02:00:00.000Z",
      ledger: [kept.entry, dropped.entry],
    });
    if (forgotten.kind !== "tombstoned") throw new Error("expected tombstoned");

    const listed = listMemories([kept.entry, dropped.entry, forgotten.entry]);

    expect(listed).toEqual([
      {
        publicId: encodeMemoryPublicId(kept.entry.id),
        text: "kept lesson",
        attribution: "octocat",
        at: "2026-08-14T00:00:00.000Z",
      },
    ]);
  });

  // Two commenters can record contradictory lessons. The spec is explicit that
  // conflicts are surfaced, never silently reconciled, so both must survive.
  it("preserves contradictory lessons rather than reconciling them", () => {
    const first = planRemember({ ...base, lesson: "always inline small helpers" });
    const second = planRemember({
      ...base,
      actionId: `action_${"5".repeat(32)}`,
      lesson: "never inline small helpers",
    });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");

    const listed = listMemories([first.entry, second.entry]);

    expect(listed.map((item) => item.text)).toEqual([
      "always inline small helpers",
      "never inline small helpers",
    ]);
  });
});
