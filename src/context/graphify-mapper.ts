// Issue #62: a second ContextMapper implementation — graphify, a deterministic
// AST indexer — as a subprocess with a JSON contract.
//
// What this deliberately is NOT: a pi session. TgdPiMapper runs a coding agent
// with bash/edit/write (the tools ADR-003 stripped from review subagents),
// which is why mapping must only ever touch the trusted base. This mapper is
// `execFile` with a fixed argument list: no agent, no tool grants, no prompt,
// and an environment scrubbed of provider credentials — there is nothing for
// a repository's contents to talk to, and nothing to leak a key to. That
// removes the 30-minute timeout, the per-review model spend, and — because an
// AST extractor is deterministic — makes the cache key's one-tree-one-graph
// assumption actually true.
//
// The adapter's contract is pinned to graphify@0.9.50 (see GRAPHIFY_VERSION).
// Parsing is defensive throughout: an unrecognised DOCUMENT shape is
// `status: "degraded"` with a stated reason, never a throw — a mapper that
// cannot be trusted to produce a known shape must not fail the review.
// Unrecognised node TYPES are different: they get a total mapping into the
// pack's closed node-type set with an explicit fallback, because a graphify
// release adding a type must not break mapping outright.

import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  CONTEXT_PATH,
  GRAPH_ROOT,
  KNOWLEDGE_PATH,
  METADATA_PATH,
  ZERO_DOMAINS_PATH,
} from "./artifact-paths.js";
import { EDGE_TYPES, MAX_JSON_ARTIFACT_BYTES } from "./artifact-validator.js";
import type {
  ContextMapper,
  ContextMapRequest,
  DegradedReason,
  MappingFailureCode,
  MappingResult,
} from "./mapper.js";

export const GRAPHIFY_VERSION = "0.9.50";
export const GRAPHIFY_MAPPER_VERSION = `graphify-mapper@1+graphify@${GRAPHIFY_VERSION}`;

const EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_CHARS = 500;

/**
 * The graph document this adapter reads, under the output root. graphify is
 * pinned, so the path is a contract; a release that moves it fails the read
 * and degrades with a stated reason instead of guessing.
 */
const GRAPHIFY_OUTPUT_GRAPH = "graph.json";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleLine(value: string): string {
  return value.replaceAll(/[\r\n]+/gu, " ").trim();
}

/** The injected subprocess boundary. `env` is what the child actually gets. */
export type GraphifyRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>;

/** Production runner: `graphify` from PATH, bounded, with a scrubbed environment. */
export function defaultGraphifyRunner(): GraphifyRunner {
  const execFileAsync = promisify(execFile);
  return async (args, env) => {
    try {
      const { stdout, stderr } = await execFileAsync("graphify", [...args], {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env,
      });
      return { stdout, stderr: stderr ?? "" };
    } catch (error) {
      // Normalize the many shapes of execFile failure into one the caller can
      // classify: a missing binary reads as an empty stderr with the error
      // attached, everything else carries whatever the child said.
      const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const wrapped = Object.assign(new Error(errorMessage(error)), {
        code: err.code,
        stderr: err.stderr ?? "",
        stdout: err.stdout ?? "",
      });
      throw wrapped;
    }
  };
}

/**
 * Provider credentials never reach the subprocess. graphify's code pass needs
 * no key, and handing it one anyway would turn a code-indexing tool into a
 * key-exfiltration surface keyed on whatever its Python dependency tree does.
 * Everything else is inherited so the binary still works behind proxies.
 */
function scrubbedChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|AZURE|AWS|MISTRAL|DEEPSEEK|GROQ|XAI)[_A-Z0-9]*$/u.test(name)) {
      continue;
    }
    env[name] = value;
  }
  return env;
}

/**
 * graphify's node kinds, as a TOTAL function into the pack's closed
 * node-type set. The fallback is deliberate: a graphify release that adds a
 * type must degrade a node's label, never the mapping run. (The document
 * shape is the other story — see `readGraphifyGraph`.)
 */
