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
//   - sessions run in precompiled workflow waves; only an explicit parallel
//     group shares a Promise.all, and one failure never takes down later waves;
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
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import matter from "gray-matter";
import type { EffectiveRule } from "../rules/types.js";
import { buildTaskText, warnIfDiffCostRisk } from "./dispatch-prompt.js";
import { createSubmitFindingsTool, readSubmittedFindings, ruleDirName } from "./findings-file.js";
import type { AgentDefinition } from "../agents/definition.js";
import { sessionToolsFor } from "../agents/definition.js";
import {
  composeSystemPrompt,
  effectiveModelPin,
  readTaskMeta,
  writeTaskMeta,
  type TaskMeta,
} from "../agents/resolve.js";
import { createDelegateTool, type DelegationRunner } from "../agents/delegate.js";
import { makeDelegationRunner } from "../agents/delegate-runner.js";
import {
  classifyTaskFailure,
  extractFindingsArray,
  parseFindingsFromFinalOutput,
  referencesDeclaredBy,
} from "./dispatch-results.js";
import type { DispatchSession } from "./dispatch-session.js";
import { resolveRpivAdvisorExtensionPath } from "./extensions.js";
import {
  resolveEffectiveRules,
  resolveOrchestratorModel,
  resolveRuleSessionModel,
} from "./orchestrator-model.js";
import { vendoredAssetContents } from "../vendored-assets.js";
import type { DispatchResult, Finding } from "./types.js";
import type { ReviewDispatchInput } from "./types.js";
import { validateDispatchContext } from "./dispatch-context.js";
import { planReviewWorkflow } from "./workflow.js";
import { redactSecrets } from "../conversation/redact.js";

/** Creates one rule's review session. Tests inject stubs; the real factory below is the only SDK toucher. */
export type DirectSessionFactory = (
  rule: EffectiveRule,
  cwd: string,
  /** Issue #138: where this rule's submitted findings.json is written. */
  outputDir: string,
  /** Issue #138 phase 2/3: the persona, tool scope, and delegation wiring for this task. */
  scope?: TaskScope,
) => Promise<DispatchSession>;

/**
 * Everything a task's session needs beyond its rule.
 *
 * Passed as ONE object rather than four positional parameters: the factory is
 * a test seam, and every stub in the suite would otherwise have to be updated
 * in lockstep each time nesting gains a field.
 */
/**
 * The `delegate` tool as this module handles it: something to register, not
 * something to call. Opaque on purpose — `createDelegateTool` owns its schema,
 * and naming that schema here would make every stub session factory in the
 * suite import typebox to satisfy a type it never uses.
 */
export type RegisteredDelegateTool = ReturnType<typeof createDelegateTool>;

export interface TaskScope {
  readonly agent?: AgentDefinition;
  /**
   * The `delegate` tool, already gated and budgeted by the caller. Typed
   * loosely on purpose: its parameter schema is an implementation detail of
   * `createDelegateTool`, and naming it here would make every stub session
   * factory in the test suite import typebox.
   */
  readonly delegate?: RegisteredDelegateTool | undefined;
}

/** Creates the (single) advisor session for the --advisor pass. */
export type AdvisorSessionFactory = (cwd: string) => Promise<DispatchSession>;

export interface DirectDispatchDeps {
  createSession?: DirectSessionFactory;
  createAdvisorSession?: AdvisorSessionFactory;
  /** Override for tests. Default RULE_PROMPT_TIMEOUT_MS. */
  ruleTimeoutMs?: number;
  /** Override for tests. Default ADVISOR_PROMPT_TIMEOUT_MS. */
  advisorTimeoutMs?: number;
  /**
   * Issue #138 phase 3: spawns and harvests one delegated child.
   *
   * Absent means no reviewer gets the `delegate` tool, whatever the flag or
   * the definition says — nesting needs a runner to be real, and a tool that
   * accepts calls it cannot service is worse than no tool. `cli.ts` supplies
   * the SDK-backed one; tests supply a stub.
   */
  runDelegation?: DelegationRunner;
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
    cachedReviewerSystemPrompt = matter(vendoredAssetContents("reviewer-agent")).content.trim();
  }
  return cachedReviewerSystemPrompt;
}

