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
//
// Design-review #8: this module now holds only the SESSION lifecycle — the
// factory, the single-flight dispatch entry point, and the hermetic-run
// choreography. Its collaborators each own one concern and are re-exported
// here so the public import surface is unchanged:
//   dispatch-prompt.ts     — task text + orchestration prompt construction
//   orchestrator-model.ts  — credential-gated orchestrator model resolution
//   session-hermetics.ts   — isolated session cwd + throwaway agent dir
//   dispatch-results.ts    — final-JSON parsing, reconciliation, provenance
import { rm } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuleDefinition } from "../rules/types.js";
import { buildDispatchPrompt } from "./dispatch-prompt.js";
import {
  enforceSuggestionProvenance,
  fallbackResult,
  parseDispatchResult,
  reconcileWithCapturedResults,
  suggestionProvenanceKeys,
} from "./dispatch-results.js";
import type { CapturedTaskResult } from "./dispatch-results.js";
import { resolvePiSubagentsExtensionPath, resolveRpivAdvisorExtensionPath } from "./extensions.js";
import { resolveEffectiveRules, resolveOrchestratorModel } from "./orchestrator-model.js";
import type { OrchestratorModelRequest } from "./orchestrator-model.js";
import {
  createIsolatedAgentDir,
  createIsolatedSessionCwd,
  describeAuthContext,
  PI_AUTH_ERROR_RE,
} from "./session-hermetics.js";
import type { DispatchResult } from "./types.js";

// Re-exported public surface (unchanged by the design-review #8 split).
export type { DispatchResult, Finding } from "./types.js";
export type { CapturedTaskResult } from "./dispatch-results.js";
export type { OrchestratorModelRequest } from "./orchestrator-model.js";
export type { AuthLinkStatus } from "./session-hermetics.js";
export { describeAuthContext } from "./session-hermetics.js";
export { buildDispatchPrompt } from "./dispatch-prompt.js";

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

// The session factory takes: `useAdvisor` (whether to also load the
// rpiv-advisor extension alongside pi-subagents), `cwd` (the fresh isolated
// temp dir — see createIsolatedSessionCwd), and `orchestratorModel` (issue #1
// round 2 — which model the ORCHESTRATING session runs on). Stub factories used
// in tests may ignore any of them.
export type DispatchSessionFactory = (
  useAdvisor: boolean,
  cwd: string,
  orchestratorModel?: OrchestratorModelRequest,
) => Promise<DispatchSession>;

