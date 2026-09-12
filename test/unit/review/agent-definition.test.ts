// Issue #138 phase 2: subagent definition files — reusable reviewer personas
// that a rule can reference by name. The loader discovers .agent.md files in
// a directory, validates frontmatter, and the direct engine resolves
// definitions to scope tool allowlists, models, and system prompts.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAgentDefinitions,
  resolveAgentDefinition,
  fingerprintAgentDefinitions,
  withinPathScope,
  ALLOWED_DEFINITION_TOOLS,
} from "../../../src/review/agent-definition.js";
import type { AgentDefinition } from "../../../src/review/agent-definition.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeDefinition(dir: string, filename: string, frontmatter: string, body = ""): Promise<string> {
  const filePath = path.join(dir, filename);
  await writeFile(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
}

const VALID_FRONTMATTER = "name: reviewer-docs\ntools: read, grep";

describe("loadAgentDefinitions", () => {
  it("loads definitions with name, tools, and body", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "reviewer-docs.agent.md", VALID_FRONTMATTER, "Focus on documentation quality.");

    const { definitions, errors } = await loadAgentDefinitions(dir);

    expect(errors).toEqual([]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      name: "reviewer-docs",
      tools: ["read", "grep"],
      body: "Focus on documentation quality.",
    });
  });

  it("returns an empty list for a missing directory", async () => {
    const { definitions, errors } = await loadAgentDefinitions(path.join(os.tmpdir(), "nonexistent-agents-dir"));
    expect(definitions).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("returns a load error when the path is not a directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    const filePath = path.join(dir, "not-a-dir");
    await writeFile(filePath, "not a directory", "utf8");

    const { definitions, errors } = await loadAgentDefinitions(filePath);

    expect(definitions).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].sourcePath).toBe(filePath);
    expect(errors[0].message).toMatch(/could not read agent definitions directory/);
  });

  it("rejects an unknown tool with a load error naming the tool", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "bad.agent.md", "name: bad\ntools: read, bash");

    const { definitions, errors } = await loadAgentDefinitions(dir);

    expect(definitions).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/bash/);
    expect(errors[0].message).toMatch(/unrecognized tool/);
  });

  it("rejects a definition missing the name field", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "noname.agent.md", "tools: read");

    const { definitions, errors } = await loadAgentDefinitions(dir);
    expect(definitions).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/"name"/);
  });

  it("rejects a model pin without a provider (and vice versa)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "half-pin.agent.md", "name: half\nmodel: claude-opus-4-5");

    const { errors } = await loadAgentDefinitions(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/"model" without "provider"/);
  });

  it("rejects a present provider or model that is not a non-empty string", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "numeric-pin.agent.md", "name: numeric\nprovider: 123\nmodel: 456");

    const { definitions, errors } = await loadAgentDefinitions(dir);
    expect(definitions).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/"provider" must be a non-empty string/);
  });

  it("keeps the first definition when names collide", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "a.agent.md", "name: dup", "first");
    await writeDefinition(dir, "b.agent.md", "name: dup", "second");

    const { definitions, errors } = await loadAgentDefinitions(dir);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].body).toBe("first");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/duplicate/);
  });

  it("defaults tools to the full read-only set when absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeDefinition(dir, "default.agent.md", "name: default-tools");

    const { definitions } = await loadAgentDefinitions(dir);
    expect(definitions[0]?.tools).toEqual([...ALLOWED_DEFINITION_TOOLS]);
  });

  it("records a malformed frontmatter error without failing the batch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-def-"));
    roots.push(dir);
    await writeFile(path.join(dir, "bad.agent.md"), "---\nname: [unclosed\n---\nbody", "utf8");
    await writeDefinition(dir, "good.agent.md", "name: good\ntools: read");

    const { definitions, errors } = await loadAgentDefinitions(dir);
    expect(definitions).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("resolveAgentDefinition", () => {
  const definitions = [
    { name: "reviewer-docs", tools: ["read"], body: "", delegate: false, sourcePath: "/a.md" },
    { name: "reviewer-core", tools: ["read", "grep", "find", "ls"], body: "", delegate: false, sourcePath: "/b.md" },
  ];

  it("finds a definition by name", () => {
    expect(resolveAgentDefinition("reviewer-docs", definitions)?.tools).toEqual(["read"]);
  });

  it("returns undefined when no definition matches", () => {
    expect(resolveAgentDefinition("nonexistent", definitions)).toBeUndefined();
  });

  it("returns undefined for an undefined reference (the standard persona)", () => {
    expect(resolveAgentDefinition(undefined, definitions)).toBeUndefined();
  });
});

