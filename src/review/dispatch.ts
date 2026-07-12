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
import { mkdir, mkdtemp, rm, copyFile, symlink, writeFile, access } from "node:fs/promises";
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
  // Optional. The real pi AgentSession exposes subscribe(); dispatchRules uses
  // it (when present) to capture the `subagent` tool's structured
  // `result.details.results` — one entry per dispatched task, in dispatch
  // order, each carrying the task's model/exitCode/finalOutput. That structured
  // data lets dispatchRules deterministically FIX the rulesRun/rulesFailed
  // accounting and RECOVER any whole rule's findings the orchestrating LLM
  // dropped, instead of trusting the LLM's self-reported final JSON (which was
  // observed to occasionally mark a task that ran — exit 0 — as "failed" and
  // drop its findings). Stub sessions that omit subscribe simply skip
  // reconciliation and fall back to the orchestrator's JSON (existing behavior).
  //
  // The listener's event is typed `any` because the real pi AgentSession's
  // event is a large SDK-internal union; forcing our narrower
  // DispatchSessionEvent here creates a listener-parameter variance conflict
  // that prevents the real session from satisfying this interface. We narrow to
  // the fields we actually read (DispatchSessionEvent) inside the listener.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe?(listener: (event: any) => void): () => void;
}

// The narrow slice of pi AgentSession events dispatchRules inspects: a
// tool_execution_end for the "subagent" tool, whose result.details.results
// carries the per-task structured outcomes (see pi-subagents'
// SingleResult in node_modules/pi-subagents/src/shared/types.ts — fields
// beyond these exist but are not needed here).
export interface DispatchSessionEvent {
  type: string;
  toolName?: string;
  result?: {
    details?: {
      results?: CapturedTaskResult[];
    };
  };
}

