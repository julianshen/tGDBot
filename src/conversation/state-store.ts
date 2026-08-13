import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { RepositoryRef } from "../target/types.js";
import {
  deriveConversationStatePaths,
  canonicalStateRepositoryIdentity,
  prepareConversationStatePaths,
  type ConversationPathFileSystem,
  type ConversationStatePaths,
  type PreparedConversationStatePaths,
} from "./state-paths.js";
import {
  materializeFindings,
  materializeMemories,
  validateCursorSnapshot,
  validateEventEntries,
  validateEventEntry,
  validateFindingEntries,
  validateJournalHead,
  validateJournalManifestNode,
  validateMemoryEntries,
  validatePendingSnapshot,
  validatePersistentIndexNode,
  validateTransactionIntent,
  type ConversationCursorSnapshot,
  type ConversationEventEntry,
  type ConversationJournalHead,
  type ConversationPendingSnapshot,
  type ConversationStateTarget,
  type ConversationTransactionIntent,
  type FindingLedgerEntry,
  type JournalFileReference,
  type JournalKind,
  type MemoryCreateEntry,
  type MemoryEntry,
  type PersistentIndexKind,
  type PersistentIndexNode,
  type PersistentIndexValue,
  type TerminalActionSummary,
  type MemoryIndexSummary,
  type FindingIndexSummary,
} from "./state-schema.js";
import type { RepositoryBinding } from "./types.js";
import {
  createDefaultProcessInspector,
  type ProcessIdentity,
  type ProcessInspector,
} from "./process-inspector.js";

const MAX_STATE_FILE_BYTES = 10_000_000;
const MAX_JOURNAL_SEGMENT_BYTES = 256 * 1024;
const MAX_JOURNAL_SEGMENT_RECORDS = 100;
// V1 retention is deliberately lossless: journal nodes and segments are never
// compacted or deleted. This preserves every idempotency key and audit record;
// a later compactor must define provider-marker liveness before pruning.
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW;

export interface ConversationContextSnapshot {
  readonly cursor: ConversationCursorSnapshot;
  readonly pending: ConversationPendingSnapshot;
  readonly events: readonly ConversationEventEntry[];
  readonly memories: readonly MemoryCreateEntry[];
  readonly memoryLedger: readonly MemoryEntry[];
  readonly findings: readonly FindingLedgerEntry[];
}

export interface ConversationStateTransaction {
  readonly snapshot: ConversationContextSnapshot;
  initializeIfAbsent(): boolean;
  appendEvent(entry: ConversationEventEntry): void;
  appendMemory(entry: MemoryEntry): void;
  appendFinding(entry: FindingLedgerEntry): void;
  replaceCursor(snapshot: ConversationCursorSnapshot): void;
  replacePending(snapshot: ConversationPendingSnapshot): void;
}

export interface ConversationExclusiveSession {
  snapshot(): ConversationContextSnapshot;
  commit(fn: (tx: ConversationStateTransaction) => void): Promise<void>;
  findTerminalAction(identity: TerminalActionIdentity): Promise<TerminalActionSummary | undefined>;
}

export interface ConversationStateStore {
  readonly repositoryBinding: Readonly<RepositoryBinding>;
  readContextSnapshot(): Promise<ConversationContextSnapshot>;
  readAuditPage(journal: JournalKind, cursor?: ConversationAuditCursor | null, limit?: number): Promise<{
    readonly entries: readonly unknown[];
    readonly nextCursor: ConversationAuditCursor | null;
  }>;
  findTerminalAction(identity: TerminalActionIdentity): Promise<TerminalActionSummary | undefined>;
  findTerminalActions(identities: readonly TerminalActionIdentity[]): Promise<ReadonlyMap<string, TerminalActionSummary>>;
  findMemory(id: string): Promise<MemoryIndexSummary | undefined>;
  findFinding(id: string): Promise<FindingIndexSummary | undefined>;
  transact<T>(fn: (tx: ConversationStateTransaction) => T): Promise<T>;
  withExclusiveLock<T>(fn: (session: ConversationExclusiveSession) => Promise<T>): Promise<T>;
}

export interface TerminalActionIdentity { readonly actionId: string; readonly identityDigest: string }

export interface ConversationAuditCursor {
  readonly manifest: JournalFileReference;
  readonly offset: number;
}