async function createRealDirectSession(
  rule: EffectiveRule,
  cwd: string,
  outputDir: string,
  scope: TaskScope = {},
): Promise<DispatchSession> {
  // Credential gate BEFORE any session exists: a rule pinned to a provider
  // this machine can't authenticate must fail with the classified reason,
  // not burn a session-construction round trip to discover it. The error
  // strings deliberately match PROVIDER_AUTH_ERROR_RE's vocabulary so
  // classifyTaskFailure names the cause in the PR comment.
  // Issue #138 phase 2: the agent's pin is the persona's DEFAULT; the rule's
  // own pin still wins, because it names one review rather than a class of
  // them (#112's outward-from-specific order).
  const pin = effectiveModelPin(rule, scope.agent);
  const resolved = await resolveRuleSessionModel(pin.provider ?? rule.provider, pin.model ?? rule.model);
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
    // Issue #138 phase 2: the persona is APPENDED to the vendored reviewer
    // contract, never substituted for it — ADR-003's read-only statement and
    // the finding schema live in that text, and a definition file is
    // user-editable.
    systemPrompt: composeSystemPrompt(reviewerSystemPrompt(), scope.agent),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    cwd,
    // Issue #138 phase 2: narrowed by the agent definition when there is one.
    // `sessionToolsFor` intersects with ADR-003's set rather than trusting the
    // file, so a definition can only ever subtract.
    tools: [
      ...sessionToolsFor(scope.agent),
      ...(scope.delegate ? ["delegate"] : []),
    ],
    customTools: [
      // Issue #138 phase 1: the findings file contract. A single host-mediated
      // tool whose write path is baked into the closure; the model supplies
      // arguments only. Read-only enforcement over the REPOSITORY is intact —
      // the write lands in host-created staging, never in the reviewed tree.
      createSubmitFindingsTool({
        outputDir,
        ruleName: rule.name,
        allowedReferences: referencesDeclaredBy(rule.body),
      }),
      // Issue #138 phase 3. Built by the caller, which owns the gate, the
      // budget, and the harvest array; this factory only registers it.
      ...(scope.delegate ? [scope.delegate as unknown as ToolDefinition] : []),
    ],
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
    const model = await resolveOrchestratorModel({
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
 * The direct counterpart of dispatchRules, selected via `--dispatch direct`
 * (the default). Invalid workflow/context input rejects before any factory runs;
 * provider/session failures remain isolated into a DispatchResult.
 */
export async function dispatchRulesDirect(
  input: ReviewDispatchInput,
  deps: DirectDispatchDeps = {},
): Promise<DispatchResult> {
  const {
    rules,
    diff,
    useAdvisor,
    contextPacks,
    orchestratorModel,
    conversationContext,
    prIntent,
    agentsByRule,
    nestingEnabled,
    changedFiles,
  } = input;
  const createSession = deps.createSession ?? createRealDirectSession;
  const ruleTimeoutMs = deps.ruleTimeoutMs ?? RULE_PROMPT_TIMEOUT_MS;
  const advisorTimeoutMs = deps.advisorTimeoutMs ?? ADVISOR_PROMPT_TIMEOUT_MS;

  // Compile the complete trusted plan and validate the caller-owned context
  // before creating a reviewer/advisor session. Context packs describe the
  // loaded rule set, including a rule whose runtime model may prove
  // unavailable; only effective rules consume their corresponding packs.
  // These validation errors are caller errors and intentionally reject rather
  // than degrading into an all-failed provider result.
  const validatedContext = validateDispatchContext(rules, contextPacks);
  // Plan the complete loaded graph, including rules that could not be given a
  // model. Those rules remain ordered workflow nodes and are reported failed,
  // but they do not suppress dependent rules in later waves.
  const workflow = planReviewWorkflow(rules);

  let cwd: string | undefined;
  let findingsDir: string | undefined;
  try {
    // Model resolution reads ambient registry/settings state and can fail for
    // operational reasons (for example an unreadable agent configuration).
    // Keep it inside the runtime fallback boundary so such failures retain
    // dispatchRulesDirect's never-throws provider/setup contract.
    const { effective, unresolved } = await resolveEffectiveRules(rules, orchestratorModel);
    const effectiveByName = new Map(effective.map((rule) => [rule.name, rule]));

    // An empty temp cwd for every session: nothing project-local to discover,
    // nothing of the target repo reachable by relative path — same isolation
    // stance as the legacy path's createIsolatedSessionCwd, without the agent
    // seeding (direct sessions do no agent discovery at all).
    cwd = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-direct-"));
    // Issue #138 phase 1: per-run staging for submitted findings, OUTSIDE the
    // sessions' cwd so one rule cannot read another rule's submissions.
    findingsDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-findings-"));

    const unresolvedNames = Object.keys(unresolved);
    for (const name of unresolvedNames) {
      console.warn(`dispatchRulesDirect: rule "${name}" not dispatched: ${unresolved[name]}`);
    }

    const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const name of unresolvedNames) ruleFailureReasons[name] = unresolved[name];

    // The diff is embedded once per rule (fresh sessions), so a large diff
    // times many rules is a real cost an operator should see before the
    // provider bills for it. Inherited from the deleted orchestrating engine,
    // which scaled exactly the same way.
    warnIfDiffCostRisk(effective, diff, validatedContext.packsByRule, prIntent);

    // Issue #109: the real per-run prompt cost, reported on the result. The
    // diff is embedded once per rule by design (fresh child sessions), so the
    // honest unit is the sum of the task texts the engine actually built.
    let taskTextChars = 0;

    // Enough to see what the model actually did without dumping a full response.
const UNPARSEABLE_EXCERPT_CHARS = 2_000;

interface RuleOutcome {
      readonly ruleName: string;
      readonly succeeded: boolean;
      readonly findings: readonly Finding[];
      readonly failureReason?: string;
    }

    const runRule = async (rule: EffectiveRule): Promise<RuleOutcome> => {
      let session: DispatchSession | undefined;
      const outputDir = path.join(findingsDir as string, ruleDirName(rule.name));
      const agent = agentsByRule?.get(rule.name);
      // Issue #138 phase 3: child findings land here, placed by the HOST when
      // it harvests a child's file. The parent never touches this array —
      // which is what keeps an LLM off the path between a child and the merge.
      const harvested: Finding[] = [];
      // The DEFAULT runner is built here rather than by the caller, because it
      // needs this function's cwd and session factory — neither of which
      // `cli.ts` has. Injecting one is a test override, not the only way to
      // get one: without this, `--subagent-nesting on` would parse, pass every
      // gate, and then silently do nothing.
      const runDelegation: DelegationRunner | undefined =
        deps.runDelegation ??
        (nestingEnabled === true && agent?.delegate === true
          ? makeDelegationRunner(rule, agent, {
              // The child gets NO delegate tool: depth is fixed at one by
              // construction, and an absent tool cannot be called.
              createChildSession: (childRule, childCwd, childOut, childScope) =>
                createSession(childRule, childCwd, childOut, { agent: childScope.agent }),
              cwd: cwd as string,
              diff,
              timeoutMs: ruleTimeoutMs,
              withTimeout,
            })
          : undefined);
      const delegate =
        nestingEnabled === true && agent?.delegate === true && runDelegation !== undefined
          ? createDelegateTool({
              parentRule: rule.name,
              agent,
              nestingEnabled: true,
              changedFiles: changedFiles ?? [],
              outputDir,
              run: runDelegation,
              harvested,
            })
          : undefined;
      let lastTaskTextChars = 0;
      // Every exit path returns THROUGH here, including the throwing ones:
      // telemetry that only describes tasks that succeeded answers the least
      // interesting half of "what did this run cost" (#109). It also merges
      // the harvested child findings, so a parent that delegated and then
      // failed still contributes what its child established.
      const finish = async (outcome: RuleOutcome): Promise<RuleOutcome> => {
        const merged =
          harvested.length > 0
            ? { ...outcome, findings: [...outcome.findings, ...harvested] }
            : outcome;
        await writeTaskMeta(outputDir, {
          ruleName: rule.name,
          ...(agent === undefined ? {} : { agent: agent.name }),
          provider: rule.provider,
          model: rule.model,
          succeeded: merged.succeeded,
          ...(merged.failureReason === undefined ? {} : { failureReason: merged.failureReason }),
          findingCount: merged.findings.length,
          taskTextChars: lastTaskTextChars,
        });
        return merged;
      };
      try {
        session = await withTimeout(
          createSession(rule, cwd as string, outputDir, { agent, delegate }),
          ruleTimeoutMs,
          `rule "${rule.name}" session creation timed out after ${ruleTimeoutMs}ms`,
        );
        const taskText = buildTaskText(rule, diff, validatedContext.packsByRule?.get(rule.name), conversationContext, prIntent);
        taskTextChars += taskText.length;
        lastTaskTextChars = taskText.length;
        await withTimeout(
          session.prompt(taskText),
          ruleTimeoutMs,
          `rule "${rule.name}" timed out after ${ruleTimeoutMs}ms`,
        );
        // Issue #138 phase 1: the file contract is the PRIMARY channel — the
        // submit_findings tool wrote the validated findings durably. The
        // assistant text remains the fallback for a reviewer that never called
        // the tool; when both exist, the file wins (the text is the same
        // array by contract, relayed by a lossier channel).
        const submitted = await readSubmittedFindings({
          outputDir,
          ruleName: rule.name,
          allowedReferences: referencesDeclaredBy(rule.body),
        });
        if (submitted !== undefined) {
          return await finish({ ruleName: rule.name, succeeded: true, findings: submitted });
        }
        const text = session.getLastAssistantText();
        // extractFindingsArray distinguishes "no parseable findings array"
        // (undefined — the rule FAILED to follow its output contract) from
        // a genuinely empty review ([] — a SUCCESS).
        if (text === undefined || extractFindingsArray(text) === undefined) {
          // Preserve WHAT the reviewer actually said. Discarding it left four
          // rules failing on one run with nothing to diagnose from, since the
          // "see the CI logs" it pointed at did not contain the output either
          // (issue #30). Bounded and redacted: this is model output over an
          // attacker-controlled diff, and it goes to logs.
          const excerpt = text === undefined
            ? "<no assistant message>"
            : `${redactSecrets(text).slice(0, UNPARSEABLE_EXCERPT_CHARS)}${text.length > UNPARSEABLE_EXCERPT_CHARS ? "… (truncated)" : ""}`;
          const failureReason =
            `the reviewer returned no parseable findings array (${text === undefined ? 0 : text.length} chars)`;
          console.warn(
            `dispatchRulesDirect: rule "${rule.name}" produced no parseable findings array; ` +
              `it returned: ${excerpt}`,
          );
          return await finish({ ruleName: rule.name, succeeded: false, findings: [], failureReason });
        }
        return await finish({
          ruleName: rule.name,
          succeeded: true,
          // The rule that ran is known here, so its declared citations can be
          // honoured — unlike the legacy orchestrator's merged output (#49).
          findings: parseFindingsFromFinalOutput(text, rule.name, referencesDeclaredBy(rule.body)),
        });
      } catch (err) {
        const timedOut = err instanceof PromptTimeoutError;
        const message = (err as Error).message;
        if (session?.abort) {
          try {
            await session.abort();
          } catch (abortError) {
            console.warn(
              `dispatchRulesDirect: failed to abort rule "${rule.name}" session ` +
                `(${(abortError as Error).message})`,
            );
          }
        }
        const failureReason = classifyTaskFailure(
          timedOut ? { timedOut: true } : { error: message },
          rule,
        );
        console.warn(
          `dispatchRulesDirect: rule "${rule.name}" (${rule.provider}/${rule.model}) failed: ${message}`,
        );
        return await finish({ ruleName: rule.name, succeeded: false, findings: [], failureReason });
      }
    };

    // Waves are sequential. Promise.all is used only inside one explicit
    // multi-rule wave, and preserves that wave's planned input order.
    const outcomes: RuleOutcome[] = [];
    for (const wave of workflow.waves) {
      const waveRules = wave.ruleNames.flatMap((name) => {
        const rule = effectiveByName.get(name);
        return rule === undefined ? [] : [rule];
      });
      outcomes.push(...(await Promise.all(waveRules.map(runRule))));
    }

    // Issue #138: collected BEFORE the staging directory is removed. Each task
    // wrote its own file; nothing else will ever be able to read them.
    const taskMeta: TaskMeta[] = [];
    for (const outcome of outcomes) {
      const meta = await readTaskMeta(path.join(findingsDir as string, ruleDirName(outcome.ruleName)));
      if (meta !== undefined) taskMeta.push(meta);
    }

    const outcomeByName = new Map(outcomes.map((outcome) => [outcome.ruleName, outcome]));
    const rulesRun: string[] = [];
    const rulesFailed: string[] = [];
    for (const rule of rules) {
      const outcome = outcomeByName.get(rule.name);
      if (outcome?.succeeded) {
        rulesRun.push(rule.name);
      } else {
        rulesFailed.push(rule.name);
        if (outcome?.failureReason !== undefined) {
          ruleFailureReasons[rule.name] = outcome.failureReason;
        }
      }
    }

    // Order-stable merge; every finding is already stamped with its own
    // rule's name by construction.
    let findings = outcomes.flatMap((outcome) => outcome.findings);

    // Advisor pass: filters the COMPLETE merged set (so, unlike the legacy
    // path, advisor-on can never mask a dropped rule). Best-effort by
    // design — any failure keeps every finding and says so.
    //
    // Gated on findings.length > 0 (issue #111): an empty merged set has
    // nothing to filter, so the advisor model call is skipped. The issue's
    // failed-rule edge resolves the same way HERE, deliberately: the direct
    // engine's advisor only FILTERS findings — it cannot review coverage —
    // so with zero findings there is literally nothing for it to act on,
    // however uncertain coverage is. (The legacy engine keeps its advisor on
    // rule failure, because there the orchestrator could still be talked
    // into a bad merge shape.) A failed rule alongside non-empty findings
    // still runs the advisor, since there IS something to filter.
    if (useAdvisor && findings.length > 0) {
      const createAdvisorSession =
        deps.createAdvisorSession ??
        makeRealAdvisorSessionFactory(orchestratorModel, effective);
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

    // The specs the rules actually ran on, so the published signature can name
    // them rather than the reader guessing.
    //
    // Derived from what was DISPATCHED, not from `rulesRun`: a rule whose
    // output failed to parse still reached the model and still consumed it, so
    // filtering on success understated what ran (PR #72 review).
    const modelsUsed = [...new Set(effective.map((rule) => `${rule.provider}/${rule.model}`))];

    return {
      findings,
      rulesRun,
      rulesFailed,
      ruleFailureReasons,
      ...(modelsUsed.length === 0 ? {} : { modelsUsed }),
      // Issue #109: reported even when rules failed or were unresolved — the
      // task texts that WERE built are the cost that was actually paid.
      taskTextChars,
      ...(taskMeta.length === 0 ? {} : { taskMeta }),
      ...(validatedContext.manifestHash === undefined
        ? {}
        : { contextManifestHash: validatedContext.manifestHash }),
    };
  } catch (err) {
    // Runtime setup failure (for example mkdtemp). Provider/session failures
    // are isolated above; invalid workflow/context rejects before this block.
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
      if (findingsDir !== undefined) {
        await rm(findingsDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(cwd, { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(
          `dispatchRulesDirect: failed to remove temp directory ${cwd} (${(err as Error).message})`,
        );
      });
    }
  }
}
