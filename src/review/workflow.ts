import type { RuleDefinition } from "../rules/types.js";

export interface ReviewWorkflowWave {
  readonly ruleNames: readonly string[];
  readonly parallelGroup?: string;
}

export interface ReviewWorkflow {
  readonly waves: readonly ReviewWorkflowWave[];
}

export class ReviewWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewWorkflowError";
  }
}

function workflowError(message: string): never {
  throw new ReviewWorkflowError(message);
}

export function planReviewWorkflow(rules: readonly RuleDefinition[]): ReviewWorkflow {
  const ruleNames = new Set<string>();
  for (const rule of rules) {
    if (ruleNames.has(rule.name)) {
      workflowError(`duplicate rule name "${rule.name}"`);
    }
    ruleNames.add(rule.name);
  }

  for (const rule of rules) {
    const dependencies = new Set<string>();
    for (const dependency of rule.dependsOn) {
      if (dependencies.has(dependency)) {
        workflowError(`rule "${rule.name}" has duplicate dependency "${dependency}"`);
      }
      if (dependency === rule.name) {
        workflowError(`rule "${rule.name}" cannot depend on itself`);
      }
      if (!ruleNames.has(dependency)) {
        workflowError(`rule "${rule.name}" depends on unknown rule "${dependency}"`);
      }
      dependencies.add(dependency);
    }
  }

  const completed = new Set<string>();
  const remaining = new Set(rules.map((rule) => rule.name));
  const waves: ReviewWorkflowWave[] = [];

  while (remaining.size > 0) {
    const ready = rules.filter(
      (rule) =>
        remaining.has(rule.name) &&
        rule.dependsOn.every((dependency) => completed.has(dependency)),
    );
    const first = ready[0];
    if (first === undefined) {
      workflowError("rule dependency graph contains a cycle");
    }

    const waveRules =
      first.parallelGroup === undefined
        ? [first]
        : ready.filter((rule) => rule.parallelGroup === first.parallelGroup);
    const ruleNamesInWave = Object.freeze(waveRules.map((rule) => rule.name));
    const wave = Object.freeze({
      ruleNames: ruleNamesInWave,
      ...(first.parallelGroup === undefined ? {} : { parallelGroup: first.parallelGroup }),
    });
    waves.push(wave);

    for (const rule of waveRules) {
      remaining.delete(rule.name);
      completed.add(rule.name);
    }
  }

  return Object.freeze({ waves: Object.freeze(waves) });
}
