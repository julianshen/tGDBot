// Prompt construction for the orchestrating dispatch session: the per-rule
// task text (rule body + read-only instruction + findings JSON contract +
// the diff) and the top-level orchestration prompt that fans the rules out
// as one PARALLEL "subagent" tool call. Split out of dispatch.ts
// (design-review #8) — pure string building, no SDK, no I/O beyond the
// cost-risk console.warn.
import type { EffectiveRule } from "../rules/types.js";

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

function warnIfDiffCostRisk(rules: EffectiveRule[], diff: string): void {
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

export function buildTaskText(rule: EffectiveRule, diff: string): string {
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
  rules: EffectiveRule[],
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
