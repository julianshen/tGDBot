// Issue #138 phase 2: subagent DEFINITIONS — a reviewer persona as a reusable
// artifact rather than something baked into each rule body.
//
// A definition is `name` + model tier (#112) + tool scope + persona prose. It
// is NOT a delegation protocol: the host still resolves rules, compiles waves,
// and spawns one session per task. "Subagent" here means an AgentSession
// scoped by a definition file — an ownership boundary, nothing more. No
// orchestrating LLM appears anywhere on this path, which is the one property
// the legacy engine's failure list exists to protect.
//
// Two rules govern everything below, and both are NARROWING-ONLY:
//
//   1. A definition can never grant a tool the host did not already allow.
//      `tools` is intersected with the read-only set (ADR-003), so a definition
//      file that asks for `bash` gets a load error, not a shell. The check is
//      an allowlist rather than a denylist for the usual reason: a tool added
//      to pi later must default to unavailable.
//
//   2. A definition's body AUGMENTS the vendored reviewer system prompt, never
//      replaces it. The reviewer prompt is where ADR-003's read-only contract
//      and the finding schema live; a definition that could replace it could
//      quietly drop both, and the persona gain is not worth putting the output
//      contract in user-editable files.
//
// Invalid definition files never throw — one bad file must not fail a run, the
// same boundary rules/loader.ts already holds.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { globToRegExp, normalizeGlobPath } from "../rules/glob.js";

/** The filename suffix a definition file must carry. */
export const AGENT_FILE_SUFFIX = ".agent.md";

/**
 * Tools a definition may ask for.
 *
 * Exactly ADR-003's read-only set. `submit_findings` is deliberately absent:
 * it is host-mediated plumbing every reviewer gets unconditionally, and making
 * it selectable would let a definition produce a reviewer that cannot report
 * anything — a silent no-op review rather than a load error.
 */
export const SCOPEABLE_TOOLS = Object.freeze(["read", "grep", "find", "ls"] as const);

export type ScopeableTool = (typeof SCOPEABLE_TOOLS)[number];

export interface AgentDefinition {
  readonly name: string;
  /** Model pin, both halves or neither — same rule as a rule file's. */
  readonly provider?: string;
  readonly model?: string;
  /**
   * The subset of {@link SCOPEABLE_TOOLS} this agent gets. Absent means the
   * whole set, so a definition that says nothing about tools behaves exactly
   * as an unscoped reviewer does.
   */
  readonly tools?: readonly ScopeableTool[];
  /**
   * Globs bounding every path this agent may name in a HOST-MEDIATED request.
   *
   * Today that means the `delegate` tool's target (phase 3) — the host checks
   * the path before it acts on it. It is deliberately NOT presented as a
   * sandbox over the reviewer's own read tools: see `pathScopeIsAdvisory`.
   */
  readonly pathScope?: readonly string[];
  /** Whether this agent may request a host-mediated delegation (phase 3). */
  readonly delegate: boolean;
  /** Persona prose, appended to the vendored reviewer prompt. */
  readonly body: string;
  readonly sourcePath: string;
}

export interface AgentLoadResult {
  readonly agents: AgentDefinition[];
  readonly errors: { sourcePath: string; message: string }[];
}

/**
 * Whether a `path_scope` currently binds the agent's own read tools.
 *
 * It does NOT, and the honest answer is a named export rather than a comment,
 * because the reason is not obvious from the code and reads like an oversight:
 * every reviewer session runs in an empty temp cwd with the repository never
 * mounted (`direct-dispatch.ts`), so `read`/`grep`/`find`/`ls` reach nothing
 * to scope in the first place. A reviewer works from the embedded diff and the
 * host-built context packs.
 *
 * So `path_scope` binds the one place a path is genuinely acted on: the
 * `delegate` target. Presenting it as a filesystem sandbox would be the
 * spec-asserting-a-property-it-does-not-deliver failure this project keeps
 * finding in review, so the loader says so out loud and the README repeats it.
 */
export const pathScopeIsAdvisory = true as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Every frontmatter key a definition may carry. Anything else is a load error. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "provider",
  "model",
  "tools",
  "path_scope",
  "delegate",
]);

