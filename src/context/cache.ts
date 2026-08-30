import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename as fsRename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  ContextValidationError,
  digestArtifactInputs,
  validateArtifactRecords,
} from "./artifact-validator.js";
import { repositoryLabel } from "./types.js";
import type {
  ArtifactRecord,
  ContextCacheKey,
  ContextLookupOptions,
  ContextManifest,
  ContextManifestInput,
  DocumentRecord,
} from "./types.js";

/**
 * Age past which a publication claim is treated as abandoned.
 *
 * `promoteContext` deliberately leaves its claim behind when a process dies
 * mid-publication, so that a later publisher cannot guess it is stale and
 * overlap a live one. That is the right instinct and the wrong end state:
 * nothing else ever creates the entry, so every later run re-maps, finds the
 * claim still held, and gives up — permanently, and under `--context require`
 * as a non-zero exit — until someone deletes the directory by hand.
 *
 * An hour resolves it without weakening the original reason. A live publisher
 * holds its claim for one `promoteContext`: hashing the mapped artifacts and
 * renaming them into place. That is seconds to tens of seconds on a large
 * repository, and the reclaim is atomic besides, so the only way to lose this
 * race is to be an hour into a rename.
 */
const STALE_CLAIM_AGE_MS = 60 * 60 * 1000;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_READY_MANIFEST_BYTES = 1024 * 1024;
type Rename = (source: string, destination: string) => Promise<void>;
type Open = typeof open;
type BeforeManifestReplace = (manifestPath: string, temporaryPath: string) => Promise<void>;
type DirectoryIdentity = { dev: number; ino: number; realPath: string };

export interface ContextCacheDependencies {
  rename?: Rename;
  claimRename?: Rename;
  lookupOpen?: Open;
  beforeManifestReplace?: BeforeManifestReplace;
}

/**
 * Compare-and-swap replacement of the entry already at the destination.
 *
 * Under the identity key of issue #60, every publication of a repository
 * targets the SAME directory, which normally already holds the previous
 * entry — so what was an exotic conflict under per-base keys is now the
 * common case. A replacement is safe only as a CAS: when the existing entry's
 * hash matches the one this publication was derived from (`parentManifestHash`
 * for a patch) — or the caller states there is nothing to expect (`null`, the
 * full-map case) — the old entry is renamed aside and removed after the new
 * one is in place. Any other existing hash means a concurrent publisher moved
 * the index forward and its entry is not ours to replace: conflict, as before.
 *
 * Same-repo publishers are serialised by the repository lock (#78), so this
 * CAS decides between legitimate racers, not against a storm.
 */
export interface ContextReplacement {
  /** The manifest hash the destination is expected to hold, or null for "replace whatever is there". */
  readonly expectedExistingManifestHash: string | null;
}

export class ContextCacheConflictError extends Error {
  constructor(destination: string) {
    super(`A different context cache entry already exists at ${destination}`);
    this.name = "ContextCacheConflictError";
  }
}

