// RuleDefinition: the fully-parsed, validated shape of one rule file (or the
// vendored built-in rule) after loader.ts has parsed its YAML frontmatter and
// Markdown body. See SPEC.md "Rule file format" and TASKS.md Task 4 — the
// original SPEC draft's `workflowType`/`steps` fields were removed by an
// architecture correction; every rule is dispatched as one subagent task.
export interface RuleDefinition {
  name: string;
  provider: string;
  model: string;
  body: string;
  sourcePath: string;
}
