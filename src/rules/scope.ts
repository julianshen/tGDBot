// Issue #115: deciding which rules a pull request's files actually call for.
//
// Deterministic and BEFORE any model call, which is the whole point: a rule
// about SQL migrations dispatched against a CSS-only change pays the full
// per-rule diff cost, and then has to answer anyway — and an answer produced
// under those conditions is the low-confidence kind that costs more triage
// than it saves.
import { globToRegExp, matchesAnyPath } from "./glob.js";
import type { RuleDefinition } from "./types.js";

export interface ScopedRules {
  /** Rules to dispatch: no declared scope, or a scope this diff touches. */
  readonly applicable: RuleDefinition[];
  /**
   * Rules whose declared paths this diff does not touch, by name and sorted.
   *
   * Reported rather than dropped. A rule that did not run is not a rule that
   * found nothing, and a summary listing only the rules that ran implies a
   * coverage the review did not have.
   */
  readonly skipped: string[];
}

/**
 * Partitions rules by whether this pull request touches paths they declare.
 *
 * A rule with no `appliesTo` is always applicable — that is what keeps every
 * existing rule, and the builtin, behaving exactly as before.
 *
 * When `changedFiles` is EMPTY the partition is skipped entirely and every
 * rule is applicable. An empty list means the diff told us nothing about which
 * files changed — a diff this tool could not parse, or one it never had — and
 * scoping on that would silently disable every scoped rule at exactly the
 * moment there is least reason to trust the input. Failing open here costs a
 * dispatch; failing closed costs a review.
 */
export function scopeRulesToChangedFiles(
  rules: readonly RuleDefinition[],
  changedFiles: readonly string[],
): ScopedRules {
  if (changedFiles.length === 0) return { applicable: [...rules], skipped: [] };

  const kept: RuleDefinition[] = [];
  const skipped: string[] = [];
  for (const rule of rules) {
    if (rule.appliesTo === undefined || rule.appliesTo.length === 0) {
      kept.push(rule);
      continue;
    }
    // Patterns were validated at load, so compiling cannot throw here. A rule
    // whose scope could not compile never reached this list.
    const patterns = rule.appliesTo.map(globToRegExp);
    if (matchesAnyPath(patterns, changedFiles)) kept.push(rule);
    else skipped.push(rule.name);
  }

  // A dependency on a rule that will not run has no order left to establish,
  // so the edge goes with it.
  //
  // Without this, a broad rule depending on a narrowly scoped prerequisite
  // aborted the entire review: `planReviewWorkflow` rejects a dependency on a
  // rule it cannot see, and scoping had removed the prerequisite while leaving
  // its name behind (Codex review of PR #126). Dropping the edge rather than
  // keeping a phantom node is what the dependency already means — the README
  // is explicit that dependencies establish ORDER rather than success gating,
  // and a failed prerequisite does not suppress the rules after it either.
  const removed = new Set(skipped);
  const applicable = kept.map((rule) =>
    rule.dependsOn.some((dependency) => removed.has(dependency))
      ? { ...rule, dependsOn: Object.freeze(rule.dependsOn.filter((d) => !removed.has(d))) }
      : rule);

  return { applicable, skipped: skipped.sort() };
}
