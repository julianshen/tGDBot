// Orchestrating AgentSession: loads the `pi-subagents` extension, dispatches
// every loaded rule as one `subagent` tool call (PARALLEL mode — one task
// per rule), and parses the session's final JSON message into a
// DispatchResult. See SPEC.md's "Architecture correction" note and
// TASKS.md Task 5.
//
// `pi-subagents` and `@earendil-works/pi-coding-agent` are real pi SDK/
// extension packages that make real LLM calls once invoked — dispatchRules
// accepts an optional injected session factory (`createSession`) so tests
// can stub the session entirely and never construct a real one or touch the
// network (see test/fixtures/pi-session-stub.ts). The default factory,
// used in production, is the only place that touches the real SDK.
import { mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuleDefinition } from "../rules/types.js";
import { resolvePiSubagentsExtensionPath, resolveRpivAdvisorExtensionPath } from "./extensions.js";
import type { DispatchResult, Finding } from "./types.js";

export type { DispatchResult, Finding } from "./types.js";

// Appended to every rule's task automatically — rule authors never write
// this themselves (TASKS.md Task 5 technical design).
const FINDING_JSON_CONTRACT = `
Respond with ONLY a JSON array matching this shape (no prose, no markdown fences):
[{ "file": string, "line": number | null, "severity": "blocking" | "warning" | "suggestion", "category": string, "message": string }]
If you find nothing, respond with [] exactly.
`.trim();

// DEBT.md "Dispatched review subagents retain bash/edit/write tool access"
// (closed by ADR-003): this instruction is now defense-in-depth on top of a
// genuine tool restriction (see createIsolatedSessionCwd below), not the
// only enforcement mechanism. The dispatched "reviewer" agent's own
// definition grants it only read/grep/find/ls — it has no bash/edit/write
// tool to call at all, regardless of what this instruction says or what the
// (untrusted) diff content tries to get it to do.
const READ_ONLY_INSTRUCTION = "You are reviewing only — do not edit, write, or run mutating commands.";

// TASKS.md Task 6: appended to the dispatch prompt only when the advisor
// second-opinion pass is enabled (`--advisor on`, the default). Instructs
// the orchestrating session to call rpiv-advisor's `advisor` tool on its
// merged findings before emitting the final JSON, and to drop anything the
// advisor flags as a false positive.
const ADVISOR_INSTRUCTION =
  'Before responding with the final JSON, call the "advisor" tool for a second opinion on your merged findings; if the advisor flags a finding as a false positive, remove it before responding.';

// The minimal slice of the real pi SDK's `AgentSession` this module needs.
// The real `AgentSession` (from @earendil-works/pi-coding-agent) satisfies
// this shape directly.
export interface DispatchSession {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
}

// TASKS.md Task 6: the factory now takes `useAdvisor` so the real
// implementation can decide whether to load the rpiv-advisor extension
// alongside pi-subagents. It also now takes `cwd` — see
// createIsolatedSessionCwd's doc comment below for why this is a fresh,
// isolated temp directory rather than the process's own cwd. Stub factories
// used in tests (which don't care about the extension list or cwd) may
// ignore either parameter.
export type DispatchSessionFactory = (useAdvisor: boolean, cwd: string) => Promise<DispatchSession>;

async function createRealDispatchSession(useAdvisor: boolean, cwd: string): Promise<DispatchSession> {
  // pi-subagents is ALWAYS loaded; rpiv-advisor is loaded only when the
  // advisor second-opinion pass is enabled (TASKS.md Task 6, AC-6.1/AC-6.2).
  const additionalExtensionPaths = [resolvePiSubagentsExtensionPath()];
  if (useAdvisor) {
    additionalExtensionPaths.push(resolveRpivAdvisorExtensionPath());
  }

  // `cwd` here is the isolated temp directory created/seeded by
  // createIsolatedSessionCwd (never the target repo's own working
  // directory) — passed to both the loader (its own project-local resource
  // discovery: .pi/extensions, .pi/skills, .pi/prompts, AGENTS.md) and to
  // createAgentSession itself (which sets the session's own `cwd`, used by
  // dispatched tools — including pi-subagents' `subagent` tool — as their
  // `ctx.cwd` for project-scoped agent discovery; confirmed by reading
  // node_modules/@earendil-works/pi-coding-agent/docs/sdk.md's "Directories"
  // section and pi-subagents' own discoverAgents()/findNearestProjectRoot()
  // in node_modules/pi-subagents/src/agents/agents.ts).
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    cwd,
    tools: ["read", "subagent"],
    sessionManager: SessionManager.inMemory(),
  });

  return session;
}