const NODE_TYPE_BY_GRAPHIFY_KIND: ReadonlyMap<string, string> = new Map([
  ["file", "file"],
  ["module", "module"],
  ["function", "function"],
  ["method", "function"],
  ["class", "class"],
  ["interface", "class"],
  ["endpoint", "endpoint"],
  ["route", "endpoint"],
  ["table", "table"],
  ["model", "table"],
  ["service", "service"],
  ["worker", "service"],
  ["config", "config"],
  ["setting", "config"],
  ["document", "document"],
  ["doc", "document"],
  ["test", "concept"],
  ["concept", "concept"],
]);

function mapNodeType(raw: Record<string, unknown>): string {
  const rawKind = typeof raw.node_type === "string"
    ? raw.node_type
    : typeof raw.kind === "string"
      ? raw.kind
      : undefined;
  if (rawKind === undefined) return "concept";
  return NODE_TYPE_BY_GRAPHIFY_KIND.get(rawKind) ?? "concept";
}

interface AdaptedNode {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly summary: string;
  readonly filePath?: string;
  /** graphify's own field name — the pack's parser reads it back verbatim. */
  readonly source_location?: string;
  readonly [key: string]: unknown;
}

interface AdaptedEdge {
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly direction: "forward";
  readonly weight: number;
  readonly confidence?: string;
  readonly [key: string]: unknown;
}

interface AdaptedGraph {
  readonly nodes: AdaptedNode[];
  readonly edges: AdaptedEdge[];
  readonly analyzedFiles: number;
  readonly skippedNodes: number;
  readonly skippedEdges: number;
}

/**
 * Adapts graphify's networkx node-link JSON into the pack's graph schema.
 *
 * The schema-mapping table from issue #62, as implemented: `label` becomes
 * `name`, `source_file` becomes `filePath`, the node kind maps through the
 * total table above, and `summary` is synthesized from the label — code nodes
 * have no summary, and rendering label + call-site facts beats an LLM
 * paraphrase on every axis this project cares about (#62 caveat 2). Two
 * fields travel through because the pack now renders them: `source_location`
 * line-anchors a node, and edge `confidence` separates a fact read from the
 * AST ("EXTRACTED") from one graphify resolved ("INFERRED").
 */
export function adaptGraphifyGraph(raw: unknown): AdaptedGraph | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.links)) return undefined;
  const nodesById = new Set<string>();
  const nodes: AdaptedNode[] = [];
  let skippedNodes = 0;
  let analyzedFiles = 0;
  for (const value of raw.nodes) {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
      skippedNodes += 1;
      continue;
    }
    const id = singleLine(value.id);
    if (id.length === 0 || nodesById.has(id)) {
      skippedNodes += 1;
      continue;
    }
    const name = typeof value.label === "string" && value.label.trim().length > 0
      ? singleLine(value.label)
      : id;
    nodesById.add(id);
    const isFile = typeof value.file_type === "string";
    if (isFile && value.file_type === "code") analyzedFiles += 1;
    const filePath = typeof value.source_file === "string" && value.source_file.length > 0
      ? value.source_file.replaceAll("\\", "/")
      : undefined;
    nodes.push({
      id,
      type: isFile ? "file" : mapNodeType(value),
      name,
      // Code nodes carry no summary. The label IS the fact; a paraphrase
      // would need a model, which is the whole point this mapper exists to
      // avoid (#62 caveat 2).
      summary: name,
      tags: [],
      complexity: "simple",
      ...(filePath === undefined ? {} : { filePath }),
      ...(typeof value.source_location === "string" && value.source_location.length > 0
        ? { source_location: singleLine(value.source_location) }
        : {}),
    });
  }
  if (nodes.length === 0) return undefined;

  const edges: AdaptedEdge[] = [];
  let skippedEdges = 0;
  for (const value of raw.links) {
    if (
      !isRecord(value) ||
      typeof value.source !== "string" ||
      typeof value.target !== "string" ||
      !nodesById.has(value.source) ||
      !nodesById.has(value.target)
    ) {
      skippedEdges += 1;
      continue;
    }
    // The validator's edge types are a CLOSED set, and graphify names
    // relations the set does not contain ("references", "dynamic_import",
    // "re_exports", ...). Copying one unchanged would fail the whole graph
    // at publication and take every pack with it (PR #116 review), so an
    // unmapped relation normalizes to "related" — availability over
    // taxonomy, since nothing downstream reads the relation name.
    const relation = typeof value.relation === "string" && value.relation.length > 0
      ? singleLine(value.relation)
      : "related";
    // Weights are validator-bounded to [0, 1]; graphify emits counts.
    const weight = typeof value.weight === "number" && Number.isFinite(value.weight)
      ? Math.min(1, Math.max(0, value.weight))
      : 1;
    edges.push({
      source: value.source,
      target: value.target,
      type: EDGE_TYPES.has(relation) ? relation : "related",
      direction: "forward",
      weight,
      ...(typeof value.confidence === "string" && value.confidence.length > 0
        ? { confidence: singleLine(value.confidence) }
        : {}),
    });
  }
  return { nodes, edges, analyzedFiles, skippedNodes, skippedEdges };
}