interface ParsedAgentFile {
  agent?: AgentDefinition;
  error?: string;
}

export function parseAgentFile(sourcePath: string, raw: string): ParsedAgentFile {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `agent file has malformed YAML frontmatter: ${message}` };
  }
  const data = parsed.data as Record<string, unknown>;

  // Unknown keys are a LOAD ERROR, not ignorable metadata, and this is the
  // highest-consequence validation in the file. `path_scpoe: ["**/*.md"]`
  // parses cleanly, leaves `pathScope` undefined, and `withinPathScope` then
  // permits every file — a typo silently producing the WIDEST configuration
  // from a file written to narrow. A misspelled `tools` grants the full
  // default set the same way. Fail-closed is not available here (an unknown
  // key could mean anything), so fail LOUDLY (CodeRabbit review of PR #149).
  const unknown = Object.keys(data).find((key) => !KNOWN_FIELDS.has(key));
  if (unknown !== undefined) {
    return {
      error:
        `agent file has unknown frontmatter field "${unknown}" — known fields are ` +
        `${[...KNOWN_FIELDS].join(", ")}. A misspelled field is silently ignored, and for ` +
        `"tools" or "path_scope" that means the agent runs UNSCOPED`,
    };
  }

  if (!isNonEmptyString(data.name)) {
    return { error: `agent file is missing required frontmatter field "name"` };
  }
  if (!NAME_PATTERN.test(data.name)) {
    return {
      error:
        `agent file's "name" must match "${NAME_PATTERN.source}" — it becomes a ` +
        `reference in rule frontmatter and a staging directory name`,
    };
  }

  // Same pairing rule as a rule file's pin, and for the same reason: half a
  // pin is certainly a mistake, and guessing the other half runs the agent
  // somewhere its author never chose.
  const hasProvider = isNonEmptyString(data.provider);
  const hasModel = isNonEmptyString(data.model);
  if (hasProvider !== hasModel) {
    const present = hasProvider ? "provider" : "model";
    const missing = hasProvider ? "model" : "provider";
    return {
      error:
        `agent file sets frontmatter field "${present}" without "${missing}" — ` +
        `pin both (provider AND model) or neither`,
    };
  }

  let tools: ScopeableTool[] | undefined;
  if (data.tools !== undefined) {
    const candidates = Array.isArray(data.tools) ? data.tools : [data.tools];
    if (candidates.length === 0 || !candidates.every(isNonEmptyString)) {
      return {
        error: `frontmatter field "tools" must be a non-empty string or an array of them`,
      };
    }
    // NARROWING ONLY. An unknown name is an error rather than a silent drop:
    // "tools: [bash]" meaning "no bash, quietly" is how a file comes to promise
    // something it does not deliver, and a typo'd "grpe" would otherwise
    // produce a reviewer missing a tool with no explanation anywhere.
    for (const candidate of candidates as string[]) {
      if (!(SCOPEABLE_TOOLS as readonly string[]).includes(candidate)) {
        return {
          error:
            `frontmatter field "tools" contains "${candidate}", which is not one of ` +
            `${SCOPEABLE_TOOLS.join(", ")} — a definition may only NARROW the ` +
            `read-only toolset (ADR-003), never extend it`,
        };
      }
    }
    tools = [...new Set(candidates as ScopeableTool[])];
  }

  let pathScope: string[] | undefined;
  if (data.path_scope !== undefined) {
    const candidates = Array.isArray(data.path_scope) ? data.path_scope : [data.path_scope];
    if (candidates.length === 0 || !candidates.every(isNonEmptyString)) {
      return {
        error: `frontmatter field "path_scope" must be a non-empty string or an array of them`,
      };
    }
    // Compiled here so an unusable pattern names the file, rather than
    // becoming a scope that silently matches nothing — which, for a scope,
    // fails CLOSED and would strand the agent with no way to see why.
    for (const candidate of candidates as string[]) {
      try {
        globToRegExp(candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          error: `frontmatter field "path_scope" contains an unusable pattern "${candidate}": ${message}`,
        };
      }
    }
    pathScope = [...(candidates as string[])];
  }

  if (data.delegate !== undefined && typeof data.delegate !== "boolean") {
    return { error: `frontmatter field "delegate" must be a boolean` };
  }

  const body = parsed.content.trim();
  if (body.length === 0) {
    return {
      error:
        `agent file has an empty body — a definition with no persona adds nothing ` +
        `to the vendored reviewer prompt, and is more likely a truncated file than an intent`,
    };
  }

  return {
    agent: {
      name: data.name,
      ...(hasProvider ? { provider: data.provider as string, model: data.model as string } : {}),
      ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
      ...(pathScope === undefined ? {} : { pathScope: Object.freeze(pathScope) }),
      delegate: data.delegate === true,
      body,
      sourcePath,
    },
  };
}

