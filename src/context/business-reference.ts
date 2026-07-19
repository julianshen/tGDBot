import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { realExecWorkspaceCommand } from "../workspace/manager.js";

const SEMANTIC_HEADINGS = [
  "architecture",
  "domain",
  "business",
  "workflow",
  "concepts",
  "design",
  "invariants",
  "data model",
] as const;
const ROOT_DOCS = ["ARCHITECTURE.md", "DESIGN.md", "DOMAIN.md", "BUSINESS.md"] as const;
const DOC_NAME_KEYWORDS = ["business", "domain", "architecture", "design", "workflow", "concept"] as const;

export interface BusinessReferenceInput {
  sourceRoot: string;
  explicitPaths: string[];
  generatedPath: string;
}

export interface BusinessReferenceResult {
  kind: "existing" | "generated" | "none";
  paths: string[];
  digest: string;
}

export interface BusinessReferenceDependencies {
  listTrackedFiles?: (sourceRoot: string) => Promise<string[]>;
  now?: () => Date;
}

interface TrustedDocument {
  relativePath: string;
  absolutePath: string;
  contents: string;
}

interface DomainGraphSource {
  projectName: string;
  baseSha: string;
  sha256: string;
  nodes: Array<{ id: string; type: "domain" | "flow" | "step"; name: string; summary: string }>;
}

function isBeneath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function emptyDigest(): string {
  return createHash("sha256").update("").digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestDocuments(documents: readonly TrustedDocument[]): string {
  const records = documents.map((document) => ({
    path: document.relativePath,
    sha256: createHash("sha256").update(document.contents).digest("hex"),
  }));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function isAdequate(contents: string): boolean {
  if (contents.trim().length < 500) return false;
  const headings = new Set<string>();
  for (const match of contents.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
    const heading = match[1]!.trim().toLowerCase();
    for (const semantic of SEMANTIC_HEADINGS) {
      if (heading.includes(semantic)) headings.add(semantic);
    }
  }
  return headings.size >= 2;
}

function candidateRank(relativePath: string): [number, number, string] | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (!lower.endsWith(".md")) return;
  const segments = lower.split("/");
  const inAdr = segments.some((segment) => segment === "adr" || segment === "adrs") ||
    /^adr[-_]/u.test(segments.at(-1)!);
  const namedDoc = segments[0] === "docs" && DOC_NAME_KEYWORDS.some((keyword) => lower.includes(keyword));
  if (inAdr || namedDoc) return [0, 0, lower];
  if (segments.length === 1) {
    const rootIndex = ROOT_DOCS.findIndex((name) => name.toLowerCase() === lower);
    if (rootIndex >= 0) return [1, rootIndex, lower];
    if (lower === "readme.md") return [2, 0, lower];
  }
  return;
}

async function defaultListTrackedFiles(sourceRoot: string): Promise<string[]> {
  const stdout = await realExecWorkspaceCommand("git", ["-C", sourceRoot, "ls-files", "-z"]);
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

async function resolveTrustedDocuments(sourceRoot: string, candidates: readonly string[]): Promise<TrustedDocument[]> {
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Business reference source root must be a real directory");
  }
  const physicalSource = await realpath(sourceRoot);
  const resolved = await Promise.all(candidates.map(async (candidate) => {
    if (candidate.length === 0 || candidate.includes("\0")) throw new Error("Business document path is empty or invalid");
    const absolutePath = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(sourceRoot, candidate);
    if (!isBeneath(sourceRoot, absolutePath)) {
      throw new Error(`Business document path is outside the trusted source: ${candidate}`);
    }
    const relativePath = toPosix(path.relative(sourceRoot, absolutePath));
    if (relativePath === ".git" || relativePath.startsWith(".git/")) {
      throw new Error(`Business document path escapes into repository metadata: ${candidate}`);
    }
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) throw new Error(`Business document path is a symbolic link: ${candidate}`);
    if (!info.isFile()) throw new Error(`Business document path is not a regular file: ${candidate}`);
    const physicalPath = await realpath(absolutePath);
    if (!isBeneath(physicalSource, physicalPath)) {
      throw new Error(`Business document path escaped the trusted source: ${candidate}`);
    }
    return { relativePath, absolutePath };
  }));
  return Promise.all(resolved.map(async (document) => ({
    ...document,
    contents: await readFile(document.absolutePath, "utf8"),
  })));
}

