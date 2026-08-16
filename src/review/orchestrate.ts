// orchestrate: a deterministic dedupe/grouping safety net over a
// DispatchResult, plus rendering the final review comment Markdown. See
// SPEC.md's "Boundaries" ("Never fail silently") and TASKS.md Task 7.
//
// This is a PURE, SYNCHRONOUS function — no LLM calls, no I/O. Any advisor
// second-opinion pass already happened inside dispatchRules (Task 6); this
// module is a plain formatting/safety-net layer on top of its output.
import { selectClarification } from "../conversation/clarification.js";
import { renderInlineComment, renderSummaryComment } from "./comment-format.js";
import type { ClarificationPresentation, FindingContext, RenderOptions } from "./comment-format.js";
import type { InlineComment } from "./comment-format.js";
import {
  changedFiles,
  commentableLines,
  hunkSnippet,
  diffPositionRange,
  isCommentable,
  parseDiffPositions,
  rangeIsCommentable,
} from "./diff-anchors.js";
import { clusterFindings } from "./finding-clusters.js";
import type { DispatchResult, Finding, FindingDecision } from "./types.js";
import type { RelatedWorkItem } from "./related-work.js";
import type { DiscussionMemory, ExistingReviewIssue } from "./existing-discussion.js";

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
  findingByClientId: ReadonlyMap<string, Finding>;
  readonly summaryInput: import("./comment-format.js").SummaryInput;
}


const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

export interface ReviewBindingOptions {
  readonly repositoryDigest: string;
  readonly reviewNumber: number;
  readonly headSha: string;
}

export type OrchestrateOptions = {
  inline?: boolean;
  relatedWork?: readonly RelatedWorkItem[];
  ruleOrder?: readonly string[];
  reviewBinding?: ReviewBindingOptions;
  contextUnavailable?: readonly string[];
  clarification?: ClarificationPresentation;
  excludeClarificationIds?: readonly string[];
  deferredClarificationCount?: number;
  existingIssues?: readonly ExistingReviewIssue[];
  discussionMemories?: readonly DiscussionMemory[];
} & RenderOptions;

function decisionOf(finding: Finding): FindingDecision {
  return finding.decision ?? "new";
}

function isActionableDecision(decision: FindingDecision): boolean {
  return decision === "new" || decision === "still-valid";
}


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
// string, keeps this file plain text -- a NUL byte anywhere in the file can
// make diff tooling and review UIs treat the whole file as binary.
function dedupeKey(finding: Finding): string {
  return JSON.stringify([finding.file, finding.line ?? null, normalizeMessage(finding.message)]);
}

// Exact-duplicate collapsing now lives in clusterFindings, which performs the
// same "keep the higher-severity copy" rule (AC-7.1) while ALSO retaining every
// contributing rule name. dedupeKey stays: it still identifies addressed
// findings above.

function issueAnchorKey(file: string, line: number): string {
  return JSON.stringify([file, line]);
}









