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
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, copyFile, symlink, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { RuleDefinition } from "../rules/types.js";
import { resolvePiSubagentsExtensionPath, resolveRpivAdvisorExtensionPath } from "./extensions.js";
import type { DispatchResult, Finding } from "./types.js";

export type { DispatchResult, Finding } from "./types.js";

// Appended to every rule's task automatically — rule authors never write
// this themselves (TASKS.md Task 5 technical design).
const FINDING_JSON_CONTRACT = `
Respond with ONLY a JSON array matching this shape (no prose, no markdown fences):
[{
  "file": string,
  "line": number | null,
  "endLine": number | null,
  "severity": "blocking" | "warning" | "suggestion",
  "category": string,
  "title": string,
  "message": string,
  "suggestion": string | null
}]

- "title": a SHORT one-line headline for the finding (<= 80 chars, no newlines),
  e.g. "The loop uses <= n, so it sums one element too many." Write it as a
  statement of the problem, not a restatement of the file name.
- "message": the full explanation — why it is wrong and what to do.
- "suggestion": the EXACT replacement text for lines "line".."endLine", or null.
  DO provide one whenever the fix is a concrete, local edit you are confident in
  — an off-by-one, a wrong operator or comparison, a missing nil/error check, a
  swapped argument, a typo'd identifier. These are exactly the cases a one-click
  fix is for, and omitting a suggestion there wastes the reviewer's time.
  Rules:
    * Verbatim code only. NOT a diff, NOT wrapped in markdown fences, no "..."
      or elisions, no commentary.
    * It replaces the WHOLE range "line".."endLine" — include every line of that
      range, with the file's existing indentation.
    * Omit it (null) for anything you cannot express as a literal replacement of
      a contiguous line range (design changes, "add a test elsewhere", etc.).
- "endLine": the last line the suggestion replaces (inclusive). Omit/null when
  the suggestion replaces only "line", or when there is no suggestion.

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

// The session factory takes: `useAdvisor` (whether to also load the
// rpiv-advisor extension alongside pi-subagents), `cwd` (the fresh isolated
// temp dir — see createIsolatedSessionCwd), and `orchestratorModel` (issue #1
// round 2 — which model the ORCHESTRATING session runs on). Stub factories used
// in tests may ignore any of them.
// Files symlinked into the hermetic agent dir (see createIsolatedAgentDir).
const AUTH_FILE = "auth.json";
const MODELS_FILE = "models.json";
const SETTINGS_FILE = "settings.json";
const HERMETIC_AGENT_LINK_FILES = [AUTH_FILE, MODELS_FILE, SETTINGS_FILE];

/**
 * What model the ORCHESTRATING session should use, in priority order.
 *
 * `explicit` distinguishes "the user demanded this exact model via --model"
 * (worth warning loudly when it can't be used) from "we derived candidates from
 * the rules" (routine automatic selection — must stay quiet on the happy path,
 * because a warning that fires on every healthy CI run is a warning nobody
 * reads).
 */
export interface OrchestratorModelRequest {
  /** From `--model`. Highest priority; failures are narrated (the user asked). */
  explicit?: string;
  /** Each rule's own "<provider>/<model>", in rule order. */
  ruleCandidates: string[];
}

export type DispatchSessionFactory = (
  useAdvisor: boolean,
  cwd: string,
  orchestratorModel?: OrchestratorModelRequest,
) => Promise<DispatchSession>;

// Known pi thinking-level suffixes. A rule may legitimately write
// `model: claude-opus-4-5:high` — pi-subagents resolves that fuzzily for the
// rule's OWN subagent (it strips the suffix), but ModelRegistry.find() is an
// EXACT match and would miss it. Strip it here so the two agree; otherwise a
// perfectly good rule model would be silently skipped as an orchestrator
// candidate and we'd fall back to the ambient default — the bug we're fixing.
const THINKING_SUFFIX_RE = /:(?:none|off|minimal|low|medium|high|max)$/i;

function parseModelRef(spec: string): { provider: string; modelId: string } | undefined {
  const trimmed = spec.trim();
  // Split on the FIRST slash only: model ids can contain slashes
  // (e.g. "openrouter/vendor/model-x").
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim().replace(THINKING_SUFFIX_RE, "");
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

// pi's own configured default ("<provider>/<model>" from settings.json), or
// undefined. Read straight off the agent dir — best-effort, never throws: a
// missing or corrupt settings.json just means "no default candidate".
function readSettingsDefaultSpec(agentDir: string): string | undefined {
  try {
    const raw = readFileSync(path.join(agentDir, SETTINGS_FILE), "utf-8");
    const parsed = JSON.parse(raw) as { defaultProvider?: unknown; defaultModel?: unknown };
    const { defaultProvider: p, defaultModel: m } = parsed;
    if (typeof p === "string" && typeof m === "string" && p && m) return `${p}/${m}`;
  } catch {
    // absent / unreadable / malformed — simply no candidate
  }
  return undefined;
}

/**
 * Issue #1 (round 2): resolve an EXPLICIT, CREDENTIALED model for the
 * orchestrating session.
 *
 * Previously `createAgentSession` got no `model`, so pi fell back to "from
 * settings, else first available" — the machine's ambient default. That BOUND
 * the tool to a global it cannot verify: on a cron box whose pi default would
 * not resolve, the whole review died even though every rule declared a good
 * model of its own.
 *
 * Candidates, highest priority first:
 *   1. `--model` (explicit user request)
 *   2. pi's OWN settings default — but only if it actually has credentials.
 *      Keeping this ahead of the rules is deliberate: on every healthy machine
 *      it preserves exactly the model the orchestrator used before this change.
 *      Rule models are chosen for their RULE's job (a cheap model may be pinned
 *      to a narrow style rule); silently demoting the orchestrator onto one
 *      would be an unannounced quality regression. Gating it on credentials is
 *      what stops it from being a hard binding.
 *   3. each rule's own model, in order.
 *   4. nothing usable → return undefined, i.e. let pi apply its own auth-aware
 *      default (`getAvailable()`), exactly the pre-existing behavior.
 *
 * CRITICAL (caught in review): `ModelRegistry.find()` is a pure NAME lookup with
 * NO credential check, and setting `options.model` SHORT-CIRCUITS the SDK's own
 * auth-aware selection (`findInitialModel` gates the settings default on
 * `hasConfiguredAuth` and otherwise falls back to the auth-filtered
 * `getAvailable()`). Handing it an un-credentialed model is therefore strictly
 * WORSE than handing it none: a guaranteed `No API key found` at prompt() →
 * fallbackResult → EVERY rule marked failed. A rule's pinned model proves the
 * rule AUTHOR's box had that key, not that this one does (the shipped CI
 * workflow sets only ANTHROPIC_API_KEY). So every candidate is gated on
 * `hasConfiguredAuth`, which counts env-var keys — keeping env-var-only CI
 * working.
 *
 * Never throws: model selection must not be able to kill a review.
 */
function resolveOrchestratorModel(
  request: OrchestratorModelRequest | undefined,
): CreateAgentSessionOptions["model"] | undefined {
  if (!request) return undefined;

  // Read the registry through the SAME agent dir the session will use: by now
  // PI_CODING_AGENT_DIR already points at the hermetic dir (see dispatchRules),
  // whose auth.json/models.json/settings.json are symlinks to the real ones — so
  // this credential view matches the session's exactly.
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(path.join(agentDir, AUTH_FILE));
  const registry = ModelRegistry.create(authStorage, path.join(agentDir, MODELS_FILE));

  const settingsDefault = readSettingsDefaultSpec(agentDir);
  // Deduped, order-preserving: the same spec can legitimately appear more than
  // once (e.g. --model happens to equal the settings default, or two rules share
  // a model). Without this we'd re-query the registry for it and — since
  // `narrate` matches by value — warn about the same rejected model twice.
  const candidates = [
    ...(request.explicit ? [request.explicit] : []),
    ...(settingsDefault ? [settingsDefault] : []),
    ...request.ruleCandidates,
  ].filter((spec, i, all) => all.indexOf(spec) === i);
  if (candidates.length === 0) return undefined;

  for (const spec of candidates) {
    // Only an EXPLICIT --model narrates its rejection: the user asked for that
    // model by name and deserves to know it wasn't used. Skipping a settings or
    // rule candidate is routine automatic selection (e.g. a rule pinned to a
    // provider this box has no key for), and warning about it would fire on
    // every healthy CI run — a warning nobody reads.
    const narrate = spec === request.explicit;
    const explain = (why: string): void => {
      if (narrate) console.warn(`dispatchRules: --model "${spec}" ${why}; trying the next candidate`);
    };

    const ref = parseModelRef(spec);
    if (!ref) {
      explain('is malformed — expected "<provider>/<model>"');
      continue;
    }
    const model = registry.find(ref.provider, ref.modelId);
    if (!model) {
      explain(`is not in the pi model registry (agent dir: ${agentDir})`);
      continue;
    }
    // THE gate. Without it we hand the session a credential-less model and
    // guarantee a total review wipeout.
    if (!registry.hasConfiguredAuth(model)) {
      explain("has no configured credentials on this machine");
      continue;
    }
    return model as CreateAgentSessionOptions["model"];
  }

  // Nothing usable anywhere. Fall back to pi's own auth-aware default rather
  // than failing — never hard-fail on model selection.
  console.warn(
    `dispatchRules: no orchestrator model with configured credentials among ` +
      `[${candidates.join(", ")}]; falling back to pi's default model`,
  );
  return undefined;
}

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
  // resolve (from auth.json or from env vars, as the shipped CI workflow does),
  // no fallback message is produced and this stays quiet. That matters — a
  // warning that fires on every healthy run is a warning everyone learns to
  // ignore.
  if (modelFallbackMessage) {
    console.warn(`dispatchRules: pi could not resolve a model — ${modelFallbackMessage}`);
  }

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
const SUBAGENT_CONFIG_INTERCOM_OFF = JSON.stringify({ intercomBridge: { mode: "off" } });

