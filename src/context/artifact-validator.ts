import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
const NODE_TYPES = new Set([
  "file", "function", "class", "module", "concept", "config", "document", "service", "table", "endpoint",
  "pipeline", "schema", "resource", "domain", "flow", "step", "article", "entity", "topic", "claim", "source",
]);
const DOMAIN_NODE_TYPES = new Set(["domain", "flow", "step"]);
const EDGE_TYPES = new Set([
  "imports", "exports", "contains", "inherits", "implements", "calls", "subscribes", "publishes", "middleware",
  "reads_from", "writes_to", "transforms", "validates", "depends_on", "tested_by", "configures", "related",
  "similar_to", "deploys", "serves", "provisions", "triggers", "migrates", "documents", "routes",
  "defines_schema", "contains_flow", "flow_step", "cross_domain", "cites", "contradicts", "builds_on",
  "exemplifies", "categorized_under", "authored_by",
]);
const DOMAIN_EDGE_TYPES = new Set(["contains_flow", "flow_step", "cross_domain"]);
const DIRECTIONS = new Set(["forward", "backward", "bidirectional"]);
const COMPLEXITIES = new Set(["simple", "moderate", "complex"]);
const ENTRY_TYPES = new Set(["http", "cli", "event", "cron", "manual"]);
/** Caps any single parsed JSON artifact at 64 MiB to bound local CLI memory use. */
const MAX_JSON_ARTIFACT_BYTES = 64 * 1024 * 1024;

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
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[a-z]:/i.test(relativePath)
  ) {
    throw new ContextValidationError(`Invalid cache-relative path: ${String(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ContextValidationError(`Invalid cache-relative path: ${relativePath}`);
  }
  const lowerPath = relativePath.toLowerCase();
  if (lowerPath === "manifest.json" || lowerPath === ".tgd-cache" || lowerPath.startsWith(".tgd-cache/")) {
    throw new ContextValidationError(`Reserved cache-control path: ${relativePath}`);
  }
}

async function resolveRegularFileWithin(
  basePath: string,
  relativePath: string,
): Promise<{ filePath: string; size: number }> {
  validateCacheRelativePath(relativePath);
  const resolvedBase = path.resolve(basePath);
  const candidate = path.resolve(resolvedBase, ...relativePath.split("/"));
  const relative = path.relative(resolvedBase, candidate);
  assert(
    relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    new ContextValidationError(`Artifact path escapes cache entry after resolution: ${relativePath}`),
  );

  let current = resolvedBase;
  try {
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new ContextValidationError(`Artifact path contains a symbolic link: ${relativePath}`);
      }
    }
    const info = await stat(candidate);
    if (!info.isFile()) {
      throw new ContextValidationError(`Artifact is not a regular file: ${relativePath}`);
    }
    return { filePath: candidate, size: info.size };
  } catch (error) {
    if (error instanceof ContextValidationError) throw error;
    if (isExpectedMissing(error)) {
      throw new ContextValidationError(`Missing artifact: ${relativePath}`, { cause: error });
    }
    throw error;
  }
}

async function readJsonArtifactWithin(basePath: string, relativePath: string): Promise<Buffer> {
  const resolved = await resolveRegularFileWithin(basePath, relativePath);
  if (resolved.size > MAX_JSON_ARTIFACT_BYTES) {
    throw new ContextValidationError(
      `JSON artifact exceeds maximum safe size (${MAX_JSON_ARTIFACT_BYTES} bytes): ${relativePath}`,
    );
  }
  return readFile(resolved.filePath);
}

async function streamDigestWithin(
  basePath: string,
  relativePath: string,
  inspectText: boolean,
): Promise<{ sha256: string; size: number; hasNonWhitespace: boolean }> {
  const resolved = await resolveRegularFileWithin(basePath, relativePath);
  const hash = createHash("sha256");
  const decoder = inspectText ? new StringDecoder("utf8") : undefined;
  let hasNonWhitespace = false;
  for await (const chunk of createReadStream(resolved.filePath)) {
    hash.update(chunk);
    if (decoder !== undefined && /\S/u.test(decoder.write(chunk))) hasNonWhitespace = true;
  }
  if (decoder !== undefined && /\S/u.test(decoder.end())) hasNonWhitespace = true;
  return { sha256: hash.digest("hex"), size: resolved.size, hasNonWhitespace };
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isSafeRepositoryRelativePath(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  ) {
    return false;
  }
  return value.split(/[\\/]/).every(
    (segment) => segment.trim().length > 0 && segment !== "." && segment !== "..",
  );
}

function isProject(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.name === "string" &&
    isStringArray(value.languages) &&
    isStringArray(value.frameworks) &&
    typeof value.description === "string" &&
    typeof value.analyzedAt === "string" &&
    typeof value.gitCommitHash === "string";
}

function isDomainMeta(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (value.entities === undefined || isStringArray(value.entities)) &&
    (value.businessRules === undefined || isStringArray(value.businessRules)) &&
    (value.crossDomainInteractions === undefined || isStringArray(value.crossDomainInteractions)) &&
    isOptionalString(value, "entryPoint") &&
    (value.entryType === undefined || ENTRY_TYPES.has(value.entryType as string));
}

function isKnowledgeMeta(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (value.wikilinks === undefined || isStringArray(value.wikilinks)) &&
    (value.backlinks === undefined || isStringArray(value.backlinks)) &&
    isOptionalString(value, "category") &&
    isOptionalString(value, "content");
}

function isGraphNode(value: unknown, domainOnly: boolean): boolean {
  if (!isRecord(value)) return false;
  const allowedTypes = domainOnly ? DOMAIN_NODE_TYPES : NODE_TYPES;
  return typeof value.id === "string" &&
    allowedTypes.has(value.type as string) &&
    typeof value.name === "string" &&
    (value.filePath === undefined || isSafeRepositoryRelativePath(value.filePath)) &&
    (value.lineRange === undefined ||
      (Array.isArray(value.lineRange) && value.lineRange.length === 2 &&
        value.lineRange.every((line) => typeof line === "number" && Number.isFinite(line)))) &&
    typeof value.summary === "string" &&
    isStringArray(value.tags) &&
    COMPLEXITIES.has(value.complexity as string) &&
    isOptionalString(value, "languageNotes") &&
    isDomainMeta(value.domainMeta) &&
    isKnowledgeMeta(value.knowledgeMeta);
}

function isGraphEdge(value: unknown, domainOnly: boolean): boolean {
  if (!isRecord(value)) return false;
  const allowedTypes = domainOnly ? DOMAIN_EDGE_TYPES : EDGE_TYPES;
  return typeof value.source === "string" &&
    typeof value.target === "string" &&
    allowedTypes.has(value.type as string) &&
    DIRECTIONS.has(value.direction as string) &&
    isOptionalString(value, "description") &&
    typeof value.weight === "number" &&
    Number.isFinite(value.weight) &&
    value.weight >= 0 &&
    value.weight <= 1;
}

function isLayer(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isStringArray(value.nodeIds);
}

function isTourStep(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.order === "number" &&
    Number.isFinite(value.order) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    isStringArray(value.nodeIds) &&
    isOptionalString(value, "languageLesson");
}

function validateGraph(parsed: Record<string, unknown>, artifactPath: string, domainOnly: boolean): void {
  const validKind = parsed.kind === undefined || parsed.kind === "codebase" || parsed.kind === "knowledge";
  const validNodes = Array.isArray(parsed.nodes) &&
    parsed.nodes.length > 0 &&
    parsed.nodes.every((node) => isGraphNode(node, domainOnly));
  const hasDomain = !domainOnly || (Array.isArray(parsed.nodes) && parsed.nodes.some(
    (node) => isRecord(node) && node.type === "domain",
  ));
  if (
    typeof parsed.version !== "string" ||
    !validKind ||
    !isProject(parsed.project) ||
    !validNodes ||
    !hasDomain ||
    !Array.isArray(parsed.edges) ||
    !parsed.edges.every((edge) => isGraphEdge(edge, domainOnly)) ||
    !Array.isArray(parsed.layers) ||
    !parsed.layers.every(isLayer) ||
    !Array.isArray(parsed.tour) ||
    !parsed.tour.every(isTourStep)
  ) {
    throw new ContextValidationError(`Invalid Understand Anything graph schema: ${artifactPath}`);
  }
}

function validateBusinessSize(size: number, documentPath: string): void {
  if (size === 0) {
    throw new ContextValidationError(`Business-reference document is empty: ${documentPath}`);
  }
}

function validateExpectedArtifactPath(kind: ArtifactKind, artifactPath: string): void {
  if (artifactPath !== EXPECTED_PATHS[kind]) {
    throw new ContextValidationError(`${kind} must use ${EXPECTED_PATHS[kind]}`);
  }
}

function validateJsonArtifactContents(
  kind: ArtifactKind,
  artifactPath: string,
  contents: Buffer,
  key: ContextCacheKey,
): void {
  const parsed = parseJsonObject(contents, artifactPath);
  if (kind === "knowledge-graph" || kind === "domain-graph") {
    validateGraph(parsed, artifactPath, kind === "domain-graph");
  }
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

async function rejectUndeclaredDomainAlternative(
  basePath: string,
  artifacts: readonly (ArtifactInput | ArtifactRecord)[],
): Promise<void> {
  const selectedDomainGraph = artifacts.some((artifact) => artifact.kind === "domain-graph");
  const alternative = selectedDomainGraph ? EXPECTED_PATHS["zero-domains"] : EXPECTED_PATHS["domain-graph"];
  try {
    await lstat(path.join(basePath, ...alternative.split("/")));
    throw new ContextValidationError(`Undeclared domain alternative exists: ${alternative}`);
  } catch (error) {
    if (error instanceof ContextValidationError) throw error;
    if (!isExpectedMissing(error)) throw error;
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
  await rejectUndeclaredDomainAlternative(basePath, artifacts);
  const artifactRecords: ArtifactRecord[] = [];
  for (const artifact of artifacts) {
    validateExpectedArtifactPath(artifact.kind, artifact.path);
    if (artifact.kind === "context") {
      const streamed = await streamDigestWithin(basePath, artifact.path, true);
      if (!streamed.hasNonWhitespace) throw new ContextValidationError("CONTEXT.md must be non-empty");
      artifactRecords.push({ ...artifact, sha256: streamed.sha256 });
      continue;
    }
    const contents = await readJsonArtifactWithin(basePath, artifact.path);
    validateJsonArtifactContents(artifact.kind, artifact.path, contents, key);
    artifactRecords.push({ ...artifact, sha256: digest(contents) });
  }
  const documentRecords: DocumentRecord[] = [];
  for (const document of documents) {
    const streamed = await streamDigestWithin(basePath, document.path, false);
    validateBusinessSize(streamed.size, document.path);
    documentRecords.push({ ...document, sha256: streamed.sha256 });
  }
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