export class ContextCachePublicationInProgressError extends Error {
  constructor(destination: string) {
    super(`Context cache publication is already in progress for ${destination}`);
    this.name = "ContextCachePublicationInProgressError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isUnsafeLookupPath(error: unknown): boolean {
  return isMissing(error) || (isRecord(error) && error.code === "ELOOP");
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRenameCollision(error: unknown): boolean {
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizedManifestIdentity(manifest: ContextManifest): Omit<ContextManifest, "manifestHash"> {
  const identity = { ...manifest };
  delete (identity as Partial<ContextManifest>).manifestHash;
  return {
    ...(identity as Omit<ContextManifest, "manifestHash">),
    artifacts: [...identity.artifacts].sort(compareRecords),
    documents: [...identity.documents].sort(compareRecords),
    degradedReasons: [...identity.degradedReasons].sort(),
  };
}

function compareRecords(left: { kind: string; path: string }, right: { kind: string; path: string }): number {
  return left.path < right.path ? -1 : 1;
}

export function computeManifestHash(manifest: ContextManifest): string {
  return createHash("sha256").update(canonicalJson(normalizedManifestIdentity(manifest))).digest("hex");
}

function validateComponent(name: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    path.isAbsolute(value)
  ) {
    throw new ContextValidationError(`Invalid context cache key ${name}`);
  }
}

function validateKey(value: unknown): asserts value is ContextCacheKey {
  if (!isRecord(value)) throw new ContextValidationError("Invalid context cache key");
  // No `baseSha`: the key is a repository-and-versions identity (#60). Which
  // commit the graphs were built from lives on the manifest as provenance.
  const commonKeys = [
      "host",
      "policyVersion",
      "provider",
      "repo",
      "schemaVersion",
      "tgdVersion",
  ];
  const expectedKeys = value.provider === "github"
    ? [...commonKeys, "owner"]
    : value.provider === "gitlab"
      ? [...commonKeys, "namespace", ...(value.port === undefined ? [] : ["port"])]
      : undefined;
  if (expectedKeys === undefined) throw new ContextValidationError("Invalid context cache key provider");
  if (!hasExactKeys(value, expectedKeys.sort())) {
    throw new ContextValidationError("Invalid context cache key fields");
  }
  for (const name of ["host", "repo", "tgdVersion", "policyVersion"] as const) {
    validateComponent(name, value[name]);
  }
  if (value.provider === "github") {
    validateComponent("owner", value.owner);
  } else {
    if (!Array.isArray(value.namespace) || value.namespace.length === 0) {
      throw new ContextValidationError("Invalid context cache key namespace");
    }
    value.namespace.forEach((segment, index) => validateComponent(`namespace[${index}]`, segment));
    if (
      value.port !== undefined &&
      (!Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)
    ) {
      throw new ContextValidationError("Invalid context cache key port");
    }
  }
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    throw new ContextValidationError("Invalid context cache key schemaVersion");
  }
}

function exactKey(left: ContextCacheKey, right: ContextCacheKey): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseArtifactRecord(value: unknown): ArtifactRecord {
  if (!isRecord(value)) throw new ContextValidationError("Invalid artifact record");
  return value as unknown as ArtifactRecord;
}

function parseDocumentRecord(value: unknown): DocumentRecord {
  if (!isRecord(value)) throw new ContextValidationError("Invalid document record");
  return value as unknown as DocumentRecord;
}

const SHA40_PATTERN = /^[0-9a-f]{40}$/u;

function parseReadyManifest(value: unknown): ContextManifest {
  if (!isRecord(value) || value.version !== 1 || value.status !== "ready") {
    throw new ContextValidationError("Manifest is not ready version 1");
  }
  if (
    !hasExactKeys(value, [
      "artifacts",
      "builtFromSha",
      "createdAt",
      "degradedReasons",
      "documents",
      "generation",
      "key",
      "manifestHash",
      "parentManifestHash",
      "status",
      "version",
    ])
  ) {
    throw new ContextValidationError("Manifest contains unexpected or missing fields");
  }
  validateKey(value.key);
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new ContextValidationError("Invalid manifest createdAt timestamp");
  }
  if (typeof value.manifestHash !== "string" || !HASH_PATTERN.test(value.manifestHash)) {
    throw new ContextValidationError("Invalid manifest hash");
  }
  // Provenance (#60). A graph is only strictly true of the tree it was built
  // from, so the commit it names must be present and SHA-shaped; whether it is
  // the SHA under review is the CALLER's delta decision, not a parse error.
  if (typeof value.builtFromSha !== "string" || !SHA40_PATTERN.test(value.builtFromSha)) {
    throw new ContextValidationError("Invalid manifest builtFromSha");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw new ContextValidationError("Invalid manifest generation");
  }
  if (
    value.parentManifestHash !== null &&
    (typeof value.parentManifestHash !== "string" || !HASH_PATTERN.test(value.parentManifestHash))
  ) {
    throw new ContextValidationError("Invalid manifest parentManifestHash");
  }
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.documents) || !Array.isArray(value.degradedReasons)) {
    throw new ContextValidationError("Invalid manifest record lists");
  }
  if (!value.degradedReasons.every((reason) => typeof reason === "string" && reason.length > 0)) {
    throw new ContextValidationError("Invalid degraded reason");
  }
  return {
    version: 1,
    status: "ready",
    key: value.key,
    createdAt: value.createdAt,
    manifestHash: value.manifestHash,
    artifacts: value.artifacts.map(parseArtifactRecord),
    documents: value.documents.map(parseDocumentRecord),
    degradedReasons: [...value.degradedReasons] as string[],
    builtFromSha: value.builtFromSha as string,
    generation: value.generation as number,
    parentManifestHash: value.parentManifestHash as string | null,
  };
}

