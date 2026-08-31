// Issue #62: the graphify mapper — a deterministic AST indexer behind a
// subprocess with a JSON contract. These tests pin the three properties the
// issue's acceptance criteria name: no model anywhere on the path (the
// subprocess args and environment), output that the existing artifact
// validator and pack builder accept unchanged, and degradation — never a
// throw — for anything this adapter does not recognise.
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GraphifyMapper,
  GRAPHIFY_MAPPER_VERSION,
  GRAPHIFY_VERSION,
  adaptGraphifyGraph,
  type GraphifyRunner,
} from "../../../src/context/graphify-mapper.js";
import { digestArtifactInputs, MAX_JSON_ARTIFACT_BYTES, validateArtifactRecords } from "../../../src/context/artifact-validator.js";
import { declareMappedArtifacts } from "../../../src/context/artifact-paths.js";
import { buildContextPack } from "../../../src/context/context-pack.js";
import type { RepositoryRef } from "../../../src/target/types.js";

const BASE_SHA = "a".repeat(40);
const roots: string[] = [];
const repository: RepositoryRef = {
  provider: "github",
  host: "github.com",
  owner: "octo-org",
  repo: "octo-repo",
  canonicalUrl: "https://github.com/octo-org/octo-repo",
} as RepositoryRef;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** A graphify node-link document for one code file with one function. */
function graphifyGraph(): Record<string, unknown> {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "file:src/auth.ts",
        label: "auth.ts",
        file_type: "code",
        source_file: "src/auth.ts",
        source_location: "L1",
      },
      {
        id: "fn:authenticate",
        label: "authenticate",
        node_type: "function",
        source_file: "src/auth.ts",
        source_location: "L17",
      },
    ],
    links: [
      {
        source: "file:src/auth.ts",
        target: "fn:authenticate",
        relation: "contains",
        weight: 1,
        confidence: "EXTRACTED",
      },
    ],
  };
}

interface Fixture {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly requests: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }>;
}

function runnerWritingGraph(
  graph: unknown,
  options: { failWith?: Error; reportedVersion?: string } = {},
): { runner: GraphifyRunner; fixture: Promise<Fixture> } {
  let resolveFixture: (fixture: Fixture) => void;
  const fixture = new Promise<Fixture>((resolve) => { resolveFixture = resolve; });
  const runner: GraphifyRunner = async (args, env) => {
    // The mapper probes --version before every extract; only the extract is
    // recorded as a request under test.
    if (args[0] === "--version") {
      const reported = options.reportedVersion ?? GRAPHIFY_VERSION;
      if (options.failWith !== undefined && options.reportedVersion === undefined) throw options.failWith;
      return { stdout: `graphify ${reported}`, stderr: "" };
    }
    const sourceRoot = args[1] as string;
    const outputRoot = args[args.indexOf("--out") + 1] as string;
    resolveFixture({ sourceRoot, outputRoot, requests: [{ args, env }] });
    if (options.failWith !== undefined) throw options.failWith;
    await mkdir(path.join(outputRoot), { recursive: true });
    await writeFile(path.join(outputRoot, "graph.json"), JSON.stringify(graph), "utf8");
    return { stdout: "", stderr: "" };
  };
  return { runner, fixture };
}

function request(sourceRoot: string, outputRoot: string) {
  return {
    sourceRoot,
    outputRoot,
    baseSha: BASE_SHA,
    repository,
  };
}

describe("GraphifyMapper — the subprocess boundary", () => {
  it("invokes graphify extract with --code-only and a credential-scrubbed environment", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const { runner, fixture } = runnerWritingGraph(graphifyGraph());
    // A provider key in the parent environment must NOT reach the child.
    process.env.ANTHROPIC_API_KEY = "sk-secret-do-not-leak";
    try {
      const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
      expect(result.status).toBe("ready");
      const { requests } = await fixture;
      // Request 0 is the version probe; request 1 is the extract.
      expect(requests).toHaveLength(1);
      const [args, env] = [requests[0]!.args, requests[0]!.env];
      // The whole argument list is fixed; --code-only is what makes the
      // code pass deterministic and key-free.
      expect(args.slice(0, 2)).toEqual(["extract", sourceRoot]);
      expect(args).toContain("--code-only");
      expect(args).toContain("--no-label");
      expect(args[args.indexOf("--out")]).toBe("--out");
      expect(args[args.indexOf("--out") + 1]).toBe(outputRoot);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.PATH).toBeDefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("reports a missing graphify binary as a failure with an install hint", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const runner: GraphifyRunner = async () => {
      throw Object.assign(new Error("spawn graphify ENOENT"), { code: "ENOENT" });
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("mapper-subprocess-failed");
    expect(result.failure?.message).toMatch(/not found on PATH/);
    expect(result.failure?.message).toMatch(/--context-mapper tgd/);
  });

  it("reports a non-zero subprocess exit through the subprocess failure code", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const { runner } = runnerWritingGraph(graphifyGraph(), {
      failWith: Object.assign(new Error("exit 1"), { stderr: "boom" }),
      reportedVersion: GRAPHIFY_VERSION,
    });
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("mapper-subprocess-failed");
    expect(result.failure?.message).toContain("boom");
  });

  it("refuses to map when the installed graphify does not match the pinned version", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    let extractInvocations = 0;
    const runner: GraphifyRunner = async (args) => {
      if (args[0] === "--version") return { stdout: "graphify 0.10.0", stderr: "" };
      extractInvocations += 1;
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("mapper-subprocess-failed");
    // Both versions are named, and the cache-key identity is defended: a
    // different release must never publish graphs attributed to the pin.
    expect(result.failure?.message).toContain("0.10.0");
    expect(result.failure?.message).toContain(GRAPHIFY_VERSION);
    // The extract never runs against a mismatched binary.
    expect(extractInvocations).toBe(0);
  });

  it("refuses to map when the version probe reports no recognizable version", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    let extractInvocations = 0;
    const runner: GraphifyRunner = async (args) => {
      if (args[0] === "--version") return { stdout: "graphify", stderr: "" };
      extractInvocations += 1;
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toMatch(/no recognizable version/);
    expect(extractInvocations).toBe(0);
  });
});