// Issue #1: the pi SDK's auth failures ("No API key found for <provider>",
// "Authentication failed for ...", "No model selected") are thrown from deep
// inside session.prompt() and name neither auth.json nor the agent dir. When
// the hermetic agent dir was built WITHOUT credentials, that produced the
// utterly opaque `No API key found for undefined` — the registry had no
// providers at all, so the resolved model carried no provider name. These are
// the error shapes worth annotating with the auth context below.
//
// Deliberately NOT including "No models available": that string is only ever
// produced as createAgentSession's non-throwing `modelFallbackMessage` (see
// createRealDispatchSession), never thrown from prompt(), so matching it here
// would be dead code.
const PI_AUTH_ERROR_RE = /No API key found|Authentication failed|No model selected/i;

// Why auth.json is (or isn't) present in the hermetic agent dir. The two
// failure causes are kept DISTINCT on purpose: telling someone "no auth.json
// found — check PI_CODING_AGENT_DIR" when the file is right there but couldn't
// be symlinked sends them to verify a path that will check out fine, while the
// real cause (a filesystem that can't symlink) goes unmentioned.
export type AuthLinkStatus = "linked" | "absent" | "link-failed";

interface IsolatedAgentDir {
  dir: string;
  /**
   * Anything other than "linked" means the hermetic dir has NO credentials
   * file, so provider auth must come from environment variables. That is NOT
   * an error on its own — the shipped GitHub Actions workflow authenticates
   * purely via env vars (ANTHROPIC_API_KEY etc.) with no auth.json anywhere,
   * and that must keep working silently. It IS the most useful fact to attach
   * to a downstream auth failure — see describeAuthContext.
   */
  authStatus: AuthLinkStatus;
}

