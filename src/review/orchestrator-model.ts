// Explicit, credential-gated resolution of the ORCHESTRATING session's model
// (issue #1 round 2). Split out of dispatch.ts (design-review #8) — reads the
// registry through the SAME agent dir the session will use (by the time this
// runs, PI_CODING_AGENT_DIR already points at the hermetic dir).
import { readFileSync } from "node:fs";
import path from "node:path";
import { AuthStorage, ModelRegistry, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { AUTH_FILE, MODELS_FILE, SETTINGS_FILE } from "./session-hermetics.js";

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
export function resolveOrchestratorModel(
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