describe("GraphifyMapper — the staging invariant", () => {
  it("refuses an output root inside the source worktree", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = path.join(sourceRoot, "out");
    let invoked = false;
    const runner: GraphifyRunner = async () => {
      invoked = true;
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("invalid-request");
    expect(result.failure?.message).toMatch(/outside the detached source worktree/);
    // The subprocess never runs against an invalid staging contract.
    expect(invoked).toBe(false);
  });

  it("refuses relative roots", async () => {
    let invoked = false;
    const runner: GraphifyRunner = async () => {
      invoked = true;
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request("relative-src", "/tmp/out"));
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("invalid-request");
    expect(invoked).toBe(false);
  });
});

describe("GraphifyMapper — degradation, never a throw", () => {
  it("degrades when the output graph is absent", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const runner: GraphifyRunner = async (args) => {
      if (args[0] === "--version") return { stdout: `graphify ${GRAPHIFY_VERSION}`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("degraded");
    expect(result.degradedReasons.join(" ")).toMatch(/no graph document/);
  });

  it("degrades when the document shape is not node-link JSON", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const { runner } = runnerWritingGraph({ nodes: "not-an-array" });
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("degraded");
    expect(result.degradedReasons.join(" ")).toMatch(/does not match the schema/);
  });

  it("degrades when the graph document exceeds the safe-size limit instead of reading it", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const runner: GraphifyRunner = async (args) => {
      if (args[0] === "--version") return { stdout: `graphify ${GRAPHIFY_VERSION}`, stderr: "" };
      const outRoot = args[args.indexOf("--out") + 1] as string;
      // Sparse write: claim the size without materialising 64 MiB.
      const handle = await open(path.join(outRoot, "graph.json"), "w");
      await handle.truncate(MAX_JSON_ARTIFACT_BYTES + 1);
      await handle.close();
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("degraded");
    expect(result.degradedReasons.join(" ")).toMatch(/safe-size limit/);
  });

  it("degrades when the output is not valid JSON", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const runner: GraphifyRunner = async (args, env) => {
      void env;
      if (args[0] === "--version") return { stdout: `graphify ${GRAPHIFY_VERSION}`, stderr: "" };
      const outRoot = args[args.indexOf("--out") + 1] as string;
      await writeFile(path.join(outRoot, "graph.json"), "{not json", "utf8");
      return { stdout: "", stderr: "" };
    };
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("degraded");
    expect(result.degradedReasons.join(" ")).toMatch(/not valid JSON/);
  });
});

