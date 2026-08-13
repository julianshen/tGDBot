import { describe, expect, test } from "vitest";
import {
  materializeMemories,
  validateCursorSnapshot,
  validateEventEntries,
  validateMemoryEntries,
  validatePendingSnapshot,
  validateTransactionIntent,
} from "../../../src/conversation/state-schema.js";
import { formatChildMarker } from "../../../src/conversation/markers.js";

const digest = "a".repeat(64);
const binding = { provider: "github" as const, repositoryDigest: digest };
const cursor = {
  version: 1 as const,
  repository: binding,
  initialized: true,
  initializedEpoch: 1,
  openReviewScanPosition: null,
  nextRoundRobinKey: null,
  reviews: [],
};

describe("strict state schemas", () => {
  test("accepts a bounded version-1 cursor and rejects unknown schemas and bindings", () => {
    expect(validateCursorSnapshot(cursor, binding)).toEqual(cursor);
    expect(() => validateCursorSnapshot({ ...cursor, version: 2 }, binding)).toThrow(/version/i);
    expect(() => validateCursorSnapshot({ ...cursor, repository: { ...binding, repositoryDigest: "b".repeat(64) } }, binding))
      .toThrow(/repository/i);
    expect(() => validateCursorSnapshot({ ...cursor, extra: true }, binding)).toThrow(/unknown|property/i);
    expect(() => validateCursorSnapshot({ ...cursor, initialized: false, initializedEpoch: 1 }, binding))
      .toThrow(/initialized|epoch/i);
  });

  test("rejects accessors, symbols, and non-plain prototypes before reading properties", () => {
    const accessor = { ...cursor } as Record<string, unknown>;
    Object.defineProperty(accessor, "initialized", { enumerable: true, get: () => true });
    expect(() => validateCursorSnapshot(accessor, binding)).toThrow(/accessor|data property/i);
    const symbol = { ...cursor, [Symbol("hidden")]: true };
    expect(() => validateCursorSnapshot(symbol, binding)).toThrow(/symbol/i);
    expect(() => validateCursorSnapshot(Object.assign(Object.create({ inherited: true }), cursor), binding))
      .toThrow(/prototype/i);
  });

  test("validates pending head-bound directions with bounded text", () => {
    const pending = { version: 1, repository: binding, clarifications: [], directions: [{
      id: `clarification_${"1".repeat(32)}`, reviewNumber: 7, headSha: "f".repeat(40),
      text: "Use the compatibility path", createdAt: "2026-01-01T00:00:00.000Z",
    }] };
    expect(validatePendingSnapshot(pending, binding)).toEqual(pending);
    expect(() => validatePendingSnapshot({ ...pending, directions: [{ ...pending.directions[0], text: "x".repeat(20_001) }] }, binding))
      .toThrow(/large|length|text/i);
  });

  test("validates exact repository-bound transaction intents without traversal", () => {
    const intent = { version: 1, repository: binding, transactionId: "tx-1", replacements: [{
      target: "cursor.json", temporary: ".cursor.json.tx-1.tmp", sha256: digest, bytes: 42,
    }] };
    expect(validateTransactionIntent(intent, binding)).toEqual(intent);
    expect(() => validateTransactionIntent({ ...intent, replacements: [{
      ...intent.replacements[0], temporary: "../cursor.json",
    }] }, binding)).toThrow(/temporary|path|basename/i);
    expect(() => validateTransactionIntent({ ...intent, replacements: [
      intent.replacements[0], intent.replacements[0],
    ] }, binding)).toThrow(/duplicate/i);
  });

  test("rejects every noncanonical or out-of-range own key on schema arrays", () => {
    const keyed = <T>(values: T[], key: string): T[] => {
      Object.defineProperty(values, key, { value: null, enumerable: true, configurable: true });
      return values;
    };
    const eventBase = {
      version: 1, repository: binding, actionId: `action_${"5".repeat(32)}`, identityDigest: "5".repeat(64), reviewNumber: 1, state: "observed",
      at: "2026-01-01T00:00:00.000Z", successorActionId: null,
    };
    const invalidArrays: Array<() => unknown> = [
      () => validateCursorSnapshot({ ...cursor, reviews: keyed([], "01") }, binding),
      () => validatePendingSnapshot({ version: 1, repository: binding,
        clarifications: keyed([], "-0"), directions: [] }, binding),
      () => validatePendingSnapshot({ version: 1, repository: binding,
        clarifications: [], directions: keyed([], "1") }, binding),
      () => validateEventEntries(keyed([], "1.0"), binding),
      () => validateEventEntries([{ ...eventBase, manifest: keyed([], "4294967295") }], binding),
      () => validateMemoryEntries(keyed([], "01"), binding),
    ];
    for (const validate of invalidArrays) expect(validate).toThrow(/array|element|key|exact|canonical/i);
  });
});