async function createRealDispatchSession(
  useAdvisor: boolean,
  cwd: string,
  orchestratorModel?: OrchestratorModelRequest,
): Promise<DispatchSession> {
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

  // Explicit model — NOT pi's ambient default. See resolveOrchestratorModel.
  // When it resolves to undefined (absent/malformed/unknown spec), omitting the
  // key leaves pi to pick its own default, i.e. the previous behavior.
  const model = resolveOrchestratorModel(orchestratorModel);

  const { session, modelFallbackMessage } = await createAgentSession({
    resourceLoader: loader,
    cwd,
    tools: ["read", "subagent"],
    ...(model ? { model } : {}),
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

  // Issue #1: createAgentSession does NOT throw when it can't resolve any
  // model — it hands the caller `modelFallbackMessage` and carries on, and we
  // used to destructure only `session` and drop it on the floor. That message
  // ("No models available. Use /login to ...") is set precisely when the model
  // registry came up with zero providers — the exact credential-free state
  // that later detonates inside prompt() as the opaque `No API key found for
  // undefined`. Surfacing it here moves the diagnosis ~30 seconds earlier, to
  // the moment the problem actually exists.
  //
  // It is also self-silencing on the happy path: when provider credentials DO
  // resolve (from auth.json, or from env vars such as ANTHROPIC_API_KEY),
  // no fallback message is produced and this stays quiet. That matters — a
  // warning that fires on every healthy run is a warning everyone learns to
  // ignore.
  if (modelFallbackMessage) {
    console.warn(`dispatchRules: pi could not resolve a model — ${modelFallbackMessage}`);
  }

  return session;
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
  /**
   * Issue #1 (round 2): "<provider>/<model>" for the ORCHESTRATING session
   * (the `--model` flag). Highest-priority candidate; see
   * resolveOrchestratorModel for the full order (--model -> pi's settings
   * default -> each rule's own model -> pi's auth-aware default) and for why
   * EVERY candidate must have configured credentials on this machine.
   */
  orchestratorModel?: string,
): Promise<DispatchResult> {
  // SINGLE-FLIGHT GUARD (design-review item #5). runDispatch mutates a
  // process-global — process.env.PI_CODING_AGENT_DIR — for the duration of a
  // real-factory run and restores it in its finally block. That is safe for the
  // CLI (one review per process), but this module is exported and importable:
  // an embedder running two reviews concurrently in one process would have the
  // second run capture the FIRST run's temp agent dir as "previous value" and
  // restore it after that dir was deleted — silent cross-contamination. Rather
  // than document the landmine, serialize: each call waits for the previous one
  // to fully settle (including env restoration) before starting. The chain
  // never rejects (runDispatch is itself a never-throws boundary, and the
  // defensive catch below keeps one hypothetical rejection from wedging every
  // later call), so this cannot deadlock or leak an error across calls.
  const run = dispatchChain.then(() =>
    runDispatch(rules, diff, useAdvisor, createSession, orchestratorModel),
  );
  dispatchChain = run.catch(() => undefined);
  return run;
}

// The serialization chain for dispatchRules' single-flight guard above.
let dispatchChain: Promise<unknown> = Promise.resolve();

async function runDispatch(
  rules: RuleDefinition[],
  diff: string,
  useAdvisor: boolean,
  createSession: DispatchSessionFactory,
  orchestratorModel?: string,
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
  // Issue #1: set only when the hermetic agent dir ended up WITHOUT auth.json.
  // Appended to a downstream pi auth error so the failure names its own cause.
  let missingAuthDiagnostic: string | undefined;

  try {
    sessionCwd = await createIsolatedSessionCwd();

    if (usingRealFactory) {
      const realAgentDir = getAgentDir();
      const isolated = await createIsolatedAgentDir(realAgentDir);
      tempAgentDir = isolated.dir;
      // Issue #1: remember WHY a later auth failure might be happening, so the
      // cryptic pi-SDK message can be annotated with the actionable context.
      // Nothing is printed here — a missing auth.json is normal (env-var auth)
      // and warning about it unconditionally would fire on every healthy CI run.
      missingAuthDiagnostic = describeAuthContext(isolated.authStatus, realAgentDir);
      agentDirEnvWasSet = "PI_CODING_AGENT_DIR" in process.env;
      prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = tempAgentDir;
      agentDirEnvOverridden = true;
    }

    // Design-review #6 (model decoupling): rules may be UNPINNED. Fill each
    // unpinned rule with the deployment default (--model → settings default →
    // first credentialed provider) — resolved here, after the agent-dir env is
    // in place, so the registry sees the same credentials the sessions will.
    // A rule that cannot be given ANY model is reported failed with its
    // reason; it is never silently dropped and never burns a model call.
    const { effective, unresolved } = resolveEffectiveRules(rules, orchestratorModel);
    const unresolvedNames = Object.keys(unresolved);
    if (effective.length === 0) {
      for (const name of unresolvedNames) {
        console.warn(`dispatchRules: rule "${name}" not dispatched: ${unresolved[name]}`);
      }
      return { findings: [], rulesRun: [], rulesFailed: unresolvedNames, ruleFailureReasons: unresolved };
    }
    // Appends the never-dispatched rules' failures to whatever the dispatch
    // produced, so the summary names every rule exactly once.
    const withUnresolved = (result: DispatchResult): DispatchResult =>
      unresolvedNames.length === 0
        ? result
        : {
            ...result,
            rulesFailed: [...result.rulesFailed, ...unresolvedNames],
            ruleFailureReasons: { ...(result.ruleFailureReasons ?? {}), ...unresolved },
          };

    // Candidates for the orchestrating session's model, highest priority first.
    // An explicit --model is a single, user-demanded candidate (failures are
    // narrated). Otherwise every rule's own pinned model is a candidate, tried
    // in order — the first one with working credentials on THIS box wins, so a
    // rule pinned to a provider this box isn't authenticated for (e.g. a CI
    // environment that only sets ANTHROPIC_API_KEY) is skipped rather than
    // fatal. resolveOrchestratorModel returns undefined if none are usable,
    // which lets pi apply its own auth-aware default — the pre-existing
    // behavior.
    const modelRequest: OrchestratorModelRequest = {
      explicit: orchestratorModel,
      ruleCandidates: effective.map((r) => `${r.provider}/${r.model}`),
    };

    const session = await createSession(useAdvisor, sessionCwd, modelRequest);
    const prompt = buildDispatchPrompt(effective, diff, useAdvisor);

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
      const message = (err as Error).message;
      // Issue #1: the pi SDK's auth errors name neither auth.json nor the agent
      // dir (worst case: "No API key found for undefined", when the registry
      // had no providers at all). If we already know the hermetic agent dir was
      // built without credentials, attach that — it turns a dead-end error into
      // an actionable one. Only for auth-shaped errors: appending it to, say, a
      // network timeout would just misdirect.
      const authHint =
        missingAuthDiagnostic && PI_AUTH_ERROR_RE.test(message)
          ? ` — ${missingAuthDiagnostic}`
          : "";
      console.warn(`dispatchRules: session.prompt() threw (${message})${authHint}`);
      return withUnresolved(fallbackResult(effective));
    } finally {
      unsubscribe?.();
    }

    // The subagent tool's structured per-task results (details.results) are the
    // deterministic source of truth this module leans on TWICE below: to
    // reconcile the orchestrator's self-reported accounting (so a task that ran
    // can't be mis-reported as failed) and to enforce suggestion provenance (a
    // committable suggestion must byte-match one a reviewer actually emitted). A
    // real pi AgentSession exposes subscribe(), so `subscribe` being a function
    // means we EXPECTED to capture those results. Capturing NONE despite that is
    // a silent double-degradation: reconciliation falls back to trusting the
    // LLM's word, and — because the provenance allow-set is then empty — EVERY
    // committable suggestion is stripped. The most likely cause is the pi SDK's
    // tool_execution_end event shape drifting from DispatchSessionEvent (which is
    // typed loosely, `any`, precisely because it mirrors an SDK-internal union).
    // Warn loudly so an SDK upgrade that breaks capture surfaces here instead of
    // quietly halving the review's guarantees. (Test stubs without subscribe are
    // unaffected — they never expected capture.)
    if (
      effective.length > 0 &&
      typeof session.subscribe === "function" &&
      capturedTaskResults.length === 0
    ) {
      console.warn(
        "dispatchRules: session exposes subscribe() but captured ZERO subagent task results — " +
          "deterministic reconciliation is disabled and every committable suggestion will be " +
          "stripped for this run. The orchestrator may not have called the subagent tool, or the " +
          "pi SDK's tool_execution_end event shape may have changed (see DispatchSessionEvent).",
      );
    }

    const orchestratorResult = parseDispatchResult(finalText, effective);
    // Recover dropped findings only when advisor is OFF — see
    // reconcileWithCapturedResults' doc comment for why recovering while the
    // advisor pass is active would undo its false-positive filtering.
    const reconciled = reconcileWithCapturedResults(
      orchestratorResult,
      capturedTaskResults,
      effective,
      !useAdvisor,
    );

    // ADR-007: a suggestion is committable code. It may only survive if a dispatched
    // reviewer actually proposed it for that exact file/line — never because the
    // orchestrator said so. Unverifiable => stripped.
    return withUnresolved(
      enforceSuggestionProvenance(
        reconciled,
        suggestionProvenanceKeys(capturedTaskResults, effective),
      ),
    );
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