// One dispatched task's structured outcome, read from the subagent tool's
// details.results[i] (order = dispatch order = rule order). `model` is
// "<provider>/<model>[:thinkingLevel]" (e.g. "xai/grok-4.5:high"), used to
// cross-check the positional rule mapping. `finalOutput` is the task's raw
// findings-JSON text (the FINDING_JSON_CONTRACT array), used to recover a
// rule's findings if the orchestrator dropped them.
export interface CapturedTaskResult {
  model?: string;
  exitCode?: number | null;
  error?: string;
  timedOut?: boolean;
  detached?: boolean;
  finalOutput?: string;
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
    // Fork-safety fix (found via a real multi-model run against
    // hmchangw/chat#490): the orchestrating LLM sometimes chooses
    // `context: "fork"` for its subagent call, which requires a PERSISTED
    // parent session. Previously this session was in-memory, so fork hard-failed
    // ("Forked subagent context requires a persisted parent session") and took
    // down every task at once — we relied on a prompt instruction (still present
    // as the preferred path) to steer the LLM to "fresh". A PERSISTED session
    // makes fork a no-op-safe choice regardless of what the LLM picks, turning
    // that from a prompt-guarded risk into a hard guarantee. Session files land
    // under `getAgentDir()/sessions/` — which, because dispatchRules points
    // PI_CODING_AGENT_DIR at the hermetic throwaway agent dir (intercom fix),
    // means they live inside that temp dir and are removed with it in the
    // `finally` block. Nothing persists into the user's real ~/.pi/agent.
    sessionManager: SessionManager.create(cwd),
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

// Bug fix (found via a real multi-model run against hmchangw/chat#490):
// pi-subagents' "intercom bridge" defaults to mode "always" — it injects
// `intercom`/`contact_supervisor` tools plus a coordination instruction into
// EVERY dispatched agent (even our tool-restricted reviewer) and lets a
// PARALLEL run "detach for intercom coordination", handing control back to
// the orchestrator to reply to a supervisor request over multiple turns.
// Our orchestrator is single-shot (one prompt() call, read the final
// message), so when N>1 rules dispatch in parallel and the run detaches, the
// orchestrator can't do that multi-turn coordination and every task fails at
// once. A single-rule run (N=1) happened to avoid the detach, which is why
// one model worked but two didn't.
//
// The fix: disable the intercom bridge for our dispatched runs by setting
// pi-subagents' `intercomBridge.mode: "off"` in its config. pi-subagents
// reads that config from `<agentDir>/extensions/subagent/config.json`, where
// `agentDir` comes from `process.env.PI_CODING_AGENT_DIR` (or ~/.pi/agent) —
// a GLOBAL location we must not mutate as a side effect of running the CLI.
// So instead we build a hermetic, throwaway agent dir per dispatch:
//   - symlink the real agentDir's `auth.json`/`models.json`/`settings.json`
//     into it (so credentials and model config still resolve — a symlink,
//     not a copy, so no secret is ever duplicated to a second location)
//   - write our own `extensions/subagent/config.json` with the bridge off
// dispatchRules points `PI_CODING_AGENT_DIR` at this temp dir for the
// duration of the session (restoring the previous value afterward) and
// removes it in its `finally` block. This never touches the user's real
// ~/.pi/agent. Validated end-to-end: with the bridge off, a 2-model parallel
// fan-out against hmchangw/chat#490 completes with rulesRun for both models.
const HERMETIC_AGENT_LINK_FILES = ["auth.json", "models.json", "settings.json"];
const SUBAGENT_CONFIG_INTERCOM_OFF = JSON.stringify({ intercomBridge: { mode: "off" } });

async function createIsolatedAgentDir(realAgentDir: string): Promise<string> {
  const tempAgentDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-agentdir-"));

  // Symlink credential/model/settings files from the real agent dir so the
  // orchestrating session and dispatched subagents still resolve API keys and
  // custom-provider config. Only link files that actually exist (a fresh CI
  // env may have none — that's fine, the review just runs with whatever
  // provider auth is present via env vars, same as before).
  await Promise.all(
    HERMETIC_AGENT_LINK_FILES.map(async (name) => {
      const source = path.join(realAgentDir, name);
      try {
        await access(source);
      } catch {
        return; // source absent — nothing to link
      }
      await symlink(source, path.join(tempAgentDir, name)).catch((err: unknown) => {
        // A failed symlink (e.g. sandbox without symlink support) shouldn't
        // abort the review — warn and continue; worst case is that provider
        // auth resolves from env vars instead of auth.json.
        console.warn(
          `dispatchRules: could not symlink ${name} into the isolated agent dir (${(err as Error).message})`,
        );
      });
    }),
  );

  const subagentConfigDir = path.join(tempAgentDir, "extensions", "subagent");
  await mkdir(subagentConfigDir, { recursive: true });
  await writeFile(path.join(subagentConfigDir, "config.json"), SUBAGENT_CONFIG_INTERCOM_OFF, "utf-8");

  return tempAgentDir;
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
    // The orchestrating session is now PERSISTED (createRealDispatchSession),
    // so `context: "fork"` no longer crashes — but "fresh" is still what we
    // actually want: each rule's review is independent and needs no visibility
    // into the parent conversation, and fresh is cheaper (no parent context
    // carried into each child). This instruction keeps "fresh" as the preferred
    // path; the persisted session is the hard-guarantee backstop if the LLM
    // ignores it. Per pi-subagents' schema, an explicit top-level `context`
    // overrides every child in the invocation.
    `Set the subagent tool call's top-level "context" field to the literal string "fresh" — each rule's review is independent and needs no shared context.`,
    taskSpecs,
    // Attribution fix (found via a real multi-model run against
    // hmchangw/chat#490): with fork/intercom fixed, BOTH parallel tasks
    // reliably ran, but the orchestrator sometimes mis-attributed or dropped
    // one. The subagent tool aggregates results as a "N/N succeeded" summary
    // line followed by one "=== Task K: reviewer ===" block per task, in the
    // SAME ORDER they were dispatched — but every block is headed "reviewer"
    // (the agent name), so the ONLY reliable signal for which block belongs to
    // which rule is position. Spell that mapping out explicitly rather than
    // letting the orchestrator guess from a block's content.
    `The subagent tool returns its result as a "K/N succeeded" summary line followed by one "=== Task <i>: reviewer ===" block per task, in the EXACT ORDER you dispatched them. Attribute strictly by that order: ${ruleNames
      .map((name, index) => `Task ${index + 1}'s block is rule "${name}"`)
      .join("; ")}. Never infer a block's rule from its content — only from its task position.`,
    `Merge every task block's JSON findings array into one combined "findings" array, stamping each finding's "ruleName" with its task's rule name from the order mapping above.`,
  ];

  // TASKS.md Task 6, AC-6.3: only present when the advisor second-opinion
  // pass is enabled — must NOT appear when useAdvisor is false.
  if (useAdvisor) {
    parts.push(ADVISOR_INSTRUCTION);
  }

  parts.push(
    `Then respond with ONLY a final JSON object (no prose, no markdown fences) matching exactly this shape:`,
    `{ "findings": [{ "file": string, "line": number | null, "severity": "blocking" | "warning" | "suggestion", "category": string, "message": string, "ruleName": string }], "rulesRun": string[], "rulesFailed": string[] }`,
    // Attribution fix (see order-mapping note above): the old wording defined
    // rulesFailed as tasks that "produced no usable output", which the
    // orchestrator wrongly applied to a task that RAN and returned an empty or
    // all-duplicate findings array — silently degrading a 2-model fan-out to
    // 1-model coverage. A rule that ran and found nothing is a SUCCESS.
    `A rule's task SUCCEEDED — put it in "rulesRun" — if its "=== Task <i> ===" block contains a parseable JSON findings array, INCLUDING an empty array []. A rule that ran and simply found no issues (or only issues another rule also found) is a SUCCESS, not a failure. Put a rule in "rulesFailed" ONLY if its task errored/crashed or its block has no parseable findings array at all. Every task counted in the "K/N succeeded" summary MUST appear in "rulesRun" by its rule name — never drop or omit a rule that ran. The rules are: ${ruleNames
      .map((name) => `"${name}"`)
      .join(", ")}.`,
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

// Like isValidFinding but WITHOUT requiring ruleName — a dispatched task's raw
// finalOutput follows FINDING_JSON_CONTRACT (`[{file,line,severity,category,
// message}]`), which has no ruleName (the orchestrator adds it during merge;
// when we recover a dropped task's findings we stamp it ourselves).
function isValidRawFinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.file !== "string") return false;
  if (!VALID_SEVERITIES.has(c.severity as string)) return false;
  if (typeof c.category !== "string") return false;
  if (typeof c.message !== "string") return false;
  if (c.line !== undefined && c.line !== null && typeof c.line !== "number") return false;
  return true;
}