// Single source of the auth explanation, so the wording can't drift between
// the places that surface it. Returns undefined when auth.json linked fine
// (nothing to explain).
export function describeAuthContext(
  authStatus: AuthLinkStatus,
  realAgentDir: string,
): string | undefined {
  if (authStatus === "linked") return undefined;
  if (authStatus === "absent") {
    return (
      `no ${AUTH_FILE} was found in the pi agent dir (${realAgentDir}), so provider ` +
      `credentials had to come from environment variables (e.g. ANTHROPIC_API_KEY) — ` +
      `if none were set, that is this error. If you expected file-based auth (e.g. OAuth ` +
      `set up via pi's /login), then PI_CODING_AGENT_DIR is likely not pointing where you think`
    );
  }
  return (
    `${AUTH_FILE} EXISTS in the pi agent dir (${realAgentDir}) but could not be linked into ` +
    `the isolated agent dir (see the symlink warning above), so provider credentials fell back ` +
    `to environment variables`
  );
}

async function createIsolatedAgentDir(realAgentDir: string): Promise<IsolatedAgentDir> {
  const tempAgentDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-agentdir-"));

  // Symlink credential/model/settings files from the real agent dir so the
  // orchestrating session and dispatched subagents still resolve API keys and
  // custom-provider config. Only link files that actually exist (a fresh CI
  // env may have none — that's fine, the review just runs with whatever
  // provider auth is present via env vars, same as before).
  let authStatus: AuthLinkStatus = "absent";

  await Promise.all(
    HERMETIC_AGENT_LINK_FILES.map(async (name) => {
      const source = path.join(realAgentDir, name);
      try {
        await access(source);
      } catch {
        return; // source absent — nothing to link
      }
      try {
        await symlink(source, path.join(tempAgentDir, name));
        if (name === AUTH_FILE) authStatus = "linked";
      } catch (err) {
        // A failed symlink (e.g. sandbox without symlink support) shouldn't
        // abort the review — warn and continue; worst case is that provider
        // auth resolves from env vars instead of auth.json.
        if (name === AUTH_FILE) authStatus = "link-failed";
        console.warn(
          `dispatchRules: could not symlink ${name} into the isolated agent dir (${(err as Error).message})`,
        );
      }
    }),
  );

  const subagentConfigDir = path.join(tempAgentDir, "extensions", "subagent");
  await mkdir(subagentConfigDir, { recursive: true });
  await writeFile(path.join(subagentConfigDir, "config.json"), SUBAGENT_CONFIG_INTERCOM_OFF, "utf-8");

  return { dir: tempAgentDir, authStatus };
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
    `{ "findings": [{ "file": string, "line": number | null, "endLine": number | null, "severity": "blocking" | "warning" | "suggestion", "category": string, "title": string, "message": string, "suggestion": string | null, "ruleName": string }], "rulesRun": string[], "rulesFailed": string[] }`,
    // ADR-007/ADR-008: the orchestrator MERGES the subagents' findings and re-emits
    // them, so every field it is not told to keep is silently dropped at this last
    // hop. That is exactly what happened on the first live run: the reviewers were
    // authoring `title` and `suggestion`, and the orchestrator threw both away —
    // the comment fell back to a derived headline and never showed a Commit button.
    // Copy them through VERBATIM; never rewrite a suggestion (it is literal code
    // destined for the file, and a paraphrase would commit something the reviewer
    // never proposed).
    `Copy each finding's "title", "message", "suggestion" and "endLine" through EXACTLY as the task emitted them — verbatim, character for character. Do NOT rewrite, summarize, reformat, re-indent, or "improve" a "suggestion": it is literal replacement code that a human can commit with one click, so any edit you make would be committed as if the reviewer had proposed it. If a task omitted a field, use null.`,
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
// The optional ADR-007/ADR-008 fields. Kept LENIENT on purpose: a rule that emits
// a malformed `title`/`suggestion`/`endLine` should lose that ENRICHMENT, not have
// its whole finding (or its rule's whole run) thrown away — the finding's core
// (file/line/severity/message) is still worth posting. So these are validated
// where they are USED, and simply dropped when wrong, rather than failing the
// finding here.

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
  // NOTE: title/suggestion/endLine are deliberately NOT validated here. They are
  // OPTIONAL ENRICHMENT, and rejecting a finding over one would be catastrophic:
  // isValidFinding feeds looksLikeDispatchResult, which is all-or-nothing — a
  // single bad field on a single finding would discard the ENTIRE orchestrator
  // result, and (with the advisor on, the default) recovery is disabled, so the
  // comment would announce "✅ No actionable comments" on a review that found
  // blocking issues. `"endLine": "12"` — a number emitted as a string — is a
  // routine LLM slip, and these are three brand-new model-authored fields. They
  // are stripped in normalizeFinding() instead. Found in review; the first draft
  // shipped exactly this kill switch.
  return true;
}

