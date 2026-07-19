import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rename as fsRename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ContextValidationError,
  digestArtifactInputs,
  validateArtifactRecords,
} from "./artifact-validator.js";
import type {
  ArtifactRecord,
  ContextCacheKey,
  ContextLookupOptions,
  ContextManifest,
  ContextManifestInput,
  DocumentRecord,
} from "./types.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_READY_MANIFEST_BYTES = 1024 * 1024;
type Rename = (source: string, destination: string) => Promise<void>;

export interface ContextCacheDependencies {
  rename?: Rename;
  claimRename?: Rename;
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
    path.isAbsolute(value)
  ) {
    throw new ContextValidationError(`Invalid context cache key ${name}`);
  }
}

function validateKey(value: unknown): asserts value is ContextCacheKey {
  if (!isRecord(value)) throw new ContextValidationError("Invalid context cache key");
  if (
    !hasExactKeys(value, [
      "baseSha",
      "host",
      "owner",
      "policyVersion",
      "provider",
      "repo",
      "schemaVersion",
      "tgdVersion",
    ])
  ) {
    throw new ContextValidationError("Invalid context cache key fields");
  }
  if (value.provider !== "github") throw new ContextValidationError("Invalid context cache key provider");
  for (const name of ["host", "owner", "repo", "baseSha", "tgdVersion", "policyVersion"] as const) {
    validateComponent(name, value[name]);
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

function parseReadyManifest(value: unknown): ContextManifest {
  if (!isRecord(value) || value.version !== 1 || value.status !== "ready") {
    throw new ContextValidationError("Manifest is not ready version 1");
  }
  if (
    !hasExactKeys(value, [
      "artifacts",
      "createdAt",
      "degradedReasons",
      "documents",
      "key",
      "manifestHash",
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
  };
  const parsed = parseReadyManifest({ ...manifest, manifestHash: "0".repeat(64) });
  manifest.manifestHash = computeManifestHash(parsed);
  return manifest;
}

function physicallyBeneath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class ContextCache {
  readonly root: string;
  readonly #rename: Rename;
  readonly #claimRename: Rename;

  constructor(root: string, dependencies: ContextCacheDependencies = {}) {
    if (!path.isAbsolute(root) || root.includes("\0")) {
      throw new ContextValidationError("Context cache root must be an absolute path");
    }
    this.root = path.resolve(root);
    this.#rename = dependencies.rename ?? fsRename;
    this.#claimRename = dependencies.claimRename ?? fsRename;
  }

  entryPath(key: ContextCacheKey): string {
    validateKey(key);
    const identity = createHash("sha256").update(canonicalJson(key)).digest("hex");
    return path.join(this.root, "contexts", identity);
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
        const handle = await open(manifestPath, "r");
        try {
          const currentInfo = await handle.stat();
          if (!currentInfo.isFile() || currentInfo.size > MAX_READY_MANIFEST_BYTES) return undefined;
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
      await validateArtifactRecords(entry, key, manifest.artifacts, manifest.documents);
      return manifest;
    } catch (error) {
      if (error instanceof ContextValidationError || isMissing(error)) return undefined;
      throw error;
    }
  }

  async promoteContext(stagingPath: string, input: ContextManifestInput): Promise<ContextManifest> {
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
        input.key,
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
      const records = await digestArtifactInputs(
        claimedStagingPath,
        input.key,
        input.artifacts,
        input.documents ?? [],
      );
      const manifest = buildManifest(input, records);
      const existing = await this.lookupContext(input.key);
      if (existing !== undefined) {
        if (existing.manifestHash === manifest.manifestHash) return existing;
        throw new ContextCacheConflictError(destination);
      }
      try {
        await lstat(destination);
        throw new ContextCacheConflictError(destination);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const stagingManifestPath = path.join(claimedStagingPath, "manifest.json");
      try {
        const stagingManifestInfo = await lstat(stagingManifestPath);
        if (stagingManifestInfo.isSymbolicLink()) {
          throw new ContextValidationError("Staging manifest must not be a symbolic link");
        }
        if (!stagingManifestInfo.isFile()) {
          throw new ContextValidationError("Staging manifest must be a regular file when present");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await writeFile(stagingManifestPath, `${canonicalJson(manifest)}\n`, "utf8");
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
        throw new ContextCacheConflictError(destination);
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
