// DIRECT deterministic dispatch (design-review P0): one AgentSession per
// rule, driven straight through the pi SDK's PUBLIC API, with the merge done
// in TypeScript — no orchestrating LLM anywhere on the data path.
//
// Why this exists: the legacy path (dispatch.ts) hands the fan-out AND the
// merge to an orchestrating LLM session calling pi-subagents' `subagent`
// tool, then spends several hundred lines correcting that LLM after the fact
// (reconciliation, provenance byte-matching, dropped-findings recovery). All
// of that machinery exists because the merge was probabilistic. Here the
// merge is code:
//
//   - each rule gets its OWN session — the vendored read-only reviewer system
//     prompt (the same reviewer.md, ADR-003), the rule's task text (the same
//     buildTaskText, diff embedded), the rule's resolved model;
//   - sessions run concurrently (Promise.all); each rule's outcome depends
//     only on its own session — one failure never takes down the others;
//   - each session's final text is parsed with the same never-throws
//     extractors the legacy recovery path already used, stamped with the
//     rule's name, and concatenated. Attribution is by construction, so
//     rulesRun/rulesFailed accounting is exact and suggestion provenance is
//     inherent (a finding can only come from its own rule's session).
//
// The advisor pass (--advisor on) stays an LLM step — that is its job (a
// second opinion) — but as a DISCRETE, bounded one: a single session that is
// asked to call the `advisor` tool on the already-complete merged findings
// and answer with a drop-list. It filters a known-complete set, so the
// advisor-on recovery gap the legacy path documents cannot exist here.
//
// Also gone relative to legacy: the PI_CODING_AGENT_DIR env mutation and the
// hermetic agent-dir symlinks (auth/models/settings are READ directly off the
// real agent dir via explicit options — nothing is written there), and with
// them the need to serialize concurrent calls; and pi-subagents itself (the
// intercom/fork failure modes it brought are unreachable).
//
// `--dispatch legacy` keeps the old path selectable for one release as the
// escape hatch while this one gets live mileage.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import matter from "gray-matter";
import type { EffectiveRule, RuleDefinition } from "../rules/types.js";
import { buildTaskText } from "./dispatch-prompt.js";
import {
  classifyTaskFailure,
  extractFindingsArray,
  parseFindingsFromFinalOutput,
} from "./dispatch-results.js";
import type { DispatchSession } from "./dispatch.js";
import { resolveRpivAdvisorExtensionPath } from "./extensions.js";
import {
  resolveEffectiveRules,
  resolveOrchestratorModel,
  resolveRuleSessionModel,
} from "./orchestrator-model.js";
import { VENDORED_REVIEWER_AGENT_PATH } from "./session-hermetics.js";
import type { DispatchResult, Finding } from "./types.js";

/** Creates one rule's review session. Tests inject stubs; the real factory below is the only SDK toucher. */
export type DirectSessionFactory = (rule: EffectiveRule, cwd: string) => Promise<DispatchSession>;

/** Creates the (single) advisor session for the --advisor pass. */
export type AdvisorSessionFactory = (cwd: string) => Promise<DispatchSession>;

export interface DirectDispatchDeps {
  createSession?: DirectSessionFactory;
  createAdvisorSession?: AdvisorSessionFactory;
  /** Override for tests. Default RULE_PROMPT_TIMEOUT_MS. */
  ruleTimeoutMs?: number;
  /** Override for tests. Default ADVISOR_PROMPT_TIMEOUT_MS. */
  advisorTimeoutMs?: number;
}

// CodeRabbit review (PR #7): a hung provider call must not block Promise.all
// indefinitely — one stalled rule (or the advisor pass) would otherwise leave
// the whole review run open-ended, with no way for a caller to notice. These
// are circuit breakers, not a performance budget — generous, because a real
// multi-tool review turn can legitimately take minutes.
const RULE_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const ADVISOR_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

// Distinguishes a timeout from any other prompt() rejection so the catch sites
// below can classify it as "timed out" (classifyTaskFailure) rather than a
// generic error.
class PromptTimeoutError extends Error {
  readonly timedOut = true as const;
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PromptTimeoutError(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The vendored reviewer agent's Markdown BODY (frontmatter stripped) is the
// direct session's system prompt — the same instructions ADR-003 vendors for
// the legacy path's project-scoped agent override, minus the discovery
// machinery. Read lazily and cached: the file ships beside the compiled
// output (the build script copies it), and tests with stub factories must
// never require it.
let cachedReviewerSystemPrompt: string | undefined;
function reviewerSystemPrompt(): string {
  if (cachedReviewerSystemPrompt === undefined) {
    cachedReviewerSystemPrompt = matter(readFileSync(VENDORED_REVIEWER_AGENT_PATH, "utf-8"))
      .content.trim();
  }
  return cachedReviewerSystemPrompt;
}

async function createRealDirectSession(rule: EffectiveRule, cwd: string): Promise<DispatchSession> {
  // Credential gate BEFORE any session exists: a rule pinned to a provider
  // this machine can't authenticate must fail with the classified reason,
  // not burn a session-construction round trip to discover it. The error
  // strings deliberately match PROVIDER_AUTH_ERROR_RE's vocabulary so
  // classifyTaskFailure names the cause in the PR comment.
  const resolved = resolveRuleSessionModel(rule.provider, rule.model);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `could not resolve model for rule "${rule.name}"`);
  }