describe("fingerprintAgentDefinitions", () => {
  const base: AgentDefinition = {
    name: "docs-reviewer",
    tools: ["read"],
    delegate: false,
    body: "Focus on documentation.",
    sourcePath: "/agents/docs.agent.md",
  };

  it("is stable for the same definitions regardless of input order or sourcePath", () => {
    const a = fingerprintAgentDefinitions([base, { ...base, name: "core", sourcePath: "/a.md" }]);
    const b = fingerprintAgentDefinitions([
      { ...base, name: "core", sourcePath: "/other.md" },
      { ...base, sourcePath: "/moved.md" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when body, tools, provider, or model change", () => {
    const original = fingerprintAgentDefinitions([base]);
    expect(fingerprintAgentDefinitions([{ ...base, body: "Different." }])).not.toBe(original);
    expect(fingerprintAgentDefinitions([{ ...base, tools: ["read", "grep"] }])).not.toBe(original);
    expect(fingerprintAgentDefinitions([{ ...base, provider: "openai", model: "gpt-4.1-mini" }])).not.toBe(original);
  });
});

// Issue #138 phase 3: the two fields nesting adds, and the validation that
// keeps a typo from silently widening a definition.
describe("phase 3 fields", () => {
  const withDir = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tgd-agents-p3-"));
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents, "utf8");
    }
    return dir;
  };

  const one = async (frontmatter: string) => {
    const dir = await withDir({ "x.agent.md": `---\n${frontmatter}\n---\n\nPersona.\n` });
    return loadAgentDefinitions(dir);
  };

  it("defaults delegate to false", async () => {
    // Absent must mean NO. A capability that defaults on is one an author
    // acquires without asking for it.
    const { definitions } = await one("name: x");
    expect(definitions[0]?.delegate).toBe(false);
  });

  it("accepts an explicit delegate", async () => {
    const { definitions } = await one("name: x\ndelegate: true");
    expect(definitions[0]?.delegate).toBe(true);
  });

  it("rejects a non-boolean delegate", async () => {
    const { definitions, errors } = await one("name: x\ndelegate: yes-please");
    expect(definitions).toEqual([]);
    expect(errors[0]?.message).toMatch(/delegate/u);
  });

  it("bounds a path scope", async () => {
    const { definitions } = await one("name: x\npath_scope: '**/*.md'");
    expect(withinPathScope(definitions[0], "docs/a.md")).toBe(true);
    expect(withinPathScope(definitions[0], "src/a.ts")).toBe(false);
  });

  it("treats an absent scope as no restriction", async () => {
    const { definitions } = await one("name: x");
    expect(withinPathScope(definitions[0], "anything/at/all.ts")).toBe(true);
  });

  it("normalizes a leading ./ the way applies_to does", async () => {
    // A scope check that normalized differently from the rest of the system
    // would accept a path everything else reads as another — a bypass, not a
    // cosmetic inconsistency.
    const { definitions } = await one("name: x\npath_scope: '**/*.md'");
    expect(withinPathScope(definitions[0], "./docs/a.md")).toBe(true);
  });

  it("rejects an unusable glob at load time", async () => {
    // A scope that silently matched nothing would fail CLOSED and strand the
    // persona with no way to see why.
    const { definitions } = await one("name: x\npath_scope: '['");
    expect(definitions).toEqual([]);
  });

  it("changes the fingerprint when the scope changes", async () => {
    // Both new fields change what a review DOES, so editing either must
    // retrigger on an unchanged head — the same reason `body` is fingerprinted.
    const scoped = (await one("name: x\npath_scope: '**/*.md'")).definitions;
    const unscoped = (await one("name: x")).definitions;
    expect(fingerprintAgentDefinitions(scoped)).not.toBe(fingerprintAgentDefinitions(unscoped));
  });

  it("changes the fingerprint when delegate changes", async () => {
    const on = (await one("name: x\ndelegate: true")).definitions;
    const off = (await one("name: x")).definitions;
    expect(fingerprintAgentDefinitions(on)).not.toBe(fingerprintAgentDefinitions(off));
  });
});

// A typo must not silently produce the WIDEST configuration from a file
// written to narrow (CodeRabbit review of PR #149).
describe("unknown frontmatter fields are a load error", () => {
  const one = async (frontmatter: string) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tgd-agents-unknown-"));
    await writeFile(path.join(dir, "x.agent.md"), `---\n${frontmatter}\n---\n\nPersona.\n`, "utf8");
    return loadAgentDefinitions(dir);
  };

  it("rejects a misspelled path_scope instead of running unscoped", async () => {
    // `path_scpoe` parses cleanly, leaves pathScope undefined, and
    // withinPathScope then permits every file.
    const { definitions, errors } = await one("name: x\npath_scpoe: '**/*.md'");
    expect(definitions).toEqual([]);
    expect(errors[0]?.message).toMatch(/path_scpoe/u);
  });

  it("rejects a misspelled tools instead of granting the full set", async () => {
    const { definitions } = await one("name: x\ntool: read");
    expect(definitions).toEqual([]);
  });

  it("names the fields that ARE known, so the typo is findable", async () => {
    const { errors } = await one("name: x\nnonsense: 1");
    expect(errors[0]?.message).toMatch(/path_scope/u);
    expect(errors[0]?.message).toMatch(/tools/u);
  });

  it("still accepts every documented field together", async () => {
    // The guard must not reject the format the README teaches.
    const { definitions, errors } = await one(
      "name: x\nprovider: anthropic\nmodel: claude-sonnet-5\ntools: read, grep\n" +
      "path_scope: ['**/*.md']\ndelegate: true",
    );
    expect(errors).toEqual([]);
    expect(definitions[0]).toMatchObject({ name: "x", delegate: true });
  });
});