// ADR-003: vendored, tool-restricted `reviewer` agent definition. Its
// frontmatter matches the shape of pi-subagents' own bundled
// agents/reviewer.md (name: reviewer, description, ...) but its `tools`
// list is `read, grep, find, ls` only — no bash/edit/write/intercom.
// Resolved relative to this module's own location (not process.cwd()) so it
// works whether running from src/ in dev (vitest) or from dist/ after
// `npm run build` — the build script copies this .md file alongside the
// compiled dispatch.js at dist/review/builtin-agents/reviewer.md (same
// pattern as src/rules/loader.ts's BUILTIN_RULE_PATH).
const VENDORED_REVIEWER_AGENT_PATH = fileURLToPath(
  new URL("./builtin-agents/reviewer.md", import.meta.url),
);

// ADR-003 "restrict dispatched subagent tools via project-scoped agent
// override": pi-subagents' agent discovery priority is Builtin < Installed
// package < User < Project, and — per pi-subagents' own README ("Agents and
// chains") and its discoverAgents()/mergeAgentsForScope() source — "if both
// .agents/ and the project config agents directory define the same parsed
// runtime agent name, the project config directory wins." pi-subagents'
// bundled `reviewer` agent (which has bash/edit/write) is loaded at
// "builtin" priority (see BUILTIN_AGENTS_DIR in
// node_modules/pi-subagents/src/agents/agents.ts) — the LOWEST priority.
//
// So: seed a fresh, empty temp directory with `<tempDir>/.pi/agents/
// reviewer.md` (our restricted definition) and use that temp directory as
// the orchestrating session's own `cwd`. pi-subagents' `findNearestProjectRoot`
// walks up from `cwd` looking for a `.pi` (or legacy `.agents`) directory;
// since we seed `<tempDir>/.pi/agents/`, `<tempDir>/.pi` exists, so the temp
// dir itself is treated as the "project root" — making our restricted
// `reviewer` definition win project-scope discovery and shadow the bundled
// one, for every dispatched task that references `agent: "reviewer"`.
//
// Critically, this NEVER touches the actual repo being reviewed: the temp
// directory is created fresh via `os.tmpdir()` + `fs.mkdtemp`, is empty
// except for the one seeded agent file, and is removed in dispatchRules'
// `finally` block after the session completes (success or failure).
//
// This also means the orchestrating session's OWN project-local resource
// discovery (.pi/extensions, .pi/skills, .pi/prompts, AGENTS.md — see
// node_modules/@earendil-works/pi-coding-agent/docs/sdk.md's "Directories"
// section) is scoped to this empty temp dir rather than to
// process.cwd()/the target repo, so nothing under the target repo can be
// accidentally discovered as an extension/skill/prompt either — confirmed
// by reading that doc directly rather than assuming.
//
// pi-subagents' and rpiv-advisor's own extension entry points
// (additionalExtensionPaths, above) are UNAFFECTED by this: they are
// resolved via `require.resolve` against THIS package's own node_modules in
// extensions.ts, which returns absolute paths independent of `cwd`.
async function createIsolatedSessionCwd(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-session-"));
  const agentsDir = path.join(tempDir, ".pi", "agents");
  await mkdir(agentsDir, { recursive: true });
  await copyFile(VENDORED_REVIEWER_AGENT_PATH, path.join(agentsDir, "reviewer.md"));
  return tempDir;
}