export interface ConversationStateFileHandle {
  stat(): Promise<Stats>;
  readFile(): Promise<Buffer>;
  writeFile(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ConversationStateFileSystem extends ConversationPathFileSystem {
  open(filePath: string, flags: number, mode?: number): Promise<ConversationStateFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
}

export interface ConversationStateStoreDependencies {
  readonly fileSystem?: Partial<ConversationStateFileSystem>;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly randomId?: () => string;
  readonly onFileSystemOperation?: (operation: string) => void;
  readonly processInspector?: ProcessInspector;
  readonly indexLeafCapacity?: number;
}

export interface ConversationStateStoreOptions {
  readonly root: string;
  readonly repository: RepositoryRef;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
  readonly dependencies?: ConversationStateStoreDependencies;
}

const realFileSystem: ConversationStateFileSystem = {
  lstat,
  mkdir,
  chmod,
  open: (filePath, flags, mode) => open(filePath, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
  link,
};

function isMissing(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function repositoryBinding(repository: RepositoryRef): Readonly<RepositoryBinding> {
  return Object.freeze({
    provider: repository.provider,
    repositoryDigest: createHash("sha256").update(repository.canonicalUrl, "utf8").digest("hex"),
  });
}

export function createEmptyCursorSnapshot(repository: RepositoryBinding): ConversationCursorSnapshot {
  return { version: 1, repository: clone(repository), initialized: false, initializedEpoch: 0,
    openReviewScanPosition: null, nextRoundRobinKey: null, reviews: [] };
}

export function createEmptyPendingSnapshot(repository: RepositoryBinding): ConversationPendingSnapshot {
  return { version: 1, repository: clone(repository), clarifications: [], directions: [] };
}

interface LoadedState {
  readonly cursor: ConversationCursorSnapshot;
  readonly pending: ConversationPendingSnapshot;
  readonly events: readonly ConversationEventEntry[];
  readonly memoryLedger: readonly MemoryEntry[];
  readonly findings: readonly FindingLedgerEntry[];
  readonly cursorExists: boolean;
  readonly pendingExists: boolean;
  readonly journalHead: ConversationJournalHead;
}

interface PreparedReplacement {
  readonly target: ConversationStateTarget;
  readonly targetPath: string;
  readonly temporary: string;
  readonly temporaryPath: string;
  readonly contents: Buffer;
  readonly sha256: string;
  readonly bytes: number;
}

interface OpenedFile {
  readonly handle: ConversationStateFileHandle;
  readonly identity: { readonly dev: number; readonly ino: number };
  readonly contents: Buffer;
}

interface LockMetadata {
  readonly version: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly processStartIdentity: string;
  readonly runId: string;
  readonly createdAt: string;
}

function validateLockMetadata(value: unknown): LockMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) throw new Error("Conversation lock metadata is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ["version", "pid", "hostname", "processStartIdentity", "runId", "createdAt"];
  if (Object.keys(descriptors).length !== expected.length || expected.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) {
    throw new Error("Conversation lock metadata must contain exact data properties");
  }
  const record = value as Record<string, unknown>;
  const bounded = (candidate: unknown, maximum: number): candidate is string => typeof candidate === "string" &&
    candidate.length > 0 && candidate.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(candidate);
  if (record.version !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 ||
    !bounded(record.hostname, 255) || !bounded(record.processStartIdentity, 1_024) || !bounded(record.runId, 128) ||
    !bounded(record.createdAt, 64) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(record.createdAt) ||
    Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error("Conversation lock metadata values are invalid");
  }
  return { version: 1, pid: record.pid as number, hostname: record.hostname,
    processStartIdentity: record.processStartIdentity, runId: record.runId, createdAt: record.createdAt };
}

function contextOf(state: LoadedState): ConversationContextSnapshot {
  return clone({ cursor: state.cursor, pending: state.pending, events: state.events,
    memories: materializeMemories(state.memoryLedger), memoryLedger: state.memoryLedger,
    findings: materializeFindings(state.findings) });
}

function emptyJournalHead(repository: RepositoryBinding): ConversationJournalHead {
  return { version: 1, repository: clone(repository), events: null, memories: null, findings: null,
    checkpoint: { events: [], terminalActions: [], terminalActionIndex: null, memories: [], memoryIndex: null,
      findings: [], findingIndex: null } };
}

function serializeSnapshot(value: unknown): Buffer {
  const contents = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (contents.length > MAX_STATE_FILE_BYTES) throw new Error("Conversation snapshot exceeds the state file size limit");
  return contents;
}

function parseJson(contents: Buffer, candidate: string): unknown {
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Malformed conversation state JSON at ${candidate}`, { cause: error });
  }
}

function parseJsonLines(contents: Buffer, candidate: string): unknown[] {
  if (contents.length === 0) return [];
  const text = contents.toString("utf8");
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines > MAX_JOURNAL_SEGMENT_RECORDS) {
      throw new Error(`Conversation ledger has too many entries: ${candidate}`);
    }
  }
  if (!text.endsWith("\n") && ++lines > MAX_JOURNAL_SEGMENT_RECORDS) {
    throw new Error(`Conversation ledger has too many entries: ${candidate}`);
  }
  const rawLines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return rawLines.map((line, index) => {
    if (line.length === 0) throw new Error(`Malformed empty conversation ledger entry at ${candidate}:${index + 1}`);
    return parseJson(Buffer.from(line, "utf8"), `${candidate}:${index + 1}`);
  });
}

class FileConversationStateStore implements ConversationStateStore {
  private readonly paths: ConversationStatePaths;
  private readonly binding: Readonly<RepositoryBinding>;
  private readonly fs: ConversationStateFileSystem;
  private readonly platform: NodeJS.Platform;
  private readonly pathImplementation: path.PlatformPath;
  private readonly uid: number | undefined;
  private readonly now: () => string;
  private readonly monotonicNow: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly randomId: () => string;
  private readonly notify: (operation: string) => void;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly processInspector: ProcessInspector;
  private readonly indexLeafCapacity: number;

  constructor(options: ConversationStateStoreOptions) {
    const dependencies = options.dependencies ?? {};
    this.platform = dependencies.platform ?? process.platform;
    this.pathImplementation = this.platform === "win32" ? path.win32 : path.posix;
    this.uid = dependencies.uid ?? process.getuid?.();
    const canonicalRepository = canonicalStateRepositoryIdentity(options.repository);
    this.paths = deriveConversationStatePaths(options.root, canonicalRepository, this.platform);
    this.binding = repositoryBinding(canonicalRepository);
    this.fs = { ...realFileSystem, ...dependencies.fileSystem };
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.randomId = dependencies.randomId ?? randomUUID;
    this.notify = dependencies.onFileSystemOperation ?? (() => undefined);
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    this.processInspector = dependencies.processInspector ?? createDefaultProcessInspector(this.platform);
    this.indexLeafCapacity = dependencies.indexLeafCapacity ?? 64;
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0 ||
      !Number.isFinite(this.lockPollMs) || this.lockPollMs <= 0) {
      throw new Error("Conversation lock timing must use finite non-negative timeout and positive poll values");
    }
    if (!Number.isSafeInteger(this.indexLeafCapacity) || this.indexLeafCapacity < 1 || this.indexLeafCapacity > 64) {
      throw new Error("Persistent index leaf capacity must be between 1 and 64");
    }
  }

  get repositoryBinding(): Readonly<RepositoryBinding> {
    return Object.freeze({ ...this.binding });
  }

  private pathDependencies() {
    return { fileSystem: this.fs, platform: this.platform, uid: this.uid };
  }

  private async preparePaths(): Promise<PreparedConversationStatePaths> {
    return prepareConversationStatePaths(this.paths, this.pathDependencies());
  }

  private validateOwnedRegular(info: Stats, candidate: string): void {
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Conversation state file must be a real regular file: ${candidate}`);
    }
    if (this.platform !== "win32") {
      if (this.uid !== undefined && info.uid !== this.uid) throw new Error(`Conversation state file must be owner-owned: ${candidate}`);
      if ((info.mode & 0o077) !== 0) throw new Error(`Conversation state file permissions must be 0600: ${candidate}`);
    }
  }

