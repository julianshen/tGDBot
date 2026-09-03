// Explicit, credential-gated resolution of the ORCHESTRATING session's model
// (issue #1 round 2). Split out of dispatch.ts (design-review #8) — reads the
// registry through the SAME agent dir the session will use (by the time this
// runs, PI_CODING_AGENT_DIR already points at the hermetic dir).
import { readFileSync } from "node:fs";
import path from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { EffectiveRule, RuleDefinition } from "../rules/types.js";
import { AUTH_FILE, MODELS_FILE, SETTINGS_FILE } from "./session-hermetics.js";

// The runtime, read through the CURRENT agent dir (which, inside a dispatch
// run, is the hermetic dir whose auth/models/settings are symlinks to the real
// ones — so this credential view matches the sessions' exactly).
//
// pi 0.80.8 replaced AuthStorage/ModelRegistry.create with async
// ModelRuntime.create(). allowModelNetwork is left false so resolution stays
// local (auth.json + env + bundled catalogs) and never waits on a catalog
// refresh. See https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md
async function createRuntime(): Promise<{ runtime: ModelRuntime; agentDir: string }> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, AUTH_FILE),
    modelsPath: path.join(agentDir, MODELS_FILE),
    allowModelNetwork: false,
  });
  return { runtime, agentDir };
}

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
// rule's OWN subagent (it strips the suffix), but ModelRuntime.getModel() is
// an EXACT match and would miss it. Strip it here so the two agree; otherwise a
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
 * CRITICAL (caught in review): `ModelRuntime.getModel()` is a pure NAME lookup
 * with NO credential check, and setting `options.model` SHORT-CIRCUITS the
 * SDK's own auth-aware selection (`findInitialModel` gates the settings
 * default on `hasConfiguredAuth` and otherwise falls back to the auth-filtered
 * available snapshot). Handing it an un-credentialed model is therefore
 * strictly WORSE than handing it none: a guaranteed `No API key found` at
 * prompt() → fallbackResult → EVERY rule marked failed. A rule's pinned model
 * proves the rule AUTHOR's box had that key, not that this one does (the
 * shipped CI workflow sets only ANTHROPIC_API_KEY). So every candidate is
 * gated on `hasConfiguredAuth`, which counts env-var keys — keeping
 * env-var-only CI working.
 *
 * Never throws: model selection must not be able to kill a review.
 */
