import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBusinessReference } from "../../../src/context/business-reference.js";

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

function adequateDoc(title = "Domain", secondHeading = "Workflow"): string {
  return `# ${title}\n\n${"Business behavior and invariants. ".repeat(20)}\n\n## ${secondHeading}\n\n` +
    "The workflow coordinates customer requests with fulfillment outcomes.\n";
}

function domainGraph(): Record<string, unknown> {
  return {
    version: "1.0.0",
    project: {
      name: "octo-repo",
      gitCommitHash: "def4567890def4567890def4567890def4567890",
    },
    nodes: [
      {
        id: "domain:orders",
        type: "domain",
        name: "Orders",
        summary: "Owns order placement and lifecycle invariants.",
      },
      {
        id: "flow:checkout",
        type: "flow",
        name: "Checkout",
        summary: "Validates a cart before creating an order.",
      },
    ],
    edges: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("selectBusinessReference", () => {
  it("AC-7.1: reuses explicit non-empty base documentation without applying the heading heuristic", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    await write(sourceRoot, "notes/product.md", "Authoritative product behavior.\n");
    const listTrackedFiles = vi.fn(async () => ["README.md"]);

    const first = await selectBusinessReference({
      sourceRoot,
      explicitPaths: ["notes/product.md"],
      generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
    }, { listTrackedFiles });
    const second = await selectBusinessReference({
      sourceRoot,
      explicitPaths: ["notes/product.md"],
      generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
    }, { listTrackedFiles });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: "existing", paths: ["notes/product.md"] });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(listTrackedFiles).not.toHaveBeenCalled();
    await expect(readFile(path.join(cacheRoot, "BUSINESS-CONTEXT.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-7.1: deduplicates equivalent explicit document paths after resolution", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    await write(sourceRoot, "notes/product.md", "Authoritative product behavior.\n");

    const result = await selectBusinessReference({
      sourceRoot,
      explicitPaths: [
        "notes/product.md",
        "./notes/product.md",
        path.join(sourceRoot, "notes/product.md"),
      ],
      generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
    });

    expect(result).toMatchObject({ kind: "existing", paths: ["notes/product.md"] });
  });

  it("AC-7.1: deterministically selects adequate tracked docs from the fixed allowlist", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    await write(sourceRoot, "docs/domain-overview.md", adequateDoc());
    await write(sourceRoot, "README.md", adequateDoc("Architecture", "Data Model"));
    await write(sourceRoot, "notes/domain.md", adequateDoc());

    const result = await selectBusinessReference({
      sourceRoot,
      explicitPaths: [],
      generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
    }, {
      listTrackedFiles: async () => ["notes/domain.md", "README.md", "docs/domain-overview.md"],
    });

    expect(result).toMatchObject({
      kind: "existing",
      paths: ["docs/domain-overview.md", "README.md"],
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("AC-7.3: rejects an explicit path outside the trusted source before reading it", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const outsideRoot = await tempRoot("business-reference-outside-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    const outsidePath = path.join(outsideRoot, "business.md");
    await writeFile(outsidePath, "sensitive outside content\n", "utf8");

    await expect(selectBusinessReference({
      sourceRoot,
      explicitPaths: [outsidePath],
      generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
    })).rejects.toThrow(/outside.*trusted source|escape/i);
  });

  it("AC-7.3: rejects an explicit document symlink that escapes the trusted source", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const outsideRoot = await tempRoot("business-reference-outside-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    await writeFile(path.join(outsideRoot, "business.md"), adequateDoc(), "utf8");
    await symlink(path.join(outsideRoot, "business.md"), path.join(sourceRoot, "business.md"));

    await expect(selectBusinessReference({
      sourceRoot,
      explicitPaths: ["business.md"],
      generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
    })).rejects.toThrow(/symbolic link|outside.*trusted source|escape/i);
  });

  it.each(["vendor/lib/.git/config.md", "vendor/lib/.GIT/config.md"])(
    "AC-7.3: rejects repository metadata at %s",
    async (relativePath) => {
      const sourceRoot = await tempRoot("business-reference-source-");
      const cacheRoot = await tempRoot("business-reference-cache-");
      await write(sourceRoot, relativePath, "credential-bearing repository metadata\n");

      await expect(selectBusinessReference({
        sourceRoot,
        explicitPaths: [relativePath],
        generatedPath: path.join(cacheRoot, "BUSINESS-CONTEXT.md"),
      })).rejects.toThrow(/repository metadata/i);
    },
  );

  it("AC-7.2: generates a cited cache-local reference from the domain graph and leaves source unchanged", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    const generatedPath = path.join(cacheRoot, "BUSINESS-CONTEXT.md");
    await write(sourceRoot, "README.md", "# Project\n\nShort setup notes only.\n");
    await write(cacheRoot, ".understand-anything/domain-graph.json", JSON.stringify(domainGraph()));
    const originalReadme = await readFile(path.join(sourceRoot, "README.md"), "utf8");

    const result = await selectBusinessReference({
      sourceRoot,
      explicitPaths: [],
      generatedPath,
    }, {
      listTrackedFiles: async () => ["README.md"],
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ kind: "generated", paths: ["BUSINESS-CONTEXT.md"] });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    const generated = await readFile(generatedPath, "utf8");
    expect(generated).toContain("generated: true");
    expect(generated).toContain("provider: github");
    expect(generated).toContain("repository: octo-repo");
    expect(generated).toContain("base_sha: def4567890def4567890def4567890def4567890");
    expect(generated).toMatch(/source_sha256: [a-f0-9]{64}/);
    expect(generated).toContain("generated_at: 2026-07-20T00:00:00.000Z");
    expect(generated).toContain(".understand-anything/domain-graph.json#domain:orders");
    expect(generated).toContain(".understand-anything/domain-graph.json#flow:checkout");
    await expect(readFile(path.join(sourceRoot, "README.md"), "utf8")).resolves.toBe(originalReadme);
    await expect(readFile(path.join(sourceRoot, "BUSINESS-CONTEXT.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-7.2: reuses generated context when graph provenance and abbreviated base SHA match", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    const generatedPath = path.join(cacheRoot, "BUSINESS-CONTEXT.md");
    await write(cacheRoot, ".understand-anything/domain-graph.json", JSON.stringify(domainGraph()));
    const input = { sourceRoot, explicitPaths: [], generatedPath };

    await selectBusinessReference(input, {
      listTrackedFiles: async () => [],
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    const firstContents = (await readFile(generatedPath, "utf8"))
      .replace("base_sha: def4567890def4567890def4567890def4567890", "base_sha: DEF4567890DE");
    await writeFile(generatedPath, firstContents, "utf8");

    const second = await selectBusinessReference(input, {
      listTrackedFiles: async () => [],
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });

    expect(second).toMatchObject({ kind: "generated", paths: ["BUSINESS-CONTEXT.md"] });
    expect(await readFile(generatedPath, "utf8")).toBe(firstContents);
    expect(firstContents).toMatch(/source_sha256: [a-f0-9]{64}/u);
    expect(firstContents).toContain("base_sha: DEF4567890DE");
    expect(firstContents).not.toContain("2027-01-01T00:00:00.000Z");
  });

  it("AC-7.2: escapes domain graph text that could alter generated Markdown structure", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    const graph = domainGraph();
    const nodes = graph.nodes as Array<Record<string, unknown>>;
    nodes[0]!.name = "# Orders [admin](https://example.test)";
    nodes[0]!.summary = "Use `unsafe` *formatting* and [links](https://example.test).";
    await write(cacheRoot, ".understand-anything/domain-graph.json", JSON.stringify(graph));
    const generatedPath = path.join(cacheRoot, "BUSINESS-CONTEXT.md");

    await selectBusinessReference({ sourceRoot, explicitPaths: [], generatedPath }, {
      listTrackedFiles: async () => [],
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    const generated = await readFile(generatedPath, "utf8");
    expect(generated).toContain("Domain: \\# Orders \\[admin\\]\\(https://example\\.test\\)");
    expect(generated).toContain("Use \\`unsafe\\` \\*formatting\\* and \\[links\\]\\(https://example\\.test\\)\\.");
  });

  it("AC-7.2: returns none without creating a document when no adequate docs or domain graph exist", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    const generatedPath = path.join(cacheRoot, "BUSINESS-CONTEXT.md");

    const result = await selectBusinessReference({
      sourceRoot,
      explicitPaths: [],
      generatedPath,
    }, { listTrackedFiles: async () => [] });

    expect(result).toMatchObject({ kind: "none", paths: [] });
    await expect(readFile(generatedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-7.2: refuses to generate BUSINESS-CONTEXT.md inside the trusted repository", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    await write(sourceRoot, ".understand-anything/domain-graph.json", JSON.stringify(domainGraph()));

    await expect(selectBusinessReference({
      sourceRoot,
      explicitPaths: [],
      generatedPath: path.join(sourceRoot, "BUSINESS-CONTEXT.md"),
    }, { listTrackedFiles: async () => [] })).rejects.toThrow(/generated.*outside|repository|trusted source/i);
    await expect(readFile(path.join(sourceRoot, "BUSINESS-CONTEXT.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-7.2: reports a descriptive error when the generation root is missing", async () => {
    const sourceRoot = await tempRoot("business-reference-source-");
    const cacheRoot = await tempRoot("business-reference-cache-");
    const missingRoot = path.join(cacheRoot, "missing");

    await expect(selectBusinessReference({
      sourceRoot,
      explicitPaths: [],
      generatedPath: path.join(missingRoot, "BUSINESS-CONTEXT.md"),
    }, { listTrackedFiles: async () => [] })).rejects.toThrow(
      `Generated business reference root directory does not exist or is inaccessible: ${missingRoot}`,
    );
  });
});