/**
 * Turns a DispatchResult into the two things a review writes: inline comments
 * anchored to the diff, and a summary comment for everything else.
 *
 * `diff` is what makes anchoring possible and safe: providers accept inline
 * comments only at valid diff positions, so a finding is only
 * anchored when the diff itself proves the line is addressable (see
 * diff-anchors). Anything else — no line number, a file not touched by this change,
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
 * These paths are where a single mistaken click stops being "bad code in a
 * change" and becomes "arbitrary execution with repository secrets": CI
 * workflow definitions run on merge (and often while reviewing a change) with
 * tokens in scope; package manifests and lockfiles execute install scripts;
 * container/build files execute at build time. A one-click commit into any of
 * them is a different category of harm from a one-click commit into application
 * code, which a human reviews and CI then tests.
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
  options: OrchestrateOptions = {},
): OrchestrationResult {
  // Addressed findings are removed before ordinary dedup, and their keys
  // suppress a repeated new/still-valid copy of the same issue.
  const addressedKeys = new Set(
    dispatchResult.findings.filter((finding) => decisionOf(finding) === "addressed").map(dedupeKey),
  );
  const actionable = dispatchResult.findings.filter(
    (finding) => isActionableDecision(decisionOf(finding)) && !addressedKeys.has(dedupeKey(finding)),
  );
  const disputed = dispatchResult.findings.filter((finding) => decisionOf(finding) === "disputed");
  const clarification = options.clarification === undefined
    ? selectClarification({
        repositoryDigest: options.reviewBinding?.repositoryDigest ?? "0".repeat(64),
        reviewNumber: options.reviewBinding?.reviewNumber ?? 1,
        headSha: options.reviewBinding?.headSha ?? "0".repeat(40),
        findings: dispatchResult.findings,
        ruleOrder: options.ruleOrder ?? dispatchResult.rulesRun,
        excludeIds: options.excludeClarificationIds,
      })
    : { selected: options.clarification, deferredCount: options.deferredClarificationCount ?? 0 };

  // Severity order is load-bearing, not cosmetic: a reader must meet the
  // blocking findings before the nits, whether they're reading the summary or
  // scanning the inline comments. dedupeFindings preserves insertion order, so
  // sort explicitly. (The old severity-grouped renderer got this for free; the
  // regression it would otherwise have introduced was caught by AC-7.2.)
  const existingIssueAnchors = new Set(
    (options.existingIssues ?? []).map((issue) => issueAnchorKey(issue.file, issue.line)),
  );
  // NOT pre-deduped: clusterFindings collapses exact duplicates itself and
  // keeps every contributing rule name while doing so. Collapsing here first
  // threw the second rule away before clustering could ever see it, which made
  // the rule-attribution logic unreachable in production (Codex review).
  const candidates = actionable.filter(
    (finding) => finding.line === undefined || finding.line === null ||
      !existingIssueAnchors.has(issueAnchorKey(finding.file, finding.line)),
  );

  // Several rules recognising ONE defect used to produce one entry each — five
  // statements of the same race on PR #281, three of them anchored to the very
  // same line. Cluster first, then present one entry per root cause with its
  // contributing rules as metadata, so the reader meets each defect once.
  const clusters = clusterFindings(candidates);
  // Every surviving finding, exact duplicates already collapsed. This is the
  // set the COUNTS describe: clustering decides what is SHOWN, never how many
  // findings a run had or what severities they carried.
  const allFindings = clusters.flatMap((cluster) => cluster.members);
  const inlineEnabled = options.inline !== false && diff !== "";

  const positions = inlineEnabled ? parseDiffPositions(diff) : undefined;
  const anchors = positions ? commentableLines(positions) : new Map<string, Set<number>>();

  // Only representatives enter the placement loop, so a representative chosen
  // purely on severity/detail can throw away an anchor the cluster genuinely
  // had — members often disagree about which line of a construct to blame.
  // Prefer an anchorable member, keeping the severity ordering among those.
  const representativeOf = (cluster: (typeof clusters)[number]): Finding =>
    cluster.members.find((member) => isCommentable(anchors, member.file, member.line)) ??
    cluster.representative;

  const contributingRules = new Map<Finding, readonly string[]>();
  // The members a cluster did NOT promote still have to be rendered somewhere,
  // or a similarity heuristic silently deletes a finding (Codex review of
  // PR #23, P1). Every surface that shows a representative shows these too.
  const mergedMembers = new Map<Finding, readonly Finding[]>();
  for (const cluster of clusters) {
    const representative = representativeOf(cluster);
    contributingRules.set(representative, cluster.rules);
    mergedMembers.set(representative, cluster.members.filter((member) => member !== representative));
  }
  const dedupedFindings = clusters
    .map(representativeOf)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const inlineComments: InlineComment[] = [];
  const unanchored: Finding[] = [];
  const findingByClientId = new Map<string, Finding>();
  let nextClientId = 0;
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
    // in the diff at all. A multi-line comment's range must lie within a single
    // hunk for provider-neutral position construction. Because context lines are
    // included in the anchor set, "every line in start..end is commentable" is
    // exactly equivalent to "the range is inside one hunk", so this check is both
    // sufficient and simple.
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

    const alsoReported = mergedMembers.get(finding) ?? [];
    // Corroboration by several rules belongs on the inline comment too, not
    // only in the summary — it is the same finding either way.
    const rules = contributingRules.get(finding) ?? [];
    const rendered = renderInlineComment(
      showFix ? { ...finding, suggestion } : { ...finding, suggestion: undefined },
      {
        suggestions: committable,
        ...(alsoReported.length > 0 ? { alsoReported } : {}),
        ...(rules.length > 1 ? { rules } : {}),
      },
    );

    // Only anchor across a range when a COMMITTABLE suggestion will actually use it —
    // otherwise it is a range that exists to serve nothing.
    const multiLine = committable && rangeOk;
    const position = diffPositionRange(
      positions!,
      finding.file,
      start,
      multiLine ? (endLine as number) : start,
    );
    if (!position) {
      unanchored.push(finding);
      continue;
    }
    const clientId = `finding-${nextClientId}`;
    nextClientId += 1;
    findingByClientId.set(clientId, finding);

    inlineComments.push({
      clientId,
      path: finding.file,
      // Provider-neutral ranges use `line` = LAST and `startLine` = FIRST.
      line: multiLine ? (endLine as number) : start,
      ...(multiLine ? { startLine: start } : {}),
      position,
      body: rendered,
    });
  }

  // Built for EVERY finding, not just the currently-unanchored ones: an inline
  // comment can still be rejected at publication time, and renderSummary must be
  // able to give it its excerpt then without re-parsing the diff.
  const context = new Map<Finding, FindingContext>(
    dedupedFindings.map((finding) => [
      finding,
      {
        ...(inlineEnabled
          ? { snippet: hunkSnippet(diff, finding.file, finding.line, finding.endLine) }
          : {}),
        ...(() => {
          const rules = contributingRules.get(finding);
          return rules && rules.length > 1 ? { rules } : {};
        })(),
        ...(() => {
          const members = mergedMembers.get(finding);
          return members && members.length > 0 ? { alsoReported: members } : {};
        })(),
      },
    ]),
  );

  const summaryInput = {
    allFindings,
    inlineCount: inlineComments.length,
    unanchored,
    publishFailed: [] as Finding[],
    findingCount: allFindings.length,
    uniqueIssueCount: clusters.length,
    context,
    filesReviewed: changedFiles(diff),
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
    ruleFailureReasons: dispatchResult.ruleFailureReasons,
    relatedWork: options.relatedWork,
    discussionMemories: options.discussionMemories,
    inlineUnavailable: !inlineEnabled && dedupedFindings.length > 0,
    ...(clarification.selected === undefined ? {} : { clarification: clarification.selected }),
    ...(clarification.deferredCount > 0 ? { deferredClarificationCount: clarification.deferredCount } : {}),
    ...(disputed.length > 0 ? { disputed } : {}),
    ...(options.contextUnavailable === undefined ? {} : { contextUnavailable: options.contextUnavailable }),
  };
  const commentBody = renderSummaryComment(summaryInput);

  return {
    commentBody,
    inlineComments,
    // Pre-cluster: this value feeds terminal results, recovery markers and
    // status logs. Clustering is a presentation choice and must not redefine
    // how many findings a run reports (Codex review of PR #23).
    findingsCount: allFindings.length,
    rulesRun: dispatchResult.rulesRun,
    rulesFailed: dispatchResult.rulesFailed,
    findingByClientId,
    summaryInput,
  };
}

/**
 * Re-renders the summary once publication outcomes are known.
 *
 * `failedIds` are findings whose anchors were VALID — they were accepted by
 * every check this tool makes and then refused by the provider. Merging them
 * into `unanchored` (which is what this did) made the comment tell the reader
 * their line numbers were not in the diff, sending them to audit anchors that
 * were never wrong. They get their own group, and `reason` carries the
 * provider's own words so the failure is diagnosable from the comment alone.
 */
