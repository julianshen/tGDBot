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