function buildManifest(
  input: ContextManifestInput,
  records: { artifacts: ArtifactRecord[]; documents: DocumentRecord[] },
): ContextManifest {
  const manifest: ContextManifest = {
    version: 1,
    status: "ready",
    key: { ...input.key },
    createdAt: input.createdAt,
    manifestHash: "",
    artifacts: [...records.artifacts].sort(compareRecords),
    documents: [...records.documents].sort(compareRecords),
    degradedReasons: [...(input.degradedReasons ?? [])].sort(),
    builtFromSha: input.builtFromSha,
    generation: input.generation ?? 0,
    parentManifestHash: input.parentManifestHash ?? null,
  };
  const parsed = parseReadyManifest({ ...manifest, manifestHash: "0".repeat(64) });
  manifest.manifestHash = computeManifestHash(parsed);
  return manifest;
}

function physicallyBeneath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertDirectoryIdentity(directoryPath: string, expected: DirectoryIdentity): Promise<void> {
  const info = await lstat(directoryPath);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino ||
    await realpath(directoryPath) !== expected.realPath
  ) {
    throw new ContextValidationError("Promotion staging directory changed during publication");
  }
}

async function writeReadyManifest(
  manifestPath: string,
  contents: string,
  beforeReplace: BeforeManifestReplace,
  expectedDirectory: DirectoryIdentity,
): Promise<void> {
  const temporaryPath = `${manifestPath}.ready-${process.pid}-${randomUUID()}`;
  let replaced = false;
  try {
    const manifestDirectory = path.dirname(manifestPath);
    await assertDirectoryIdentity(manifestDirectory, expectedDirectory);
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const [handleInfo, pathInfo, physicalTemporaryPath] = await Promise.all([
        handle.stat(),
        lstat(temporaryPath),
        realpath(temporaryPath),
      ]);
      if (
        !handleInfo.isFile() ||
        !sameIdentity(handleInfo, pathInfo) ||
        path.dirname(physicalTemporaryPath) !== expectedDirectory.realPath
      ) {
        throw new ContextValidationError("Ready manifest temporary file escaped staging");
      }
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }

    await beforeReplace(manifestPath, temporaryPath);
    await assertDirectoryIdentity(manifestDirectory, expectedDirectory);
    await fsRename(temporaryPath, manifestPath);
    replaced = true;
  } finally {
    if (!replaced) {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}

export class ContextCache {
  readonly root: string;
  readonly #rename: Rename;
  readonly #claimRename: Rename;
  readonly #lookupOpen: Open;
  readonly #beforeManifestReplace: BeforeManifestReplace;

  constructor(root: string, dependencies: ContextCacheDependencies = {}) {
    if (!path.isAbsolute(root) || root.includes("\0")) {
      throw new ContextValidationError("Context cache root must be an absolute path");
    }
    this.root = path.resolve(root);
    this.#rename = dependencies.rename ?? fsRename;
    this.#claimRename = dependencies.claimRename ?? fsRename;
    this.#lookupOpen = dependencies.lookupOpen ?? open;
    this.#beforeManifestReplace = dependencies.beforeManifestReplace ?? (async () => undefined);
  }

  entryPath(key: ContextCacheKey): string {
    validateKey(key);
    const identity = createHash("sha256").update(canonicalJson(key)).digest("hex");
    return path.join(this.root, "contexts", identity);
  }

  /**
   * Keeps at most `keep` entries per repository, evicting the older ones.
   *
   * The cache root is shared across repositories, and each publication of one
   * repository replaces its own entry — so per-repository growth comes from
   * version bumps and legacy schemas, which is exactly the drift #60 bounds.
   * Grouping reads each entry's manifest for its repository identity; an
   * entry whose manifest cannot be read is left alone UNLESS it is older than
   * `corruptMaxAgeMs`, because legacy-schema manifests fail the current parse
   * and would otherwise survive forever. Freshness protects a manifest a
   * concurrent publisher has just renamed in but this scan read mid-window.
   *
   * NOT race-free against a concurrent publisher of the same entry — that is
   * what the repository lock is for. Call it while holding the lock the
   * mapping flow already holds (#78), so the only publishers it can race are
   * reviews of OTHER repositories, whose entries it never touches: grouping
   * is per repository and an evicted entry is never the newest of its own
   * group, which a live publisher's entry just published is.
   */
  async evictOlderEntries(
    keep: number,
    now: number = Date.now(),
    corruptMaxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    if (!Number.isSafeInteger(keep) || keep < 1) {
      throw new ContextValidationError("Context cache eviction keep count must be a positive integer");
    }
    let contextsDir: string;
    let names: string[];
    try {
      contextsDir = path.join(this.root, "contexts");
      names = await readdir(contextsDir);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }

    const byRepository = new Map<string, Array<{ name: string; createdAt: number }>>();
    const corrupt: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      // Entry directory names are hashes this cache computed; anything else
      // was not written here by this cache and is not ours to judge.
      if (!HASH_PATTERN.test(name)) continue;
      const entryPath = path.join(contextsDir, name);
      const info = await lstat(entryPath).catch(() => undefined);
      if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) continue;
      const manifestContents = await readFile(path.join(entryPath, "manifest.json"), "utf8").catch(() => undefined);
      if (manifestContents === undefined) {
        corrupt.push({ name, mtimeMs: info.mtimeMs });
        continue;
      }
      try {
        const manifest = parseReadyManifest(JSON.parse(manifestContents));
        const group = repositoryLabel(manifest.key);
        const entries = byRepository.get(group) ?? [];
        entries.push({ name, createdAt: Date.parse(manifest.createdAt) });
        byRepository.set(group, entries);
      } catch {
        corrupt.push({ name, mtimeMs: info.mtimeMs });
      }
    }

    let evicted = 0;
    for (const entries of byRepository.values()) {
      entries.sort((left, right) => right.createdAt - left.createdAt);
      for (const entry of entries.slice(keep)) {
        await rm(path.join(contextsDir, entry.name), { recursive: true, force: true }).then(
          () => { evicted += 1; },
          () => undefined,
        );
      }
    }
    for (const entry of corrupt) {
      if (now - entry.mtimeMs < corruptMaxAgeMs) continue;
      await rm(path.join(contextsDir, entry.name), { recursive: true, force: true }).then(
        () => { evicted += 1; },
        () => undefined,
      );
    }
    return evicted;
  }

  async lookupContext(
    key: ContextCacheKey,
    options: ContextLookupOptions = {},
  ): Promise<ContextManifest | undefined> {
    if (options.forceRemap) return undefined;
    let entry: string;
    try {
      entry = this.entryPath(key);
    } catch {
      return undefined;
    }

    try {
      const entryInfo = await lstat(entry);
      if (!entryInfo.isDirectory() || entryInfo.isSymbolicLink()) return undefined;
      const parentInfo = await lstat(path.dirname(entry));
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return undefined;
      const manifestPath = path.join(entry, "manifest.json");
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) return undefined;
      if (manifestInfo.size > MAX_READY_MANIFEST_BYTES) return undefined;
      let parsedJson: unknown;
      try {
        const handle = await this.#lookupOpen(
          manifestPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const currentInfo = await handle.stat();
          const [currentEntryInfo, currentParentInfo] = await Promise.all([
            lstat(entry),
            lstat(path.dirname(entry)),
          ]);
          if (
            !currentInfo.isFile() ||
            currentInfo.size > MAX_READY_MANIFEST_BYTES ||
            !sameIdentity(currentInfo, manifestInfo) ||
            !sameIdentity(currentEntryInfo, entryInfo) ||
            !sameIdentity(currentParentInfo, parentInfo) ||
            currentEntryInfo.isSymbolicLink() ||
            currentParentInfo.isSymbolicLink()
          ) return undefined;
          const contents = Buffer.alloc(currentInfo.size);
          const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
          const probe = Buffer.allocUnsafe(1);
          const trailing = await handle.read(probe, 0, 1, currentInfo.size);
          if (bytesRead !== currentInfo.size || trailing.bytesRead !== 0) return undefined;
          parsedJson = JSON.parse(contents.toString("utf8"));
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }
      const manifest = parseReadyManifest(parsedJson);
      if (!exactKey(manifest.key, key)) return undefined;
      if (computeManifestHash(manifest) !== manifest.manifestHash) return undefined;
      // The expected base SHA comes from the manifest's provenance, not the
      // key (#60): the key no longer carries a commit.
      await validateArtifactRecords(entry, manifest.builtFromSha, manifest.artifacts, manifest.documents);
      return manifest;
    } catch (error) {
      if (error instanceof ContextValidationError || isUnsafeLookupPath(error)) return undefined;
      throw error;
    }
  }

  /**
   * Discards a publication claim left behind by a process that died, so the
   * next publication can proceed. Returns whether one was actually reclaimed.
   *
   * Only a claim older than `maxAgeMs` is touched — see `STALE_CLAIM_AGE_MS`
   * for why an hour is both safe and necessary. The reclaim itself is a single
   * `rename` to a unique path, never a delete in place: two racing reclaimers
   * mean one `rename` succeeds and the other gets ENOENT, and a publisher
   * somehow still live finds its own paths gone and fails cleanly rather than
   * racing anyone into a half-built ready entry. The rename is the commit
   * point; removing the moved directory afterwards is only housekeeping, and a
   * failure there is not allowed to unsay a reclaim that already happened.
   */
  async reclaimStaleClaim(
    key: ContextCacheKey,
    maxAgeMs: number = STALE_CLAIM_AGE_MS,
    now: number = Date.now(),
  ): Promise<boolean> {
    let claimPath: string;
    try {
      claimPath = `${this.entryPath(key)}.publishing`;
    } catch {
      return false;
    }

    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(claimPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    // A symlink here is not a claim this cache wrote. Following it would move
    // or delete something outside the root entirely.
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (now - info.mtimeMs < maxAgeMs) return false;

    const quarantined = `${claimPath}.stale-${randomUUID()}`;
    try {
      await fsRename(claimPath, quarantined);
    } catch (error) {
      // Lost the race to another reclaimer, or the publisher woke and released
      // it. Either way the claim is no longer ours to report on.
      if (isMissing(error)) return false;
      throw error;
    }
    await rm(quarantined, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  async promoteContext(
    stagingPath: string,
    input: ContextManifestInput,
    replacement?: ContextReplacement,
  ): Promise<ContextManifest> {
    validateKey(input.key);
    if (input.documents !== undefined && !Array.isArray(input.documents)) {
      throw new ContextValidationError("Documents must be an array when provided");
    }
    if (input.degradedReasons !== undefined && !Array.isArray(input.degradedReasons)) {
      throw new ContextValidationError("Degraded reasons must be an array when provided");
    }
    if (!path.isAbsolute(stagingPath) || stagingPath.includes("\0")) {
      throw new ContextValidationError("Promotion staging path must be absolute");
    }
    await mkdir(this.root, { recursive: true });
    const [realRoot, realStaging] = await Promise.all([realpath(this.root), realpath(stagingPath)]);
    if (!physicallyBeneath(realRoot, realStaging)) {
      throw new ContextValidationError("Promotion staging directory must be beneath the configured cache root");
    }
    const stagingInfo = await lstat(stagingPath);
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
      throw new ContextValidationError("Promotion staging path must be a real directory");
    }

    const destination = this.entryPath(input.key);
    if (path.resolve(stagingPath) === destination) {
      throw new ContextValidationError("Promotion staging directory must be outside the ready destination");
    }
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    if (!physicallyBeneath(realRoot, realParent)) {
      throw new ContextValidationError("Ready destination escapes the configured cache root");
    }

    const claimPath = `${destination}.publishing`;
    try {
      await mkdir(claimPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const records = await digestArtifactInputs(
        stagingPath,
        input.builtFromSha,
        input.artifacts,
        input.documents ?? [],
      );
      const manifest = buildManifest(input, records);
      const concurrentlyPublished = await this.lookupContext(input.key);
      if (concurrentlyPublished?.manifestHash === manifest.manifestHash) return concurrentlyPublished;
      if (concurrentlyPublished !== undefined) throw new ContextCacheConflictError(destination);
      throw new ContextCachePublicationInProgressError(destination);
    }

    const claimedStagingPath = path.join(claimPath, "entry");
    let published = false;
    const publicationResult = await (async () => {
      await this.#claimRename(stagingPath, claimedStagingPath);
      const claimedStagingInfo = await lstat(claimedStagingPath);
      if (!claimedStagingInfo.isDirectory() || claimedStagingInfo.isSymbolicLink()) {
        throw new ContextValidationError("Promotion staging path must remain a real directory after claiming");
      }
      const realClaimedStaging = await realpath(claimedStagingPath);
      if (!physicallyBeneath(realRoot, realClaimedStaging)) {
        throw new ContextValidationError("Promotion staging directory escaped the configured cache root after claiming");
      }
      const claimedStagingIdentity: DirectoryIdentity = {
        dev: claimedStagingInfo.dev,
        ino: claimedStagingInfo.ino,
        realPath: realClaimedStaging,
      };
      await assertDirectoryIdentity(claimedStagingPath, claimedStagingIdentity);
      const records = await digestArtifactInputs(
        claimedStagingPath,
        input.builtFromSha,
        input.artifacts,
        input.documents ?? [],
      );
      await assertDirectoryIdentity(claimedStagingPath, claimedStagingIdentity);
      const manifest = buildManifest(input, records);
      const existing = await this.lookupContext(input.key);
      if (existing !== undefined) {
        if (existing.manifestHash === manifest.manifestHash) return existing;
        if (replacement === undefined) throw new ContextCacheConflictError(destination);
        if (
          replacement.expectedExistingManifestHash !== null &&
          existing.manifestHash !== replacement.expectedExistingManifestHash
        ) {
          // A concurrent publisher moved the index forward. Its entry is newer
          // than the parent this publication was derived from, so replacing
          // it would discard work this run never saw.
          throw new ContextCacheConflictError(destination);
        }
      }
      if (replacement === undefined) {
        try {
          await lstat(destination);
          throw new ContextCacheConflictError(destination);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }

      const stagingManifestPath = path.join(claimedStagingPath, "manifest.json");
      await assertDirectoryIdentity(claimedStagingPath, claimedStagingIdentity);
      try {
        const stagingManifestInfo = await lstat(stagingManifestPath);
        if (stagingManifestInfo.isSymbolicLink()) {
          throw new ContextValidationError("Staging manifest must not be a symbolic link");
        }
        if (!stagingManifestInfo.isFile()) {
          throw new ContextValidationError("Staging manifest must be a regular file when present");
        }
        if (stagingManifestInfo.nlink !== 1) {
          throw new ContextValidationError("Staging manifest must not have multiple hard links");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await writeReadyManifest(
        stagingManifestPath,
        `${canonicalJson(manifest)}\n`,
        this.#beforeManifestReplace,
        claimedStagingIdentity,
      );
      try {
        // The exclusive claim prevents conforming publishers from entering this
        // window together. Node has no portable no-replace directory rename, so
        // an arbitrary non-cooperating process can still race in an empty target.
        await this.#rename(claimedStagingPath, destination);
        published = true;
      } catch (error) {
        if (!isRenameCollision(error)) throw error;
        const raced = await this.lookupContext(input.key);
        if (raced?.manifestHash === manifest.manifestHash) return raced;
        if (replacement === undefined) throw new ContextCacheConflictError(destination);
        // CAS replacement: the occupied destination is the entry this
        // publication was derived from (the CAS above verified its hash).
        // Rename it aside, rename ours into place, then remove the retired
        // copy. A reader that looks up mid-window gets a miss and re-maps —
        // wasteful, never wrong.
        const retiringPath = `${destination}.retiring-${randomUUID()}`;
        try {
          await this.#rename(destination, retiringPath);
        } catch (retireError) {
          if (isMissing(retireError)) {
            await this.#rename(claimedStagingPath, destination);
            published = true;
            return manifest;
          }
          throw retireError;
        }
        try {
          await this.#rename(claimedStagingPath, destination);
          published = true;
        } finally {
          // Housekeeping after the commit point, like every claim cleanup:
          // a failure here must not unsay a replacement that happened.
          await rm(retiringPath, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      return manifest;
    })().then(
      (value) => ({ succeeded: true as const, value }),
      (error: unknown) => ({ succeeded: false as const, error }),
    );

    const cleanupErrors: unknown[] = [];
    let claimCanBeRemoved = true;
    if (!published) {
      try {
        await lstat(claimedStagingPath);
        let stagingWasReplaced = false;
        try {
          await lstat(stagingPath);
          stagingWasReplaced = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (stagingWasReplaced) {
          claimCanBeRemoved = false;
          cleanupErrors.push(
            new ContextValidationError("Promotion staging path was replaced while publication was in progress"),
          );
        } else {
          await fsRename(claimedStagingPath, stagingPath);
        }
      } catch (error) {
        if (!isMissing(error)) cleanupErrors.push(error);
      }
    }
    if (claimCanBeRemoved) {
      // An in-process success/failure releases its own empty claim. A process
      // crash leaves the claim in place so a later publisher cannot guess that
      // it is stale and overlap a potentially live publisher.
      try {
        await rmdir(claimPath);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      const cleanupError = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, `Context cache publication cleanup failed for ${destination}`);
      if (!publicationResult.succeeded) {
        throw new AggregateError(
          [publicationResult.error, cleanupError],
          `Context cache publication and cleanup both failed for ${destination}`,
        );
      }
      throw cleanupError;
    }
    if (!publicationResult.succeeded) throw publicationResult.error;
    return publicationResult.value;
  }
}