// Parses one task's raw finalOutput into Finding[] stamped with ruleName.
// Best-effort — returns [] on any parse/shape problem, never throws.
function parseFindingsFromFinalOutput(text: string, ruleName: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every(isValidRawFinding)) return [];
  return parsed.map((f) => {
    const c = f as Record<string, unknown>;
    return {
      file: c.file as string,
      line: c.line as number | undefined,
      severity: c.severity as Finding["severity"],
      category: c.category as string,
      message: c.message as string,
      ruleName,
    };
  });
}

// A task ran successfully iff it exited 0 with no error/timeout/detach.
function taskSucceeded(c: CapturedTaskResult): boolean {
  return c.exitCode === 0 && !c.error && !c.timedOut && !c.detached;
}

// Deterministic reconciliation of the orchestrating LLM's self-reported
// DispatchResult against the structured per-task results captured from the
// subagent tool (details.results). See DispatchSession.subscribe's doc comment
// for why: the LLM was observed to occasionally mark a task that RAN (exit 0)
// as "failed" and drop its whole findings set.
//
// - rulesRun/rulesFailed come purely from each task's exitCode (order-mapped to
//   rules), so a task that ran can never be mis-reported as failed.
// - Findings are kept from the orchestrator (preserving the advisor
//   second-opinion pass's filtering) for rules that ran, PLUS recovered from a
//   rule's raw finalOutput when the orchestrator dropped that whole rule's
//   findings (zero findings tagged with its name). Findings the orchestrator
//   attributed to a rule that did NOT run are dropped (a failed task's output
//   isn't trustworthy; also drops hallucinated rule names).
//
// Falls back to the orchestrator's own result (NO reconciliation) whenever the
// captured results can't be safely 1:1 order-mapped to rules — counts differ,
// or a captured model doesn't match its positional rule's "<provider>/<model>"
// prefix (the real details.model carries a ":thinkingLevel" suffix, so a prefix
// match is used). This guarantees reconciliation never makes results WORSE on
// an unexpected shape; it only ever corrects a mapping we can fully verify.
//
// KNOWN LIMITATION (documented, unobserved): this repairs whole-rule drops (the
// observed failure) and fixes accounting; it does not detect a PARTIAL drop
// within a rule the orchestrator kept, nor a mis-attribution where the
// orchestrator tagged one rule's findings with another rule's name.
function reconcileWithCapturedResults(
  orchestrator: DispatchResult,
  captured: CapturedTaskResult[],
  rules: RuleDefinition[],
): DispatchResult {
  if (captured.length !== rules.length) return orchestrator;
  const orderTrustworthy = captured.every((c, i) => {
    if (!c.model) return true; // nothing to cross-check — rely on dispatch order
    return c.model.startsWith(`${rules[i].provider}/${rules[i].model}`);
  });
  if (!orderTrustworthy) return orchestrator;

  const rulesRun: string[] = [];
  const rulesFailed: string[] = [];
  const recovered: Finding[] = [];
  captured.forEach((c, i) => {
    const rule = rules[i];
    if (!taskSucceeded(c)) {
      rulesFailed.push(rule.name);
      return;
    }
    rulesRun.push(rule.name);
    const orchestratorHasFindings = orchestrator.findings.some((f) => f.ruleName === rule.name);
    if (!orchestratorHasFindings && c.finalOutput) {
      recovered.push(...parseFindingsFromFinalOutput(c.finalOutput, rule.name));
    }
  });

  const runSet = new Set(rulesRun);
  const kept = orchestrator.findings.filter((f) => runSet.has(f.ruleName));
  return { findings: [...kept, ...recovered], rulesRun, rulesFailed };
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
  // Hermetic agent dir + PI_CODING_AGENT_DIR override (intercom-bridge fix,
  // see createIsolatedAgentDir) are set up ONLY for the real session factory.
  // When a test injects a stub factory, none of this runs — the stub never
  // touches the real SDK, so it needs no credentials, no agent-dir config,
  // and must not mutate process.env or symlink the real ~/.pi/agent.
  const usingRealFactory = createSession === createRealDispatchSession;

  // Declared up front (not inside `try`) so the `finally` block can always
  // see them: whatever was created before a mid-setup throw still gets
  // restored/removed. All setup below happens INSIDE the try so that a
  // failure in createIsolatedSessionCwd / createIsolatedAgentDir /
  // createSession degrades to fallbackResult rather than propagating —
  // dispatchRules is a never-throws safety boundary (Task 8's CLI wiring
  // calls it directly without its own try/catch).
  let sessionCwd: string | undefined;
  let tempAgentDir: string | undefined;
  let prevAgentDirEnv: string | undefined;
  let agentDirEnvWasSet = false;
  let agentDirEnvOverridden = false;

  try {
    sessionCwd = await createIsolatedSessionCwd();

    if (usingRealFactory) {
      tempAgentDir = await createIsolatedAgentDir(getAgentDir());
      agentDirEnvWasSet = "PI_CODING_AGENT_DIR" in process.env;
      prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      agentDirEnvOverridden = true;
    }

    const session = await createSession(useAdvisor, sessionCwd);
    const prompt = buildDispatchPrompt(rules, diff, useAdvisor);

    // Capture the subagent tool's structured per-task results (details.results)
    // so we can deterministically reconcile the orchestrator's self-reported
    // accounting/findings afterward (see reconcileWithCapturedResults). Only
    // the LAST subagent call's results are kept (the orchestrator is instructed
    // to call it exactly once; if it retries, the final call is authoritative).
    // Sessions without subscribe (test stubs) skip capture → no reconciliation.
    let capturedTaskResults: CapturedTaskResult[] = [];
    let unsubscribe: (() => void) | undefined;
    if (typeof session.subscribe === "function") {
      unsubscribe = session.subscribe((event: DispatchSessionEvent) => {
        if (event.type === "tool_execution_end" && event.toolName === "subagent") {
          const results = event.result?.details?.results;
          if (Array.isArray(results)) {
            capturedTaskResults = results;
          }
        }
      });
    }

    // A thrown exception from the real SDK (network error, tool failure,
    // rate limit, ...) during prompt() or while reading the final message
    // must not propagate — same never-throws contract as the malformed-JSON
    // fallback path below.
    let finalText: string | undefined;
    try {
      await session.prompt(prompt);
      finalText = session.getLastAssistantText();
    } catch (err) {
      console.warn(`dispatchRules: session.prompt() threw (${(err as Error).message})`);
      return fallbackResult(rules);
    } finally {
      unsubscribe?.();
    }

    const orchestratorResult = parseDispatchResult(finalText, rules);
    return reconcileWithCapturedResults(orchestratorResult, capturedTaskResults, rules);
  } catch (err) {
    // Setup/session-creation failure (createIsolatedSessionCwd,
    // createIsolatedAgentDir, or createSession threw). Degrade to
    // fallbackResult rather than propagating, upholding the never-throws
    // safety-boundary contract.
    console.warn(
      `dispatchRules: setup or session creation failed (${(err as Error).message})`,
    );
    return fallbackResult(rules);
  } finally {
    // Restore PI_CODING_AGENT_DIR to exactly its prior state (unset vs. a
    // specific value) before anything else, so the override never leaks past
    // this call — the CLI runs one review per process, but leaving a mutated
    // global env behind would still be a latent surprise. This is straight
    // assignment/delete and cannot throw. NOTE: process.env is process-global,
    // so dispatchRules must not be run concurrently within one process (the
    // CLI runs exactly one review per process).
    if (agentDirEnvOverridden) {
      if (agentDirEnvWasSet) {
        process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
      } else {
        delete process.env.PI_CODING_AGENT_DIR;
      }
    }
    // Never let a cleanup failure mask the real result/error above, or itself
    // throw out of dispatchRules — just warn, matching this module's existing
    // "warn, don't throw" pattern. Each rm is independently guarded so one
    // failing doesn't skip the other.
    if (sessionCwd) {
      await rm(sessionCwd, { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(
          `dispatchRules: failed to remove temp session directory ${sessionCwd} (${(err as Error).message})`,
        );
      });
    }
    if (tempAgentDir) {
      await rm(tempAgentDir, { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(
          `dispatchRules: failed to remove temp agent directory ${tempAgentDir} (${(err as Error).message})`,
        );
      });
    }
  }
}
