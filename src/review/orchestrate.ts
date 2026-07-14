// orchestrate: a deterministic dedupe/grouping safety net over a
// DispatchResult, plus rendering the final PR comment Markdown. See
// SPEC.md's "Boundaries" ("Never fail silently") and TASKS.md Task 7.
//
// This is a PURE, SYNCHRONOUS function — no LLM calls, no I/O. Any advisor
// second-opinion pass already happened inside dispatchRules (Task 6); this
// module is a plain formatting/safety-net layer on top of its output.
import { renderInlineComment, renderSummaryComment } from "./comment-format.js";
import type { RenderOptions } from "./comment-format.js";
import type { InlineComment } from "./comment-format.js";
import { changedFiles, commentableLines, isCommentable, rangeIsCommentable } from "./diff-anchors.js";
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
/**
 * ADR-007: files where a committable suggestion is NEVER offered.
 *
 * The honest position (forced by review): the `suggestion` field is filled by the
 * same LLM reading the same attacker-controlled diff as everything else. Being a
 * structured field constrains which JSON key a payload rides in — it is NOT a trust
 * boundary. So the residual risk is real, and the right response is to cap the BLAST
 * RADIUS rather than pretend it is mitigated.
 *
 * These paths are where a single mistaken click stops being "bad code in a PR" and
 * becomes "arbitrary execution with repository secrets": CI workflow definitions run
 * on merge (and often on PR) with tokens in scope; package manifests and lockfiles
 * execute install scripts; container/build files execute at build time. A one-click
 * commit into any of them is a different category of harm from a one-click commit
 * into application code, which a human reviews and CI then tests.
 *
 * Findings on these files are still reported in full — only the COMMIT BUTTON is
 * withheld. The fix is shown as a plain, non-committable block.
 */
const NO_SUGGESTION_PATHS: RegExp[] = [
  /(^|\/)\.github\//i, // workflows, actions — run with secrets
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)(Jenkinsfile|Dockerfile|Containerfile|Makefile)$/i,
  /(^|\/)docker-compose(\.\w+)?\.ya?ml$/i,
  /(^|\/)package\.json$/i, // install/postinstall scripts
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  /(^|\/)(setup\.py|pyproject\.toml|Gemfile|build\.gradle(\.kts)?)$/i,
  /(^|\/)\.(npmrc|yarnrc|pypirc|netrc|env)(\.|$)/i,
];

export function isSuggestionAllowedForPath(file: string): boolean {
  return !NO_SUGGESTION_PATHS.some((re) => re.test(file));
}

export function orchestrate(
  dispatchResult: DispatchResult,
  diff = "",
  options: { inline?: boolean } & RenderOptions = {},
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
    if (!inlineEnabled || !isCommentable(anchors, finding.file, finding.line)) {
      unanchored.push(finding);
      continue;
    }

    const start = finding.line as number;
    const suggestion = finding.suggestion?.trim() ? finding.suggestion : undefined;
    const endLine = finding.endLine;

    // ADR-007: a committable suggestion REPLACES the range `line`..`endLine`, so
    // EVERY line in that range must be in the diff — not just the endpoints.
    //
    // Endpoint-only checking (the first draft, caught in review) is unsound:
    // `commentableLines` merges all of a file's hunks into one set, so a range
    // whose ends sit in DIFFERENT hunks passes while the lines between it are not
    // in the diff at all. GitHub requires a multi-line comment's range to lie
    // within a single hunk and 422s the ENTIRE review otherwise — killing every
    // inline comment on the run. Because context lines are included in the anchor
    // set, "every line in start..end is commentable" is exactly equivalent to
    // "the range is inside one hunk", so this check is both sufficient and simple.
    const wantsRange = Number.isInteger(endLine) && (endLine as number) > start;
    const rangeOk =
      wantsRange &&
      rangeIsCommentable(anchors, finding.file, start, endLine as number);

    // A malformed range (endLine < line, non-integer, NaN) must DROP the
    // suggestion, never silently collapse a multi-line replacement onto one line —
    // that would commit a 3-line fix onto line 1, duplicating the rest. A wrong
    // one-click fix is worse than none.
    const rangeMalformed =
      endLine !== undefined && !Number.isInteger(endLine);
    const rangeInverted =
      Number.isInteger(endLine) && (endLine as number) < start;

    // Blast-radius cap: never offer a one-click commit into a file whose contents
    // execute with secrets (CI workflows, manifests, lockfiles, build files). The
    // finding is still posted in full; only the button is withheld.
    const pathAllowsSuggestion = isSuggestionAllowedForPath(finding.file);

    const suggestable =
      suggestion !== undefined &&
      pathAllowsSuggestion &&
      !rangeMalformed &&
      !rangeInverted &&
      (!wantsRange || rangeOk);

    // On a denied path the fix is still SHOWN — as a plain, non-committable block.
    const committable = suggestable && options.suggestions !== false;

    const showFix =
      suggestion !== undefined && !rangeMalformed && !rangeInverted && (!wantsRange || rangeOk);

    const rendered = renderInlineComment(
      showFix ? { ...finding, suggestion } : { ...finding, suggestion: undefined },
      { suggestions: committable },
    );

    // Only anchor across a range when a COMMITTABLE suggestion will actually use it —
    // otherwise it is a range that exists to serve nothing.
    const multiLine = committable && rangeOk;

    inlineComments.push({
      path: finding.file,
      // GitHub anchors a multi-line comment with `line` = LAST and start_line = FIRST.
      line: multiLine ? (endLine as number) : start,
      ...(multiLine ? { startLine: start } : {}),
      body: rendered,
    });
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
