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
}
