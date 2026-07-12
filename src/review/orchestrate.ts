// orchestrate: a deterministic dedupe/grouping safety net over a
// DispatchResult, plus rendering the final PR comment Markdown. See
// SPEC.md's "Boundaries" ("Never fail silently") and TASKS.md Task 7.
//
// This is a PURE, SYNCHRONOUS function — no LLM calls, no I/O. Any advisor
// second-opinion pass already happened inside dispatchRules (Task 6); this
// module is a plain formatting/safety-net layer on top of its output.
import type { DispatchResult, Finding } from "./types.js";

export interface OrchestrationResult {
  commentBody: string;
  findingsCount: number;
  rulesRun: string[];
  rulesFailed: string[];
}

// Order matters here: it doubles as both the dedup severity-preference
// ranking and the section-rendering order (TASKS.md Task 7 step 2:
// "blocking, then warning, then suggestion").
const SEVERITY_ORDER: Finding["severity"][] = ["blocking", "warning", "suggestion"];

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  blocking: "Blocking",
  warning: "Warning",
  suggestion: "Suggestion",
};

// Trimmed, case-insensitive, whitespace-collapsed — so cosmetic differences
// between two rules' phrasing of the same underlying issue (extra spaces,
// different casing) don't defeat the dedup key.
function normalizeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

// JSON.stringify of the field tuple is used as the delimiter-free key
// encoding: it's provably collision-free (embedded characters are escaped
// by JSON, unlike a literal separator character which could in principle
// appear in a file path or message) and, unlike a NUL-byte-delimited
// string, keeps this file plain text -- a NUL byte anywhere in the file
// makes `git diff`/GitHub's PR view treat the whole file as binary.
function dedupeKey(finding: Finding): string {
  return JSON.stringify([finding.file, finding.line ?? null, normalizeMessage(finding.message)]);
}

// Two findings are "the same" if file + line + normalized message are
// equal — keep one, preferring the higher-severity duplicate (TASKS.md
// Task 7 step 1, AC-7.1).
function dedupeFindings(findings: Finding[]): Finding[] {
  const bestByKey = new Map<string, Finding>();

  for (const finding of findings) {
    const key = dedupeKey(finding);
    const existing = bestByKey.get(key);
    if (!existing || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) {
      bestByKey.set(key, finding);
    }
  }

  return [...bestByKey.values()];
}

// Groups already-deduped findings by severity (in SEVERITY_ORDER, omitting
// empty groups), then by file within each severity group. File order
// within a severity is first-seen order among that severity's findings.
function groupBySeverityThenFile(findings: Finding[]): Map<Finding["severity"], Map<string, Finding[]>> {
  const bySeverity = new Map<Finding["severity"], Map<string, Finding[]>>();

  for (const severity of SEVERITY_ORDER) {
    const byFile = new Map<string, Finding[]>();
    for (const finding of findings) {
      if (finding.severity !== severity) continue;
      const bucket = byFile.get(finding.file) ?? [];
      bucket.push(finding);
      byFile.set(finding.file, bucket);
    }
    if (byFile.size > 0) {
      bySeverity.set(severity, byFile);
    }
  }

  return bySeverity;
}

function renderFinding(finding: Finding): string {
  const location = finding.line !== undefined && finding.line !== null ? `L${finding.line}` : "general";
  return `- **[${location}]** ${finding.message} _(${finding.category}, rule: ${finding.ruleName})_`;
}

function renderFindingsSection(findings: Finding[]): string {
  const bySeverity = groupBySeverityThenFile(findings);
  const sections: string[] = [];

  for (const severity of SEVERITY_ORDER) {
    const byFile = bySeverity.get(severity);
    if (!byFile) continue;

    const fileBlocks = [...byFile.entries()].map(([file, fileFindings]) => {
      const lines = fileFindings.map(renderFinding).join("\n");
      return `**${file}**\n${lines}`;
    });

    sections.push(`### ${SEVERITY_LABEL[severity]}\n\n${fileBlocks.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

// Smoke-test finding: this section used to name the failed rules and say
// nothing about WHY, leaving a maintainer with no next step. Append the reason
// when dispatch could classify one (see DispatchResult.ruleFailureReasons);
// stay exactly as before when it couldn't, so a missing reason never renders as
// "undefined".
function renderFailedRulesSection(
  rulesFailed: string[],
  reasons: Record<string, string> | undefined,
): string {
  const items = rulesFailed
    .map((ruleName) => {
      const reason = reasons?.[ruleName];
      return reason ? `- ${ruleName} — ${reason}` : `- ${ruleName}`;
    })
    .join("\n");
  return `### ⚠️ Rules that failed\n\nThe following rules failed to run and were skipped:\n\n${items}`;
}

export function orchestrate(dispatchResult: DispatchResult): OrchestrationResult {
  const dedupedFindings = dedupeFindings(dispatchResult.findings);
  const hasFailedRules = dispatchResult.rulesFailed.length > 0;

  const bodyParts = ["## Code Review"];

  if (dedupedFindings.length > 0) {
    bodyParts.push(renderFindingsSection(dedupedFindings));
  } else if (!hasFailedRules) {
    // AC-7.4: never render a blank/near-empty comment — a blank bot
    // comment reads as a bug, not "all clear".
    bodyParts.push("No issues found.");
  }

  if (hasFailedRules) {
    bodyParts.push(
      renderFailedRulesSection(dispatchResult.rulesFailed, dispatchResult.ruleFailureReasons),
    );
  }

  return {
    commentBody: bodyParts.join("\n\n"),
    findingsCount: dedupedFindings.length,
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
  };
}
