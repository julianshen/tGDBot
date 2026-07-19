import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
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
}

interface TrustedDocument {
  relativePath: string;
  absolutePath: string;
  contents: string;
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
  if (documents.length === 0) return { kind: "none", paths: [], digest: emptyDigest() };
  return {
    kind: "existing",
    paths: documents.map((document) => document.relativePath),
    digest: digestDocuments(documents),
  };
}