/**
 * Drops any optional enrichment that is the wrong type, keeping the finding.
 * The core (file/line/severity/category/message/ruleName) is already validated;
 * a malformed title/suggestion/endLine costs only itself.
 */
function normalizeFinding(finding: Finding): Finding {
  const raw = finding as unknown as Record<string, unknown>;
  return {
    ...finding,
    title: typeof raw.title === "string" ? raw.title : undefined,
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion : undefined,
    endLine: Number.isInteger(raw.endLine) ? (raw.endLine as number) : undefined,
  };
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

function fallbackResult(
  rules: RuleDefinition[],
  reason = "the review orchestrator did not complete — see the CI logs for the cause",
): DispatchResult {
  // Review finding: without a reason here, every ORCHESTRATOR-level failure
  // (prompt() threw, malformed final JSON, setup failed, unreconcilable results)
  // still rendered the bare "- rule-name" list this change exists to kill. Stamp
  // a generic-but-honest reason so the whole class is covered, not just the
  // per-task branch the smoke test happened to hit.
  const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const rule of rules) ruleFailureReasons[rule.name] = reason;
  return { findings: [], rulesRun: [], rulesFailed: rules.map((rule) => rule.name), ruleFailureReasons };
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

  return { ...parsed, findings: parsed.findings.map(normalizeFinding) };
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
  // Same rule as isValidFinding: optional enrichment must never invalidate a
  // finding. extractFindingsArray uses `p.every(isValidRawFinding)`, so a bad
  // `title` here would lose ALL of that rule's recovered findings.
  return true;
}

