// Issue #138 phase 2: subagent definition files — reusable reviewer personas
// that a rule can reference instead of inlining its own model/tool/prompt.
//
// A definition is a Markdown file with YAML frontmatter:
//
//     ---
//     name: reviewer-docs
//     tools: read, grep
//     provider: anthropic
//     model: claude-opus-4-5
//     ---
//
//     Additional system-prompt instructions for this persona. These are
//     PREPENDED to the vendored reviewer base prompt, so the persona narrows
//     or extends the base without duplicating it.
//
// The three knobs (tools, model, extra prompt) are the only ones a definition
// controls. Everything else — the diff, the context packs, the findings
// contract — comes from the rule and the host, so a definition cannot widen
// the trust boundary or bypass the findings contract.
//
// Definitions live alongside rules and are discovered by the same loader.
// A rule references one by name via its own `agent:` frontmatter field.
// Unresolved references are a dispatch-time warning and the rule runs with
// the defaults (additive, never a cliff), consistent with every optional
// feature in this codebase.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export interface AgentDefinition {
  readonly name: string;
  /** Subset of the read-only tool set this persona is scoped to. */
  readonly tools: readonly string[];
  readonly provider?: string;
  readonly model?: string;
  /** Additional system-prompt instructions, prepended to the reviewer base. */
  readonly body: string;
  readonly sourcePath: string;
}

export interface AgentDefinitionLoadResult {
  definitions: AgentDefinition[];
  errors: { sourcePath: string; message: string }[];
}

/**
 * The complete tool surface a definition may draw from. A definition cannot
 * add tools beyond this set — narrowing only, never widening (#62/ADR-003).
 */
export const ALLOWED_DEFINITION_TOOLS = new Set([
  "read", "grep", "find", "ls", "submit_findings",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseAgentDefinitionFile(
  sourcePath: string,
  raw: string,
): { definition?: AgentDefinition; error?: string } {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `agent definition has malformed YAML frontmatter: ${message}` };
  }
  const data = parsed.data as Record<string, unknown>;

  if (!isNonEmptyString(data.name)) {
    return { error: `agent definition is missing required frontmatter field "name"` };
  }

  // Tools: a comma-separated string or an array. Absent = the full read-only
  // set. Present = validated against the allowed set; an unknown tool is a
  // load error (never silently dropped — a typo'd tool name would silently
  // narrow the reviewer's vision with no explanation).
  const toolsValue = data.tools;
  let tools: string[];
  if (toolsValue === undefined) {
    tools = [...ALLOWED_DEFINITION_TOOLS];
  } else {
    const candidates = Array.isArray(toolsValue) ? toolsValue : String(toolsValue).split(",").map((t) => t.trim());
    if (candidates.length === 0 || !candidates.every(isNonEmptyString)) {
      return { error: `frontmatter field "tools" must be a non-empty string or an array of them` };
    }
    const invalid = (candidates as string[]).filter((t) => !ALLOWED_DEFINITION_TOOLS.has(t));
    if (invalid.length > 0) {
      return {
        error:
          `frontmatter field "tools" contains unrecognized tool(s): ${invalid.join(", ")}. ` +
          `Allowed: ${[...ALLOWED_DEFINITION_TOOLS].join(", ")}`,
      };
    }
    tools = [...(candidates as string[])];
  }

  // Model: same pair rule as rules files (provider + model, or neither).
  const hasProvider = isNonEmptyString(data.provider);
  const hasModel = isNonEmptyString(data.model);
  if (hasProvider !== hasModel) {
    const present = hasProvider ? "provider" : "model";
    const missing = hasProvider ? "model" : "provider";
    return {
      error:
        `agent definition sets frontmatter field "${present}" without "${missing}" — ` +
        `pin both (provider AND model) or neither (the definition then uses the rule's model)`,
    };
  }

  const body = parsed.content.trim();

  return {
    definition: {
      name: data.name,
      tools: Object.freeze(tools),
      ...(hasProvider ? { provider: data.provider as string, model: data.model as string } : {}),
      body,
      sourcePath,
    },
  };
}

async function loadOneDefinitionFile(
  sourcePath: string,
): Promise<{ definition?: AgentDefinition; error?: { sourcePath: string; message: string } }> {
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: { sourcePath, message: `could not read agent definition file: ${message}` } };
  }
  const { definition, error } = parseAgentDefinitionFile(sourcePath, raw);
  if (error) {
    return { error: { sourcePath, message: error } };
  }
  return { definition };
}

/**
 * Loads agent definitions from a directory. Same discovery pattern as the
 * rule loader: Markdown files, alphabetical, one bad file never fails the
 * batch. Duplicate names: first wins, later ones become errors.
 */
export async function loadAgentDefinitions(
  agentsDir: string,
): Promise<AgentDefinitionLoadResult> {
  const definitions: AgentDefinition[] = [];
  const errors: { sourcePath: string; message: string }[] = [];

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { definitions, errors };
    }
    throw err;
  }

  const mdFiles = entries
    .filter((entry) => entry.endsWith(".agent.md"))
    .sort();

  const results = await Promise.all(
    mdFiles.map((file) => loadOneDefinitionFile(path.join(agentsDir, file))),
  );
  for (const { definition, error } of results) {
    if (definition) definitions.push(definition);
    if (error) errors.push(error);
  }

  // Duplicate names: first wins (same pattern as dedupeByName in the rule
  // loader), later duplicates become errors.
  const seen = new Map<string, string>();
  const kept: AgentDefinition[] = [];
  for (const definition of definitions) {
    const first = seen.get(definition.name);
    if (first === undefined) {
      seen.set(definition.name, definition.sourcePath);
      kept.push(definition);
    } else {
      errors.push({
        sourcePath: definition.sourcePath,
        message: `duplicate agent definition name "${definition.name}": already defined by ${first}; this file's definition was skipped`,
      });
    }
  }

  return { definitions: kept, errors };
}

/**
 * Resolves the definition a rule references, or `undefined` when the rule
 * has no `agent` reference (the default — the rule runs with the standard
 * reviewer persona).
 */
export function resolveAgentDefinition(
  agentName: string | undefined,
  definitions: readonly AgentDefinition[],
): AgentDefinition | undefined {
  if (agentName === undefined) return undefined;
  return definitions.find((d) => d.name === agentName);
}
