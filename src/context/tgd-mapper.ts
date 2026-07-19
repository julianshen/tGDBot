import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { digestArtifactInputs } from "./artifact-validator.js";
import type { ArtifactInput, ContextCacheKey } from "./types.js";
import type { ContextMapper, ContextMapRequest, MappingResult } from "./mapper.js";

const CONTEXT_PATH = "CONTEXT.md";
const GRAPH_ROOT = ".understand-anything";
const KNOWLEDGE_PATH = `${GRAPH_ROOT}/knowledge-graph.json`;
const DOMAIN_PATH = `${GRAPH_ROOT}/domain-graph.json`;
const ZERO_DOMAINS_PATH = `${GRAPH_ROOT}/zero-domains.json`;
const METADATA_PATH = `${GRAPH_ROOT}/mapping-metadata.json`;
const DEFAULT_MAPPING_TIMEOUT_MS = 30 * 60 * 1000;

const EMBEDDED_MAPPING_CONTRACT = [
  "You are running tGD mapping non-interactively for a review CLI.",
  "Map only the current working directory. Do not ask for or select additional repositories.",
  "TGD_DIR is already supplied by the bash tool environment; use it without confirmation.",
  "Do not open or launch dashboards in this embedded run.",
  "Treat prose as informational: the caller validates artifacts independently.",
].join("\n");

export interface MappingSession {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  abort?(): Promise<void>;
}

export interface MappingSessionRequest {
  sourceRoot: string;
  outputRoot: string;
}

export type MappingSessionFactory = (request: MappingSessionRequest) => Promise<MappingSession>;