/**
 * The prose document the pack renders first. Mechanically generated — file
 * and relation counts, what the graph is — because anything richer needs a
 * model and would reopen the zero-LLM claim this mapper rests on (#62).
 * Includes the caveat-4 statement: graphify silently skips files it flags as
 * sensitive, so absence from the graph is NOT evidence of absence in the code.
 */
function synthesizeContextDocument(
  repositoryName: string,
  graph: AdaptedGraph,
  baseSha: string,
): string {
  const fileNodes = graph.nodes.filter((node) => node.type === "file").length;
  const extracted = graph.edges.filter((edge) => edge.confidence === "EXTRACTED").length;
  const inferred = graph.edges.filter((edge) => edge.confidence === "INFERRED").length;
  return [
    `# Repository context: ${repositoryName}`,
    "",
    `Deterministic AST index produced by graphify (no language model involved)`,
    `from the base commit ${baseSha}.`,
    "",
    `- Indexed files: ${fileNodes} (${graph.analyzedFiles} code files analyzed)`,
    `- Graph entries: ${graph.nodes.length} nodes, ${graph.edges.length} relations`,
    `- Relations read from the AST: ${extracted}; resolved by graphify: ${inferred}`,
    "",
    "This index describes structure, not intent: entries name what exists and",
    "how it connects, not why. Node locations are line anchors into the indexed",
    "commit.",
    "",
    "IMPORTANT: graphify skips files it classifies as potentially sensitive.",
    "Absence from this graph is NOT evidence that something does not exist in",
    "the code. Never report a caller, a configuration, or a behavior as absent",
    "because this graph has no node for it.",
    "",
  ].join("\n");
}

interface StagingValidation {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly failure?: { code: MappingFailureCode; message: string };
}

/** The same staging invariant TgdPiMapper enforces — no agent, same rules. */
async function validateRoots(request: ContextMapRequest): Promise<StagingValidation> {
  if (!path.isAbsolute(request.sourceRoot) || !path.isAbsolute(request.outputRoot)) {
    return { sourceRoot: request.sourceRoot, outputRoot: request.outputRoot, failure: { code: "invalid-request", message: "Mapping source and output roots must be absolute paths" } };
  }
  const sourceRoot = path.resolve(request.sourceRoot);
  const outputRoot = path.resolve(request.outputRoot);
  if (sourceRoot === outputRoot || physicallyBeneath(sourceRoot, outputRoot)) {
    return { sourceRoot, outputRoot, failure: { code: "invalid-request", message: "Mapping output must be outside the detached source worktree" } };
  }
  try {
    await mkdir(outputRoot, { recursive: true });
    const [sourceInfo, outputInfo] = await Promise.all([lstat(sourceRoot), lstat(outputRoot)]);
    if (sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink() && outputInfo.isDirectory() && !outputInfo.isSymbolicLink()) {
      const [physicalSourceRoot, physicalOutputRoot] = await Promise.all([realpath(sourceRoot), realpath(outputRoot)]);
      if (physicalSourceRoot === physicalOutputRoot || physicallyBeneath(physicalSourceRoot, physicalOutputRoot)) {
        return { sourceRoot, outputRoot, failure: { code: "invalid-request", message: "Mapping output must be outside the detached source worktree" } };
      }
    } else {
      return { sourceRoot, outputRoot, failure: { code: "invalid-request", message: "Mapping roots must be real directories" } };
    }
  } catch (error) {
    return { sourceRoot, outputRoot, failure: { code: "invalid-request", message: errorMessage(error) } };
  }
  return { sourceRoot, outputRoot };
}

