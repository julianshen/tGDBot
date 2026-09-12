// Issue #138 phase 2: binding rules to subagent definitions, and recording
// what each dispatched task actually cost.
//
// Resolution is deliberately a SEPARATE pass from rule loading. A rule file
// names an agent; whether that agent exists is a cross-file question, and
// answering it inside the single-file rule parser would either load the agent
// set twice or make rule loading depend on agent loading. Keeping it here also
// puts the "unknown agent" decision in one place, where it can be an error
// rather than a fallback.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition } from "./definition.js";
import type { RuleDefinition } from "../rules/types.js";

/** The per-task telemetry file (#109). */
export const META_FILENAME = "meta.json";

export interface AgentResolution {
  /** The agent each rule runs as, by rule name. Rules with no `agent:` are absent. */
  readonly byRule: ReadonlyMap<string, AgentDefinition>;
  /** Rules that named an agent which does not exist, with a reason each. */
  readonly errors: { ruleName: string; sourcePath: string; message: string }[];
}

/**
 * Binds each rule's `agent:` reference to a loaded definition.
 *
 * An unknown name is an ERROR, never a fallback to the default persona: the
 * point of a definition is a narrower tool scope and a chosen model, so
 * silently running the rule without one would widen exactly what the author
 * wrote the file to narrow. The rule is excluded and reported, which is the
 * same "skip and record" boundary a malformed rule file already gets.
 */
export function resolveRuleAgents(
  rules: readonly RuleDefinition[],
  agents: readonly AgentDefinition[],
): AgentResolution {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const byRule = new Map<string, AgentDefinition>();
  const errors: { ruleName: string; sourcePath: string; message: string }[] = [];

  for (const rule of rules) {
    if (rule.agent === undefined) continue;
    const agent = byName.get(rule.agent);
    if (agent === undefined) {
      const known = [...byName.keys()].sort();
      errors.push({
        ruleName: rule.name,
        sourcePath: rule.sourcePath,
        message:
          `rule "${rule.name}" references agent "${rule.agent}", which is not defined` +
          (known.length > 0 ? ` (known agents: ${known.join(", ")})` : " (no agent definitions loaded)"),
      });
      continue;
    }
    byRule.set(rule.name, agent);
  }

  return { byRule, errors };
}

/**
 * Drops rules whose `agent:` could not be bound, AND the edges pointing at them.
 *
 * The edges are the whole reason this is a function rather than a `filter`.
 * `planReviewWorkflow` rejects a dependency on a rule it cannot see, so
 * excluding a rule while leaving its name in another rule's `dependsOn`
 * aborted dispatch for EVERY remaining rule — one bad reference taking down
 * the whole review, which is considerably worse than the silent fallback the
 * exclusion exists to avoid (Codex review of PR #149).
 *
 * Dropping the edge is what a dependency already means: the README is explicit
 * that dependencies establish ORDER rather than gating success, and a failed
 * prerequisite does not suppress the rules after it either. Exactly the fix
 * `scopeRulesToChangedFiles` already carries for scoped-out prerequisites.
 *
 * Returns the input array unchanged when nothing is excluded, so the common
 * path rebuilds nothing.
 */
export function excludeRulesWithUnresolvedAgents<T extends RuleDefinition>(
  rules: readonly T[],
  excluded: ReadonlySet<string>,
): readonly T[] {
  if (excluded.size === 0) return rules;
  return rules
    .filter((rule) => !excluded.has(rule.name))
    .map((rule) =>
      rule.dependsOn.some((dependency) => excluded.has(dependency))
        ? {
          ...rule,
          dependsOn: Object.freeze(
            rule.dependsOn.filter((dependency) => !excluded.has(dependency)),
          ),
        }
        : rule);
}