export interface TgdPiMapperDependencies {
  createSession?: MappingSessionFactory;
  timeoutMs?: number;
  onProgress?: (event: { stage: "session" | "validation"; status: "started" | "completed" | "failed" }) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function physicallyBeneath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertNonEmptyContext(outputRoot: string): Promise<void> {
  const contextPath = path.join(outputRoot, CONTEXT_PATH);
  const handle = await open(contextPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("CONTEXT.md is not a regular file");
    const contents = await handle.readFile("utf8");
    if (contents.trim().length === 0) throw new Error("CONTEXT.md is empty");
  } finally {
    await handle.close();
  }
}

async function copyMappedGraphsFromTgdLayout(sourceRoot: string, outputRoot: string): Promise<void> {
  if (await regularFileExists(path.join(outputRoot, KNOWLEDGE_PATH))) return;
  const scansRoot = path.join(outputRoot, ".scans");
  let entries;
  try {
    entries = await readdir(scansRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const preferredName = path.basename(sourceRoot);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => Number(right.name === preferredName) - Number(left.name === preferredName) ||
      left.name.localeCompare(right.name));
  const matches: string[] = [];
  for (const entry of candidates) {
    const candidate = path.join(scansRoot, entry.name, GRAPH_ROOT);
    if (await regularFileExists(path.join(candidate, "knowledge-graph.json"))) matches.push(candidate);
  }
  if (matches.length !== 1) return;

  const physicalOutput = await realpath(outputRoot);
  const physicalSource = await realpath(matches[0]!);
  if (!physicallyBeneath(physicalOutput, physicalSource)) {
    throw new Error("tGD graph output escaped the mapping staging directory");
  }
  const target = path.join(outputRoot, GRAPH_ROOT);
  await mkdir(target, { recursive: true });
  for (const filename of ["knowledge-graph.json", "domain-graph.json", "zero-domains.json"]) {
    const source = path.join(matches[0]!, filename);
    if (await regularFileExists(source)) await copyFile(source, path.join(target, filename), constants.COPYFILE_EXCL);
  }
}

function validationKey(baseSha: string): ContextCacheKey {
  return {
    provider: "github",
    host: "github.com",
    owner: "mapping-validation",
    repo: "mapping-validation",
    baseSha,
    schemaVersion: 1,
    tgdVersion: "mapping-validation",
    policyVersion: "mapping-validation",
  };
}

async function countAnalyzedFiles(outputRoot: string): Promise<number> {
  const parsed = JSON.parse(await readFile(path.join(outputRoot, KNOWLEDGE_PATH), "utf8")) as {
    nodes?: Array<{ type?: unknown }>;
  };
  return Array.isArray(parsed.nodes) ? parsed.nodes.filter((node) => node.type === "file").length : 0;
}

function mappingArtifacts(hasDomainGraph: boolean): ArtifactInput[] {
  return [
    { kind: "context", path: CONTEXT_PATH },
    { kind: "knowledge-graph", path: KNOWLEDGE_PATH },
    hasDomainGraph
      ? { kind: "domain-graph", path: DOMAIN_PATH }
      : { kind: "zero-domains", path: ZERO_DOMAINS_PATH },
    { kind: "mapping-metadata", path: METADATA_PATH },
  ];
}

async function createRealMappingSession(request: MappingSessionRequest): Promise<MappingSession> {
  const loader = new DefaultResourceLoader({
    cwd: request.sourceRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [EMBEDDED_MAPPING_CONTRACT],
  });
  await loader.reload();
  const tools = createCodingTools(request.sourceRoot, {
    bash: {
      spawnHook: (context) => ({
        ...context,
        env: { ...context.env, TGD_DIR: request.outputRoot, CI: "1" },
      }),
    },
  });
  const { session } = await createAgentSession({
    resourceLoader: loader,
    cwd: request.sourceRoot,
    tools: ["read", "bash", "edit", "write"],
    customTools: tools,
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`tGD mapping timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class TgdPiMapper implements ContextMapper {
  readonly #createSession: MappingSessionFactory;
  readonly #timeoutMs: number;
  readonly #onProgress: NonNullable<TgdPiMapperDependencies["onProgress"]>;

  constructor(dependencies: TgdPiMapperDependencies = {}) {
    this.#createSession = dependencies.createSession ?? createRealMappingSession;
    this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_MAPPING_TIMEOUT_MS;
    this.#onProgress = dependencies.onProgress ?? (() => undefined);
  }

  async map(request: ContextMapRequest): Promise<MappingResult> {
    const manifestPath = path.join(request.outputRoot, METADATA_PATH);
    const failed = (code: string, message: string, degradedReasons: string[] = []): MappingResult => ({
      status: "failed",
      manifestPath,
      artifactPaths: [],
      analyzedFiles: 0,
      degradedReasons,
      failure: { stage: "context-map", code, message },
    });

    if (!path.isAbsolute(request.sourceRoot) || !path.isAbsolute(request.outputRoot)) {
      return failed("invalid-request", "Mapping source and output roots must be absolute paths");
    }
    const sourceRoot = path.resolve(request.sourceRoot);
    const outputRoot = path.resolve(request.outputRoot);
    if (sourceRoot === outputRoot || physicallyBeneath(sourceRoot, outputRoot)) {
      return failed("invalid-request", "Mapping output must be outside the detached source worktree");
    }

    await mkdir(outputRoot, { recursive: true });
    try {
      const [sourceInfo, outputInfo] = await Promise.all([lstat(sourceRoot), lstat(outputRoot)]);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
        return failed("invalid-request", "Mapping roots must be real directories");
      }
      this.#onProgress({ stage: "session", status: "started" });
      const session = await this.#createSession({ sourceRoot, outputRoot });
      await withTimeout(session.prompt("/tgd-map"), this.#timeoutMs, () => {
        void session.abort?.().catch(() => undefined);
      });
      this.#onProgress({ stage: "session", status: "completed" });
    } catch (error) {
      this.#onProgress({ stage: "session", status: "failed" });
      return failed("pi-session-failed", errorMessage(error));
    }

    this.#onProgress({ stage: "validation", status: "started" });
    try {
      await copyMappedGraphsFromTgdLayout(sourceRoot, outputRoot);
      await assertNonEmptyContext(outputRoot);
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        `${JSON.stringify({ version: 1, status: "complete", baseSha: request.baseSha })}\n`,
        { encoding: "utf8", flag: "wx" },
      );

      const hasKnowledge = await regularFileExists(path.join(outputRoot, KNOWLEDGE_PATH));
      const hasDomain = await regularFileExists(path.join(outputRoot, DOMAIN_PATH));
      const hasZeroDomains = await regularFileExists(path.join(outputRoot, ZERO_DOMAINS_PATH));
      if (!hasKnowledge || hasDomain === hasZeroDomains) {
        if (!request.allowDegradedContext) {
          throw new Error(!hasKnowledge
            ? "Required knowledge graph is missing"
            : "Mapping must produce exactly one domain graph or zero-domain marker");
        }
        const degradedReasons = [!hasKnowledge ? "knowledge-graph-unavailable" : "domain-context-unavailable"];
        this.#onProgress({ stage: "validation", status: "completed" });
        return {
          status: "degraded",
          manifestPath,
          artifactPaths: [CONTEXT_PATH, METADATA_PATH],
          analyzedFiles: 0,
          degradedReasons,
        };
      }

      const artifacts = mappingArtifacts(hasDomain);
      await digestArtifactInputs(outputRoot, validationKey(request.baseSha), artifacts);
      const analyzedFiles = await countAnalyzedFiles(outputRoot);
      this.#onProgress({ stage: "validation", status: "completed" });
      return {
        status: "ready",
        manifestPath,
        artifactPaths: artifacts.map((artifact) => artifact.path),
        analyzedFiles,
        degradedReasons: [],
      };
    } catch (error) {
      await unlink(manifestPath).catch((unlinkError: unknown) => {
        if (!isMissing(unlinkError)) throw unlinkError;
      });
      this.#onProgress({ stage: "validation", status: "failed" });
      return failed("invalid-artifacts", errorMessage(error));
    }
  }
}