export interface GraphifyMapperDependencies {
  /** Injectable so the suite never puts a real graphify on PATH. */
  readonly run?: GraphifyRunner;
  readonly now?: () => string;
  readonly onProgress?: (event: { stage: "extract" | "adapt"; status: "started" | "completed" | "failed" }) => void;
}

export class GraphifyMapper implements ContextMapper {
  readonly #run: GraphifyRunner;
  readonly #now: () => string;
  readonly #onProgress: NonNullable<GraphifyMapperDependencies["onProgress"]>;

  constructor(dependencies: GraphifyMapperDependencies = {}) {
    this.#run = dependencies.run ?? defaultGraphifyRunner();
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#onProgress = dependencies.onProgress ?? (() => undefined);
  }

  async map(request: ContextMapRequest): Promise<MappingResult> {
    const manifestPath = path.join(request.outputRoot, METADATA_PATH);
    const failed = (
      code: MappingFailureCode,
      message: string,
      degradedReasons: DegradedReason[] = [],
    ): MappingResult => ({
      status: "failed",
      manifestPath,
      artifactPaths: [],
      analyzedFiles: 0,
      degradedReasons,
      failure: { stage: "context-map", code, message },
    });

    // `scopePaths` is deliberately ignored: this mapper cannot scope a
    // tree-sitter extraction, so it always produces the full deterministic
    // graph. Correctness is unaffected — the incremental merge only admits
    // nodes naming a delta path — and a full AST pass costs seconds, not the
    // model minutes that made scoping worth building.
    const roots = await validateRoots(request);
    if (roots.failure !== undefined) {
      return failed(roots.failure.code, roots.failure.message);
    }
    const { sourceRoot, outputRoot } = roots;

    this.#onProgress({ stage: "extract", status: "started" });
    // The cache key claims graphs come from the PINNED graphify release
    // (GRAPHIFY_MAPPER_VERSION embeds it), so an installed binary that
    // reports anything else must not map: a warm cache would not invalidate
    // across an upgrade, and the incremental path could merge graphs from
    // different releases under one identity (PR #116 review). Verify before
    // every extract; the check costs one subprocess round trip.
    let reportedVersion: string | undefined;
    try {
      const probe = await this.#run(["--version"], scrubbedChildEnvironment());
      reportedVersion = /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0];
    } catch (error) {
      this.#onProgress({ stage: "extract", status: "failed" });
      const err = error as NodeJS.ErrnoException;
      if (isMissing(error) || err.code === "ENOENT") {
        return failed(
          "mapper-subprocess-failed",
          "the graphify executable was not found on PATH; install it (e.g. `pipx install graphifyy`) or run with --context-mapper tgd",
        );
      }
      return failed(
        "mapper-subprocess-failed",
        `graphify --version failed: ${errorMessage(error).slice(0, MAX_STDERR_CHARS)}`,
      );
    }
    if (reportedVersion !== GRAPHIFY_VERSION) {
      this.#onProgress({ stage: "extract", status: "failed" });
      return failed(
        "mapper-subprocess-failed",
        `graphify on PATH reports ${reportedVersion ?? "no recognizable version"}, but this build pins graphify@${GRAPHIFY_VERSION}; install exactly that release (e.g. pipx install graphifyy==${GRAPHIFY_VERSION}) or run with --context-mapper tgd`,
      );
    }
    try {
      await this.#run(
        ["extract", sourceRoot, "--code-only", "--no-label", "--out", outputRoot],
        scrubbedChildEnvironment(),
      );
    } catch (error) {
      this.#onProgress({ stage: "extract", status: "failed" });
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      if (isMissing(error) || err.code === "ENOENT") {
        // The acceptance criterion's exact case: absence from PATH must
        // degrade to a context-free review with a stated reason, never fail
        // the review.
        return failed(
          "mapper-subprocess-failed",
          "the graphify executable was not found on PATH; install it (e.g. `pipx install graphifyy`) or run with --context-mapper tgd",
        );
      }
      const detail = (err.stderr ?? errorMessage(error)).slice(0, MAX_STDERR_CHARS);
      return failed("mapper-subprocess-failed", `graphify extract failed: ${detail}`);
    }
    this.#onProgress({ stage: "extract", status: "completed" });

    this.#onProgress({ stage: "adapt", status: "started" });
    // Bound the read BEFORE it happens: a huge repository produces a huge
    // graph, and reading it unbounded exhausts the Node heap and kills the
    // review process — the one failure mode that is not a degradation. The
    // limit matches the validator's own parsed-JSON ceiling, so anything this
    // refuses would have been refused at publication anyway (PR #116 review).
    const graphPath = path.join(outputRoot, GRAPHIFY_OUTPUT_GRAPH);
    const graphInfo = await lstat(graphPath).catch(() => undefined);
    if (graphInfo === undefined) {
      this.#onProgress({ stage: "adapt", status: "failed" });
      return {
        status: "degraded",
        manifestPath,
        artifactPaths: [],
        analyzedFiles: 0,
        degradedReasons: ["graphify produced no graph document at the expected output path"],
        failure: undefined,
      };
    }
    if (graphInfo.size > MAX_JSON_ARTIFACT_BYTES) {
      this.#onProgress({ stage: "adapt", status: "failed" });
      return {
        status: "degraded",
        manifestPath,
        artifactPaths: [],
        analyzedFiles: 0,
        degradedReasons: [`graphify graph document exceeds the ${MAX_JSON_ARTIFACT_BYTES}-byte safe-size limit; choose --context-mapper tgd or narrow the indexed tree`],
        failure: undefined,
      };
    }
    let rawGraph: unknown;
    try {
      rawGraph = JSON.parse(await readFile(graphPath, "utf8"));
    } catch (error) {
      this.#onProgress({ stage: "adapt", status: "failed" });
      if (isMissing(error)) {
        // The subprocess exited zero but wrote no graph we can find: treat the
        // same as an unrecognised shape — degraded, never a crash.
        return {
          status: "degraded",
          manifestPath,
          artifactPaths: [],
          analyzedFiles: 0,
          degradedReasons: ["graphify produced no graph document at the expected output path"],
          failure: undefined,
        };
      }
      return {
        status: "degraded",
        manifestPath,
        artifactPaths: [],
        analyzedFiles: 0,
        degradedReasons: [`graphify output is not valid JSON: ${errorMessage(error)}`],
        failure: undefined,
      };
    }
    const adapted = adaptGraphifyGraph(rawGraph);
    if (adapted === undefined) {
      this.#onProgress({ stage: "adapt", status: "failed" });
      return {
        status: "degraded",
        manifestPath,
        artifactPaths: [],
        analyzedFiles: 0,
        degradedReasons: ["graphify graph document does not match the schema this adapter maps (pinned to graphify@" + GRAPHIFY_VERSION + ")"],
        failure: undefined,
      };
    }

    const graphRoot = path.join(outputRoot, GRAPH_ROOT);
    await mkdir(graphRoot, { recursive: true });
    const graphDocument = {
      version: "1.0.0",
      kind: "codebase",
      project: {
        name: request.repository.repo,
        languages: [],
        frameworks: [],
        description: "Deterministic AST index produced by graphify",
        analyzedAt: this.#now(),
        gitCommitHash: request.baseSha,
      },
      nodes: adapted.nodes,
      edges: adapted.edges,
      layers: [],
      tour: [],
    };
    await writeFile(path.join(outputRoot, KNOWLEDGE_PATH), `${JSON.stringify(graphDocument, null, 2)}\n`, "utf8");
    await writeFile(path.join(outputRoot, ZERO_DOMAINS_PATH), `${JSON.stringify({ version: 1, status: "zero-domains" }, null, 2)}\n`, "utf8");
    await writeFile(path.join(outputRoot, CONTEXT_PATH), synthesizeContextDocument(request.repository.repo, adapted, request.baseSha), "utf8");
    await writeFile(
      path.join(outputRoot, METADATA_PATH),
      `${JSON.stringify({ version: 1, status: "complete", baseSha: request.baseSha }, null, 2)}\n`,
      "utf8",
    );
    this.#onProgress({ stage: "adapt", status: "completed" });

    return {
      status: "ready",
      manifestPath,
      artifactPaths: [CONTEXT_PATH, ZERO_DOMAINS_PATH, KNOWLEDGE_PATH, METADATA_PATH],
      analyzedFiles: adapted.analyzedFiles,
      degradedReasons: [],
    };
  }
}