// Extracts a findings JSON array from a task's finalOutput, tolerating a model
// that wraps the array in preamble/trailing prose despite the STRICT contract
// (e.g. "Here is my review:\n[ ... ]"). Tries, in order: (1) strict parse of
// the fence-stripped text; (2) parse of the first `[` … last `]` slice. Returns
// undefined if neither yields a valid findings array. The reviewer's own system
// prompt is the primary defense (it's instructed to emit ONLY the array); this
// leniency is a safety net so a stray preamble doesn't silently lose findings.
function extractFindingsArray(text: string): unknown[] | undefined {
  const stripped = stripCodeFences(text);
  const tryParse = (s: string): unknown[] | undefined => {
    try {
      const p = JSON.parse(s);
      return Array.isArray(p) && p.every(isValidRawFinding) ? p : undefined;
    } catch {
      return undefined;
    }
  };
  const strict = tryParse(stripped);
  if (strict) return strict;
  const first = stripped.indexOf("[");
  const last = stripped.lastIndexOf("]");
  if (first >= 0 && last > first) return tryParse(stripped.slice(first, last + 1));
  return undefined;
}

// Parses one task's raw finalOutput into Finding[] stamped with ruleName.
// Best-effort — returns [] on any parse/shape problem, never throws.
function parseFindingsFromFinalOutput(text: string, ruleName: string): Finding[] {
  const parsed = extractFindingsArray(text);
  if (!parsed) return [];
  return parsed.map((f) => {
    const c = f as Record<string, unknown>;
    return {
      file: c.file as string,
      // The contract allows `number | null`; Finding.line is `number?`, so a
      // null (or absent) line becomes undefined rather than being kept as null.
      line: typeof c.line === "number" ? c.line : undefined,
      severity: c.severity as Finding["severity"],
      category: c.category as string,
      message: c.message as string,
      ruleName,
      // ADR-007/008 enrichment. Carried through the RECOVERY path too — a rule
      // whose findings had to be recovered from its raw output must not silently
      // lose its titles and suggestions.
      title: typeof c.title === "string" ? c.title : undefined,
      suggestion: typeof c.suggestion === "string" ? c.suggestion : undefined,
      endLine: typeof c.endLine === "number" ? c.endLine : undefined,
    };
  });
}

