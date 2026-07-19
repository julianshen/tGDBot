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
});