export function renderSummary(
  presentation: OrchestrationResult,
  failedIds: ReadonlySet<string>,
  maxLength?: number,
  reason?: string | ReadonlyMap<string, string>,
): string {
  const failed = [...failedIds].map((id) => {
    const finding = presentation.findingByClientId.get(id);
    if (!finding) throw new Error(`unknown inline finding clientId: ${id}`);
    return finding;
  });

  // A per-clientId map attributes each rejection to the finding it actually
  // describes; a bare string keeps the older "one cause for the batch" form,
  // which is still the truth for a single atomic rejection.
  const perFinding = typeof reason === "object" ? reason : undefined;
  const sharedReason = typeof reason === "string" ? reason : undefined;
  const context = perFinding
    ? new Map(presentation.summaryInput.context ?? [])
    : presentation.summaryInput.context;
  if (perFinding && context instanceof Map) {
    for (const id of failedIds) {
      const finding = presentation.findingByClientId.get(id);
      const why = perFinding.get(id);
      if (!finding || why === undefined) continue;
      context.set(finding, { ...context.get(finding), publishFailureReason: why });
    }
  }

  return renderSummaryComment({
    ...presentation.summaryInput,
    ...(context === undefined ? {} : { context }),
    inlineCount: presentation.inlineComments.length - failed.length,
    publishFailed: [
      ...(presentation.summaryInput.publishFailed ?? []),
      ...failed,
    ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    ...(sharedReason === undefined ? {} : { publishFailureReason: sharedReason }),
    inlineUnavailable: presentation.summaryInput.inlineUnavailable,
  }, maxLength);
}