async function validateGenerationRoot(sourceRoot: string, generatedPath: string): Promise<{
  generatedPath: string;
  generationRoot: string;
  physicalGenerationRoot: string;
}> {
  if (!path.isAbsolute(generatedPath) || path.basename(generatedPath) !== "BUSINESS-CONTEXT.md") {
    throw new Error("Generated business reference must use an absolute BUSINESS-CONTEXT.md path");
  }
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedGenerated = path.resolve(generatedPath);
  if (resolvedGenerated === resolvedSource || isBeneath(resolvedSource, resolvedGenerated)) {
    throw new Error("Generated business reference must be outside the trusted source repository");
  }
  const generationRoot = path.dirname(resolvedGenerated);
  const rootInfo = await lstat(generationRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Generated business reference root must be a real cache directory");
  }
  const [physicalSource, physicalGenerationRoot] = await Promise.all([
    realpath(resolvedSource),
    realpath(generationRoot),
  ]);
  if (physicalGenerationRoot === physicalSource || isBeneath(physicalSource, physicalGenerationRoot)) {
    throw new Error("Generated business reference cache resolves inside the trusted source repository");
  }
  return { generatedPath: resolvedGenerated, generationRoot, physicalGenerationRoot };
}

async function readDomainGraph(
  generationRoot: string,
  physicalGenerationRoot: string,
): Promise<DomainGraphSource | undefined> {
  const graphPath = path.join(generationRoot, ".understand-anything", "domain-graph.json");
  let info;
  try {
    info = await lstat(graphPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Domain graph must be a real cache file");
  const physicalGraph = await realpath(graphPath);
  if (!isBeneath(physicalGenerationRoot, physicalGraph)) {
    throw new Error("Domain graph escaped the business-reference cache root");
  }
  const raw = await readFile(graphPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.project) || !Array.isArray(parsed.nodes) ||
    typeof parsed.project.name !== "string" || typeof parsed.project.gitCommitHash !== "string") {
    throw new Error("Domain graph is missing business-reference provenance");
  }
  const nodes = parsed.nodes.flatMap((node) => {
    if (!isRecord(node) || (node.type !== "domain" && node.type !== "flow" && node.type !== "step") ||
      typeof node.id !== "string" || typeof node.name !== "string" || typeof node.summary !== "string") {
      return [];
    }
    const type: "domain" | "flow" | "step" = node.type;
    return [{ id: node.id, type, name: node.name, summary: node.summary }];
  }).sort((left, right) => {
    const typeOrder = { domain: 0, flow: 1, step: 2 } as const;
    return typeOrder[left.type] - typeOrder[right.type] || left.id.localeCompare(right.id);
  });
  if (nodes.length === 0) throw new Error("Domain graph has no domain or flow context to generate");
  return {
    projectName: parsed.project.name,
    baseSha: parsed.project.gitCommitHash,
    sha256: createHash("sha256").update(raw).digest("hex"),
    nodes,
  };
}

function safeScalar(value: string): string {
  return /^[a-zA-Z0-9._:/-]+$/u.test(value) ? value : JSON.stringify(value);
}

function singleLine(value: string): string {
  return value.replaceAll(/[\r\n]+/gu, " ").trim();
}

function generateBusinessContext(source: DomainGraphSource, generatedAt: Date): string {
  const sections = source.nodes.map((node) => {
    const citationId = /^[a-zA-Z0-9:_-]+$/u.test(node.id) ? node.id : encodeURIComponent(node.id);
    return [
      `## ${node.type[0]!.toUpperCase()}${node.type.slice(1)}: ${singleLine(node.name)}`,
      "",
      singleLine(node.summary),
      "",
      `Source: \`.understand-anything/domain-graph.json#${citationId}\``,
    ].join("\n");
  });
  return [
    "---",
    "generated: true",
    "provider: github",
    `repository: ${safeScalar(source.projectName)}`,
    `base_sha: ${safeScalar(source.baseSha)}`,
    "source: .understand-anything/domain-graph.json",
    `source_sha256: ${source.sha256}`,
    `generated_at: ${generatedAt.toISOString()}`,
    "---",
    "",
    "# Business Context",
    "",
    "Generated solely from the validated trusted-base domain graph.",
    "",
    ...sections,
    "",
  ].join("\n");
}

async function readReusableGenerated(generatedPath: string, source: DomainGraphSource): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(generatedPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generated business reference must be a real file");
  const contents = await readFile(generatedPath, "utf8");
  return contents.includes(`source_sha256: ${source.sha256}`) && contents.includes(`base_sha: ${safeScalar(source.baseSha)}`)
    ? contents
    : undefined;
}

async function writeGenerated(generatedPath: string, contents: string): Promise<void> {
  const temporaryPath = path.join(path.dirname(generatedPath), `.BUSINESS-CONTEXT.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, generatedPath);
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError: unknown) => {
      if (!isMissing(cleanupError)) throw cleanupError;
    });
    throw error;
  }
}

export async function selectBusinessReference(
  input: BusinessReferenceInput,
  dependencies: BusinessReferenceDependencies = {},
): Promise<BusinessReferenceResult> {
  if (!path.isAbsolute(input.sourceRoot)) throw new Error("Business reference source root must be absolute");
  if (!Array.isArray(input.explicitPaths)) throw new Error("Explicit business document paths must be an array");

  if (input.explicitPaths.length > 0) {
    const candidates = [...new Set(input.explicitPaths)].sort((left, right) => left.localeCompare(right));
    const documents = await resolveTrustedDocuments(path.resolve(input.sourceRoot), candidates);
    if (documents.some((document) => document.contents.trim().length === 0)) {
      throw new Error("Explicit business documents must be non-empty");
    }
    return {
      kind: "existing",
      paths: documents.map((document) => document.relativePath),
      digest: digestDocuments(documents),
    };
  }

  const listTrackedFiles = dependencies.listTrackedFiles ?? defaultListTrackedFiles;
  const ranked = (await listTrackedFiles(path.resolve(input.sourceRoot)))
    .map((relativePath) => ({ relativePath, rank: candidateRank(relativePath) }))
    .filter((candidate): candidate is { relativePath: string; rank: [number, number, string] } =>
      candidate.rank !== undefined)
    .sort((left, right) =>
      left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || left.rank[2].localeCompare(right.rank[2]))
    .map((candidate) => candidate.relativePath);
  const documents = (await resolveTrustedDocuments(path.resolve(input.sourceRoot), ranked)).filter((document) =>
    isAdequate(document.contents));
  if (documents.length > 0) {
    return {
      kind: "existing",
      paths: documents.map((document) => document.relativePath),
      digest: digestDocuments(documents),
    };
  }

  const destination = await validateGenerationRoot(path.resolve(input.sourceRoot), input.generatedPath);
  const domainGraph = await readDomainGraph(destination.generationRoot, destination.physicalGenerationRoot);
  if (domainGraph === undefined) return { kind: "none", paths: [], digest: emptyDigest() };
  const existing = await readReusableGenerated(destination.generatedPath, domainGraph);
  const contents = existing ?? generateBusinessContext(domainGraph, (dependencies.now ?? (() => new Date()))());
  if (existing === undefined) await writeGenerated(destination.generatedPath, contents);
  return {
    kind: "generated",
    paths: [path.basename(destination.generatedPath)],
    digest: createHash("sha256").update(contents).digest("hex"),
  };
}
