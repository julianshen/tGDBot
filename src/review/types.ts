// Finding/DispatchResult: the shape produced by dispatching every loaded rule
// through the orchestrating AgentSession's `subagent` tool call and parsing
// its final JSON message. See SPEC.md "Data Models" and TASKS.md Task 5.
export interface Finding {
  file: string;
  line?: number;
  severity: "blocking" | "warning" | "suggestion";
  category: string;
  message: string;
  ruleName: string;

  /**
   * ADR-008: a short, AUTHORED headline (<= 80 chars, one line).
   *
   * Previously the bold headline was DERIVED by splitting `message` at its first
   * sentence — which produced no headline at all when that sentence was long,
   * because truncating it and reprinting the same sentence below reads as a
   * stutter. A title is something the reviewer should write, not something we
   * should guess. Optional: when absent, the derived-headline fallback still
   * applies, so older rules keep working.
   */
  title?: string;

  /**
   * ADR-007: replacement text for the anchored line range — rendered as a
   * GitHub COMMITTABLE SUGGESTION (a one-click "Commit suggestion" button).
   *
   * SECURITY (this is the whole reason it is a separate field): free-text
   * `message` is LLM output over an ATTACKER-CONTROLLED diff, and any
   * ```suggestion fence inside it is deliberately DEFANGED (ADR-006) — otherwise
   * prompt injection could mint a committable block. A suggestion may therefore
   * ONLY originate here: a structured field we validate, fence with a run longer
   * than any inside it, and scope to the anchored lines. See ADR-007 for the full
   * threat model and the `--suggestions off` escape hatch.
   *
   * Verbatim replacement text — NOT a diff, NOT fenced. Exactly what the lines
   * `line`..`endLine` should become.
   */
  suggestion?: string;

  /**
   * ADR-007: last line of the range a `suggestion` replaces (inclusive).
   * Omitted for a single-line suggestion, where the range is just `line`.
   * Both ends must be inside the diff, or the suggestion is dropped (the finding
   * itself is still posted).
   */
  endLine?: number;
}

export interface DispatchResult {
  findings: Finding[];
  rulesRun: string[];
  rulesFailed: string[];
  /**
   * ruleName -> WHY it failed, as a short CLASSIFIED phrase safe to publish.
   *
   * Found by the zero-config smoke test: a rule could fail and the comment said
   * only "rules failed to run and were skipped", with the real cause (no API key
   * for the rule's pinned provider) captured from the subagent and then dropped.
   *
   * Deliberately NOT the raw provider error: this is rendered into a PR comment,
   * which is world-readable on a public repo, and raw provider errors can echo
   * request details. The raw error goes to stderr (private CI logs) instead.
   *
   * Optional: absent when reconciliation couldn't map results to rules, and
   * absent per-rule for rules that succeeded.
   */
  ruleFailureReasons?: Record<string, string>;
}