  private async assertParentIdentity(expected: { dev: number; ino: number }): Promise<void> {
    const actual = await this.fs.lstat(this.paths.repositoryRoot);
    if (actual.isSymbolicLink() || !actual.isDirectory() || !sameIdentity(actual, expected)) {
      throw new Error("Conversation repository directory identity changed");
    }
    if (this.platform !== "win32" && (actual.mode & 0o077) !== 0) {
      throw new Error("Conversation repository directory permissions changed");
    }
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await this.fs.lstat(candidate);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /**
   * O_NOFOLLOW is used when the host exposes it. On hosts without it, the
   * lstat/open/fstat identity comparison is the fail-closed fallback.
   */
  private async openValidated(
    candidate: string,
    parentIdentity: { dev: number; ino: number },
    maximumBytes = MAX_STATE_FILE_BYTES,
  ): Promise<OpenedFile> {
    await this.assertParentIdentity(parentIdentity);
    let before = await this.fs.lstat(candidate);
    this.validateOwnedRegular(before, candidate);
    if (this.platform !== "win32" && (before.mode & 0o777) !== 0o600) {
      await this.fs.chmod(candidate, 0o600);
      const secured = await this.fs.lstat(candidate);
      if (!sameIdentity(before, secured)) throw new Error(`Conversation state file identity changed during chmod: ${candidate}`);
      before = secured;
      this.validateOwnedRegular(before, candidate);
    }
    if (before.size > maximumBytes) throw new Error(`Conversation state file is too large: ${candidate}`);
    const handle = await this.fs.open(candidate, READ_FLAGS);
    try {
      const opened = await handle.stat();
      this.validateOwnedRegular(opened, candidate);
      if (!sameIdentity(before, opened)) throw new Error(`Conversation state file identity changed during open: ${candidate}`);
      if (opened.size > maximumBytes) throw new Error(`Conversation state file is too large: ${candidate}`);
      const contents = await handle.readFile();
      const after = await handle.stat();
      if (!sameIdentity(opened, after) || after.size !== opened.size || contents.length !== opened.size) {
        throw new Error(`Conversation state file changed while being read: ${candidate}`);
      }
      return { handle, identity: { dev: opened.dev, ino: opened.ino }, contents };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async readOptional(
    candidate: string,
    parentIdentity: { dev: number; ino: number },
    maximumBytes = MAX_STATE_FILE_BYTES,
  ): Promise<Buffer | undefined> {
    if (!(await this.pathExists(candidate))) return undefined;
    const opened = await this.openValidated(candidate, parentIdentity, maximumBytes);
    try {
      return Buffer.from(opened.contents);
    } finally {
      await opened.handle.close();
    }
  }

  private async fsyncParent(parentIdentity: { dev: number; ino: number }, operation: string): Promise<void> {
    await this.assertParentIdentity(parentIdentity);
    const handle = await this.fs.open(this.paths.repositoryRoot, DIRECTORY_FLAGS);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || !sameIdentity(opened, parentIdentity)) {
        throw new Error("Conversation repository directory identity changed during fsync");
      }
      this.notify(operation);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async createPreparedFile(
    candidate: string,
    contents: Buffer,
    parentIdentity: { dev: number; ino: number },
    operationName: string,
  ): Promise<{ dev: number; ino: number }> {
    if (contents.length > MAX_STATE_FILE_BYTES) throw new Error(`Prepared conversation state file is too large: ${candidate}`);
    await this.assertParentIdentity(parentIdentity);
    this.notify(`create-temp:${operationName}`);
    const handle = await this.fs.open(candidate, CREATE_FLAGS, 0o600);
    let createdIdentity: { dev: number; ino: number } | undefined;
    let failure: unknown;
    try {
      const created = await handle.stat();
      createdIdentity = { dev: created.dev, ino: created.ino };
      this.validateOwnedRegular(created, candidate);
      if (this.platform !== "win32" && (created.mode & 0o777) !== 0o600) {
        throw new Error(`Prepared state file permissions are unsafe: ${candidate}`);
      }
      await handle.writeFile(contents);
      this.notify(`fsync-temp:${operationName}`);
      await handle.sync();
      const written = await handle.stat();
      if (!sameIdentity(created, written) || written.size !== contents.length) {
        throw new Error(`Prepared state file changed while being written: ${candidate}`);
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      if (createdIdentity !== undefined) await this.removeIfOwned(candidate, createdIdentity);
      throw failure;
    }
    const verified = await this.openValidated(candidate, parentIdentity);
    try {
      if (verified.contents.length !== contents.length || sha256(verified.contents) !== sha256(contents)) {
        throw new Error(`Prepared state file digest mismatch: ${candidate}`);
      }
    } finally {
      await verified.handle.close();
    }
    return verified.identity;
  }

  private async renameVerifiedFile(
    source: string,
    target: string,
    expected: { sha256: string; bytes: number },
    parentIdentity: { dev: number; ino: number },
    operation: string,
  ): Promise<void> {
    const opened = await this.openValidated(source, parentIdentity);
    try {
      if (opened.contents.length !== expected.bytes || sha256(opened.contents) !== expected.sha256) {
        throw new Error(`Conversation state source digest mismatch before rename: ${source}`);
      }
      await this.assertParentIdentity(parentIdentity);
      const namedSource = await this.fs.lstat(source);
      if (!sameIdentity(namedSource, opened.identity)) {
        throw new Error(`Conversation state source identity changed before rename: ${source}`);
      }
      this.notify(operation);
      await this.fs.rename(source, target);
    } finally {
      await opened.handle.close();
    }
    if (!(await this.fileMatches(target, expected, parentIdentity))) {
      throw new Error(`Conversation state target failed validation after rename: ${target}`);
    }
  }

  private async validateCurrentJournal(
    kind: JournalKind,
    reference: JournalFileReference | null,
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    if (reference !== null) {
      const manifestPath = this.targetPath(reference.target);
      const manifestContents = await this.readOptional(manifestPath, parentIdentity, 64 * 1024);
      if (manifestContents === undefined || manifestContents.length !== reference.bytes ||
        sha256(manifestContents) !== reference.sha256) {
        throw new Error(`Conversation ${kind} journal manifest is missing or corrupt`);
      }
      const manifest = validateJournalManifestNode(parseJson(manifestContents, manifestPath), this.binding, kind);
      if (reference.target !== `${kind}.manifest.${manifest.id}.json`) {
        throw new Error(`Conversation ${kind} journal manifest identity does not match its target`);
      }
      const segmentPath = this.targetPath(manifest.segment.target);
      const segmentContents = await this.readOptional(segmentPath, parentIdentity, MAX_JOURNAL_SEGMENT_BYTES);
      if (segmentContents === undefined || segmentContents.length !== manifest.segment.bytes ||
        sha256(segmentContents) !== manifest.segment.sha256) {
        throw new Error(`Conversation ${kind} journal segment is missing or corrupt`);
      }
      const entries = parseJsonLines(segmentContents, segmentPath);
      if (entries.length !== manifest.segment.records) throw new Error(`Conversation ${kind} journal segment count is invalid`);
    }
  }

  private checkpoint(
    head: Pick<ConversationJournalHead, "events" | "memories" | "findings">,
    previous: ConversationJournalHead["checkpoint"],
    events: readonly ConversationEventEntry[], memories: readonly MemoryEntry[], findings: readonly FindingLedgerEntry[],
    indexes: Pick<ConversationJournalHead["checkpoint"], "terminalActionIndex" | "memoryIndex" | "findingIndex">,
    newlyTerminal: readonly TerminalActionSummary[],
  ): ConversationJournalHead {
    const latestActions = new Map<string, ConversationEventEntry>();
    for (const event of events) latestActions.set(event.actionId, event);
    const nonterminal = new Set([...latestActions.values()].filter((event) =>
      event.state !== "completed" && event.state !== "superseded").map((event) => event.actionId));
    const retainedEvents = events.filter((event) => nonterminal.has(event.actionId));
    const activeMemories = materializeMemories(memories);
    const retainedFindings = findings.slice(-500);
    return validateJournalHead({ version: 1, repository: this.binding, ...head,
      checkpoint: { events: retainedEvents,
        terminalActions: [...previous.terminalActions, ...newlyTerminal].slice(-200), ...indexes,
        memories: activeMemories, findings: retainedFindings } }, this.binding);
  }

  private indexTarget(kind: PersistentIndexKind, id: string): string {
    return `index.${kind}.node.${id}.json`;
  }

  private async readIndexNode(reference: JournalFileReference, kind: PersistentIndexKind,
    parentIdentity: { dev: number; ino: number }): Promise<PersistentIndexNode> {
    if (!reference.target.startsWith(`index.${kind}.node.`)) throw new Error("Persistent index reference kind mismatch");
    const candidate = this.targetPath(reference.target);
    const contents = await this.readOptional(candidate, parentIdentity, 512 * 1024);
    if (contents === undefined || contents.length !== reference.bytes || sha256(contents) !== reference.sha256) {
      throw new Error(`Persistent ${kind} index node is missing or corrupt`);
    }
    const node = validatePersistentIndexNode(parseJson(contents, candidate), this.binding, kind);
    for (const entry of node.entries ?? []) {
      if (!sha256(Buffer.from(entry.key, "utf8")).startsWith(node.prefix)) {
        throw new Error("Persistent index entry is routed to the wrong prefix");
      }
    }
    return node;
  }

  private stageIndexNode(node: PersistentIndexNode, transactionId: string,
    replacements: PreparedReplacement[]): JournalFileReference {
    const validated = validatePersistentIndexNode(node, this.binding, node.kind);
    const target = this.indexTarget(node.kind, this.randomId());
    const replacement = this.replacement(target, serializeSnapshot(validated), transactionId);
    replacements.push(replacement);
    return { target, sha256: replacement.sha256, bytes: replacement.bytes };
  }

  private async upsertIndex(kind: PersistentIndexKind, reference: JournalFileReference | null,
    values: readonly PersistentIndexValue[], transactionId: string, replacements: PreparedReplacement[],
    parentIdentity: { dev: number; ino: number }): Promise<JournalFileReference | null> {
    if (reference === null && values.length > 0) {
      const unique = new Map(values.map((value) => [value.key, value]));
      return this.buildFreshIndex(kind, [...unique.values()], "", transactionId, replacements);
    }
    let current = reference;
    for (const value of values) current = await this.upsertIndexValue(kind, current, value, "", transactionId,
      replacements, parentIdentity);
    return current;
  }

  private buildFreshIndex(kind: PersistentIndexKind, entries: readonly PersistentIndexValue[], prefix: string,
    transactionId: string, replacements: PreparedReplacement[]): JournalFileReference {
    const sorted = [...entries].sort((left, right) => left.key.localeCompare(right.key));
    if (sorted.length <= this.indexLeafCapacity) {
      return this.stageIndexNode({ version: 1, repository: this.binding, kind, prefix, entries: sorted },
        transactionId, replacements);
    }
    if (prefix.length >= 64) throw new Error("Persistent index SHA-256 collision exceeds leaf capacity");
    const groups = new Map<string, PersistentIndexValue[]>();
    for (const entry of sorted) {
      const digit = sha256(Buffer.from(entry.key, "utf8"))[prefix.length]!;
      const group = groups.get(digit) ?? [];
      group.push(entry);
      groups.set(digit, group);
    }
    const children = [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([digit, group]) => ({
      digit, reference: this.buildFreshIndex(kind, group, `${prefix}${digit}`, transactionId, replacements),
    }));
    return this.stageIndexNode({ version: 1, repository: this.binding, kind, prefix, children }, transactionId, replacements);
  }

  private async upsertIndexValue(kind: PersistentIndexKind, reference: JournalFileReference | null,
    value: PersistentIndexValue, prefix: string, transactionId: string, replacements: PreparedReplacement[],
    parentIdentity: { dev: number; ino: number }): Promise<JournalFileReference> {
    const hash = sha256(Buffer.from(value.key, "utf8"));
    const staged = reference === null ? undefined : replacements.find((candidate) => candidate.target === reference.target);
    const node = reference === null ? { version: 1 as const, repository: this.binding, kind, prefix, entries: [] } :
      staged === undefined ? await this.readIndexNode(reference, kind, parentIdentity) :
        validatePersistentIndexNode(parseJson(staged.contents, staged.target), this.binding, kind);
    if (node.prefix !== prefix || !hash.startsWith(prefix)) throw new Error("Persistent index node prefix mismatch");
    if (node.entries !== undefined) {
      const map = new Map(node.entries.map((entry) => [entry.key, entry]));
      map.set(value.key, value);
      const entries = [...map.values()].sort((left, right) => left.key.localeCompare(right.key));
      if (entries.length <= this.indexLeafCapacity) {
        return this.stageIndexNode({ version: 1, repository: this.binding, kind, prefix, entries }, transactionId, replacements);
      }
      if (prefix.length >= 64) throw new Error("Persistent index SHA-256 collision exceeds leaf capacity");
      const groups = new Map<string, PersistentIndexValue[]>();
      for (const entry of entries) {
        const digit = sha256(Buffer.from(entry.key, "utf8"))[prefix.length]!;
        const group = groups.get(digit) ?? [];
        group.push(entry);
        groups.set(digit, group);
      }
      const children: Array<{ digit: string; reference: JournalFileReference }> = [];
      for (const [digit, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
        let child: JournalFileReference | null = null;
        for (const entry of group) child = await this.upsertIndexValue(kind, child, entry, `${prefix}${digit}`,
          transactionId, replacements, parentIdentity);
        children.push({ digit, reference: child! });
      }
      return this.stageIndexNode({ version: 1, repository: this.binding, kind, prefix, children }, transactionId, replacements);
    }
    const digit = hash[prefix.length];
    if (digit === undefined) throw new Error("Persistent index branch exceeds digest depth");
    const children = [...node.children!];
    const found = children.find((child) => child.digit === digit);
    const child = await this.upsertIndexValue(kind, found?.reference ?? null, value, `${prefix}${digit}`,
      transactionId, replacements, parentIdentity);
    if (found === undefined) children.push({ digit, reference: child });
    else children[children.indexOf(found)] = { digit, reference: child };
    children.sort((left, right) => left.digit.localeCompare(right.digit));
    return this.stageIndexNode({ version: 1, repository: this.binding, kind, prefix, children }, transactionId, replacements);
  }

  private async findIndexValue(kind: PersistentIndexKind, reference: JournalFileReference | null, key: string,
    parentIdentity: { dev: number; ino: number }): Promise<PersistentIndexValue | undefined> {
    const hash = sha256(Buffer.from(key, "utf8"));
    let current = reference;
    while (current !== null) {
      const node = await this.readIndexNode(current, kind, parentIdentity);
      if (!hash.startsWith(node.prefix)) throw new Error("Persistent index lookup prefix mismatch");
      if (node.entries !== undefined) return node.entries.find((entry) => entry.key === key);
      const digit = hash[node.prefix.length];
      current = node.children!.find((child) => child.digit === digit)?.reference ?? null;
    }
    return undefined;
  }

  private async loadState(parentIdentity: { dev: number; ino: number }): Promise<LoadedState> {
    const [cursorContents, pendingContents, journalHeadContents] = await Promise.all([
      this.readOptional(this.paths.cursorPath, parentIdentity),
      this.readOptional(this.paths.pendingPath, parentIdentity),
      this.readOptional(this.paths.journalHeadPath, parentIdentity),
    ]);
    const cursor = cursorContents === undefined ? createEmptyCursorSnapshot(this.binding) :
      validateCursorSnapshot(parseJson(cursorContents, this.paths.cursorPath), this.binding);
    const pending = pendingContents === undefined ? createEmptyPendingSnapshot(this.binding) :
      validatePendingSnapshot(parseJson(pendingContents, this.paths.pendingPath), this.binding);
    const journalHead = journalHeadContents === undefined ? emptyJournalHead(this.binding) :
      validateJournalHead(parseJson(journalHeadContents, this.paths.journalHeadPath), this.binding);
    await Promise.all([
      this.validateCurrentJournal("events", journalHead.events, parentIdentity),
      this.validateCurrentJournal("memories", journalHead.memories, parentIdentity),
      this.validateCurrentJournal("findings", journalHead.findings, parentIdentity),
    ]);
    const { events, memories: memoryLedger, findings } = journalHead.checkpoint;
    return { cursor, pending, events, memoryLedger, findings,
      cursorExists: cursorContents !== undefined, pendingExists: pendingContents !== undefined, journalHead };
  }

  private targetPath(target: ConversationStateTarget): string {
    const result = this.pathImplementation.join(this.paths.repositoryRoot, target);
    if (this.pathImplementation.dirname(result) !== this.paths.repositoryRoot ||
      this.pathImplementation.basename(result) !== target) {
      throw new Error("Conversation transaction target escapes repository state root");
    }
    return result;
  }

  private temporaryPath(temporary: string): string {
    const result = this.pathImplementation.join(this.paths.repositoryRoot, temporary);
    if (this.pathImplementation.dirname(result) !== this.paths.repositoryRoot ||
      this.pathImplementation.basename(result) !== temporary) {
      throw new Error("Conversation transaction temporary path escapes repository state root");
    }
    return result;
  }

  private async fileMatches(
    candidate: string,
    expected: { sha256: string; bytes: number },
    parentIdentity: { dev: number; ino: number },
  ): Promise<boolean> {
    if (!(await this.pathExists(candidate))) return false;
    const opened = await this.openValidated(candidate, parentIdentity);
    try {
      return opened.contents.length === expected.bytes && sha256(opened.contents) === expected.sha256;
    } finally {
      await opened.handle.close();
    }
  }

  private async validateIntentFile(
    candidate: string,
    parentIdentity: { dev: number; ino: number },
  ): Promise<ConversationTransactionIntent> {
    const contents = await this.readOptional(candidate, parentIdentity, MAX_STATE_FILE_BYTES);
    if (contents === undefined) throw new Error(`Conversation transaction intent disappeared: ${candidate}`);
    return validateTransactionIntent(parseJson(contents, candidate), this.binding);
  }

  private async installReplacement(
    replacement: ConversationTransactionIntent["replacements"][number],
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    const targetPath = this.targetPath(replacement.target);
    const temporaryPath = this.temporaryPath(replacement.temporary);
    if (await this.fileMatches(targetPath, replacement, parentIdentity)) {
      if (await this.pathExists(temporaryPath)) {
        const redundant = await this.openValidated(temporaryPath, parentIdentity);
        try {
          if (redundant.contents.length !== replacement.bytes || sha256(redundant.contents) !== replacement.sha256) {
            throw new Error(`Redundant conversation replacement is corrupt: ${replacement.target}`);
          }
          await this.assertParentIdentity(parentIdentity);
          const namedTemporary = await this.fs.lstat(temporaryPath);
          if (!sameIdentity(namedTemporary, redundant.identity)) {
            throw new Error(`Redundant conversation replacement identity changed: ${replacement.target}`);
          }
          this.notify(`unlink-completed-temp:${replacement.target}`);
          await this.fs.unlink(temporaryPath);
        } finally {
          await redundant.handle.close();
        }
        await this.fsyncParent(parentIdentity, `fsync-completed-temp-parent:${replacement.target}`);
      }
      return;
    }
    if (!(await this.pathExists(temporaryPath))) {
      throw new Error(`Committed conversation replacement is missing or corrupt: ${replacement.target}`);
    }
    await this.renameVerifiedFile(temporaryPath, targetPath, replacement, parentIdentity,
      `rename-target:${replacement.target}`);
    await this.fsyncParent(parentIdentity, `fsync-target-parent:${replacement.target}`);
  }

  private async verifyCompletedIntent(
    intent: ConversationTransactionIntent,
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    for (const replacement of intent.replacements) {
      if (!(await this.fileMatches(this.targetPath(replacement.target), replacement, parentIdentity))) {
        throw new Error(`Retired conversation transaction has an incomplete target: ${replacement.target}`);
      }
    }
  }

  private async removeRetiredIntent(
    intent: ConversationTransactionIntent,
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    const opened = await this.openValidated(this.paths.transactionRetiredPath, parentIdentity, MAX_STATE_FILE_BYTES);
    try {
      const validated = validateTransactionIntent(parseJson(opened.contents, this.paths.transactionRetiredPath), this.binding);
      if (JSON.stringify(validated) !== JSON.stringify(intent)) {
        throw new Error("Retired conversation transaction intent changed before removal");
      }
      await this.assertParentIdentity(parentIdentity);
      const namedRetired = await this.fs.lstat(this.paths.transactionRetiredPath);
      if (!sameIdentity(namedRetired, opened.identity)) {
        throw new Error("Retired conversation transaction intent identity changed before removal");
      }
      this.notify("unlink-retired");
      await this.fs.unlink(this.paths.transactionRetiredPath);
    } finally {
      await opened.handle.close();
    }
    await this.fsyncParent(parentIdentity, "fsync-remove-parent");
  }

  private async applyIntent(
    intent: ConversationTransactionIntent,
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    for (const replacement of intent.replacements) await this.installReplacement(replacement, parentIdentity);
    await this.verifyCompletedIntent(intent, parentIdentity);
    if (await this.pathExists(this.paths.transactionRetiredPath)) {
      throw new Error("Conversation transaction has conflicting active and retired intent files");
    }
    const active = await this.openValidated(this.paths.transactionIntentPath, parentIdentity, MAX_STATE_FILE_BYTES);
    try {
      const validatedActive = validateTransactionIntent(parseJson(active.contents, this.paths.transactionIntentPath), this.binding);
      if (JSON.stringify(validatedActive) !== JSON.stringify(intent)) {
        throw new Error("Conversation transaction intent changed before retirement");
      }
      await this.assertParentIdentity(parentIdentity);
      const namedIntent = await this.fs.lstat(this.paths.transactionIntentPath);
      if (!sameIdentity(namedIntent, active.identity)) throw new Error("Conversation transaction intent identity changed before retirement");
      this.notify("retire-intent");
      await this.fs.rename(this.paths.transactionIntentPath, this.paths.transactionRetiredPath);
    } finally {
      await active.handle.close();
    }
    const retired = await this.validateIntentFile(this.paths.transactionRetiredPath, parentIdentity);
    if (JSON.stringify(retired) !== JSON.stringify(intent)) throw new Error("Retired conversation transaction intent changed");
    await this.fsyncParent(parentIdentity, "fsync-retire-parent");
    await this.removeRetiredIntent(intent, parentIdentity);
  }

  private async recover(parentIdentity: { dev: number; ino: number }): Promise<void> {
    const hasIntent = await this.pathExists(this.paths.transactionIntentPath);
    const hasRetired = await this.pathExists(this.paths.transactionRetiredPath);
    if (hasIntent && hasRetired) throw new Error("Conversation transaction has conflicting intent files");
    if (hasRetired) {
      const retired = await this.validateIntentFile(this.paths.transactionRetiredPath, parentIdentity);
      await this.verifyCompletedIntent(retired, parentIdentity);
      await this.removeRetiredIntent(retired, parentIdentity);
      return;
    }
    if (hasIntent) {
      const intent = await this.validateIntentFile(this.paths.transactionIntentPath, parentIdentity);
      await this.applyIntent(intent, parentIdentity);
    }
  }

  private async tryReclaimStaleLock(
    parentIdentity: { dev: number; ino: number },
    currentProcess: ProcessIdentity,
  ): Promise<boolean> {
    let opened: OpenedFile;
    try {
      opened = await this.openValidated(this.paths.lockPath, parentIdentity, 64 * 1024);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    try {
      let metadata: LockMetadata;
      try {
        metadata = validateLockMetadata(parseJson(opened.contents, this.paths.lockPath));
      } catch {
        return false;
      }
      if (metadata.hostname !== currentProcess.hostname) return false;
      let inspection;
      try {
        inspection = await this.processInspector.inspect(metadata.pid);
      } catch {
        return false;
      }
      const stale = inspection.status === "absent" ||
        (inspection.status === "alive" && inspection.startIdentity !== metadata.processStartIdentity);
      if (!stale) return false;
      await this.assertParentIdentity(parentIdentity);
      let namedLock: Stats;
      try {
        namedLock = await this.fs.lstat(this.paths.lockPath);
      } catch (error) {
        if (isMissing(error)) return true;
        throw error;
      }
      if (!sameIdentity(namedLock, opened.identity)) {
        throw new Error("Conversation lock identity changed before stale-owner quarantine");
      }
      const quarantineName = `.conversation.lock.stale-${this.randomId()}`;
      if (!/^\.conversation\.lock\.stale-[A-Za-z0-9_-]{1,128}$/u.test(quarantineName)) {
        throw new Error("Conversation stale-lock quarantine ID is invalid");
      }
      const quarantinePath = this.temporaryPath(quarantineName);
      if (await this.pathExists(quarantinePath)) throw new Error("Conversation stale-lock quarantine collision");
      this.notify("lock:quarantine-stale");
      await this.fs.rename(this.paths.lockPath, quarantinePath);
      const quarantined = await this.fs.lstat(quarantinePath);
      this.validateOwnedRegular(quarantined, quarantinePath);
      if (!sameIdentity(quarantined, opened.identity)) {
        throw new Error("Quarantined conversation lock identity does not match the observed stale owner");
      }
      await this.fsyncParent(parentIdentity, "fsync-stale-lock-parent");
      return true;
    } finally {
      await opened.handle.close();
    }
  }

  private async acquireLock(parentIdentity: { dev: number; ino: number }): Promise<{
    readonly identity: { readonly dev: number; readonly ino: number };
    readonly handle: ConversationStateFileHandle;
  }> {
    const currentProcess = await this.processInspector.current();
    const runId = this.randomId();
    const deadline = this.monotonicNow() + this.lockTimeoutMs;
    let first = true;
    while (true) {
      await this.assertParentIdentity(parentIdentity);
      const candidateName = `.conversation.lock.candidate-${runId}`;
      if (!/^\.conversation\.lock\.candidate-[A-Za-z0-9_-]{1,128}$/u.test(candidateName)) {
        throw new Error("Conversation lock candidate ID is invalid");
      }
      const candidatePath = this.temporaryPath(candidateName);
      const metadata = Buffer.from(`${JSON.stringify({ version: 1, pid: currentProcess.pid,
        hostname: currentProcess.hostname, processStartIdentity: currentProcess.startIdentity,
        runId, createdAt: this.now() })}\n`, "utf8");
      let candidateIdentity: { dev: number; ino: number };
      try {
        this.notify("lock:create");
        candidateIdentity = await this.createPreparedFile(candidatePath, metadata, parentIdentity, "lock-candidate");
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const existing = await this.fs.lstat(candidatePath);
        this.validateOwnedRegular(existing, candidatePath);
        candidateIdentity = { dev: existing.dev, ino: existing.ino };
      }
      try {
        await this.fsyncParent(parentIdentity, "fsync-lock-candidate-parent");
        this.notify("lock:link");
        await this.fs.link(candidatePath, this.paths.lockPath);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          await this.removeIfOwned(candidatePath, candidateIdentity);
          throw error;
        }
        await this.removeIfOwned(candidatePath, candidateIdentity);
        if (await this.tryReclaimStaleLock(parentIdentity, currentProcess)) continue;
        if (!first && this.monotonicNow() >= deadline) throw new Error("Timed out acquiring conversation repository lock");
        first = false;
        const remaining = deadline - this.monotonicNow();
        if (remaining <= 0) throw new Error("Timed out acquiring conversation repository lock");
        await this.sleep(Math.min(this.lockPollMs, remaining));
        continue;
      }
      const fixed = await this.openValidated(this.paths.lockPath, parentIdentity, 64 * 1024);
      try {
        if (!sameIdentity(fixed.identity, candidateIdentity) || sha256(fixed.contents) !== sha256(metadata) ||
          JSON.stringify(validateLockMetadata(parseJson(fixed.contents, this.paths.lockPath))) !==
          JSON.stringify(validateLockMetadata(parseJson(metadata, candidatePath)))) {
          throw new Error("Published conversation lock does not match its initialized candidate");
        }
        await this.fsyncParent(parentIdentity, "fsync-lock-linked-parent");
        this.notify("lock:unlink-candidate");
        await this.removeIfOwned(candidatePath, candidateIdentity);
        await this.fsyncParent(parentIdentity, "fsync-lock-candidate-removed-parent");
        return { identity: fixed.identity, handle: fixed.handle };
      } catch (error) {
        await fixed.handle.close();
        try {
          await this.removeIfOwned(this.paths.lockPath, fixed.identity);
          await this.fsyncParent(parentIdentity, "fsync-lock-publication-abort-parent");
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Conversation lock publication and cleanup both failed");
        }
        throw error;
      }
    }
  }

  private async releaseLock(
    lock: { readonly identity: { readonly dev: number; readonly ino: number }; readonly handle: ConversationStateFileHandle },
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    let closed = false;
    try {
      await this.assertParentIdentity(parentIdentity);
      const opened = await lock.handle.stat();
      if (!sameIdentity(opened, lock.identity)) throw new Error("Open conversation repository lock identity changed");
      const current = await this.fs.lstat(this.paths.lockPath);
      if (!sameIdentity(current, lock.identity) || current.isSymbolicLink() || !current.isFile()) {
        throw new Error("Conversation repository lock identity changed before release");
      }
      this.notify("lock:unlink");
      await this.fs.unlink(this.paths.lockPath);
      await lock.handle.close();
      closed = true;
      await this.fsyncParent(parentIdentity, "fsync-lock-parent");
    } finally {
      if (!closed) await lock.handle.close();
    }
  }

  private async withLock<T>(work: (parentIdentity: { dev: number; ino: number }) => Promise<T>): Promise<T> {
    const prepared = await this.preparePaths();
    const parentIdentity = prepared.repositoryDirectoryIdentity;
    const lock = await this.acquireLock(parentIdentity);
    const outcome = await Promise.resolve().then(async () => {
      const secured = await this.preparePaths();
      if (!sameIdentity(secured.repositoryDirectoryIdentity, parentIdentity)) {
        throw new Error("Conversation repository directory changed after lock acquisition");
      }
      await this.recover(parentIdentity);
      return work(parentIdentity);
    }).then(
      (value) => ({ succeeded: true as const, value }),
      (error: unknown) => ({ succeeded: false as const, error }),
    );
    let releaseError: unknown;
    try {
      await this.releaseLock(lock, parentIdentity);
    } catch (error) {
      releaseError = error;
    }
    if (releaseError !== undefined && !outcome.succeeded) {
      throw new AggregateError([outcome.error, releaseError], "Conversation work and lock release both failed");
    }
    if (releaseError !== undefined) throw releaseError;
    if (!outcome.succeeded) throw outcome.error;
    return outcome.value;
  }

  private async removeIfOwned(candidate: string, expectedIdentity: { dev: number; ino: number }): Promise<void> {
    try {
      const current = await this.fs.lstat(candidate);
      if (!sameIdentity(current, expectedIdentity) || current.isSymbolicLink() || !current.isFile()) {
        throw new Error(`Refusing to remove replaced conversation temporary file: ${candidate}`);
      }
      await this.fs.unlink(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async commit(
    replacements: readonly PreparedReplacement[],
    transactionId: string,
    parentIdentity: { dev: number; ino: number },
  ): Promise<void> {
    if (replacements.length === 0) return;
    const sorted = [...replacements].sort((left, right) => left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
    const intent: ConversationTransactionIntent = validateTransactionIntent({
      version: 1,
      repository: this.binding,
      transactionId,
      replacements: sorted.map(({ target, temporary, sha256: digest, bytes }) =>
        ({ target, temporary, sha256: digest, bytes })),
    }, this.binding);
    const intentContents = serializeSnapshot(intent);
    const intentTemporaryPath = this.temporaryPath(
      `.${this.pathImplementation.basename(this.paths.transactionIntentPath)}.${transactionId}.intent.tmp`,
    );
    const createdTemps: Array<{ path: string; identity: { dev: number; ino: number } }> = [];
    let committed = false;
    try {
      for (const replacement of sorted) {
        if (!new Set(["cursor.json", "pending.json", "journal-head.json"]).has(replacement.target) &&
          await this.pathExists(replacement.targetPath)) {
          throw new Error(`Immutable conversation journal target already exists: ${replacement.target}`);
        }
        const identity = await this.createPreparedFile(
          replacement.temporaryPath, replacement.contents, parentIdentity, replacement.target,
        );
        createdTemps.push({ path: replacement.temporaryPath, identity });
      }
      await this.fsyncParent(parentIdentity, "fsync-prepared-parent");
      const intentTemporaryIdentity = await this.createPreparedFile(
        intentTemporaryPath, intentContents, parentIdentity, "transaction-intent",
      );
      createdTemps.push({ path: intentTemporaryPath, identity: intentTemporaryIdentity });
      await this.fsyncParent(parentIdentity, "fsync-intent-temp-parent");
      if (await this.pathExists(this.paths.transactionIntentPath) || await this.pathExists(this.paths.transactionRetiredPath)) {
        throw new Error("Conversation transaction intent collision");
      }
      await this.renameVerifiedFile(intentTemporaryPath, this.paths.transactionIntentPath, {
        sha256: sha256(intentContents), bytes: intentContents.length,
      }, parentIdentity, "rename-intent");
      committed = true;
      await this.validateIntentFile(this.paths.transactionIntentPath, parentIdentity);
      await this.fsyncParent(parentIdentity, "fsync-intent-parent");
      await this.applyIntent(intent, parentIdentity);
    } catch (error) {
      if (!committed && await this.pathExists(this.paths.transactionIntentPath)) {
        try {
          const observed = await this.readOptional(this.paths.transactionIntentPath, parentIdentity, MAX_STATE_FILE_BYTES);
          committed = observed !== undefined && observed.length === intentContents.length &&
            sha256(observed) === sha256(intentContents);
        } catch {
          // A present but unreadable intent fails closed and must not trigger temp cleanup.
          committed = true;
        }
      }
      if (!committed) {
        for (const candidate of createdTemps.reverse()) await this.removeIfOwned(candidate.path, candidate.identity);
        await this.fsyncParent(parentIdentity, "fsync-abort-parent");
      }
      throw error;
    }
  }

  private replacement(target: ConversationStateTarget, contents: Buffer, transactionId: string): PreparedReplacement {
    const temporary = `.${target}.${transactionId}.tmp`;
    return { target, targetPath: this.targetPath(target), temporary, temporaryPath: this.temporaryPath(temporary),
      contents, sha256: sha256(contents), bytes: contents.length };
  }

  private journalChunks(entries: readonly unknown[]): Buffer[] {
    const chunks: Buffer[] = [];
    let lines: string[] = [];
    let bytes = 0;
    const flush = (): void => {
      if (lines.length > 0) chunks.push(Buffer.from(lines.join(""), "utf8"));
      lines = [];
      bytes = 0;
    };
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > MAX_JOURNAL_SEGMENT_BYTES) throw new Error("Conversation journal entry exceeds segment size");
      if (lines.length >= MAX_JOURNAL_SEGMENT_RECORDS || bytes + lineBytes > MAX_JOURNAL_SEGMENT_BYTES) flush();
      lines.push(line);
      bytes += lineBytes;
    }
    flush();
    return chunks;
  }

  private stageJournal(
    kind: JournalKind,
    entries: readonly unknown[],
    previous: JournalFileReference | null,
    transactionId: string,
    replacements: PreparedReplacement[],
  ): JournalFileReference {
    let current = previous;
    for (const segmentContents of this.journalChunks(entries)) {
      const segmentId = this.randomId();
      const segmentTarget = `${kind}.segment.${segmentId}.jsonl`;
      const segmentReplacement = this.replacement(segmentTarget, segmentContents, transactionId);
      replacements.push(segmentReplacement);
      const manifestId = this.randomId();
      const manifestTarget = `${kind}.manifest.${manifestId}.json`;
      const node = validateJournalManifestNode({ version: 1, repository: this.binding, kind, id: manifestId,
        segment: { target: segmentTarget, sha256: segmentReplacement.sha256,
          bytes: segmentReplacement.bytes, records: parseJsonLines(segmentContents, segmentTarget).length },
        previous: current }, this.binding, kind);
      const manifestContents = serializeSnapshot(node);
      const manifestReplacement = this.replacement(manifestTarget, manifestContents, transactionId);
      replacements.push(manifestReplacement);
      current = { target: manifestTarget, sha256: manifestReplacement.sha256, bytes: manifestReplacement.bytes };
    }
    if (current === null) throw new Error("Cannot stage an empty conversation journal update");
    return current;
  }

  async readContextSnapshot(): Promise<ConversationContextSnapshot> {
    return this.withLock(async (parentIdentity) => contextOf(await this.loadState(parentIdentity)));
  }

  async findTerminalAction(identity: TerminalActionIdentity): Promise<TerminalActionSummary | undefined> {
    const found = await this.findTerminalActions([identity]);
    return found.get(identity.actionId);
  }

  async findTerminalActions(
    identities: readonly TerminalActionIdentity[],
  ): Promise<ReadonlyMap<string, TerminalActionSummary>> {
    return this.withLock(async (parentIdentity) => {
      const loaded = await this.loadState(parentIdentity);
      const found = new Map<string, TerminalActionSummary>();
      for (const identity of identities) {
        const key = `${identity.actionId}:${identity.identityDigest}`;
        const value = await this.findIndexValue("terminal-actions", loaded.journalHead.checkpoint.terminalActionIndex,
          key, parentIdentity);
        if (value !== undefined) found.set(identity.actionId, clone(value as TerminalActionSummary));
      }
      return found;
    });
  }

  async findMemory(id: string): Promise<MemoryIndexSummary | undefined> {
    return this.withLock(async (parentIdentity) => {
      const loaded = await this.loadState(parentIdentity);
      const value = await this.findIndexValue("memories", loaded.journalHead.checkpoint.memoryIndex, id, parentIdentity);
      return value === undefined ? undefined : clone(value as MemoryIndexSummary);
    });
  }

  async findFinding(id: string): Promise<FindingIndexSummary | undefined> {
    return this.withLock(async (parentIdentity) => {
      const loaded = await this.loadState(parentIdentity);
      const value = await this.findIndexValue("findings", loaded.journalHead.checkpoint.findingIndex, id, parentIdentity);
      return value === undefined ? undefined : clone(value as FindingIndexSummary);
    });
  }

  async readAuditPage(journal: JournalKind, cursor: ConversationAuditCursor | null = null, limit = 100): Promise<{
    readonly entries: readonly unknown[]; readonly nextCursor: ConversationAuditCursor | null;
  }> {
    if (!["events", "memories", "findings"].includes(journal) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Conversation audit page journal and limit are invalid");
    }
    return this.withLock(async (parentIdentity) => {
      const headContents = await this.readOptional(this.paths.journalHeadPath, parentIdentity);
      const head = headContents === undefined ? emptyJournalHead(this.binding) :
        validateJournalHead(parseJson(headContents, this.paths.journalHeadPath), this.binding);
      if (cursor !== null && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= 100)) {
        throw new Error("Conversation audit cursor offset is invalid");
      }
      const reference = cursor?.manifest ?? head[journal];
      if (reference === null) return { entries: [], nextCursor: null };
      const manifestPath = this.targetPath(reference.target);
      const manifestContents = await this.readOptional(manifestPath, parentIdentity, 64 * 1024);
      if (manifestContents === undefined || manifestContents.length !== reference.bytes ||
        sha256(manifestContents) !== reference.sha256) throw new Error("Conversation audit manifest is missing or corrupt");
      const manifest = validateJournalManifestNode(parseJson(manifestContents, manifestPath), this.binding, journal);
      const segmentPath = this.targetPath(manifest.segment.target);
      const segmentContents = await this.readOptional(segmentPath, parentIdentity, MAX_JOURNAL_SEGMENT_BYTES);
      if (segmentContents === undefined || segmentContents.length !== manifest.segment.bytes ||
        sha256(segmentContents) !== manifest.segment.sha256) throw new Error("Conversation audit segment is missing or corrupt");
      const raw = parseJsonLines(segmentContents, segmentPath);
      const validated = journal === "events" ? raw.map((entry, index) =>
        validateEventEntry(entry, this.binding, `audit events[${index}]`)) :
        journal === "memories" ? validateMemoryEntries(raw, this.binding, raw.length) :
          validateFindingEntries(raw, this.binding, raw.length);
      const offset = cursor?.offset ?? 0;
      const entries = validated.slice(offset, offset + limit);
      const nextOffset = offset + entries.length;
      const nextCursor = nextOffset < validated.length
        ? { manifest: reference, offset: nextOffset }
        : manifest.previous === null ? null : { manifest: manifest.previous, offset: 0 };
      return { entries: clone(entries), nextCursor };
    });
  }

  async transact<T>(fn: (tx: ConversationStateTransaction) => T): Promise<T> {
    if (typeof fn !== "function") throw new Error("Conversation state transaction callback must be a function");
    return this.withLock((parentIdentity) => this.applyTransaction(parentIdentity, fn));
  }

  async withExclusiveLock<T>(fn: (session: ConversationExclusiveSession) => Promise<T>): Promise<T> {
    if (typeof fn !== "function") throw new Error("Conversation exclusive lock callback must be a function");
    return this.withLock(async (parentIdentity) => {
      const session: ConversationExclusiveSession = {
        snapshot: () => {
          throw new Error("Conversation exclusive session snapshot must be loaded before use");
        },
        commit: (txFn) => this.applyTransaction(parentIdentity, txFn),
        findTerminalAction: async (identity) => {
          const loaded = await this.loadState(parentIdentity);
          const value = await this.findIndexValue(
            "terminal-actions",
            loaded.journalHead.checkpoint.terminalActionIndex,
            `${identity.actionId}:${identity.identityDigest}`,
            parentIdentity,
          );
          return value === undefined ? undefined : clone(value as TerminalActionSummary);
        },
      };
      let loaded = await this.loadState(parentIdentity);
      session.snapshot = () => contextOf(loaded);
      const originalCommit = session.commit;
      session.commit = async (txFn) => {
        const result = await originalCommit(txFn);
        loaded = await this.loadState(parentIdentity);
        return result;
      };
      return fn(session);
    });
  }

  private async applyTransaction<T>(
    parentIdentity: { dev: number; ino: number },
    fn: (tx: ConversationStateTransaction) => T,
  ): Promise<T> {
      const loaded = await this.loadState(parentIdentity);
      let cursor = clone(loaded.cursor);
      let pending = clone(loaded.pending);
      let writeCursor = false;
      let writePending = false;
      const addedEvents: ConversationEventEntry[] = [];
      const addedMemories: MemoryEntry[] = [];
      const addedFindings: FindingLedgerEntry[] = [];
      let initialized = loaded.cursorExists && loaded.pendingExists;

      const tx: ConversationStateTransaction = {
        get snapshot() {
          return contextOf({ ...loaded, cursor, pending, events: [...loaded.events, ...addedEvents],
            memoryLedger: [...loaded.memoryLedger, ...addedMemories], findings: [...loaded.findings, ...addedFindings] });
        },
        initializeIfAbsent: () => {
          if (initialized) return false;
          initialized = true;
          if (!loaded.cursorExists) writeCursor = true;
          if (!loaded.pendingExists) writePending = true;
          return true;
        },
        appendEvent: (entry) => {
          const candidate = [...loaded.events, ...addedEvents, entry];
          const validated = validateEventEntries(candidate, this.binding, candidate.length);
          addedEvents.push(validated[validated.length - 1]!);
        },
        appendMemory: (entry) => {
          const candidate = [...loaded.memoryLedger, ...addedMemories, entry];
          const validated = validateMemoryEntries(candidate, this.binding, candidate.length);
          materializeMemories(validated);
          addedMemories.push(validated[validated.length - 1]!);
        },
        appendFinding: (entry) => {
          const candidate = [...loaded.findings, ...addedFindings, entry];
          const validated = validateFindingEntries(candidate, this.binding, candidate.length);
          addedFindings.push(validated[validated.length - 1]!);
        },
        replaceCursor: (value) => { cursor = validateCursorSnapshot(value, this.binding); writeCursor = true; },
        replacePending: (value) => { pending = validatePendingSnapshot(value, this.binding); writePending = true; },
      };

      const result = fn(tx);
      if ((typeof result === "object" && result !== null && "then" in result) ||
        (typeof result === "function" && "then" in result)) {
        throw new Error("Conversation state transaction callbacks must be synchronous and cannot return thenables");
      }
      const eventCandidates = [...loaded.events, ...addedEvents];
      const memoryCandidates = [...loaded.memoryLedger, ...addedMemories];
      const findingCandidates = [...loaded.findings, ...addedFindings];
      const events = validateEventEntries(eventCandidates, this.binding, eventCandidates.length);
      const memories = validateMemoryEntries(memoryCandidates, this.binding, memoryCandidates.length);
      materializeMemories(memories);
      const findings = validateFindingEntries(findingCandidates, this.binding, findingCandidates.length);
      cursor = validateCursorSnapshot(cursor, this.binding);
      pending = validatePendingSnapshot(pending, this.binding);
      const transactionId = this.randomId();
      const replacements: PreparedReplacement[] = [];
      if (writeCursor) replacements.push(this.replacement("cursor.json", serializeSnapshot(cursor), transactionId));
      let eventsHead = loaded.journalHead.events;
      let memoriesHead = loaded.journalHead.memories;
      let findingsHead = loaded.journalHead.findings;
      if (addedEvents.length > 0) {
        eventsHead = this.stageJournal("events", addedEvents, eventsHead, transactionId, replacements);
      }
      if (addedFindings.length > 0) {
        findingsHead = this.stageJournal("findings", addedFindings, findingsHead, transactionId, replacements);
      }
      if (addedMemories.length > 0) {
        memoriesHead = this.stageJournal("memories", addedMemories, memoriesHead, transactionId, replacements);
      }
      const priorActionStates = new Map<string, ConversationEventEntry>();
      for (const entry of loaded.events) priorActionStates.set(entry.actionId, entry);
      const newlyTerminal: TerminalActionSummary[] = [];
      for (const entry of addedEvents) {
        const previous = priorActionStates.get(entry.actionId);
        priorActionStates.set(entry.actionId, entry);
        if ((entry.state === "completed" || entry.state === "superseded") &&
          previous?.state !== "completed" && previous?.state !== "superseded") {
          const identityDigest = entry.identityDigest;
          newlyTerminal.push({ key: `${entry.actionId}:${identityDigest}`, actionId: entry.actionId, identityDigest,
            state: entry.state, successorActionId: entry.successorActionId, at: entry.at,
            manifestDigest: sha256(Buffer.from(JSON.stringify(entry.manifest), "utf8")),
            reconciliationDigest: sha256(Buffer.from(JSON.stringify({ repository: this.binding,
              actionId: entry.actionId, successorActionId: entry.successorActionId, manifest: entry.manifest }), "utf8")) });
        }
      }
      for (const summary of newlyTerminal) {
        if (await this.findIndexValue("terminal-actions", loaded.journalHead.checkpoint.terminalActionIndex,
          summary.key, parentIdentity) !== undefined) throw new Error("duplicate terminal action identity");
      }
      const addedActionIdentities = new Set(addedEvents.map((entry) => `${entry.actionId}:${entry.identityDigest}`));
      for (const key of addedActionIdentities) {
        if (await this.findIndexValue("terminal-actions", loaded.journalHead.checkpoint.terminalActionIndex,
          key, parentIdentity) !== undefined) throw new Error("action identity is already terminal");
      }
      for (const entry of addedMemories) {
        const known = await this.findIndexValue("memories", loaded.journalHead.checkpoint.memoryIndex,
          entry.id, parentIdentity) as MemoryIndexSummary | undefined;
        if (entry.operation === "create" && known !== undefined) throw new Error("duplicate memory create already recorded by index");
        if (entry.operation === "tombstone" && known?.status === "tombstoned") throw new Error("duplicate memory tombstone already recorded by index");
      }
      const reboundFindings = new Set<string>();
      for (const entry of addedFindings) {
        const known = await this.findIndexValue("findings", loaded.journalHead.checkpoint.findingIndex,
          entry.id, parentIdentity) as FindingIndexSummary | undefined;
        if (known === undefined) continue;
        if (known.contentDigest !== entry.contentDigest) throw new Error("finding index digest conflict");
        if (entry.identity === undefined) throw new Error("duplicate finding already recorded by index");
        reboundFindings.add(entry.id);
      }
      const terminalActionIndex = await this.upsertIndex("terminal-actions",
        loaded.journalHead.checkpoint.terminalActionIndex, newlyTerminal, transactionId, replacements, parentIdentity);
      const memoryIndexValues: MemoryIndexSummary[] = addedMemories.map((entry) => ({ key: entry.id, id: entry.id,
        status: entry.operation === "create" ? "active" : "tombstoned",
        entryDigest: sha256(Buffer.from(JSON.stringify(entry), "utf8")), at: entry.at }));
      const memoryIndex = await this.upsertIndex("memories", loaded.journalHead.checkpoint.memoryIndex,
        memoryIndexValues, transactionId, replacements, parentIdentity);
      const findingIndexValues: FindingIndexSummary[] = addedFindings
        .filter((entry) => !reboundFindings.has(entry.id))
        .map((entry) => ({ key: entry.id, id: entry.id,
        contentDigest: entry.contentDigest, reviewNumber: entry.reviewNumber, reviewId: entry.reviewId,
        bindingDigest: sha256(Buffer.from(JSON.stringify({ repository: entry.repository, reviewNumber: entry.reviewNumber,
          reviewId: entry.reviewId, baseSha: entry.baseSha, headSha: entry.headSha }), "utf8")) }));
      const findingIndex = await this.upsertIndex("findings", loaded.journalHead.checkpoint.findingIndex,
        findingIndexValues, transactionId, replacements, parentIdentity);
      if (addedEvents.length > 0 || addedFindings.length > 0 || addedMemories.length > 0) {
        const journalHead = this.checkpoint({ events: eventsHead, memories: memoriesHead, findings: findingsHead },
          loaded.journalHead.checkpoint, events, memories, findings,
          { terminalActionIndex, memoryIndex, findingIndex }, newlyTerminal);
        replacements.push(this.replacement("journal-head.json", serializeSnapshot(journalHead), transactionId));
      }
      if (writePending) replacements.push(this.replacement("pending.json", serializeSnapshot(pending), transactionId));
      await this.commit(replacements, transactionId, parentIdentity);
      return result;
  }
}

export type ConcreteConversationStateStore = ConversationStateStore & { readonly repositoryBinding: Readonly<RepositoryBinding> };

export function createConversationStateStore(options: ConversationStateStoreOptions): ConcreteConversationStateStore {
  return new FileConversationStateStore(options);
}