// Review finding (code-review fix): the diff IS embedded once per rule
// here, and that duplication is NECESSARY, not an oversight — verified
// against node_modules/pi-subagents/src/extension/schemas.ts. Each rule
// becomes its own entry in the "subagent" tool's top-level PARALLEL
// `tasks` array (TaskItem: `{ agent, task, model, ... }`), which the
// pi-subagents extension runs as an independent child agent session. Per
// schemas.ts's `context` field ("'fresh' or 'fork' to branch from parent
// session ... agents without defaultContext: 'fork' run fresh") and
// node_modules/pi-subagents/agents/reviewer.md (no `defaultContext:
// fork` frontmatter), the "reviewer" agent we dispatch defaults to a
// FRESH child session with no visibility into the orchestrating
// session's own conversation/context. Each task's `task` string is the
// *only* input that child ever sees — so if the diff isn't embedded in
// every rule's task text, N-1 of the N dispatched reviewers would have
// no diff to review at all. Instructing tasks to "review the diff
// already provided above in this conversation" would be incoherent
// under this dispatch model.
//
// What IS a legitimate residual risk: this makes total prompt size
// (across all N dispatched tasks combined) scale as O(rules * diff
// size), which can be large for a big diff and many rules. There's no
// safe way to truncate the diff without harming review quality (a
// truncated diff produces false negatives), so instead of silently
// eating that cost, `warnIfDiffCostRisk` below logs a visible warning
// when the combined size crosses a threshold, so the risk is observable
// rather than silent.
const DIFF_COST_WARNING_THRESHOLD_CHARS = 500_000; // ~125k tokens at ~4 chars/token

function warnIfDiffCostRisk(rules: RuleDefinition[], diff: string): void {
  const totalChars = diff.length * rules.length;
  if (rules.length > 1 && totalChars > DIFF_COST_WARNING_THRESHOLD_CHARS) {
    console.warn(
      `dispatchRules: dispatch prompt embeds the ${diff.length}-char diff once per rule ` +
        `(${rules.length} rules, ~${totalChars} chars total) — this is required because each ` +
        `dispatched "reviewer" subagent runs in a fresh, isolated child session with no access ` +
        `to the orchestrator's own context, but it does mean cost/context-window usage scales ` +
        `with rule count on large diffs or rule sets.`,
    );
  }
}

function buildTaskText(rule: RuleDefinition, diff: string): string {
  return [rule.body.trim(), READ_ONLY_INSTRUCTION, FINDING_JSON_CONTRACT, "---", "Diff:", diff].join(
    "\n\n",
  );
}

// Pure and SDK-independent, so it's directly testable (AC-5.2, AC-6.3)
// without a session of any kind. The only side effect is the cost-risk
// warning above, which mirrors the existing console.warn use elsewhere
// in this module (parseDispatchResult) and does not affect the return
// value.
export function buildDispatchPrompt(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
): string {
  warnIfDiffCostRisk(rules, diff);

  const ruleNames = rules.map((rule) => rule.name);

  const taskSpecs = rules
    .map((rule, index) => {
      const modelRef = `${rule.provider}/${rule.model}`;
      return [
        `Task ${index + 1} — rule "${rule.name}":`,
        `  agent: "reviewer"`,
        `  model: "${modelRef}"`,
        `  task: """`,
        buildTaskText(rule, diff),
        `  """`,
      ].join("\n");
    })
    .join("\n\n");

  const parts = [
    `You are orchestrating a code review. Call the "subagent" tool exactly ONCE, in its PARALLEL form (a top-level "tasks" array), with one task entry per rule below.`,
    `Each task entry's "agent" field must be the literal string "reviewer", its "task" field must be that rule's task text below (verbatim, including the diff), and its "model" field must be that rule's exact "<provider>/<model>" string below.`,
    taskSpecs,
    `After the subagent tool call returns, merge every task's own JSON findings array into one combined result, tagging each finding's "ruleName" field with the name of the rule whose task produced it (one of: ${ruleNames
      .map((name) => `"${name}"`)
      .join(", ")}).`,
  ];

  // TASKS.md Task 6, AC-6.3: only present when the advisor second-opinion
  // pass is enabled — must NOT appear when useAdvisor is false.
  if (useAdvisor) {
    parts.push(ADVISOR_INSTRUCTION);
  }

  parts.push(
    `Then respond with ONLY a final JSON object (no prose, no markdown fences) matching exactly this shape:`,
    `{ "findings": [{ "file": string, "line": number | null, "severity": "blocking" | "warning" | "suggestion", "category": string, "message": string, "ruleName": string }], "rulesRun": string[], "rulesFailed": string[] }`,
    `"rulesRun" lists the names of rules whose subagent task completed and produced usable output; "rulesFailed" lists any rule names whose task errored or produced no usable output.`,
  );

  return parts.join("\n\n");
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const VALID_SEVERITIES = new Set(["blocking", "warning", "suggestion"]);

// Validates a single Finding's required fields/types. `line` is optional/
// nullable (per the JSON contract, `number | null`) so it's checked only
// when present. If any element of `findings` fails this check, the whole
// response is treated as malformed (see dispatch.ts's caller) rather than
// silently keeping the well-formed findings and dropping the bad ones —
// a response that gets the shape wrong for one finding is not trustworthy
// for the others either.
function isValidFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.file !== "string") return false;
  if (!VALID_SEVERITIES.has(candidate.severity as string)) return false;
  if (typeof candidate.category !== "string") return false;
  if (typeof candidate.message !== "string") return false;
  if (typeof candidate.ruleName !== "string") return false;
  if (
    candidate.line !== undefined &&
    candidate.line !== null &&
    typeof candidate.line !== "number"
  ) {
    return false;
  }
  return true;
}

