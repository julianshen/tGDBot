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
  ALLOWED_DEFINITION_TOOLS,
} from "../../../src/review/agent-definition.js";

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
    { name: "reviewer-docs", tools: ["read"], body: "", sourcePath: "/a.md" },
    { name: "reviewer-core", tools: ["read", "grep", "find", "ls"], body: "", sourcePath: "/b.md" },
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