  // Hermetic by CONSTRUCTION rather than by directory games: the empty temp
  // cwd plus the no* flags mean nothing project-local can be discovered, and
  // the read-only toolset (read/grep/find/ls — ADR-003's exact list) is the
  // complete tool surface. auth/models/settings resolve from the REAL agent
  // dir via the SDK's own defaults — read-only, nothing symlinked or written.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: reviewerSystemPrompt(),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    cwd,
    tools: ["read", "grep", "find", "ls"],
    customTools: createReadOnlyTools(cwd),
    model: resolved.model,
    ...(resolved.thinkingLevel
      ? { thinkingLevel: resolved.thinkingLevel as CreateAgentSessionOptions["thinkingLevel"] }
      : {}),
    // In-memory: direct sessions are single-shot and never forked, so nothing
    // needs persisting anywhere.
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

// The advisor session: rpiv-advisor's extension loaded (it provides the
// `advisor` tool), everything else off. Runs on the same default-model ladder
// the orchestrator used (--model → settings default → rule models → pi's
// auth-aware default) — resolveOrchestratorModel already encodes it.
function makeRealAdvisorSessionFactory(
  defaultModel: string | undefined,
  effective: EffectiveRule[],
): AdvisorSessionFactory {
  return async (cwd: string): Promise<DispatchSession> => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      // Codex review (PR #7): noExtensions was missing here, so this loader
      // still discovered the user's REAL ambient extensions (from the real
      // agentDir's extensions/settings) alongside rpiv-advisor — breaking the
      // "everything else off" hermeticity this comment already promised, and
      // letting unrelated installed-extension code run during a review. The
      // rpiv-advisor path is loaded explicitly via additionalExtensionPaths
      // regardless of noExtensions (confirmed: createRealDirectSession's own
      // loader sets noExtensions: true and its extension still loads the same
      // way), so this is the only change needed.
      noExtensions: true,
      additionalExtensionPaths: [resolveRpivAdvisorExtensionPath()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const model = resolveOrchestratorModel({
      explicit: defaultModel,
      ruleCandidates: effective.map((r) => `${r.provider}/${r.model}`),
    });
    const { session } = await createAgentSession({
      resourceLoader: loader,
      cwd,
      tools: ["advisor"],
      ...(model ? { model } : {}),
      sessionManager: SessionManager.inMemory(),
    });
    return session;
  };
}

// The advisor's whole contract: one tool call, then a drop-list. Narrow on
// purpose — the advisor FILTERS findings; it never authors, edits, or
// re-attributes them, so nothing it says can add content to the review.
function buildAdvisorPrompt(findings: Finding[]): string {
  const numbered = findings.map((f, index) => ({ index, ...f }));
  return [
    `You are screening code-review findings for false positives.`,
    `Call the "advisor" tool exactly once, passing it the findings below for a second opinion.`,
    `Then respond with ONLY a JSON object (no prose, no markdown fences) of exactly this shape:`,
    `{ "drop": number[] }`,
    `where "drop" lists the "index" values of findings the advisor identified as false positives. If none are false positives, respond with { "drop": [] }.`,
    ``,
    `Findings:`,
    JSON.stringify(numbered, null, 2),
  ].join("\n");
}

// Lenient {"drop": number[]} extraction — same tolerance philosophy as
// extractFindingsArray. undefined = unusable answer (caller keeps everything).
export function parseAdvisorDropList(text: string | undefined): number[] | undefined {
  if (!text) return undefined;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  try {
    const parsed = JSON.parse(text.slice(first, last + 1)) as { drop?: unknown };
    if (Array.isArray(parsed.drop) && parsed.drop.every((n) => Number.isInteger(n))) {
      return parsed.drop as number[];
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * The direct counterpart of dispatchRules — same inputs, same DispatchResult,
 * same never-throws boundary — selected via `--dispatch direct` (the default).
 */
export async function dispatchRulesDirect(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
  deps: DirectDispatchDeps = {},
  defaultModel?: string,
): Promise<DispatchResult> {
  const createSession = deps.createSession ?? createRealDirectSession;
  const ruleTimeoutMs = deps.ruleTimeoutMs ?? RULE_PROMPT_TIMEOUT_MS;
  const advisorTimeoutMs = deps.advisorTimeoutMs ?? ADVISOR_PROMPT_TIMEOUT_MS;

  let cwd: string | undefined;
  try {
    // An empty temp cwd for every session: nothing project-local to discover,
    // nothing of the target repo reachable by relative path — same isolation
    // stance as the legacy path's createIsolatedSessionCwd, without the agent
    // seeding (direct sessions do no agent discovery at all).
    cwd = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-direct-"));

    const { effective, unresolved } = resolveEffectiveRules(rules, defaultModel);
    const unresolvedNames = Object.keys(unresolved);
    for (const name of unresolvedNames) {
      console.warn(`dispatchRulesDirect: rule "${name}" not dispatched: ${unresolved[name]}`);
    }

    const rulesRun: string[] = [];
    const rulesFailed: string[] = [...unresolvedNames];
    const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const name of unresolvedNames) ruleFailureReasons[name] = unresolved[name];

    // One independent session per rule. Every branch below records its
    // outcome and returns findings — nothing rejects, so Promise.all is safe.
    const perRule = await Promise.all(
      effective.map(async (rule): Promise<Finding[]> => {
        try {
          const session = await createSession(rule, cwd as string);
          await withTimeout(
            session.prompt(buildTaskText(rule, diff)),
            ruleTimeoutMs,
            `rule "${rule.name}" timed out after ${ruleTimeoutMs}ms`,
          );
          const text = session.getLastAssistantText();
          // extractFindingsArray distinguishes "no parseable findings array"
          // (undefined — the rule FAILED to follow its output contract) from
          // a genuinely empty review ([] — a SUCCESS).
          if (text === undefined || extractFindingsArray(text) === undefined) {
            rulesFailed.push(rule.name);
            ruleFailureReasons[rule.name] =
              "the reviewer returned no parseable findings array (see the CI logs)";
            console.warn(
              `dispatchRulesDirect: rule "${rule.name}" produced no parseable findings array`,
            );
            return [];
          }
          rulesRun.push(rule.name);
          return parseFindingsFromFinalOutput(text, rule.name);
        } catch (err) {
          const timedOut = err instanceof PromptTimeoutError;
          const message = (err as Error).message;
          rulesFailed.push(rule.name);
          // Same publish-safe classification the legacy path uses; the RAW
          // error goes to the logs only. A timeout is classified distinctly
          // ("timed out") rather than as a generic error.
          ruleFailureReasons[rule.name] = classifyTaskFailure(
            timedOut ? { timedOut: true } : { error: message },
            rule,
          );
          console.warn(
            `dispatchRulesDirect: rule "${rule.name}" (${rule.provider}/${rule.model}) failed: ${message}`,
          );
          return [];
        }
      }),
    );
    // Order-stable merge; every finding is already stamped with its own
    // rule's name by construction.
    let findings = perRule.flat();

    // Advisor pass: filters the COMPLETE merged set (so, unlike the legacy
    // path, advisor-on can never mask a dropped rule). Best-effort by
    // design — any failure keeps every finding and says so.
    if (useAdvisor && findings.length > 0) {
      const createAdvisorSession =
        deps.createAdvisorSession ?? makeRealAdvisorSessionFactory(defaultModel, effective);
      try {
        const advisor = await createAdvisorSession(cwd);
        await withTimeout(
          advisor.prompt(buildAdvisorPrompt(findings)),
          advisorTimeoutMs,
          `advisor pass timed out after ${advisorTimeoutMs}ms`,
        );
        const drop = parseAdvisorDropList(advisor.getLastAssistantText());
        if (drop === undefined) {
          console.warn(
            "dispatchRulesDirect: advisor pass returned no usable drop-list; keeping all findings",
          );
        } else if (drop.length > 0) {
          const dropSet = new Set(drop);
          findings = findings.filter((_, index) => !dropSet.has(index));
        }
      } catch (err) {
        console.warn(
          `dispatchRulesDirect: advisor pass failed (${(err as Error).message}); keeping all findings`,
        );
      }
    }

    return { findings, rulesRun, rulesFailed, ruleFailureReasons };
  } catch (err) {
    // Setup failure (mkdtemp, resolveEffectiveRules). Same never-throws
    // contract as dispatchRules.
    console.warn(`dispatchRulesDirect: setup failed (${(err as Error).message})`);
    const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    const reason = "the review dispatcher did not complete — see the CI logs for the cause";
    for (const rule of rules) ruleFailureReasons[rule.name] = reason;
    return {
      findings: [],
      rulesRun: [],
      rulesFailed: rules.map((rule) => rule.name),
      ruleFailureReasons,
    };
  } finally {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(
          `dispatchRulesDirect: failed to remove temp directory ${cwd} (${(err as Error).message})`,
        );
      });
    }
  }
}