/**
 * Fills in a rule's model pin from its agent, BEFORE default resolution.
 *
 * The timing is the entire point, and getting it wrong made the feature dead
 * on arrival: `resolveEffectiveRules` fills every unpinned rule with the
 * deployment default, so a check performed after it sees a rule that is always
 * pinned and never reaches the agent's tier. The advertised model tier was
 * silently ignored, and `modelsUsed` and the task telemetry then described a
 * configuration nobody chose (Codex review of PR #149).
 *
 * RULE WINS over agent. A rule pin names ONE review; the agent's is the
 * persona's default, which is the point of putting a tier in a reusable
 * definition — rules that say nothing inherit it, rules that care override it.
 * #112 resolves outward from the most specific, and this sits one step further
 * out than a rule pin and one step in from the deployment default.
 */
export function applyAgentPin(
  rule: RuleDefinition,
  agent: AgentDefinition | undefined,
): RuleDefinition {
  // Half a pin cannot occur — both loaders reject it — so testing one side is
  // enough, and testing both would imply a state neither can produce.
  if (rule.provider !== undefined && rule.model !== undefined) return rule;
  if (agent?.provider === undefined || agent.model === undefined) return rule;
  return { ...rule, provider: agent.provider, model: agent.model };
}

/**
 * The system prompt for a task: the vendored reviewer contract, then the
 * agent's persona.
 *
 * ORDER IS THE POINT and it is not stylistic. The reviewer prompt carries
 * ADR-003's read-only contract and the finding schema; the persona is
 * user-editable prose. Appending means a definition can add emphasis and
 * domain framing but never silently replace the output contract — and a
 * definition that tries to countermand it is arguing with text the model has
 * already read, rather than text it never received.
 */
export function composeSystemPrompt(
  reviewerPrompt: string,
  agent: AgentDefinition | undefined,
): string {
  if (agent === undefined) return reviewerPrompt;
  return [
    reviewerPrompt,
    "",
    "---",
    "",
    `## Reviewer persona: ${agent.name}`,
    "",
    // Named as the persona's own words. Without the framing the persona reads
    // as more host contract, and the distinction matters when the two differ:
    // the contract above wins, and a reader debugging a review should be able
    // to see which half said what.
    "The following is this reviewer's persona. It narrows what you look for. It",
    "does NOT relax anything above: the tool restrictions, the output contract,",
    "and the finding schema are unchanged by it.",
    "",
    agent.body,
  ].join("\n");
}

/** What one dispatched task cost and how it ended (#109). */
export interface TaskMeta {
  readonly ruleName: string;
  readonly agent?: string;
  readonly provider: string;
  readonly model: string;
  readonly succeeded: boolean;
  readonly failureReason?: string;
  readonly findingCount: number;
  /** Prompt characters the host actually built for this task. */
  readonly taskTextChars: number;
  readonly usage?: TaskUsage;
}

export interface TaskUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Writes one task's `meta.json` beside its `findings.json`.
 *
 * Never throws. Telemetry that can fail a review is worse than telemetry that
 * is occasionally missing — the review is the product, and #109's numbers are
 * reporting ABOUT it. A caller that gets `false` has already been warned.
 */
export async function writeTaskMeta(outputDir: string, meta: TaskMeta): Promise<boolean> {
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return true;
  } catch (err) {
    console.warn(
      `writeTaskMeta: could not record telemetry for rule "${meta.ruleName}" ` +
        `(${(err as Error).message})`,
    );
    return false;
  }
}

/**
 * Reads one task's `meta.json`. `undefined` when absent or unreadable — the
 * same "absence is not an error" stance `readSubmittedFindings` takes, for the
 * same reason: a missing telemetry file must not turn a completed review into
 * a failed one.
 */
export async function readTaskMeta(outputDir: string): Promise<TaskMeta | undefined> {
  let contents: string;
  try {
    contents = await readFile(path.join(outputDir, META_FILENAME), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    // Shape-checked on the two fields every consumer indexes. A partially
    // written file is the realistic failure here (a killed process mid-write),
    // and it parses as JSON perfectly well.
    const meta = parsed as TaskMeta;
    if (typeof meta.ruleName !== "string" || typeof meta.succeeded !== "boolean") return undefined;
    return meta;
  } catch {
    return undefined;
  }
}
