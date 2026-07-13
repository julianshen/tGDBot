// orchestrate: a deterministic dedupe/grouping safety net over a
// DispatchResult, plus rendering the final PR comment Markdown. See
// SPEC.md's "Boundaries" ("Never fail silently") and TASKS.md Task 7.
//
// This is a PURE, SYNCHRONOUS function — no LLM calls, no I/O. Any advisor
// second-opinion pass already happened inside dispatchRules (Task 6); this
// module is a plain formatting/safety-net layer on top of its output.
import { renderInlineComment, renderSummaryComment } from "./comment-format.js";
import type { InlineComment } from "./comment-format.js";
import { changedFiles, commentableLines, isCommentable } from "./diff-anchors.js";
import type { DispatchResult, Finding } from "./types.js";

export type { InlineComment } from "./comment-format.js";

export interface OrchestrationResult {
  /** The SUMMARY comment (upserted, carries the dedup SHA marker). */
  commentBody: string;
  /**
   * Findings anchored to a line of the diff, to be posted as INLINE review
   * comments. Empty when there are none, or when the caller opted out.
   *
   * Every finding is in exactly ONE place: either here, or rendered in full in
   * `commentBody`. A finding is never dropped and never duplicated.
   */
  inlineComments: InlineComment[];
  findingsCount: number;
  rulesRun: string[];
  rulesFailed: string[];
}


const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
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









/**
 * Turns a DispatchResult into the two things a review writes: inline comments
 * anchored to the diff, and a summary comment for everything else.
 *
 * `diff` is what makes anchoring possible AND safe: GitHub 422s the entire
 * review if any comment targets a line outside the diff, so a finding is only
 * anchored when the diff itself proves the line is addressable (see
 * diff-anchors). Anything else — no line number, a file not touched by this PR,
 * a line outside every hunk — is rendered into the summary instead of being
 * silently dropped.
 *
 * `inline: false` (used for the `--dry-run`/no-diff paths and as the failure
 * fallback) forces EVERY finding into the summary body, so the caller always has
 * a single self-contained comment it can post.
 */
export function orchestrate(
  dispatchResult: DispatchResult,
  diff = "",
  options: { inline?: boolean } = {},
): OrchestrationResult {
  // Severity order is load-bearing, not cosmetic: a reader must meet the
  // blocking findings before the nits, whether they're reading the summary or
  // scanning the inline comments. dedupeFindings preserves insertion order, so
  // sort explicitly. (The old severity-grouped renderer got this for free; the
  // regression it would otherwise have introduced was caught by AC-7.2.)
  const dedupedFindings = dedupeFindings(dispatchResult.findings).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const inlineEnabled = options.inline !== false && diff !== "";

  const anchors = inlineEnabled ? commentableLines(diff) : new Map<string, Set<number>>();

  const inlineComments: InlineComment[] = [];
  const unanchored: Finding[] = [];
  for (const finding of dedupedFindings) {
    if (inlineEnabled && isCommentable(anchors, finding.file, finding.line)) {
      inlineComments.push({
        path: finding.file,
        line: finding.line as number,
        body: renderInlineComment(finding),
      });
    } else {
      unanchored.push(finding);
    }
  }

  const commentBody = renderSummaryComment({
    allFindings: dedupedFindings,
    inlineCount: inlineComments.length,
    unanchored,
    filesReviewed: changedFiles(diff),
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
    ruleFailureReasons: dispatchResult.ruleFailureReasons,
    inlineUnavailable: !inlineEnabled && dedupedFindings.length > 0,
  });

  return {
    commentBody,
    inlineComments,
    findingsCount: dedupedFindings.length,
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
  };
}