/**
 * ADR-007 PROVENANCE. A committable suggestion must be traceable to a suggestion a
 * dispatched reviewer ACTUALLY emitted for that exact (file, line).
 *
 * Why this is a control and not a nicety: the ORCHESTRATOR is an LLM that has also
 * read the attacker-controlled diff, and it re-emits every finding as its own JSON.
 * Telling it "copy the suggestion verbatim, never rewrite" is a prompt — a hope. It
 * could invent a suggestion for any (file, line) in the diff, or mutate an honest
 * one, and the reviewer's real finding would serve as cover for it. Since the
 * subagents' raw outputs are already captured (details.results[i].finalOutput), we
 * can turn that hope into an INVARIANT by byte-matching.
 *
 * Unverifiable => dropped. If the captured results can't be mapped (so we cannot
 * know what any subagent actually proposed), no suggestion is committable. The
 * finding itself is always kept — losing a one-click fix is a fair price.
 */
function suggestionProvenanceKeys(
  captured: CapturedTaskResult[],
  rules: RuleDefinition[],
): Set<string> {
  const keys = new Set<string>();
  captured.forEach((c, i) => {
    const rule = rules[i];
    if (!rule || !c.finalOutput) return;
    for (const finding of parseFindingsFromFinalOutput(c.finalOutput, rule.name)) {
      if (typeof finding.suggestion === "string") {
        keys.add(provenanceKey(finding.file, finding.line, finding.suggestion));
      }
    }
  });
  return keys;
}

function provenanceKey(file: string, line: number | undefined, suggestion: string): string {
  return JSON.stringify([file, line ?? null, suggestion]);
}

/** Strips any suggestion the orchestrator cannot prove a subagent actually made. */
function enforceSuggestionProvenance(result: DispatchResult, allowed: Set<string>): DispatchResult {
  let dropped = 0;
  const findings = result.findings.map((f) => {
    if (typeof f.suggestion !== "string") return f;
    if (allowed.has(provenanceKey(f.file, f.line, f.suggestion))) return f;
    dropped += 1;
    return { ...f, suggestion: undefined, endLine: undefined };
  });
  if (dropped > 0) {
    console.warn(
      `dispatchRules: dropped ${dropped} committable suggestion(s) that no dispatched reviewer ` +
        `actually produced for that file/line (orchestrator provenance check)`,
    );
  }
  return { ...result, findings };
}

// A task ran successfully iff it exited 0 with no error/timeout/detach.
function taskSucceeded(c: CapturedTaskResult): boolean {
  return c.exitCode === 0 && !c.error && !c.timedOut && !c.detached;
}

