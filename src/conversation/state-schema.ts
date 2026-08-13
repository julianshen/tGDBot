import type { BotIdentity, ConversationPlacement, RepositoryBinding } from "./types.js";
import { parseChildMarker } from "./markers.js";

const DIGEST_RE = /^[0-9a-f]{64}$/u;
const SHA_RE = /^[0-9a-f]{7,64}$/iu;
const ID_RE = /^(?:action|output|finding|clarification|memory)_[0-9a-f]{32}$/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_COLLECTION = 10_000;
const MAX_TEXT = 20_000;
const MAX_STATE_FILE_BYTES = 10_000_000;

export interface ReviewCursorRecord {
  readonly reviewNumber: number;
  readonly cursor: string | null;
  readonly retired: boolean;
  readonly retiredAt?: string;
}

export interface ConversationCursorSnapshot {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly initialized: boolean;
  readonly initializedEpoch: number;
  readonly openReviewScanPosition: string | null;
  readonly nextRoundRobinKey: string | null;
  readonly reviews: readonly ReviewCursorRecord[];
}

export interface PendingClarification {
  readonly id: string;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly question: string;
  readonly createdAt: string;
}

export interface PendingDirection {
  readonly id: string;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface ConversationPendingSnapshot {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly clarifications: readonly PendingClarification[];
  readonly directions: readonly PendingDirection[];
}

export type ActionState = "observed" | "prepared" | "manifest-ready" | "published" | "completed" | "superseded";
export type PublicationStatus = "prepared" | "published" | "completed";

export interface PublicationManifestChild {
  readonly id: string;
  readonly kind: "action" | "finding" | "clarification";
  readonly status: PublicationStatus;
  readonly placement: ConversationPlacement | null;
  readonly bodyDigest: string;
  readonly marker: string;
  readonly identity?: BotIdentity;
}

export interface ConversationEventEntry {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly actionId: string;
  readonly state: ActionState;
  readonly at: string;
  readonly successorActionId: string | null;
  readonly manifest: readonly PublicationManifestChild[];
  readonly identityDigest: string;
  readonly reviewNumber: number;
}

export interface TerminalActionSummary {
  readonly key: string;
  readonly actionId: string;
  readonly identityDigest: string;
  readonly state: "completed" | "superseded";
  readonly successorActionId: string | null;
  readonly at: string;
  readonly manifestDigest: string;
  readonly reconciliationDigest: string;
}

export interface MemoryIndexSummary {
  readonly key: string;
  readonly id: string;
  readonly status: "active" | "tombstoned";
  readonly entryDigest: string;
  readonly at: string;
}

export interface FindingIndexSummary {
  readonly key: string;
  readonly id: string;
  readonly contentDigest: string;
  readonly reviewNumber: number;
  readonly reviewId: string;
  readonly bindingDigest: string;
}

export type PersistentIndexKind = "terminal-actions" | "memories" | "findings";
export type PersistentIndexValue = TerminalActionSummary | MemoryIndexSummary | FindingIndexSummary;

export interface PersistentIndexNode {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly kind: PersistentIndexKind;
  readonly prefix: string;
  readonly entries?: readonly PersistentIndexValue[];
  readonly children?: readonly { readonly digit: string; readonly reference: JournalFileReference }[];
}

export interface MemoryCreateEntry {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly operation: "create";
  readonly id: string;
  readonly text: string;
  readonly attribution: string;
  readonly source: string;
  readonly at: string;
}

export interface MemoryTombstoneEntry {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly operation: "tombstone";
  readonly id: string;
  readonly reason: string;
  readonly at: string;
}

export type MemoryEntry = MemoryCreateEntry | MemoryTombstoneEntry;

export interface FindingLedgerEntry {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly id: string;
  readonly reviewNumber: number;
  readonly reviewId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly contentDigest: string;
  readonly ruleDigest: string;
  readonly ruleSnapshot: string;
  readonly placement: ConversationPlacement | null;
  readonly identity?: BotIdentity;
  readonly at: string;
}

export type JournalKind = "events" | "memories" | "findings";
export type ConversationStateTarget = string;

export interface JournalFileReference {
  readonly target: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface JournalSegmentReference extends JournalFileReference {
  readonly records: number;
}

export interface ConversationJournalManifestNode {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly kind: JournalKind;
  readonly id: string;
  readonly segment: JournalSegmentReference;
  readonly previous: JournalFileReference | null;
}

export interface ConversationJournalHead {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly events: JournalFileReference | null;
  readonly memories: JournalFileReference | null;
  readonly findings: JournalFileReference | null;
  readonly checkpoint: {
    readonly events: readonly ConversationEventEntry[];
    readonly terminalActions: readonly TerminalActionSummary[];
    readonly terminalActionIndex: JournalFileReference | null;
    readonly memories: readonly MemoryEntry[];
    readonly memoryIndex: JournalFileReference | null;
    readonly findings: readonly FindingLedgerEntry[];
    readonly findingIndex: JournalFileReference | null;
  };
}

export interface ConversationTransactionReplacement {
  readonly target: ConversationStateTarget;
  readonly temporary: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ConversationTransactionIntent {
  readonly version: 1;
  readonly repository: RepositoryBinding;
  readonly transactionId: string;
  readonly replacements: readonly ConversationTransactionReplacement[];
}

function journalId(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function journalTarget(value: unknown, name: string, kind?: JournalKind, fileKind?: "segment" | "manifest"): string {
  const result = text(value, name, 512);
  if (pathLike(result)) throw new Error(`${name} must be a basename`);
  if (kind !== undefined && fileKind !== undefined &&
    !new RegExp(`^${kind}\\.${fileKind}\\.[A-Za-z0-9_-]+\\.${fileKind === "segment" ? "jsonl" : "json"}$`, "u").test(result)) {
    throw new Error(`${name} is not a canonical journal target`);
  }
  return result;
}

function journalReference(value: unknown, name: string, kind?: JournalKind): JournalFileReference {
  const object = exact(value, name, ["target", "sha256", "bytes"]);
  const target = journalTarget(object.target, `${name}.target`);
  if (kind !== undefined && !new RegExp(`^${kind}\\.manifest\\.[A-Za-z0-9_-]+\\.json$`, "u").test(target)) {
    throw new Error(`${name}.target is not a canonical manifest target`);
  }
  if (!Number.isSafeInteger(object.bytes) || (object.bytes as number) < 1 || (object.bytes as number) > MAX_STATE_FILE_BYTES) {
    throw new Error(`${name}.bytes is invalid`);
  }
  return { target, sha256: digest(object.sha256, `${name}.sha256`), bytes: object.bytes as number };
}

export function validateJournalManifestNode(
  value: unknown,
  expected: RepositoryBinding,
  expectedKind?: JournalKind,
): ConversationJournalManifestNode {
  const object = exact(value, "journal manifest", ["version", "repository", "kind", "id", "segment", "previous"]);
  const repository = validateVersionAndBinding(object, expected, "journal manifest");
  if (object.kind !== "events" && object.kind !== "memories" && object.kind !== "findings") {
    throw new Error("journal manifest kind is invalid");
  }
  const kind = object.kind;
  if (expectedKind !== undefined && kind !== expectedKind) throw new Error("journal manifest kind does not match head");
  const manifestId = journalId(object.id, "journal manifest ID");
  const segmentObject = exact(object.segment, "journal segment reference", ["target", "sha256", "bytes", "records"]);
  const segmentTarget = journalTarget(segmentObject.target, "journal segment target", kind, "segment");
  if (!Number.isSafeInteger(segmentObject.bytes) || (segmentObject.bytes as number) < 1 ||
    (segmentObject.bytes as number) > 256 * 1024 || !Number.isSafeInteger(segmentObject.records) ||
    (segmentObject.records as number) < 1 || (segmentObject.records as number) > 100) {
    throw new Error("journal segment bounds are invalid");
  }
  const segment = { target: segmentTarget, sha256: digest(segmentObject.sha256, "journal segment sha256"),
    bytes: segmentObject.bytes as number, records: segmentObject.records as number };
  const previous = object.previous === null ? null : journalReference(object.previous, "previous journal manifest", kind);
  return { version: 1, repository, kind, id: manifestId, segment, previous };
}

export function validateJournalHead(value: unknown, expected: RepositoryBinding): ConversationJournalHead {
  const object = exact(value, "journal head", ["version", "repository", "events", "memories", "findings", "checkpoint"]);
  const repository = validateVersionAndBinding(object, expected, "journal head");
  const reference = (kind: JournalKind): JournalFileReference | null =>
    object[kind] === null ? null : journalReference(object[kind], `journal head ${kind}`, kind);
  const checkpoint = exact(object.checkpoint, "journal checkpoint",
    ["events", "terminalActions", "terminalActionIndex", "memories", "memoryIndex", "findings", "findingIndex"]);
  const events = validateEventEntries(checkpoint.events, expected, 1_000);
  const terminalActions = array(checkpoint.terminalActions, "terminal action display", 200)
    .map((entry, index) => terminalActionSummary(entry, `terminal action display[${index}]`));
  const memories = validateMemoryEntries(checkpoint.memories, expected, 200);
  materializeMemories(memories);
  const findings = validateFindingEntries(checkpoint.findings, expected, 500);
  const indexReference = (candidate: unknown, name: string): JournalFileReference | null =>
    candidate === null ? null : indexNodeReference(candidate, name);
  return { version: 1, repository, events: reference("events"), memories: reference("memories"),
    findings: reference("findings"), checkpoint: { events, terminalActions,
      terminalActionIndex: indexReference(checkpoint.terminalActionIndex, "terminal action index"), memories,
      memoryIndex: indexReference(checkpoint.memoryIndex, "memory index"), findings,
      findingIndex: indexReference(checkpoint.findingIndex, "finding index") } };
}

function indexNodeReference(value: unknown, name: string): JournalFileReference {
  const result = journalReference(value, name);
  if (!/^index\.(?:terminal-actions|memories|findings)\.node\.[A-Za-z0-9_-]+\.json$/u.test(result.target)) {
    throw new Error(`${name} target is invalid`);
  }
  return result;
}

type Plain = Record<string, unknown>;

function plain(value: unknown, name: string): Plain {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} has an unsafe prototype`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${name} cannot contain symbol properties`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${name}.${key} must be an enumerable data property, not an accessor`);
  }
  return value as Plain;
}

function exact(value: unknown, name: string, required: readonly string[], optional: readonly string[] = []): Plain {
  const object = plain(value, name);
  const keys = Object.keys(object);
  const permitted = new Set([...required, ...optional]);
  for (const key of keys) if (!permitted.has(key)) throw new Error(`${name} contains unknown property ${key}`);
  for (const key of required) if (!Object.hasOwn(object, key)) throw new Error(`${name} is missing property ${key}`);
  return object;
}

function array(value: unknown, name: string, maximum = MAX_COLLECTION): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${name} has an unsafe prototype`);
  if (value.length > maximum) throw new Error(`${name} is too large`);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  expectedKeys.push("length");
  const expectedKeySet = new Set<PropertyKey>(expectedKeys);
  const assertExactKeys = (keys: readonly PropertyKey[]): void => {
    if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeySet.has(key))) {
      throw new Error(`${name} must contain only canonical in-range array element keys`);
    }
  };
  assertExactKeys(Reflect.ownKeys(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assertExactKeys(Reflect.ownKeys(descriptors));
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${name} must contain exact enumerable data elements`);
    }
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || lengthDescriptor.enumerable || !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== value.length) {
    throw new Error(`${name} has an invalid length data property`);
  }
  return value;
}

function text(value: unknown, name: string, maximum = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be bounded non-empty text`);
  }
  if (value !== value.normalize("NFC").trim()) throw new Error(`${name} must be normalized`);
  return value;
}

