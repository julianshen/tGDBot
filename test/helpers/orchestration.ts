import type { SummaryInput } from "../../src/review/comment-format.js";
import type { OrchestrationResult } from "../../src/review/orchestrate.js";

export function emptySummaryInput(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    allFindings: [],
    inlineCount: 0,
    unanchored: [],
    filesReviewed: [],
    rulesRun: [],
    rulesFailed: [],
    ...over,
  };
}

export function emptyOrchestration(over: Partial<OrchestrationResult> = {}): OrchestrationResult {
  const rulesRun = over.rulesRun ?? [];
  const rulesFailed = over.rulesFailed ?? [];
  return {
    commentBody: "",
    inlineComments: [],
    findingsCount: 0,
    findingByClientId: new Map(),
    ...over,
    rulesRun,
    rulesFailed,
    summaryInput: emptySummaryInput({
      rulesRun: [...rulesRun],
      rulesFailed: [...rulesFailed],
      ...(over.summaryInput ?? {}),
    }),
  };
}