describe("ledger invariants", () => {
  test("requires an immutable action identity digest from the first event", () => {
    const base = { version: 1, repository: binding, actionId: `action_${"1".repeat(32)}`, reviewNumber: 1, at: "2026-01-01T00:00:00.000Z", state: "observed", successorActionId: null, manifest: [] };
    expect(() => validateEventEntries([base], binding)).toThrow(/identityDigest/);
    expect(() => validateEventEntries([{ ...base, identityDigest: "1".repeat(64) }, { ...base, identityDigest: "2".repeat(64), state: "prepared" }], binding)).toThrow(/identity digest/i);
  });

  test("rejects impossible action transitions and duplicate immutable manifest children", () => {
    const base = { version: 1, repository: binding, actionId: `action_${"1".repeat(32)}`, identityDigest: "1".repeat(64), reviewNumber: 1, at: "2026-01-01T00:00:00.000Z" };
    expect(() => validateEventEntries([
      { ...base, state: "published", successorActionId: null, manifest: [] },
    ], binding)).toThrow(/transition/i);
    expect(() => validateEventEntries([
      { ...base, state: "observed", successorActionId: null, manifest: [] },
      { ...base, state: "superseded", successorActionId: base.actionId, manifest: [] },
    ], binding)).toThrow(/successor|itself/i);
    const child = { id: `output_${"3".repeat(32)}`, kind: "finding", placement: null, bodyDigest: digest,
      marker: formatChildMarker({ kind: "finding", parentId: `act_${"1".repeat(32)}`, childId: `finding_${"3".repeat(32)}`, repositoryDigest: digest, reviewNumber: 1, contentDigest: digest }) };
    expect(() => validateEventEntries([
      { ...base, state: "observed", successorActionId: null, manifest: [] },
      { ...base, state: "prepared", successorActionId: null, manifest: [] },
      { ...base, state: "manifest-ready", successorActionId: null, manifest: [{ ...child, status: "prepared" }] },
      { ...base, state: "published", successorActionId: null, manifest: [{ ...child, status: "published" }] },
      { ...base, state: "superseded", successorActionId: `action_${"4".repeat(32)}`,
        manifest: [{ ...child, status: "prepared" }] },
    ], binding)).toThrow(/status|transition/i);
    expect(() => validateEventEntries([
      { ...base, state: "observed", successorActionId: null, manifest: [] },
      { ...base, state: "prepared", successorActionId: null, manifest: [] },
      { ...base, state: "manifest-ready", successorActionId: null, manifest: [
        { id: `output_${"2".repeat(32)}`, kind: "finding", status: "prepared", placement: null, bodyDigest: digest, marker: formatChildMarker({ kind: "finding", parentId: `act_${"1".repeat(32)}`, childId: `finding_${"2".repeat(32)}`, repositoryDigest: digest, reviewNumber: 1, contentDigest: digest }) },
        { id: `output_${"2".repeat(32)}`, kind: "finding", status: "prepared", placement: null, bodyDigest: digest, marker: formatChildMarker({ kind: "finding", parentId: `act_${"1".repeat(32)}`, childId: `finding_${"2".repeat(32)}`, repositoryDigest: digest, reviewNumber: 1, contentDigest: digest }) },
      ] },
    ], binding)).toThrow(/duplicate/i);
  });

  test("materializes create/tombstone memory entries and enforces capacity", () => {
    const create = (index: number) => ({
      version: 1, repository: binding, operation: "create", id: `memory_${index.toString(16).padStart(32, "0")}`,
      text: `memory ${index}`, attribution: "reviewer", source: "review", at: "2026-01-01T00:00:00.000Z",
    });
    expect(materializeMemories(validateMemoryEntries([create(1), {
      version: 1, repository: binding, operation: "tombstone", id: `memory_${"0".repeat(31)}1`,
      reason: "obsolete", at: "2026-01-02T00:00:00.000Z",
    }], binding))).toEqual([]);
    expect(() => validateMemoryEntries([{ ...create(1), text: " unnormalized " }], binding)).toThrow(/normalized/i);
    expect(() => materializeMemories(validateMemoryEntries(Array.from({ length: 201 }, (_, index) => create(index + 1)), binding)))
      .toThrow(/200|capacity/i);
  });
});