function nullableText(value: unknown, name: string, maximum = 4_096): string | null {
  return value === null ? null : text(value, name, maximum);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function date(value: unknown, name: string): string {
  const result = text(value, name, 64);
  if (!ISO_DATE_RE.test(result) || Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO date`);
  return result;
}

function id(value: unknown, name: string, prefix?: string): string {
  const result = text(value, name, 64);
  if (!ID_RE.test(result) || (prefix !== undefined && !result.startsWith(`${prefix}_`))) throw new Error(`${name} is not a stable ID`);
  return result;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function binding(value: unknown, name: string): RepositoryBinding {
  const object = exact(value, name, ["provider", "repositoryDigest"]);
  if (object.provider !== "github" && object.provider !== "gitlab") throw new Error(`${name}.provider is invalid`);
  return { provider: object.provider, repositoryDigest: digest(object.repositoryDigest, `${name}.repositoryDigest`) };
}

function sameBinding(actual: RepositoryBinding, expected: RepositoryBinding): void {
  if (actual.provider !== expected.provider || actual.repositoryDigest !== expected.repositoryDigest) {
    throw new Error("State repository binding does not match the requested repository");
  }
}

function identity(value: unknown, name: string): BotIdentity {
  const object = exact(value, name, ["provider", "login", "mention"]);
  if (object.provider !== "github" && object.provider !== "gitlab") throw new Error(`${name}.provider is invalid`);
  const login = text(object.login, `${name}.login`, 255);
  const mention = text(object.mention, `${name}.mention`, 256);
  if (mention !== `@${login}`) throw new Error(`${name}.mention does not match login`);
  return { provider: object.provider, login, mention };
}

function placement(value: unknown, name: string): ConversationPlacement | null {
  if (value === null) return null;
  const object = exact(value, name, ["file", "outdated"], ["side", "line", "originalHeadSha", "currentHeadSha"]);
  const result: { file: string; outdated: boolean; side?: "old" | "new"; line?: number; originalHeadSha?: string; currentHeadSha?: string } = {
    file: text(object.file, `${name}.file`, 4_096), outdated: object.outdated as boolean,
  };
  if (typeof object.outdated !== "boolean") throw new Error(`${name}.outdated must be boolean`);
  if (object.side !== undefined) {
    if (object.side !== "old" && object.side !== "new") throw new Error(`${name}.side is invalid`);
    result.side = object.side;
  }
  if (object.line !== undefined) result.line = positiveInteger(object.line, `${name}.line`);
  for (const key of ["originalHeadSha", "currentHeadSha"] as const) {
    if (object[key] !== undefined) {
      if (typeof object[key] !== "string" || !SHA_RE.test(object[key] as string)) throw new Error(`${name}.${key} is invalid`);
      result[key] = object[key] as string;
    }
  }
  if (result.outdated && (result.originalHeadSha === undefined || result.currentHeadSha === undefined ||
    result.originalHeadSha.toLowerCase() === result.currentHeadSha.toLowerCase())) {
    throw new Error(`${name} has an impossible outdated placement`);
  }
  return result;
}

function validateVersionAndBinding(object: Plain, expected: RepositoryBinding, name: string): RepositoryBinding {
  if (object.version !== 1) throw new Error(`${name} has an unsupported schema version`);
  const repository = binding(object.repository, `${name}.repository`);
  sameBinding(repository, expected);
  return repository;
}

export function validateCursorSnapshot(value: unknown, expected: RepositoryBinding): ConversationCursorSnapshot {
  const object = exact(value, "cursor", ["version", "repository", "initialized", "initializedEpoch",
    "openReviewScanPosition", "nextRoundRobinKey", "reviews"]);
  const repository = validateVersionAndBinding(object, expected, "cursor");
  if (typeof object.initialized !== "boolean") throw new Error("cursor.initialized must be boolean");
  if (!Number.isSafeInteger(object.initializedEpoch) || (object.initializedEpoch as number) < 0) throw new Error("cursor.initializedEpoch is invalid");
  if (object.initialized !== ((object.initializedEpoch as number) > 0)) {
    throw new Error("cursor initialized flag and epoch are inconsistent");
  }
  const reviews = array(object.reviews, "cursor.reviews", 5_000).map((entry, index) => {
    const review = exact(entry, `cursor.reviews[${index}]`, ["reviewNumber", "cursor", "retired"], ["retiredAt"]);
    if (typeof review.retired !== "boolean") throw new Error("review retired flag must be boolean");
    if (review.retired && review.retiredAt === undefined) throw new Error("retired review must record retiredAt");
    if (!review.retired && review.retiredAt !== undefined) throw new Error("active review cannot record retiredAt");
    return { reviewNumber: positiveInteger(review.reviewNumber, "reviewNumber"), cursor: nullableText(review.cursor, "review cursor"),
      retired: review.retired, ...(review.retiredAt === undefined ? {} : { retiredAt: date(review.retiredAt, "retiredAt") }) };
  });
  if (new Set(reviews.map((review) => review.reviewNumber)).size !== reviews.length) throw new Error("cursor contains duplicate reviews");
  return { version: 1, repository, initialized: object.initialized, initializedEpoch: object.initializedEpoch as number,
    openReviewScanPosition: nullableText(object.openReviewScanPosition, "openReviewScanPosition"),
    nextRoundRobinKey: nullableText(object.nextRoundRobinKey, "nextRoundRobinKey"), reviews };
}

export function validatePendingSnapshot(value: unknown, expected: RepositoryBinding): ConversationPendingSnapshot {
  const object = exact(value, "pending", ["version", "repository", "clarifications", "directions"]);
  const repository = validateVersionAndBinding(object, expected, "pending");
  const parse = (entry: unknown, index: number, kind: "clarifications" | "directions") => {
    const contentKey = kind === "clarifications" ? "question" : "text";
    const item = exact(entry, `pending.${kind}[${index}]`, ["id", "reviewNumber", "headSha", contentKey, "createdAt"]);
    if (typeof item.headSha !== "string" || !SHA_RE.test(item.headSha)) throw new Error("pending headSha is invalid");
    return { id: id(item.id, "pending id", "clarification"), reviewNumber: positiveInteger(item.reviewNumber, "reviewNumber"),
      headSha: item.headSha.toLowerCase(), [contentKey]: text(item[contentKey], contentKey), createdAt: date(item.createdAt, "createdAt") };
  };
  const clarifications = array(object.clarifications, "pending.clarifications", 1_000)
    .map((entry, index) => parse(entry, index, "clarifications") as unknown as PendingClarification);
  const directions = array(object.directions, "pending.directions", 1_000)
    .map((entry, index) => parse(entry, index, "directions") as unknown as PendingDirection);
  const ids = [...clarifications, ...directions].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("pending contains duplicate IDs");
  return { version: 1, repository, clarifications, directions };
}

function manifestChild(value: unknown, name: string, repository: RepositoryBinding, actionId: string, reviewNumber: number): PublicationManifestChild {
  const object = exact(value, name, ["id", "kind", "status", "placement", "bodyDigest", "marker"], ["identity"]);
  if (object.kind !== "action" && object.kind !== "finding" && object.kind !== "clarification") throw new Error(`${name}.kind is invalid`);
  if (object.status !== "prepared" && object.status !== "published" && object.status !== "completed") throw new Error(`${name}.status is invalid`);
  const childId = id(object.id, `${name}.id`, "output");
  const bodyDigest = digest(object.bodyDigest, `${name}.bodyDigest`);
  const marker = text(object.marker, `${name}.marker`, 4_096);
  const parsed = parseChildMarker(marker);
  const markerPrefix = object.kind === "action" ? "out" : object.kind === "finding" ? "finding" : "clar";
  const markerChildId = `${markerPrefix}_${childId.slice("output_".length)}`;
  const parentId = `act_${actionId.slice("action_".length)}`;
  if (parsed === null || parsed.kind !== object.kind || parsed.parentId !== parentId || parsed.childId !== markerChildId || parsed.repositoryDigest !== repository.repositoryDigest || parsed.reviewNumber !== reviewNumber || parsed.contentDigest !== bodyDigest) {
    throw new Error(`${name}.marker does not canonically bind the manifest child`);
  }
  return { id: childId, kind: object.kind, status: object.status,
    placement: placement(object.placement, `${name}.placement`), bodyDigest, marker,
    ...(object.identity === undefined ? {} : { identity: identity(object.identity, `${name}.identity`) }) };
}

export function validateEventEntry(value: unknown, expected: RepositoryBinding, name = "event"): ConversationEventEntry {
    const object = exact(value, name, ["version", "repository", "actionId", "identityDigest", "reviewNumber", "state", "at", "successorActionId", "manifest"]);
    const repository = validateVersionAndBinding(object, expected, name);
    if (!["observed", "prepared", "manifest-ready", "published", "completed", "superseded"].includes(object.state as string)) {
      throw new Error("event state is invalid");
    }
    const successorActionId = object.successorActionId === null ? null : id(object.successorActionId, "successorActionId", "action");
    if ((object.state === "superseded") !== (successorActionId !== null)) throw new Error("superseded action must have exactly one successor link");
    const actionId = id(object.actionId, "actionId", "action");
    const reviewNumber = positiveInteger(object.reviewNumber, "reviewNumber");
    if (successorActionId === actionId) throw new Error("superseded action cannot link to itself as successor");
    const manifest = array(object.manifest, "event manifest", 1_000)
      .map((child, childIndex) => manifestChild(child, `event manifest[${childIndex}]`, repository, actionId, reviewNumber));
    for (const child of manifest) {
      if (child.identity !== undefined && child.identity.provider !== expected.provider) {
        throw new Error("publication identity provider does not match repository");
      }
    }
    if (new Set(manifest.map((child) => child.id)).size !== manifest.length) throw new Error("manifest contains duplicate child IDs");
    return { version: 1 as const, repository, actionId, identityDigest: digest(object.identityDigest, "event identity digest"), reviewNumber, state: object.state as ActionState,
      at: date(object.at, "event at"), successorActionId, manifest };
}

export function validateEventEntries(
  value: unknown,
  expected: RepositoryBinding,
  maximum = MAX_COLLECTION,
): readonly ConversationEventEntry[] {
  const entries = array(value, "events", maximum).map((entry, index) =>
    validateEventEntry(entry, expected, `events[${index}]`));
  const prior = new Map<string, ConversationEventEntry>();
  const order: readonly ActionState[] = ["observed", "prepared", "manifest-ready", "published", "completed"];
  const immutableManifest = (entry: ConversationEventEntry): unknown => entry.manifest.map((child) => ({
    id: child.id,
    kind: child.kind,
    placement: child.placement,
    bodyDigest: child.bodyDigest,
    marker: child.marker,
    ...(child.identity === undefined ? {} : { identity: child.identity }),
  }));
  for (const entry of entries) {
    const previous = prior.get(entry.actionId);
    if (previous === undefined) {
      if (entry.state !== "observed") throw new Error("Impossible action transition: first state must be observed");
    } else if (previous.state === "completed" || previous.state === "superseded") {
      throw new Error("Impossible action transition after terminal state");
    } else if (entry.state !== "superseded" && order.indexOf(entry.state) !== order.indexOf(previous.state) + 1) {
      throw new Error(`Impossible action transition from ${previous.state} to ${entry.state}`);
    }
    if (previous !== undefined && previous.identityDigest !== entry.identityDigest) {
      throw new Error("Action identity digest changed during its lifecycle");
    }
    if (previous !== undefined && previous.reviewNumber !== entry.reviewNumber) throw new Error("Action review number changed during its lifecycle");
    if ((entry.state === "observed" || entry.state === "prepared") && entry.manifest.length !== 0) {
      throw new Error(`${entry.state} action cannot have a publication manifest`);
    }
    const requiredChildStatus = entry.state === "manifest-ready" ? "prepared" :
      entry.state === "published" ? "published" : entry.state === "completed" ? "completed" : undefined;
    if (requiredChildStatus !== undefined && entry.manifest.some((child) => child.status !== requiredChildStatus)) {
      throw new Error(`publication manifest status is inconsistent with ${entry.state}`);
    }
    if (previous !== undefined &&
      (order.indexOf(previous.state) >= order.indexOf("manifest-ready") || entry.state === "superseded") &&
      JSON.stringify(immutableManifest(previous)) !== JSON.stringify(immutableManifest(entry))) {
      throw new Error("Immutable publication manifest changed");
    }
    if (previous !== undefined && entry.state === "superseded") {
      const statusOrder: readonly PublicationStatus[] = ["prepared", "published", "completed"];
      if (entry.manifest.some((child, index) =>
        statusOrder.indexOf(child.status) < statusOrder.indexOf(previous.manifest[index]!.status))) {
        throw new Error("Superseded publication manifest contains an impossible status transition");
      }
    }
    prior.set(entry.actionId, entry);
  }
  return entries;
}

function terminalActionSummary(value: unknown, name: string): TerminalActionSummary {
  const object = exact(value, name, ["key", "actionId", "identityDigest", "state", "successorActionId", "at",
    "manifestDigest", "reconciliationDigest"]);
  if (object.state !== "completed" && object.state !== "superseded") throw new Error(`${name}.state is invalid`);
  const actionId = id(object.actionId, `${name}.actionId`, "action");
  const identityDigest = digest(object.identityDigest, `${name}.identityDigest`);
  const key = text(object.key, `${name}.key`, 160);
  if (key !== `${actionId}:${identityDigest}`) throw new Error(`${name}.key does not match its identity`);
  const successorActionId = object.successorActionId === null ? null : id(object.successorActionId, `${name}.successorActionId`, "action");
  if ((object.state === "superseded") !== (successorActionId !== null)) throw new Error(`${name} has an invalid successor`);
  return { key, actionId, identityDigest, state: object.state, successorActionId, at: date(object.at, `${name}.at`),
    manifestDigest: digest(object.manifestDigest, `${name}.manifestDigest`),
    reconciliationDigest: digest(object.reconciliationDigest, `${name}.reconciliationDigest`) };
}

function memoryIndexSummary(value: unknown, name: string): MemoryIndexSummary {
  const object = exact(value, name, ["key", "id", "status", "entryDigest", "at"]);
  const memoryId = id(object.id, `${name}.id`, "memory");
  if (object.key !== memoryId) throw new Error(`${name}.key does not match its ID`);
  if (object.status !== "active" && object.status !== "tombstoned") throw new Error(`${name}.status is invalid`);
  return { key: memoryId, id: memoryId, status: object.status, entryDigest: digest(object.entryDigest, `${name}.entryDigest`),
    at: date(object.at, `${name}.at`) };
}

function findingIndexSummary(value: unknown, name: string): FindingIndexSummary {
  const object = exact(value, name, ["key", "id", "contentDigest", "reviewNumber", "reviewId", "bindingDigest"]);
  const findingId = id(object.id, `${name}.id`, "finding");
  if (object.key !== findingId) throw new Error(`${name}.key does not match its ID`);
  return { key: findingId, id: findingId, contentDigest: digest(object.contentDigest, `${name}.contentDigest`),
    reviewNumber: positiveInteger(object.reviewNumber, `${name}.reviewNumber`),
    reviewId: text(object.reviewId, `${name}.reviewId`, 1_000),
    bindingDigest: digest(object.bindingDigest, `${name}.bindingDigest`) };
}

export function validatePersistentIndexNode(
  value: unknown, expected: RepositoryBinding, expectedKind?: PersistentIndexKind,
): PersistentIndexNode {
  const object = exact(value, "persistent index node", ["version", "repository", "kind", "prefix"], ["entries", "children"]);
  const repository = validateVersionAndBinding(object, expected, "persistent index node");
  if (!(["terminal-actions", "memories", "findings"] as const).includes(object.kind as PersistentIndexKind) ||
    (expectedKind !== undefined && object.kind !== expectedKind)) throw new Error("persistent index kind is invalid");
  const kind = object.kind as PersistentIndexKind;
  const prefix = typeof object.prefix === "string" && /^[0-9a-f]{0,64}$/u.test(object.prefix) ? object.prefix : undefined;
  if (prefix === undefined) throw new Error("persistent index prefix is invalid");
  if ((object.entries === undefined) === (object.children === undefined)) throw new Error("persistent index node must be exactly a leaf or branch");
  if (object.entries !== undefined) {
    const entries = array(object.entries, "persistent index entries", 64).map((entry, index) =>
      kind === "terminal-actions" ? terminalActionSummary(entry, `persistent index entries[${index}]`) :
        kind === "memories" ? memoryIndexSummary(entry, `persistent index entries[${index}]`) :
          findingIndexSummary(entry, `persistent index entries[${index}]`));
    if (entries.some((entry, index) => index > 0 && entries[index - 1]!.key >= entry.key)) {
      throw new Error("persistent index leaf entries are not canonical");
    }
    return { version: 1, repository, kind, prefix, entries };
  }
  const children = array(object.children, "persistent index children", 16).map((entry, index) => {
    const child = exact(entry, `persistent index children[${index}]`, ["digit", "reference"]);
    if (typeof child.digit !== "string" || !/^[0-9a-f]$/u.test(child.digit)) throw new Error("persistent index child digit is invalid");
    return { digit: child.digit, reference: indexNodeReference(child.reference, "persistent index child reference") };
  });
  if (children.length === 0 || children.some((entry, index) => index > 0 && children[index - 1]!.digit >= entry.digit)) {
    throw new Error("persistent index children are not canonical");
  }
  return { version: 1, repository, kind, prefix, children };
}

export function validateMemoryEntries(
  value: unknown,
  expected: RepositoryBinding,
  maximum = MAX_COLLECTION,
): readonly MemoryEntry[] {
  return array(value, "memories", maximum).map((entry, index) => {
    const base = plain(entry, `memories[${index}]`);
    if (base.operation === "create") {
      const object = exact(entry, `memories[${index}]`, ["version", "repository", "operation", "id", "text", "attribution", "source", "at"]);
      const repository = validateVersionAndBinding(object, expected, `memories[${index}]`);
      return { version: 1, repository, operation: "create", id: id(object.id, "memory id", "memory"),
        text: text(object.text, "memory text", 8_000), attribution: text(object.attribution, "memory attribution", 1_000),
        source: text(object.source, "memory source", 2_000), at: date(object.at, "memory at") };
    }
    if (base.operation === "tombstone") {
      const object = exact(entry, `memories[${index}]`, ["version", "repository", "operation", "id", "reason", "at"]);
      const repository = validateVersionAndBinding(object, expected, `memories[${index}]`);
      return { version: 1, repository, operation: "tombstone", id: id(object.id, "memory id", "memory"),
        reason: text(object.reason, "memory tombstone reason", 2_000), at: date(object.at, "memory at") };
    }
    throw new Error("memory operation is invalid");
  });
}

export function materializeMemories(entries: readonly MemoryEntry[]): readonly MemoryCreateEntry[] {
  const active = new Map<string, MemoryCreateEntry>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.operation === "create") {
      if (seen.has(entry.id)) throw new Error("duplicate memory create");
      seen.add(entry.id);
      active.set(entry.id, entry);
      if (active.size > 200) throw new Error("active memory capacity exceeds 200");
    } else {
      if (!active.delete(entry.id)) throw new Error("impossible or duplicate memory tombstone");
    }
  }
  return [...active.values()];
}

export function validateFindingEntries(
  value: unknown,
  expected: RepositoryBinding,
  maximum = MAX_COLLECTION,
): readonly FindingLedgerEntry[] {
  const entries = array(value, "findings", maximum).map((entry, index) => {
    const object = exact(entry, `findings[${index}]`, ["version", "repository", "id", "reviewNumber", "reviewId", "baseSha",
      "headSha", "contentDigest", "ruleDigest", "ruleSnapshot", "placement", "at"], ["identity"]);
    const repository = validateVersionAndBinding(object, expected, `findings[${index}]`);
    const parseSha = (candidate: unknown, name: string): string => {
      if (typeof candidate !== "string" || !SHA_RE.test(candidate)) throw new Error(`${name} is invalid`);
      return candidate.toLowerCase();
    };
    const validatedIdentity = object.identity === undefined ? undefined : identity(object.identity, "identity");
    if (validatedIdentity !== undefined && validatedIdentity.provider !== expected.provider) {
      throw new Error("finding identity provider does not match repository");
    }
    return { version: 1 as const, repository, id: id(object.id, "finding id", "finding"),
      reviewNumber: positiveInteger(object.reviewNumber, "reviewNumber"), reviewId: text(object.reviewId, "reviewId", 1_000),
      baseSha: parseSha(object.baseSha, "baseSha"), headSha: parseSha(object.headSha, "headSha"),
      contentDigest: digest(object.contentDigest, "contentDigest"), ruleDigest: digest(object.ruleDigest, "ruleDigest"),
      ruleSnapshot: text(object.ruleSnapshot, "ruleSnapshot", 100_000), placement: placement(object.placement, "placement"),
      ...(validatedIdentity === undefined ? {} : { identity: validatedIdentity }), at: date(object.at, "finding at") };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("finding ledger contains duplicate IDs");
  return entries;
}

export function validateTransactionIntent(
  value: unknown,
  expected: RepositoryBinding,
): ConversationTransactionIntent {
  const object = exact(value, "transaction intent", ["version", "repository", "transactionId", "replacements"]);
  const repository = validateVersionAndBinding(object, expected, "transaction intent");
  const transactionId = text(object.transactionId, "transaction intent ID", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(transactionId)) throw new Error("transaction intent ID is invalid");
  const fixedTargets = new Set(["cursor.json", "pending.json", "journal-head.json"]);
  const validTarget = (target: string): boolean => fixedTargets.has(target) ||
    /^(?:events|memories|findings)\.(?:segment\.[A-Za-z0-9_-]+\.jsonl|manifest\.[A-Za-z0-9_-]+\.json)$/u.test(target) ||
    /^index\.(?:terminal-actions|memories|findings)\.node\.[A-Za-z0-9_-]+\.json$/u.test(target);
  const replacements = array(object.replacements, "transaction replacements", 1_000)
    .map((entry, index) => {
      const replacement = exact(entry, `transaction replacements[${index}]`,
        ["target", "temporary", "sha256", "bytes"]);
      if (typeof replacement.target !== "string" || !validTarget(replacement.target)) {
        throw new Error("transaction replacement target basename is invalid");
      }
      const target = replacement.target as ConversationStateTarget;
      const expectedTemporary = `.${target}.${transactionId}.tmp`;
      if (replacement.temporary !== expectedTemporary || pathLike(replacement.temporary)) {
        throw new Error("transaction replacement temporary basename is invalid");
      }
      if (!Number.isSafeInteger(replacement.bytes) || (replacement.bytes as number) < 0 ||
        (replacement.bytes as number) > MAX_STATE_FILE_BYTES) {
        throw new Error("transaction replacement byte length is invalid");
      }
      return { target, temporary: expectedTemporary, sha256: digest(replacement.sha256, "replacement sha256"),
        bytes: replacement.bytes as number };
    });
  if (replacements.length === 0) throw new Error("transaction intent must contain replacements");
  if (new Set(replacements.map((entry) => entry.target)).size !== replacements.length ||
    new Set(replacements.map((entry) => entry.temporary)).size !== replacements.length) {
    throw new Error("transaction intent contains duplicate replacements");
  }
  const orderedTargets = replacements.map((entry) => entry.target);
  if (orderedTargets.some((target, index) => index > 0 && orderedTargets[index - 1]! >= target)) {
    throw new Error("transaction intent replacements must use deterministic target order");
  }
  return { version: 1, repository, transactionId, replacements };
}

function pathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value === "." || value === ".." ||
    /[\u0000-\u001f\u007f]/u.test(value);
}