function looksLikeDispatchResult(value: unknown): value is DispatchResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.findings) &&
    candidate.findings.every(isValidFinding) &&
    isStringArray(candidate.rulesRun) &&
    isStringArray(candidate.rulesFailed)
  );
}

function fallbackResult(rules: RuleDefinition[]): DispatchResult {
  return { findings: [], rulesRun: [], rulesFailed: rules.map((rule) => rule.name) };
}

// Never throws — a single bad/malformed LLM response must not crash the
// whole run (SPEC.md boundary, AC-5.4).
function parseDispatchResult(text: string | undefined, rules: RuleDefinition[]): DispatchResult {
  if (!text) {
    console.warn("dispatchRules: session produced no final assistant message");
    return fallbackResult(rules);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch (err) {
    console.warn(`dispatchRules: could not parse final message as JSON (${(err as Error).message})`);
    return fallbackResult(rules);
  }

  if (!looksLikeDispatchResult(parsed)) {
    console.warn("dispatchRules: final message JSON did not match the DispatchResult shape");
    return fallbackResult(rules);
  }

  return parsed;
}

// TASKS.md Task 6: `useAdvisor` controls whether the rpiv-advisor extension
// is loaded (AC-6.1/AC-6.2) and whether the dispatch prompt instructs the
// session to call its `advisor` tool for a second opinion before finalizing
// (AC-6.3).
//
// ADR-003: every call creates a fresh, isolated temp directory (via
// createIsolatedSessionCwd) seeded with our tool-restricted `reviewer`
// agent override, passes it to the session factory as `cwd`, and always
// removes it in a `finally` block — on the success path AND on every
// error/fallback path below (a thrown session.prompt(), a malformed
// response, ...) — so temp directories never leak, including across CI
// runs where dispatchRules may be called repeatedly or fail partway.
export async function dispatchRules(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
  createSession: DispatchSessionFactory = createRealDispatchSession,
): Promise<DispatchResult> {
  const sessionCwd = await createIsolatedSessionCwd();

  try {
    const session = await createSession(useAdvisor, sessionCwd);
    const prompt = buildDispatchPrompt(rules, diff, useAdvisor);

    // dispatchRules is a safety boundary: a thrown exception from the real
    // SDK (network error, tool failure, rate limit, ...) during prompt() or
    // while reading the final message must not propagate — Task 8's CLI
    // wiring calls this function directly without its own try/catch, relying
    // on it to never throw (same contract as the malformed-JSON fallback
    // path below).
    let finalText: string | undefined;
    try {
      await session.prompt(prompt);
      finalText = session.getLastAssistantText();
    } catch (err) {
      console.warn(`dispatchRules: session.prompt() threw (${(err as Error).message})`);
      return fallbackResult(rules);
    }

    return parseDispatchResult(finalText, rules);
  } finally {
    // Never let a cleanup failure mask the real result/error above, or
    // itself throw out of dispatchRules — just warn, matching this module's
    // existing "warn, don't throw" pattern.
    await rm(sessionCwd, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(
        `dispatchRules: failed to remove temp session directory ${sessionCwd} (${(err as Error).message})`,
      );
    });
  }
}