describe("GraphifyMapper — the artifact contract", () => {
  it("produces artifacts the existing validator and pack builder accept unchanged", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const cacheRoot = await tempRoot("graphify-cache-");
    // Promotion requires the staging directory to live beneath the cache root.
    const outputRoot = path.join(cacheRoot, "staging", "out");
    const { runner, fixture } = runnerWritingGraph(graphifyGraph());
    const result = await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    expect(result.status).toBe("ready");
    expect(result.analyzedFiles).toBe(1);
    expect(result.artifactPaths).toEqual([
      "CONTEXT.md",
      ".understand-anything/zero-domains.json",
      ".understand-anything/knowledge-graph.json",
      ".understand-anything/mapping-metadata.json",
    ]);
    void (await fixture);

    // The EXISTING validator, driven exactly as promotion drives it: digest
    // the staged artifacts, then re-verify the records against them.
    const declared = declareMappedArtifacts(result.artifactPaths);
    const { artifacts } = await digestArtifactInputs(outputRoot, BASE_SHA, declared);
    await expect(validateArtifactRecords(outputRoot, BASE_SHA, artifacts, [])).resolves.toBeUndefined();

    // The EXISTING pack builder over the published layout.
    const { ContextCache } = await import("../../../src/context/cache.js");
    const cache = new ContextCache(cacheRoot);
    const manifest = await cache.promoteContext(outputRoot, {
      key: {
        provider: "github",
        host: "github.com",
        owner: "octo-org",
        repo: "octo-repo",
        schemaVersion: 2,
        tgdVersion: GRAPHIFY_MAPPER_VERSION,
        policyVersion: "1",
      },
      createdAt: "2026-08-31T00:00:00.000Z",
      artifacts: declareMappedArtifacts(result.artifactPaths),
      degradedReasons: [],
      builtFromSha: BASE_SHA,
      generation: 0,
      parentManifestHash: null,
    });

    const pack = await buildContextPack({
      contextRoot: cache.entryPath(manifest.key),
      manifest,
      ruleName: "tgd-review",
      changedFiles: ["src/auth.ts"],
    });
    expect(pack.text).toContain("# Trusted Rule Context");
    expect(pack.text).toContain("fn:authenticate");
    // #62's two new fields are rendered: the call-site anchor and the
    // AST-read provenance of the node's relations.
    expect(pack.text).toContain("Location: `L17`");
    expect(pack.text).toMatch(/Relations: 1 read from the AST, 0 resolved/);
    // The sensitive-files caveat from issue #62 caveat 4 — stated for every
    // mapper, since graph gaps are never evidence of absent code.
    expect(pack.text).toContain("absence from this graph is not evidence of absence in the code");
  });

  it("writes mapping metadata pinned to the analyzed base commit", async () => {
    const sourceRoot = await tempRoot("graphify-src-");
    const outputRoot = await tempRoot("graphify-out-");
    const { runner } = runnerWritingGraph(graphifyGraph());
    await new GraphifyMapper({ run: runner }).map(request(sourceRoot, outputRoot));
    const metadata = JSON.parse(
      await readFile(path.join(outputRoot, ".understand-anything/mapping-metadata.json"), "utf8"),
    );
    expect(metadata).toEqual({ version: 1, status: "complete", baseSha: BASE_SHA });
  });
});

describe("adaptGraphifyGraph — the total node-type mapping", () => {
  it("falls back to a valid pack type for a kind the table does not know", () => {
    const adapted = adaptGraphifyGraph({
      nodes: [{ id: "n1", label: "mystery", node_type: "quantum_thing" }],
      links: [],
    });
    expect(adapted).toBeDefined();
    expect(adapted?.nodes[0]?.type).toBe("concept");
  });

  it("skips malformed nodes and dangling links instead of throwing", () => {
    const adapted = adaptGraphifyGraph({
      nodes: [
        { id: "n1", label: "keep", node_type: "function" },
        { label: "no-id" },
        { id: "", label: "empty-id" },
      ],
      links: [
        { source: "n1", target: "missing", relation: "calls" },
        { source: "n1", target: "n1", relation: "self", confidence: "INFERRED" },
      ],
    });
    expect(adapted).toBeDefined();
    expect(adapted?.nodes).toHaveLength(1);
    expect(adapted?.edges).toHaveLength(1);
    expect(adapted?.edges[0]?.confidence).toBe("INFERRED");
    expect(adapted?.skippedNodes).toBe(2);
    expect(adapted?.skippedEdges).toBe(1);
  });

  it("normalizes relations the validator does not know and clamps weights", () => {
    const adapted = adaptGraphifyGraph({
      nodes: [
        { id: "n1", label: "a", node_type: "function" },
        { id: "n2", label: "b", node_type: "function" },
      ],
      links: [
        // graphify names relations tGDBot's closed set does not contain...
        { source: "n1", target: "n2", relation: "dynamic_import", weight: 7 },
        // ...and weights that are counts, not [0, 1] scores.
        { source: "n2", target: "n1", relation: "calls", weight: 42 },
        { source: "n1", target: "n2", relation: "references", weight: -3 },
      ],
    });
    expect(adapted).toBeDefined();
    // Unmapped relations normalize to "related"; known ones survive...
    expect(adapted?.edges[0]?.type).toBe("related");
    expect(adapted?.edges[1]?.type).toBe("calls");
    // ...and weights clamp into the validator's range instead of failing
    // the whole graph at publication.
    expect(adapted?.edges[0]?.weight).toBe(1);
    expect(adapted?.edges[1]?.weight).toBe(1);
    expect(adapted?.edges[2]?.weight).toBe(0);
  });

  it("returns undefined for a document with no usable nodes", () => {
    expect(adaptGraphifyGraph({ nodes: [], links: [] })).toBeUndefined();
    expect(adaptGraphifyGraph("not an object")).toBeUndefined();
  });
});