export async function resolveOrchestratorModel(
  request: OrchestratorModelRequest | undefined,
): Promise<CreateAgentSessionOptions["model"] | undefined> {
  if (!request) return undefined;

  // Read the runtime through the SAME agent dir the session will use: by now
  // PI_CODING_AGENT_DIR already points at the hermetic dir (see dispatchRules),
  // whose auth.json/models.json/settings.json are symlinks to the real ones — so
  // this credential view matches the session's exactly.
  const { runtime, agentDir } = await createRuntime();

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
    const model = runtime.getModel(ref.provider, ref.modelId);
    if (!model) {
      explain(`is not in the pi model registry (agent dir: ${agentDir})`);
      continue;
    }
    // THE gate. Without it we hand the session a credential-less model and
    // guarantee a total review wipeout. hasConfiguredAuth takes a provider id.
    if (!runtime.hasConfiguredAuth(model.provider)) {
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

/**
 * Direct dispatch (P0): resolve one RULE's session model. Unlike the
 * orchestrator's candidate ladder this is a single spec — the rule's own
 * (effective) pin — so failure is an ERROR STRING for the caller to classify
 * into the rule's failure reason, not a silent fallback. The thinking-level
 * suffix (`:high` etc.) is split off and returned separately so the session
 * can be created at the pinned level.
 */
export async function resolveRuleSessionModel(
  provider: string,
  modelSpec: string,
): Promise<{
  model?: CreateAgentSessionOptions["model"];
  thinkingLevel?: string;
  error?: string;
}> {
  const { runtime } = await createRuntime();
  const suffixMatch = THINKING_SUFFIX_RE.exec(modelSpec);
  const modelId = modelSpec.replace(THINKING_SUFFIX_RE, "");
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    return { error: `model "${provider}/${modelId}" is not in the pi model registry` };
  }
  if (!runtime.hasConfiguredAuth(model.provider)) {
    return { error: `no configured credentials for provider ${provider} on this machine` };
  }
  // Codex review (PR #7): the SDK's own ThinkingLevel type is "off" |
  // "minimal" | "low" | "medium" | "high" | "xhigh" | "max" — "off" IS the
  // valid disabled value; "none" is not a value the SDK accepts at all. A
  // rule/--model suffix of `:none` is normalized to "off" so both spellings
  // reach createAgentSession as the one value it actually recognizes.
  const rawLevel = suffixMatch?.[0].slice(1).toLowerCase();
  const thinkingLevel = rawLevel === "none" ? "off" : rawLevel;
  return { model: model as CreateAgentSessionOptions["model"], thinkingLevel };
}

export interface EffectiveRulesResult {
  /** Every rule, with unpinned ones filled from the resolved default. */
  effective: EffectiveRule[];
  /**
   * ruleName -> why it could NOT be given a model (only possible when the rule
   * is unpinned AND no default resolved: no credentialed --model, no
   * credentialed settings default, zero credentialed providers). These rules
   * must be reported failed with this reason, never silently dropped.
   */
  unresolved: Record<string, string>;
}

/**
 * A model's published pricing, when the registry carries it. Rates are per
 * what the registry records (pi models.json uses dollars per million tokens);
 * only their RELATIVE order matters here, never the unit.
 */
interface ModelCost {
  readonly input: number;
  readonly output: number;
}

// The per-class rates CANNOT be summed into a scalar price — they price
// different token classes, so which model is pricier depends on the workload's
// input/output mix (Codex review of PR #124: 20+80 vs 30+60 flips under an
// input-heavy mix). Reviews ARE input-heavy — every prompt embeds the diff and
// trusted context, and the output is the bounded findings JSON (#110 caps its
// prose) — so the comparison uses a documented, review-shaped profile. It is
// an approximation by construction: cache rates and volume tiers are ignored,
// and the claim stays advisory (the resolution order is untouched).
const INPUT_TOKEN_WEIGHT = 0.9;
const OUTPUT_TOKEN_WEIGHT = 0.1;

function reviewShapedCost(model: { cost?: ModelCost }): number | undefined {
  // A model without published pricing cannot take part in an expense
  // comparison — it is excluded, not treated as free. Two shapes of "no
  // pricing" exist here: the field absent outright, AND — the pinned SDK
  // normalizes a custom models.json model's required cost field to all zeros
  // when the author omitted it (provider-composer.js:
  // `cost: definition.cost ?? { input: 0, output: 0, ... }`) — input AND
  // output both zero. A genuine 0/0 published price is indistinguishable from
  // that default and is excluded the same way; conservative, since a
  // zero-priced model would otherwise be reported as the cheapest
  // alternative at ~0% (Codex review of PR #124).
  if (model.cost === undefined) return undefined;
  if (model.cost.input === 0 && model.cost.output === 0) return undefined;
  return INPUT_TOKEN_WEIGHT * model.cost.input + OUTPUT_TOKEN_WEIGHT * model.cost.output;
}

/**
 * Issue #112 (model discipline): "an omitted model silently inherits the
 * session's most expensive one" — Superpowers 6.0's phrasing of the exact trap
 * our default-fill shares. Two log lines, and only when unpinned rules exist:
 *
 * 1. ALWAYS: name the model the unpinned rules will run on. Silent inheritance
 *    becomes visible inheritance — the operator can see what the absence of a
 *    pin chose.
 * 2. When pricing data is available and the resolved default is the most
 *    expensive credentialed model on this machine, say so and name the
 *    cheapest alternative. Deliberately a WARNING, not a block, and
 *    deliberately not "use the cheapest": turn count beats token price — the
 *    cheapest models routinely take 2-3x the turns on multi-step work and cost
 *    more overall — so the default stays the default and the choice stays
 *    visible. Resolution ORDER is unchanged (issue #112's own constraint).
 */
function warnOnInheritedModelCost(
  unpinned: readonly RuleDefinition[],
  defaultSpec: string,
  runtime: ModelRuntime,
): void {
  console.warn(
    `tgd-review-agent: ${unpinned.length} rule(s) without a provider/model pin ` +
      `will run on "${defaultSpec}" (the deployment default)`,
  );

  const defaultRef = parseModelRef(defaultSpec);
  if (defaultRef === undefined) return;
  const available = runtime.getAvailableSnapshot();
  const defaultCost = reviewShapedCost(available.find((m) => m.provider === defaultRef.provider && m.id === defaultRef.modelId) ?? {});
  if (defaultCost === undefined) return; // no pricing on the default — nothing to compare
  const priced = available
    .map((m) => ({ spec: `${m.provider}/${m.id}`, cost: reviewShapedCost(m) }))
    .filter((entry): entry is { spec: string; cost: number } => entry.cost !== undefined);
  const cheaper = priced.filter((entry) => entry.cost < defaultCost).sort((a, b) => a.cost - b.cost);
  // "Most expensive" requires BOTH something cheaper and NOTHING pricier: a
  // mid-priced default (say costs of 5, 10, 20 with the default at 10) has
  // cheaper alternatives but is not the ceiling, and warning would misdescribe
  // it (Codex review of PR #124).
  const pricier = priced.filter((entry) => entry.cost > defaultCost);
  if (cheaper.length === 0 || pricier.length > 0) return;
  const ratio = Math.round((cheaper[0]!.cost / defaultCost) * 100);
  console.warn(
    `tgd-review-agent: "${defaultSpec}" is the priciest credentialed model on this ` +
      `machine for a review-shaped token mix (90% input / 10% output); the cheapest ` +
      `alternative is "${cheaper[0]!.spec}" (~${ratio}% of its price). ` +
      `Consider pinning a mid-tier model on review rules — though turn count beats token ` +
      `price, so the cheapest is not automatically right (issue #112).`,
  );
}

/**
 * Design-review #6 (model decoupling): a rule's `provider`/`model` are now
 * optional. This fills every UNPINNED rule with the deployment's default
 * model, resolved once, in priority order:
 *
 *   1. `--model` — if credentialed on this machine (warned about when not:
 *      the user asked for it by name).
 *   2. pi's own settings default — if credentialed.
 *   3. the first credentialed model in the runtime (`getAvailableSnapshot()[0]`),
 *      pi's own auth-aware notion of "the model this machine can run".
 *
 * PINNED rules pass through untouched — even when their provider has no
 * credentials here. That is deliberate: a pin is the rule author's explicit
 * choice, and the existing dispatch-time failure ("no working credentials for
 * provider X") names the problem far more usefully than a silent re-route to
 * a different model would.
 *
 * Never throws. When nothing resolves at all, unpinned rules land in
 * `unresolved` with a reason the caller MUST surface as a rule failure.
 */
export async function resolveEffectiveRules(
  rules: RuleDefinition[],
  explicitDefault?: string,
): Promise<EffectiveRulesResult> {
  const unpinned = rules.filter((r) => r.provider === undefined || r.model === undefined);
  if (unpinned.length === 0) {
    return { effective: rules as EffectiveRule[], unresolved: {} };
  }

  const { runtime, agentDir } = await createRuntime();

  // Resolve the ONE default spec all unpinned rules share.
  let defaultSpec: string | undefined;
  const settingsDefault = readSettingsDefaultSpec(agentDir);
  // Deduped, same reasoning as resolveOrchestratorModel's candidates above
  // (CodeRabbit review, PR #7): --model and the settings default can
  // legitimately be the same spec, and without dedup a rejected model would
  // get the explicit-only warning printed twice.
  const candidates = [
    ...(explicitDefault ? [explicitDefault] : []),
    ...(settingsDefault ? [settingsDefault] : []),
  ].filter((spec, i, all) => all.indexOf(spec) === i);
  for (const spec of candidates) {
    const ref = parseModelRef(spec);
    const model = ref ? runtime.getModel(ref.provider, ref.modelId) : undefined;
    if (model && runtime.hasConfiguredAuth(model.provider)) {
      // Codex review (PR #7): preserve the ORIGINAL candidate spec (which may
      // carry a thinking-level suffix like ":high") rather than reconstructing
      // from `model.provider`/`model.id` — the registry lookup above already
      // stripped the suffix to find the model (parseModelRef), so rebuilding
      // from the looked-up model's own fields would silently drop it for
      // every unpinned rule this default fills. resolveRuleSessionModel
      // downstream re-parses this exact string (same THINKING_SUFFIX_RE) to
      // recover the level, so preserving it here is sufficient.
      defaultSpec = spec.trim();
      break;
    }
    if (spec === explicitDefault) {
      console.warn(
        `tgd-review-agent: --model "${spec}" is not a credentialed model on this machine; ` +
          `trying the next default candidate for unpinned rules`,
      );
    }
  }
  if (!defaultSpec) {
    const available = runtime.getAvailableSnapshot();
    if (available.length > 0) {
      defaultSpec = `${available[0].provider}/${available[0].id}`;
    }
  }

  if (!defaultSpec) {
    const unresolved: Record<string, string> = Object.create(null) as Record<string, string>;
    const reason =
      "rule has no provider/model pin and no default model could be resolved " +
      "(no credentialed --model or settings default, and no provider on this machine " +
      "has configured credentials)";
    for (const rule of unpinned) unresolved[rule.name] = reason;
    return {
      effective: rules.filter((r): r is EffectiveRule => r.provider !== undefined && r.model !== undefined),
      unresolved,
    };
  }

  warnOnInheritedModelCost(unpinned, defaultSpec, runtime);

  const slash = defaultSpec.indexOf("/");
  const defaultProvider = defaultSpec.slice(0, slash);
  const defaultModel = defaultSpec.slice(slash + 1);
  return {
    effective: rules.map((r) =>
      r.provider !== undefined && r.model !== undefined
        ? (r as EffectiveRule)
        : { ...r, provider: defaultProvider, model: defaultModel },
    ),
    unresolved: {},
  };
}
