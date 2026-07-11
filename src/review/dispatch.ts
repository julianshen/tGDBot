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

// TASKS.md Task 5 "Read-only enforcement caveat": pi-subagents' bundled
// `reviewer` agent has bash/edit/write in its default tool list and the
// `subagent` tool exposes no per-task tool allowlist override, so v1 relies
// on this prompt instruction rather than a hard tool restriction.
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
// alongside pi-subagents. Stub factories used in tests (which don't care
// about the extension list) may ignore the parameter.
export type DispatchSessionFactory = (useAdvisor: boolean) => Promise<DispatchSession>;

async function createRealDispatchSession(useAdvisor: boolean): Promise<DispatchSession> {
  // pi-subagents is ALWAYS loaded; rpiv-advisor is loaded only when the
  // advisor second-opinion pass is enabled (TASKS.md Task 6, AC-6.1/AC-6.2).
  const additionalExtensionPaths = [resolvePiSubagentsExtensionPath()];
  if (useAdvisor) {
    additionalExtensionPaths.push(resolveRpivAdvisorExtensionPath());
  }

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    additionalExtensionPaths,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    tools: ["read", "subagent"],
    sessionManager: SessionManager.inMemory(),
  });

  return session;
}

function buildTaskText(rule: RuleDefinition, diff: string): string {
  return [rule.body.trim(), READ_ONLY_INSTRUCTION, FINDING_JSON_CONTRACT, "---", "Diff:", diff].join(
    "\n\n",
  );
}

// Pure and SDK-independent, so it's directly testable (AC-5.2, AC-6.3)
// without a session of any kind.
export function buildDispatchPrompt(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
): string {
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
export async function dispatchRules(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
  createSession: DispatchSessionFactory = createRealDispatchSession,
): Promise<DispatchResult> {
  const session = await createSession(useAdvisor);
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
}