// Errors that mean "this rule's provider isn't usable on this machine" — by far
// the most common real cause (the zero-config smoke test hit exactly this: the
// builtin rule is pinned to anthropic and the box had no ANTHROPIC_API_KEY).
//
// The numeric status codes are DELIBERATELY anchored. A bare /401|403/ matches
// those digits anywhere — "retry after 4030ms", "40312 tokens exceeds limit",
// "req_011CS401xyz" — and this string is published in the PR comment. Telling a
// maintainer "no working credentials" when the real cause was a rate limit sends
// them to rotate a healthy key while the truth hides in the logs: confidently
// wrong, which is worse than the silence this whole change exists to fix.
//
// Distinct from PI_AUTH_ERROR_RE above, which annotates the ORCHESTRATOR's own
// prompt() throw. This one classifies a dispatched RULE's task error. They
// overlap but are not interchangeable — update both if auth detection changes.
const PROVIDER_AUTH_ERROR_RE =
  /No API key found|Authentication failed|no configured credentials|unauthoriz|forbidden|invalid api key|\b(?:status|code|http)\W{0,4}(?:401|403)\b/i;

// rule.provider is rule-file-sourced and gets interpolated into a world-readable
// PR comment inside a code span. Strip what could break out of it (backticks,
// newlines, table pipes) and cap the length, so a crafted value can't inject
// markdown into the bot's own comment.
function sanitizeForComment(value: string): string {
  return value.replace(/[`\r\n|]/g, "").trim().slice(0, 60);
}

/**
 * WHY a rule's task failed, as a short phrase SAFE TO PUBLISH.
 *
 * This is rendered into a PR comment, which is world-readable on a public repo.
 * Raw provider errors can echo request/response details, so they are deliberately
 * NOT included here — they go to stderr (private CI logs) instead. What a
 * maintainer needs from the comment is the actionable class of failure plus which
 * provider it was, and that is exactly what this returns.
 */
function classifyTaskFailure(c: CapturedTaskResult, rule: RuleDefinition): string {
  if (c.timedOut) return "timed out";
  if (c.detached) return "detached before finishing";
  const error = c.error ?? "";
  if (PROVIDER_AUTH_ERROR_RE.test(error)) {
    return `no working credentials for provider \`${sanitizeForComment(rule.provider)}\` on the machine running the review`;
  }
  if (error) return `errored (see the CI logs for the full message)`;
  if (typeof c.exitCode === "number" && c.exitCode !== 0) return `exited with code ${c.exitCode}`;
  return "failed to run";
}

// Deterministic reconciliation of the orchestrating LLM's self-reported
// DispatchResult against the structured per-task results captured from the
// subagent tool (details.results). See DispatchSession.subscribe's doc comment
// for why: the LLM was observed to occasionally mark a task that RAN (exit 0)
// as "failed" and drop its whole findings set.
//
// - rulesRun/rulesFailed come purely from each task's exitCode (order-mapped to
//   rules), so a task that ran can never be mis-reported as failed.
// - Findings are always kept from the orchestrator for rules that ran (and
//   dropped for rules that did NOT run — a failed task's output isn't
//   trustworthy; this also drops hallucinated rule names).
// - When `recoverFindings` is true, a rule that ran but has ZERO orchestrator
//   findings ALSO has its findings recovered from its raw finalOutput (the
//   orchestrator dropped the whole rule). `recoverFindings` is `!useAdvisor`:
//   with the advisor pass OFF, "zero findings for a rule that ran" can only
//   mean a buggy drop, so recovery is safe. With the advisor ON, zero findings
//   is AMBIGUOUS — it could be a buggy drop OR the advisor legitimately
//   removing all of that rule's findings as false positives — and recovering
//   from raw finalOutput would UNDO the advisor and reintroduce false
//   positives. So with advisor on we do NOT recover: accounting is still fixed
//   deterministically (the rule correctly shows as run), but its findings are
//   left as the advisor-filtered orchestrator produced them.
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
// orchestrator tagged one rule's findings with another rule's name. And with
// advisor on, a genuine whole-rule drop leaves that rule's findings lost (only
// its accounting is corrected) — accepted to never undo advisor filtering.
function reconcileWithCapturedResults(
  orchestrator: DispatchResult,
  captured: CapturedTaskResult[],
  rules: RuleDefinition[],
  recoverFindings: boolean,
): DispatchResult {
  if (captured.length !== rules.length) return orchestrator;
  const orderTrustworthy = captured.every((c, i) => {
    if (!c.model) return true; // nothing to cross-check — rely on dispatch order
    return c.model.startsWith(`${rules[i].provider}/${rules[i].model}`);
  });
  if (!orderTrustworthy) return orchestrator;

  const rulesRun: string[] = [];
  const rulesFailed: string[] = [];
  // Null-prototype: a rule literally named "__proto__" would otherwise not set an
  // own property, and the later lookup would return Object.prototype (truthy) and
  // render "[object Object]" as the reason.
  const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<string, string>;
  const recovered: Finding[] = [];
  captured.forEach((c, i) => {
    const rule = rules[i];
    if (!taskSucceeded(c)) {
      rulesFailed.push(rule.name);
      ruleFailureReasons[rule.name] = classifyTaskFailure(c, rule);
      // Smoke-test finding: this was previously silent — a rule failed and NOTHING,
      // not even stderr, said why. The RAW error goes to the CI logs; only the
      // classified reason above reaches the PR comment. (On a public repo the logs
      // are readable too — but GitHub masks registered secrets there, and a comment
      // is pushed into every reviewer's face while a log line is not.)
      const raw = c.error ?? classifyTaskFailure(c, rule);
      console.warn(
        `dispatchRules: rule "${rule.name}" (${rule.provider}/${rule.model}) failed: ${raw}`,
      );
      return;
    }
    rulesRun.push(rule.name);
    if (!recoverFindings) return;
    const orchestratorHasFindings = orchestrator.findings.some((f) => f.ruleName === rule.name);
    if (!orchestratorHasFindings && c.finalOutput) {
      recovered.push(...parseFindingsFromFinalOutput(c.finalOutput, rule.name));
    }
  });

  const runSet = new Set(rulesRun);
  const kept = orchestrator.findings.filter((f) => runSet.has(f.ruleName));
  return { findings: [...kept, ...recovered], rulesRun, rulesFailed, ruleFailureReasons };
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

    // Candidates for the orchestrating session's model, highest priority first.
    // An explicit --model is a single, user-demanded candidate (failures are
    // narrated). Otherwise every rule's own pinned model is a candidate, tried
    // in order — the first one with working credentials on THIS box wins, so a
    // rule pinned to a provider this box isn't authenticated for (e.g. the CI
    // workflow only sets ANTHROPIC_API_KEY) is skipped rather than fatal.
    // resolveOrchestratorModel returns undefined if none are usable, which lets
    // pi apply its own auth-aware default — the pre-existing behavior.
    const modelRequest: OrchestratorModelRequest = {
      explicit: orchestratorModel,
      ruleCandidates: rules.map((r) => `${r.provider}/${r.model}`),
    };

    const session = await createSession(useAdvisor, sessionCwd, modelRequest);
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
      return fallbackResult(rules);
    } finally {
      unsubscribe?.();
    }

    const orchestratorResult = parseDispatchResult(finalText, rules);
    // Recover dropped findings only when advisor is OFF — see
    // reconcileWithCapturedResults' doc comment for why recovering while the
    // advisor pass is active would undo its false-positive filtering.
    const reconciled = reconcileWithCapturedResults(
      orchestratorResult,
      capturedTaskResults,
      rules,
      !useAdvisor,
    );

    // ADR-007: a suggestion is committable code. It may only survive if a dispatched
    // reviewer actually proposed it for that exact file/line — never because the
    // orchestrator said so. Unverifiable => stripped.
    return enforceSuggestionProvenance(
      reconciled,
      suggestionProvenanceKeys(capturedTaskResults, rules),
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
