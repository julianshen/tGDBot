import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactInput,
  ArtifactKind,
  ArtifactRecord,
  ContextCacheKey,
  DocumentInput,
  DocumentRecord,
} from "./types.js";

const EXPECTED_PATHS: Readonly<Record<ArtifactKind, string>> = {
  context: "CONTEXT.md",
  "knowledge-graph": ".understand-anything/knowledge-graph.json",
  "domain-graph": ".understand-anything/domain-graph.json",
  "zero-domains": ".understand-anything/zero-domains.json",
  "mapping-metadata": ".understand-anything/mapping-metadata.json",
};
const ARTIFACT_KINDS = new Set<ArtifactKind>(Object.keys(EXPECTED_PATHS) as ArtifactKind[]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class ContextValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isExpectedMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function validateCacheRelativePath(relativePath: unknown): asserts relativePath is string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new ContextValidationError(`Invalid cache-relative path: ${String(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ContextValidationError(`Invalid cache-relative path: ${relativePath}`);
  }
}

async function readRegularFileWithin(basePath: string, relativePath: string): Promise<Buffer> {
  validateCacheRelativePath(relativePath);
  const candidate = path.resolve(basePath, ...relativePath.split("/"));

  let current = path.resolve(basePath);
  try {
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new ContextValidationError(`Artifact path contains a symbolic link: ${relativePath}`);
      }
    }
    const info = await lstat(candidate);
    if (!info.isFile()) {
      throw new ContextValidationError(`Artifact is not a regular file: ${relativePath}`);
    }
    return await readFile(candidate);
  } catch (error) {
    if (error instanceof ContextValidationError) throw error;
    if (isExpectedMissing(error)) {
      throw new ContextValidationError(`Missing artifact: ${relativePath}`, { cause: error });
    }
    throw error;
  }
}

function parseJsonObject(contents: Buffer, artifactPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(contents.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("expected a JSON object");
    return parsed;
  } catch (error) {
    throw new ContextValidationError(`Invalid JSON artifact: ${artifactPath}`, { cause: error });
  }
}

function validateBusinessContents(contents: Buffer, documentPath: string): void {
  if (contents.length === 0) {
    throw new ContextValidationError(`Business-reference document is empty: ${documentPath}`);
  }
}

function validateArtifactContents(
  kind: ArtifactKind,
  artifactPath: string,
  contents: Buffer,
  key: ContextCacheKey,
): void {
  if (artifactPath !== EXPECTED_PATHS[kind]) {
    throw new ContextValidationError(`${kind} must use ${EXPECTED_PATHS[kind]}`);
  }
  if (kind === "context") {
    if (contents.toString("utf8").trim().length === 0) {
      throw new ContextValidationError("CONTEXT.md must be non-empty");
    }
    return;
  }

  const parsed = parseJsonObject(contents, artifactPath);
  if (kind === "mapping-metadata") {
    if (
      !hasExactKeys(parsed, ["baseSha", "status", "version"]) ||
      parsed.version !== 1 ||
      parsed.status !== "complete" ||
      parsed.baseSha !== key.baseSha
    ) {
      throw new ContextValidationError("Mapping metadata must be complete and match the analyzed base SHA");
    }
  }
  if (kind === "zero-domains") {
    if (
      !hasExactKeys(parsed, ["status", "version"]) ||
      parsed.version !== 1 ||
      parsed.status !== "zero-domains"
    ) {
      throw new ContextValidationError("Invalid zero-domain marker");
    }
  }
}

function validateRecordSets(
  artifacts: readonly (ArtifactInput | ArtifactRecord)[],
  documents: readonly (DocumentInput | DocumentRecord)[],
): void {
  const kinds = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !ARTIFACT_KINDS.has(artifact.kind as ArtifactKind)) {
      throw new ContextValidationError("Invalid artifact record");
    }
    validateCacheRelativePath(artifact.path);
    if (kinds.has(artifact.kind)) throw new ContextValidationError(`Duplicate artifact kind: ${artifact.kind}`);
    if (paths.has(artifact.path)) throw new ContextValidationError(`Duplicate artifact path: ${artifact.path}`);
    kinds.add(artifact.kind);
    paths.add(artifact.path);
  }
  for (const document of documents) {
    if (!isRecord(document) || document.kind !== "business-reference") {
      throw new ContextValidationError("Invalid document record");
    }
    validateCacheRelativePath(document.path);
    if (paths.has(document.path)) throw new ContextValidationError(`Duplicate record path: ${document.path}`);
    paths.add(document.path);
  }

  for (const required of ["context", "knowledge-graph", "mapping-metadata"] as const) {
    if (!kinds.has(required)) throw new ContextValidationError(`Missing required artifact kind: ${required}`);
  }
  const hasDomainGraph = kinds.has("domain-graph");
  const hasZeroDomains = kinds.has("zero-domains");
  if (hasDomainGraph === hasZeroDomains) {
    throw new ContextValidationError("Exactly one domain graph or zero-domain marker is required");
  }
}

function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function digestArtifactInputs(
  basePath: string,
  key: ContextCacheKey,
  artifacts: readonly ArtifactInput[],
  documents: readonly DocumentInput[] = [],
): Promise<{ artifacts: ArtifactRecord[]; documents: DocumentRecord[] }> {
  if (!Array.isArray(artifacts)) throw new ContextValidationError("Artifacts must be an array");
  if (!Array.isArray(documents)) throw new ContextValidationError("Documents must be an array");
  validateRecordSets(artifacts, documents);
  const artifactRecords = await Promise.all(
    artifacts.map(async (artifact): Promise<ArtifactRecord> => {
      const contents = await readRegularFileWithin(basePath, artifact.path);
      validateArtifactContents(artifact.kind, artifact.path, contents, key);
      return { ...artifact, sha256: digest(contents) };
    }),
  );
  const documentRecords = await Promise.all(
    documents.map(async (document): Promise<DocumentRecord> => {
      const contents = await readRegularFileWithin(basePath, document.path);
      validateBusinessContents(contents, document.path);
      return { ...document, sha256: digest(contents) };
    }),
  );
  return {
    artifacts: artifactRecords.sort((left, right) => left.path.localeCompare(right.path)),
    documents: documentRecords.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function validateArtifactRecords(
  basePath: string,
  key: ContextCacheKey,
  artifacts: readonly ArtifactRecord[],
  documents: readonly DocumentRecord[],
): Promise<void> {
  validateRecordSets(artifacts, documents);
  for (const record of [...artifacts, ...documents]) {
    if (!isRecord(record) || typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
      throw new ContextValidationError(`Invalid SHA-256 digest for ${String(record.path)}`);
    }
  }
  const recomputed = await digestArtifactInputs(basePath, key, artifacts, documents);
  const expectedByPath = new Map(
    [...artifacts, ...documents].map((record) => [record.path, record.sha256] as const),
  );
  for (const record of [...recomputed.artifacts, ...recomputed.documents]) {
    if (expectedByPath.get(record.path) !== record.sha256) {
      throw new ContextValidationError(`Artifact digest mismatch: ${record.path}`);
    }
  }
}
