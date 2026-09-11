// Issue #138 phase 2. Ordered by how much the property matters, not by how
// the module is laid out.
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAgentDefinitions,
  parseAgentFile,
  SCOPEABLE_TOOLS,
  sessionToolsFor,
  withinPathScope,
  type AgentDefinition,
} from "../../../src/agents/definition.js";

const agentFile = (frontmatter: string, body = "Review documentation changes."): string =>
  `---\n${frontmatter}\n---\n\n${body}\n`;

const parsed = (frontmatter: string, body?: string): AgentDefinition | undefined =>
  parseAgentFile("/agents/x.agent.md", agentFile(frontmatter, body)).agent;

describe("agent definitions narrow, never widen", () => {
  // THE property. A definition file is user-editable; if it could name a tool
  // the host did not already allow, ADR-003's read-only guarantee would live
  // in a Markdown file any contributor can change.
  it("rejects a tool outside the read-only set", () => {
    const { agent, error } = parseAgentFile("/a.agent.md", agentFile("name: x\ntools: [read, bash]"));

    expect(agent).toBeUndefined();
    expect(error).toMatch(/bash/u);
    expect(error).toMatch(/NARROW/u);
  });

  it.each(["bash", "edit", "write", "subagent"])("rejects %s specifically", (tool) => {
    // Named individually because each is a documented ADR-003 violation, and a
    // regression that re-admitted exactly one of them would otherwise pass.
    expect(parsed(`name: x\ntools: [${tool}]`)).toBeUndefined();
  });

  it("rejects an unknown tool rather than dropping it", () => {
    // A silent drop is how a file comes to promise something it does not
    // deliver: `tools: [grpe]` would produce a reviewer missing grep with no
    // explanation anywhere.
    expect(parsed("name: x\ntools: [grpe]")).toBeUndefined();
  });

  it("gives an unscoped agent the whole read-only set", () => {
    expect(sessionToolsFor(parsed("name: x"))).toEqual([...SCOPEABLE_TOOLS, "submit_findings"]);
  });

  it("always includes submit_findings, even for the narrowest agent", () => {
    // A reviewer that cannot report is not a narrower reviewer; it is a broken
    // one, and its whole task would read as a rule that found nothing.
    expect(sessionToolsFor(parsed("name: x\ntools: [read]"))).toEqual(["read", "submit_findings"]);
  });

  it("cannot select submit_findings itself", () => {
    // Selectable plumbing means a definition can produce a silent no-op review.
    expect(parsed("name: x\ntools: [submit_findings]")).toBeUndefined();
  });
});

