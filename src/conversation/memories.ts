// Pure repository-local memory operations. Nothing here touches the provider,
// the filesystem, or a model: callers hand in the active memory snapshot and a
// deterministic action identity, and get back the exact ledger entry to append.
import { createHash } from "node:crypto";
import { encodePublicId } from "./public-id.js";
import { MAX_ACTIVE_MEMORIES as ACTIVE_CEILING, materializeMemories } from "./state-schema.js";
import type { MemoryCreateEntry, MemoryEntry, MemoryTombstoneEntry } from "./state-schema.js";
import type { RepositoryBinding } from "./types.js";

/**
 * Reaching the ceiling is a terminal refusal, not a queue: the commenter frees
 * space with `forget` and issues a new `remember`. Retrying the refused event
 * must never later succeed.
 */
export { MAX_ACTIVE_MEMORIES } from "./state-schema.js";

export interface RememberInput {
  readonly binding: RepositoryBinding;
  readonly actionId: string;
  readonly lesson: string;
  readonly attribution: string;
  readonly source: string;
  readonly at: string;
  readonly activeMemories: readonly MemoryCreateEntry[];
}

export type RememberPlan =
  | { readonly kind: "created"; readonly entry: MemoryCreateEntry }
  | { readonly kind: "already-created"; readonly entry: MemoryCreateEntry }
  | { readonly kind: "at-capacity"; readonly limit: number };

/**
 * Derived from the action identity rather than the text, so a retry after a
 * crash recomputes the same ID and recognises its own earlier write instead of
 * creating a second memory.
 */
function memoryLedgerId(binding: RepositoryBinding, actionId: string): string {
  const digest = createHash("sha256")
    .update("tgd:memory:v1\0", "utf8")
    .update(binding.repositoryDigest)
    .update("\0")
    .update(actionId)
    .digest("hex");
  return `memory_${digest.slice(0, 32)}`;
}

export const MEMORY_PUBLIC_ID_LENGTH = 26;

/**
 * Stable, one-way mapping from a ledger key to the `mem_` ID shown in listings
 * and accepted by `forget`. Resolution scans the ledger for a matching encoding
 * rather than decoding, so an ID from another repository simply fails to match.
 */
export function encodeMemoryPublicId(ledgerId: string): string {
  const digest = createHash("sha256")
    .update("tgd:memory-public:v1\0", "utf8")
    .update(ledgerId)
    .digest();
  return encodePublicId("mem", digest, MEMORY_PUBLIC_ID_LENGTH);
}

export function planRemember(input: RememberInput): RememberPlan {
  const id = memoryLedgerId(input.binding, input.actionId);
  const existing = input.activeMemories.find((memory) => memory.id === id);
  // Before the capacity check: a retry of a create that already landed is its
  // own completed work, not a new lesson competing for the last slot.
  if (existing !== undefined) return { kind: "already-created", entry: existing };
  if (input.activeMemories.length >= ACTIVE_CEILING) {
    return { kind: "at-capacity", limit: ACTIVE_CEILING };
  }
  return {
    kind: "created",
    entry: {
      version: 1,
      repository: input.binding,
      operation: "create",
      id,
      text: input.lesson,
      attribution: input.attribution,
      source: input.source,
      at: input.at,
    },
  };
}

export interface MemoryListItem {
  readonly publicId: string;
  readonly text: string;
  readonly attribution: string;
  readonly at: string;
}

/**
 * Active memories only, in ledger order. Contradictory lessons are both
 * returned: tGDBot surfaces conflicts for a human to resolve with `forget`
 * rather than picking a winner. Rendering/escaping belongs to render.ts.
 */
export function listMemories(ledger: readonly MemoryEntry[]): readonly MemoryListItem[] {
  return materializeMemories(ledger).map((memory) => ({
    publicId: encodeMemoryPublicId(memory.id),
    text: memory.text,
    attribution: memory.attribution,
    at: memory.at,
  }));
}

export interface ForgetInput {
  readonly binding: RepositoryBinding;
  readonly actionId: string;
  readonly publicId: string;
  readonly at: string;
  readonly ledger: readonly MemoryEntry[];
}

export type ForgetPlan =
  | { readonly kind: "tombstoned"; readonly entry: MemoryTombstoneEntry }
  | { readonly kind: "already-tombstoned"; readonly entry: MemoryTombstoneEntry }
  | { readonly kind: "not-found" };

/**
 * The tombstone carries the acting command's identity, which is what lets a
 * retry tell "I already did this" apart from "no such memory". Both look like
 * an absent active memory otherwise, and answering `not-found` the second time
 * would give one event two different public answers.
 */
function forgetReason(actionId: string): string {
  return `forget by ${actionId}`;
}

export function planForget(input: ForgetInput): ForgetPlan {
  const reason = forgetReason(input.actionId);
  const mine = input.ledger.find(
    (entry): entry is MemoryTombstoneEntry => entry.operation === "tombstone" && entry.reason === reason,
  );
  if (mine !== undefined) return { kind: "already-tombstoned", entry: mine };

  const active = materializeMemories(input.ledger);
  const target = active.find((memory) => encodeMemoryPublicId(memory.id) === input.publicId);
  // Identical answer for a never-existent ID, a tombstoned one, and one that
  // belongs to another repository: the response must not confirm existence.
  if (target === undefined) return { kind: "not-found" };
  return {
    kind: "tombstoned",
    entry: {
      version: 1,
      repository: input.binding,
      operation: "tombstone",
      id: target.id,
      reason,
      at: input.at,
    },
  };
}

