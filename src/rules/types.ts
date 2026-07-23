// RuleDefinition: the fully-parsed, validated shape of one rule file (or the
// vendored built-in rule) after loader.ts has parsed its YAML frontmatter and
// Markdown body. See SPEC.md "Rule file format" and TASKS.md Task 4 — the
// original SPEC draft's `workflowType`/`steps` fields were removed by an
// architecture correction; every rule is dispatched as one subagent task.
export interface RuleDefinition {
  name: string;
  /**
   * Design-review #6 (model decoupling): `provider`/`model` are now OPTIONAL
   * overrides. A rule file describes WHAT to review; WHICH model runs it is a
   * deployment decision — an unpinned rule runs on the default model
   * (`--model`, else pi's settings default, else the first provider with
   * working credentials; see orchestrator-model.ts's resolveEffectiveRules).
   * When present they must come as a PAIR (loader-validated): a provider
   * without a model, or vice versa, is a load error, never a silent guess.
   */
  provider?: string;
  model?: string;
  dependsOn: readonly string[];
  parallelGroup?: string;
  body: string;
  sourcePath: string;
}

/**
 * A rule whose model has been RESOLVED: either its own pin, or the default
 * filled in by resolveEffectiveRules. Everything downstream of resolution
 * (prompt construction, reconciliation, failure classification) works on this
 * shape so it never has to re-handle "no model" — that case fails, with a
 * clear reason, before dispatch.
 */
export type EffectiveRule = RuleDefinition & { provider: string; model: string };