describe("model pinning", () => {
  it("accepts a complete pin", () => {
    expect(parsed("name: x\nprovider: anthropic\nmodel: claude-sonnet-5")).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it.each([
    ["provider without model", "name: x\nprovider: anthropic"],
    ["model without provider", "name: x\nmodel: claude-sonnet-5"],
  ])("rejects %s", (_label, frontmatter) => {
    // Same rule a rule file's pin has: guessing the other half runs the agent
    // somewhere its author never chose.
    expect(parsed(frontmatter)).toBeUndefined();
  });
});

describe("path scope", () => {
  it("accepts a path inside the scope", () => {
    expect(withinPathScope(parsed("name: x\npath_scope: '**/*.md'"), "docs/a.md")).toBe(true);
  });

  it("refuses a path outside it", () => {
    expect(withinPathScope(parsed("name: x\npath_scope: '**/*.md'"), "src/a.ts")).toBe(false);
  });

  it("treats an absent scope as no restriction", () => {
    expect(withinPathScope(parsed("name: x"), "anything/at/all.ts")).toBe(true);
  });

  it("normalizes a leading ./ the same way applies_to does", () => {
    // A scope check that normalized differently from the rest of the system
    // would accept a path everything else reads as another — a bypass, not an
    // inconsistency.
    expect(withinPathScope(parsed("name: x\npath_scope: '**/*.md'"), "./docs/a.md")).toBe(true);
  });

  it("rejects an unusable glob at load time", () => {
    // A scope that silently matched nothing would fail CLOSED and strand the
    // agent with no way to see why.
    expect(parsed("name: x\npath_scope: '['")).toBeUndefined();
  });
});

describe("loading a directory", () => {
  const withAgentsDir = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tgd-agents-test-"));
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents, "utf8");
    }
    return dir;
  };

  it("loads every .agent.md", async () => {
    const dir = await withAgentsDir({
      "docs.agent.md": agentFile("name: docs"),
      "core.agent.md": agentFile("name: core"),
    });
    const { agents, errors } = await loadAgentDefinitions(dir);

    expect(errors).toEqual([]);
    expect(agents.map((agent) => agent.name).sort()).toEqual(["core", "docs"]);
  });

  it("ignores files that are not .agent.md", async () => {
    // The suffix is the opt-in. A README in the agents directory is not a
    // definition, and reporting it as a malformed one would be noise on every
    // single run.
    const dir = await withAgentsDir({ "README.md": "# not an agent\n" });

    await expect(loadAgentDefinitions(dir)).resolves.toEqual({ agents: [], errors: [] });
  });

  it("treats a missing directory as no definitions", async () => {
    // Definitions are opt-in; every repository predating #138 has no such
    // directory and must review exactly as before.
    await expect(loadAgentDefinitions("/nonexistent/agents/dir")).resolves.toEqual({
      agents: [],
      errors: [],
    });
  });

  it("records a bad file and keeps the good ones", async () => {
    // One malformed definition must not fail the run — the same boundary rule
    // loading already holds.
    const dir = await withAgentsDir({
      "bad.agent.md": agentFile("name: bad\ntools: [bash]"),
      "good.agent.md": agentFile("name: good"),
    });
    const { agents, errors } = await loadAgentDefinitions(dir);

    expect(agents.map((agent) => agent.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.sourcePath).toMatch(/bad\.agent\.md$/u);
  });

  it("keeps the first claim on a duplicate name and reports the second", async () => {
    const dir = await withAgentsDir({
      "a.agent.md": agentFile("name: dup", "First."),
      "b.agent.md": agentFile("name: dup", "Second."),
    });
    const { agents, errors } = await loadAgentDefinitions(dir);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.body).toBe("First.");
    expect(errors[0]?.message).toMatch(/already defined/u);
  });
});

describe("shape validation", () => {
  it("requires a name", () => {
    expect(parsed("tools: [read]")).toBeUndefined();
  });

  it("rejects a name that cannot be a directory or a reference", () => {
    expect(parsed("name: 'has spaces/and slashes'")).toBeUndefined();
  });

  it("rejects an empty body", () => {
    // A definition with no persona adds nothing to the vendored prompt, and is
    // far likelier to be a truncated file than an intent.
    expect(parsed("name: x", "")).toBeUndefined();
  });

  it("rejects a non-boolean delegate", () => {
    expect(parsed("name: x\ndelegate: yes-please")).toBeUndefined();
  });

  it("defaults delegate to false", () => {
    // Absent must mean NO. A capability that defaults on is one a definition
    // author acquires without asking for it.
    expect(parsed("name: x")?.delegate).toBe(false);
  });

  it("survives malformed YAML without throwing", () => {
    const { agent, error } = parseAgentFile("/a.agent.md", "---\nname: [unclosed\n---\n\nbody\n");

    expect(agent).toBeUndefined();
    expect(error).toMatch(/frontmatter/u);
  });
});

// The examples are documentation, and documentation that does not parse is
// worse than none: a user copying `examples/agents/docs.agent.md` would get a
// load error the README implies cannot happen.
describe("the shipped examples", () => {
  it("all parse", async () => {
    const { agents, errors } = await loadAgentDefinitions("examples/agents");

    expect(errors).toEqual([]);
    expect(agents.map((agent) => agent.name).sort()).toEqual(["deep-dive", "docs"]);
  });

  it("keeps the delegating example inside a path scope", async () => {
    // An example that declared `delegate: true` with no scope would be the
    // widest possible configuration presented as the recommended one — and
    // examples get copied far more often than they get read.
    const { agents } = await loadAgentDefinitions("examples/agents");
    const deepDive = agents.find((agent) => agent.name === "deep-dive");

    expect(deepDive?.delegate).toBe(true);
    expect(deepDive?.pathScope).toBeDefined();
  });

  it("keeps the non-delegating example non-delegating", async () => {
    const { agents } = await loadAgentDefinitions("examples/agents");

    expect(agents.find((agent) => agent.name === "docs")?.delegate).toBe(false);
  });
});