async function listAgentFiles(agentsDir: string): Promise<string[]> {
  // A caller that built its config by hand can leave this unset, and `readdir`
  // answers `undefined` with a TypeError rather than ENOENT — which took the
  // ENTIRE review down from inside an opt-in feature that had nothing to
  // contribute. Definitions are additive; failing to find none of them is not
  // a reason to fail a review.
  if (typeof agentsDir !== "string" || agentsDir.length === 0) return [];
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // NOTDIR, EACCES, and anything else: named, and treated as no definitions.
    // The alternative is that an unreadable directory aborts a review that
    // would otherwise have run every rule it loaded.
    console.warn(
      `loadAgentDefinitions: could not read agent definitions from "${agentsDir}" ` +
        `(${(err as Error).message}); continuing with none`,
    );
    return [];
  }
  return entries.filter((entry) => entry.endsWith(AGENT_FILE_SUFFIX)).sort();
}

/**
 * Loads every `*.agent.md` under `agentsDir`.
 *
 * Missing directory is not an error: definitions are opt-in, and a repository
 * that has none is the common case. First name wins on a collision, with the
 * loser recorded as an error naming its own path — the same policy rule
 * loading already uses, so the two behave alike when a user has both.
 */
export async function loadAgentDefinitions(agentsDir: string): Promise<AgentLoadResult> {
  const agents: AgentDefinition[] = [];
  const errors: { sourcePath: string; message: string }[] = [];
  const claimed = new Map<string, string>();

  for (const entry of await listAgentFiles(agentsDir)) {
    const sourcePath = path.join(agentsDir, entry);
    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ sourcePath, message: `could not read agent file: ${message}` });
      continue;
    }
    const { agent, error } = parseAgentFile(sourcePath, raw);
    if (error !== undefined || agent === undefined) {
      errors.push({ sourcePath, message: error ?? "agent file could not be parsed" });
      continue;
    }
    const previous = claimed.get(agent.name);
    if (previous !== undefined) {
      errors.push({
        sourcePath,
        message: `agent name "${agent.name}" is already defined by ${previous}`,
      });
      continue;
    }
    claimed.set(agent.name, sourcePath);
    agents.push(agent);
  }

  return { agents, errors };
}

/**
 * The tool names a session for this agent should be created with.
 *
 * `submit_findings` is appended unconditionally — a reviewer that cannot
 * report is not a narrower reviewer, it is a broken one.
 */
export function sessionToolsFor(agent: AgentDefinition | undefined): string[] {
  const scoped = agent?.tools ?? SCOPEABLE_TOOLS;
  return [...scoped, "submit_findings"];
}

/**
 * Whether `candidate` falls inside an agent's declared path scope.
 *
 * No scope means no restriction. An empty scope cannot occur — the loader
 * rejects it — so this never has to decide whether "declared but empty" means
 * everything or nothing, which is exactly the ambiguity that makes fail-open
 * scope bugs.
 */
export function withinPathScope(agent: AgentDefinition | undefined, candidate: string): boolean {
  const scope = agent?.pathScope;
  if (scope === undefined) return true;
  // `normalizeGlobPath`, not a local normalization: `applies_to` matching
  // already uses it, and a scope check that normalized even slightly
  // differently would accept a path the rest of the system reads as another —
  // which is a scope BYPASS, not a cosmetic inconsistency.
  const normalized = normalizeGlobPath(candidate.replace(/\\/gu, "/"));
  return scope.some((glob) => globToRegExp(glob).test(normalized));
}
