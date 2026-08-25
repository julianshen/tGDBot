// Everything downstream of the orchestrating session's OUTPUT: parsing its
// final JSON (never-throws), recovering findings from raw task output,
// deterministic reconciliation against the subagent tool's captured
// per-task results, suggestion provenance (ADR-007), and failure
// classification. Split out of dispatch.ts (design-review #8) — pure and
// synchronous, no SDK, no I/O beyond console.warn.
import type { EffectiveRule, RuleDefinition } from "../rules/types.js";
import type { DispatchResult, Finding, FindingDecision } from "./types.js";

// One dispatched task's structured outcome, read from the subagent tool's
// details.results[i] (order = dispatch order = rule order). `model` is
// "<provider>/<model>[:thinkingLevel]" (e.g. "xai/grok-4.5:high"), used to
// cross-check the positional rule mapping. `finalOutput` is the task's raw
// findings-JSON text (the FINDING_JSON_CONTRACT array), used to recover a
// rule's findings if the orchestrator dropped them.
export interface CapturedTaskResult {
  model?: string;
  exitCode?: number | null;
  error?: string;
  timedOut?: boolean;
  detached?: boolean;
  finalOutput?: string;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const VALID_SEVERITIES = new Set(["blocking", "warning", "suggestion"]);
export const FINDING_DECISIONS = [
  "new",
  "still-valid",
  "addressed",
  "disputed",
  "needs-clarification",
] as const satisfies readonly FindingDecision[];
export const MAX_FINDING_QUESTION_CHARS = 500;
const MAX_STATE_SUGGESTION_CHARS = 20_000;

/**
 * Suggestions are optional executable enrichment and are later persisted in
 * the conversation ledger. Keep only values that satisfy that ledger's text
 * contract without rewriting a byte of the proposed replacement. Rewriting
 * whitespace or Unicode would make the stored/replayed fix differ from what
 * the reviewer authored, so an unsafe suggestion is dropped while its finding
 * remains usable.
 */
function stateSafeSuggestion(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STATE_SUGGESTION_CHARS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    // `.trimEnd()`, not `.trim()` (issue #43). A suggestion REPLACES its whole
    // line range, so it carries the file's existing indentation and the
    // contract asks for exactly that — comparing against a fully trimmed value
    // silently dropped every suggestion whose first line was indented, which is
    // nearly all of them.
    //
    // TRAILING whitespace stays rejected, though: renderSuggestionBlock strips
    // it, so accepting it here would publish a committable block that no longer
    // byte-matches the value we validated and persisted.
    value !== value.normalize("NFC").trimEnd()
  ) {
    return undefined;
  }
  return value;
}

const FINDING_DECISION_SET = new Set<string>(FINDING_DECISIONS);

/**
 * `Set<string>.has()` is not a type guard, so membership alone leaves the value
 * as `string`. This predicate is what carries the narrowing to the callers that
 * return a FindingDecision.
 */
function isFindingDecision(value: string): value is FindingDecision {
  return FINDING_DECISION_SET.has(value);
}

/**
 * Shared decision/question contract for both dispatch engines.
 * Missing/null decision defaults to `new`. Inconsistent shapes reject.
 */
export function readFindingDecision(
  raw: Record<string, unknown>,
): { ok: true; decision: FindingDecision; question?: string } | { ok: false } {
  const decisionRaw = raw.decision;
  const questionRaw = raw.question;
  const decision = decisionRaw === undefined || decisionRaw === null ? "new" : decisionRaw;
  if (typeof decision !== "string" || !isFindingDecision(decision)) return { ok: false };

  const hasQuestion = questionRaw !== undefined && questionRaw !== null;
  if (decision === "needs-clarification") {
    if (typeof questionRaw !== "string") return { ok: false };
    const question = questionRaw.trim();
    if (question.length === 0 || question.length > MAX_FINDING_QUESTION_CHARS) return { ok: false };
    return { ok: true, decision, question };
  }
  if (hasQuestion) return { ok: false };
  return { ok: true, decision };
}

/**
 * Shared finding validator/normalizer. Direct dispatch parses task arrays
 * through this; the legacy orchestrator path uses it for the merged result.
 * Title/suggestion/endLine stay lenient optional enrichment.
 */
/**
 * The URLs a rule's own text cites (issue #49).
 *
 * Bounded and http(s) only. This is the set a finding may cite from, so it is
 * the security boundary for the citation feature: anything outside it is a
 * model invention.
 */
export function referencesDeclaredBy(ruleBody: string): Set<string> {
  const declared = new Set<string>();
  for (const match of ruleBody.matchAll(/https?:\/\/[^\s<>()\[\]"'`]+/gu)) {
    const url = match[0].replace(/[.,;:]+$/u, "");
    if (url.length <= 2_000) declared.add(url);
  }
  return declared;
}

export function normalizeUnknownFinding(
  value: unknown,
  ruleName?: string,
  allowedReferences?: ReadonlySet<string>,
): Finding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.file !== "string") return undefined;
  if (!VALID_SEVERITIES.has(candidate.severity as string)) return undefined;
  if (typeof candidate.category !== "string") return undefined;
  if (typeof candidate.message !== "string") return undefined;
  const resolvedRuleName = typeof candidate.ruleName === "string" ? candidate.ruleName : ruleName;
  if (typeof resolvedRuleName !== "string") return undefined;
  if (
    candidate.line !== undefined &&
    candidate.line !== null &&
    typeof candidate.line !== "number"
  ) {
    return undefined;
  }
  const contract = readFindingDecision(candidate);
  if (!contract.ok) return undefined;

  const finding: Finding = {
    file: candidate.file,
    ...(typeof candidate.line === "number" ? { line: candidate.line } : {}),
    severity: candidate.severity as Finding["severity"],
    category: candidate.category,
    message: candidate.message,
    ruleName: resolvedRuleName,
    decision: contract.decision,
  };
  if (typeof candidate.title === "string") finding.title = candidate.title;
  // Issue #38: advisory metadata, so an unrecognized value is dropped and the
  // finding still posts. Exact match only — no lowercasing or trimming, which
  // would invent a contract the prompt never stated.
  if (candidate.effort === "quick" || candidate.effort === "heavy") {
    finding.effort = candidate.effort;
  }
  // Fail closed: with no allowed set there is nothing to check a citation
  // against, so none survives (issue #49).
  if (Array.isArray(candidate.references) && allowedReferences !== undefined) {
    const cited = candidate.references.filter(
      (url): url is string => typeof url === "string" && allowedReferences.has(url),
    );
    if (cited.length > 0) finding.references = cited;
  }
  const suggestion = stateSafeSuggestion(candidate.suggestion);
  if (suggestion !== undefined) finding.suggestion = suggestion;
  if (Number.isInteger(candidate.endLine)) finding.endLine = candidate.endLine as number;
  if (contract.question !== undefined) finding.question = contract.question;
  return finding;
}

function isValidFinding(value: unknown): value is Finding {
  return normalizeUnknownFinding(value) !== undefined;
}

function normalizeFinding(
  finding: Finding,
  declaredByRule: ReadonlyMap<string, ReadonlySet<string>>,
): Finding {
  const normalized = normalizeUnknownFinding(
    finding,
    undefined,
    declaredByRule.get(finding.ruleName),
  );
  if (normalized !== undefined) return normalized;
  // UNREACHABLE today, and deliberately kept. looksLikeDispatchResult has
  // already validated every finding through this same normalization, and the
  // allowed-reference set affects which citations survive rather than whether
  // the finding is valid — so normalization cannot fail here, and no test can
  // drive this branch (verified by removing it: nothing failed).
  //
  // It stays because the hazard it guards is a security one: should those two
  // validations ever diverge, the raw finding would carry citations that never
  // went through the declared-URL check, which is precisely what #49 exists to
  // prevent. Cheap insurance at a boundary, not a tested path.
  if (finding.references === undefined) return finding;
  const { references, ...withoutReferences } = finding;
  void references;
  return withoutReferences;
}

function looksLikeDispatchResult(value: unknown): value is DispatchResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.findings) &&
    candidate.findings.every(isValidFinding) &&
    isStringArray(candidate.rulesRun) &&
    isStringArray(candidate.rulesFailed)
  );
}

export function fallbackResult(
  rules: RuleDefinition[],
  reason = "the review orchestrator did not complete — see the CI logs for the cause",
): DispatchResult {
  // Review finding: without a reason here, every ORCHESTRATOR-level failure
  // (prompt() threw, malformed final JSON, setup failed, unreconcilable results)
  // still rendered the bare "- rule-name" list this change exists to kill. Stamp
  // a generic-but-honest reason so the whole class is covered, not just the
  // per-task branch the smoke test happened to hit.
  const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const rule of rules) ruleFailureReasons[rule.name] = reason;
  return { findings: [], rulesRun: [], rulesFailed: rules.map((rule) => rule.name), ruleFailureReasons };
}

// Never throws — a single bad/malformed LLM response must not crash the
// whole run (SPEC.md boundary, AC-5.4).
export function parseDispatchResult(text: string | undefined, rules: RuleDefinition[]): DispatchResult {
  if (!text) {
    console.warn("dispatchRules: session produced no final assistant message");
    return fallbackResult(rules);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch (err) {
    console.warn(`dispatchRules: could not parse final message as JSON (${(err as Error).message})`);
    return fallbackResult(rules);
  }

  if (!looksLikeDispatchResult(parsed)) {
    console.warn("dispatchRules: final message JSON did not match the DispatchResult shape");
    return fallbackResult(rules);
  }

  // A finding may cite only what ITS OWN rule declared, so the allowed set is
  // keyed by rule name rather than pooled across the run (issue #49).
  const declaredByRule = new Map(rules.map((rule) => [rule.name, referencesDeclaredBy(rule.body)]));
  return {
    ...parsed,
    findings: parsed.findings.map((finding) => normalizeFinding(finding, declaredByRule)),
  };
}

// Like isValidFinding but WITHOUT requiring ruleName — a dispatched task's raw
// finalOutput follows FINDING_JSON_CONTRACT (`[{file,line,severity,category,
// message}]`), which has no ruleName (the orchestrator adds it during merge;
// when we recover a dropped task's findings we stamp it ourselves).
function isValidRawFinding(value: unknown): boolean {
  // Dummy ruleName: task arrays omit it; the same decision contract still applies.
  return normalizeUnknownFinding(value, "raw") !== undefined;
}

// Extracts a findings JSON array from a task's finalOutput, tolerating a model
// that wraps the array in preamble/trailing prose despite the STRICT contract
// (e.g. "Here is my review:\n[ ... ]"). Tries, in order: (1) strict parse of
// the fence-stripped text; (2) parse of the first `[` … last `]` slice. Returns
// undefined if neither yields a valid findings array. The reviewer's own system
// prompt is the primary defense (it's instructed to emit ONLY the array); this
// leniency is a safety net so a stray preamble doesn't silently lose findings.
export function extractFindingsArray(text: string): unknown[] | undefined {
  const stripped = stripCodeFences(text);
  const tryParse = (s: string): unknown[] | undefined => {
    try {
      const p = JSON.parse(s);
      return Array.isArray(p) && p.every(isValidRawFinding) ? p : undefined;
    } catch {
      return undefined;
    }
  };
  const strict = tryParse(stripped);
  if (strict) return strict;
  // Gemini review: TRAILING prose can itself contain a `]` (e.g. "see [3]
  // above"), which would make a single first-`[`..last-`]` slice unparseable.
  // Walk the closing bracket backwards until a candidate parses — strictly
  // more lenient than the old single attempt (whose slice is the first
  // candidate tried), so nothing that recovered before is lost.
  const first = stripped.indexOf("[");
  if (first >= 0) {
    let last = stripped.lastIndexOf("]");
    while (last > first) {
      const parsed = tryParse(stripped.slice(first, last + 1));
      if (parsed) return parsed;
      last = stripped.lastIndexOf("]", last - 1);
    }
  }
  return undefined;
}

// Parses one task's raw finalOutput into Finding[] stamped with ruleName.
// Best-effort — returns [] on any parse/shape problem, never throws.
export function parseFindingsFromFinalOutput(text: string, ruleName: string): Finding[] {
  const parsed = extractFindingsArray(text);
  if (!parsed) return [];
  // No entry can be dropped here: extractFindingsArray accepts an array only
  // when EVERY entry passes isValidRawFinding, which is this same
  // normalization. A single malformed finding rejects the whole array upstream,
  // and the caller reports unusable output rather than a short list — checked
  // in "an array is all or nothing" (issue #41).
  return parsed.flatMap((value) => {
    const finding = normalizeUnknownFinding(value, ruleName);
    return finding === undefined ? [] : [finding];
  });
}

/**
 * ADR-007 PROVENANCE. A committable suggestion must be traceable to a suggestion a
 * dispatched reviewer ACTUALLY emitted for that exact (file, line).
 *
 * Why this is a control and not a nicety: the ORCHESTRATOR is an LLM that has also
 * read the attacker-controlled diff, and it re-emits every finding as its own JSON.
 * Telling it "copy the suggestion verbatim, never rewrite" is a prompt — a hope. It
 * could invent a suggestion for any (file, line) in the diff, or mutate an honest
 * one, and the reviewer's real finding would serve as cover for it. Since the
 * subagents' raw outputs are already captured (details.results[i].finalOutput), we
 * can turn that hope into an INVARIANT by byte-matching.
 *
 * Unverifiable => dropped. If the captured results can't be mapped (so we cannot
 * know what any subagent actually proposed), no suggestion is committable. The
 * finding itself is always kept — losing a one-click fix is a fair price.
 */
export function suggestionProvenanceKeys(
  captured: CapturedTaskResult[],
  rules: RuleDefinition[],
): Set<string> {
  const keys = new Set<string>();
  captured.forEach((c, i) => {
    const rule = rules[i];
    if (!rule || !c.finalOutput) return;
    for (const finding of parseFindingsFromFinalOutput(c.finalOutput, rule.name)) {
      if (typeof finding.suggestion === "string") {
        keys.add(provenanceKey(finding.file, finding.line, finding.suggestion));
      }
    }
  });
  return keys;
}

function provenanceKey(file: string, line: number | undefined, suggestion: string): string {
  return JSON.stringify([file, line ?? null, suggestion]);
}

/** Strips any suggestion the orchestrator cannot prove a subagent actually made. */
export function enforceSuggestionProvenance(result: DispatchResult, allowed: Set<string>): DispatchResult {
  let dropped = 0;
  const findings = result.findings.map((f) => {
    if (typeof f.suggestion !== "string") return f;
    if (allowed.has(provenanceKey(f.file, f.line, f.suggestion))) return f;
    dropped += 1;
    return { ...f, suggestion: undefined, endLine: undefined };
  });
  if (dropped > 0) {
    console.warn(
      `dispatchRules: dropped ${dropped} committable suggestion(s) that no dispatched reviewer ` +
        `actually produced for that file/line (orchestrator provenance check)`,
    );
  }
  return { ...result, findings };
}

// A task ran successfully iff it exited 0 with no error/timeout/detach.
function taskSucceeded(c: CapturedTaskResult): boolean {
  return c.exitCode === 0 && !c.error && !c.timedOut && !c.detached;
}

// Errors that mean "this rule's provider isn't usable on this machine" — by far
// the most common real cause (the zero-config smoke test hit exactly this: the
// builtin rule is pinned to anthropic and the box had no ANTHROPIC_API_KEY).
//
// The numeric status codes are DELIBERATELY anchored. A bare /401|403/ matches
// those digits anywhere — "retry after 4030ms", "40312 tokens exceeds limit",
// "req_011CS401xyz" — and this string is published in the PR comment. Telling a
// maintainer "no working credentials" when the real cause was a rate limit sends
// them to rotate a healthy key while the truth hides in the logs: confidently
// wrong, which is worse than the silence this whole change exists to fix.
//
// Distinct from PI_AUTH_ERROR_RE above, which annotates the ORCHESTRATOR's own
// prompt() throw. This one classifies a dispatched RULE's task error. They
// overlap but are not interchangeable — update both if auth detection changes.
const PROVIDER_AUTH_ERROR_RE =
  /No API key found|Authentication failed|no configured credentials|unauthoriz|forbidden|invalid api key|\b(?:status|code|http)\W{0,4}(?:401|403)\b/i;

// rule.provider is rule-file-sourced and gets interpolated into a world-readable
// PR comment inside a code span. Strip what could break out of it (backticks,
// newlines, table pipes) and cap the length, so a crafted value can't inject
// markdown into the bot's own comment.
function sanitizeForComment(value: string): string {
  return value.replace(/[`\r\n|]/g, "").trim().slice(0, 60);
}

/**
 * WHY a rule's task failed, as a short phrase SAFE TO PUBLISH.
 *
 * This is rendered into a PR comment, which is world-readable on a public repo.
 * Raw provider errors can echo request/response details, so they are deliberately
 * NOT included here — they go to stderr (private CI logs) instead. What a
 * maintainer needs from the comment is the actionable class of failure plus which
 * provider it was, and that is exactly what this returns.
 */
export function classifyTaskFailure(c: CapturedTaskResult, rule: EffectiveRule): string {
  if (c.timedOut) return "timed out";
  if (c.detached) return "detached before finishing";
  const error = c.error ?? "";
  if (PROVIDER_AUTH_ERROR_RE.test(error)) {
    return `no working credentials for provider \`${sanitizeForComment(rule.provider)}\` on the machine running the review`;
  }
  if (error) return `errored (see the CI logs for the full message)`;
  if (typeof c.exitCode === "number" && c.exitCode !== 0) return `exited with code ${c.exitCode}`;
  return "failed to run";
}

// Deterministic reconciliation of the orchestrating LLM's self-reported
// DispatchResult against the structured per-task results captured from the
// subagent tool (details.results). See DispatchSession.subscribe's doc comment
// for why: the LLM was observed to occasionally mark a task that RAN (exit 0)
// as "failed" and drop its whole findings set.
//
// - rulesRun/rulesFailed come purely from each task's exitCode (order-mapped to
//   rules), so a task that ran can never be mis-reported as failed.
// - Findings are always kept from the orchestrator for rules that ran (and
//   dropped for rules that did NOT run — a failed task's output isn't
//   trustworthy; this also drops hallucinated rule names).
// - When `recoverFindings` is true, a rule that ran but has ZERO orchestrator
//   findings ALSO has its findings recovered from its raw finalOutput (the
//   orchestrator dropped the whole rule). `recoverFindings` is `!useAdvisor`:
//   with the advisor pass OFF, "zero findings for a rule that ran" can only
//   mean a buggy drop, so recovery is safe. With the advisor ON, zero findings
//   is AMBIGUOUS — it could be a buggy drop OR the advisor legitimately
//   removing all of that rule's findings as false positives — and recovering
//   from raw finalOutput would UNDO the advisor and reintroduce false
//   positives. So with advisor on we do NOT recover: accounting is still fixed
//   deterministically (the rule correctly shows as run), but its findings are
//   left as the advisor-filtered orchestrator produced them.
//
// Falls back to the orchestrator's own result (NO reconciliation) whenever the
// captured results can't be safely 1:1 order-mapped to rules — counts differ,
// or a captured model doesn't match its positional rule's "<provider>/<model>"
// prefix (the real details.model carries a ":thinkingLevel" suffix, so a prefix
// match is used). This guarantees reconciliation never makes results WORSE on
// an unexpected shape; it only ever corrects a mapping we can fully verify.
//
// KNOWN LIMITATION (documented, unobserved): this repairs whole-rule drops (the
// observed failure) and fixes accounting; it does not detect a PARTIAL drop
// within a rule the orchestrator kept, nor a mis-attribution where the
// orchestrator tagged one rule's findings with another rule's name. And with
// advisor on, a genuine whole-rule drop leaves that rule's findings lost (only
// its accounting is corrected) — accepted to never undo advisor filtering.
export function reconcileWithCapturedResults(
  orchestrator: DispatchResult,
  captured: CapturedTaskResult[],
  rules: EffectiveRule[],
  recoverFindings: boolean,
): DispatchResult {
  if (captured.length !== rules.length) return orchestrator;
  const orderTrustworthy = captured.every((c, i) => {
    if (!c.model) return true; // nothing to cross-check — rely on dispatch order
    // Gemini review: normalize the thinking suffix on BOTH sides. A rule may
    // itself pin `model: claude-opus-4-5:high` while the captured model omits
    // (or differs in) the suffix — a raw startsWith would then fail and
    // silently SKIP reconciliation, the exact degradation the cross-check
    // exists to prevent. Same suffix set as orchestrator-model.ts's
    // THINKING_SUFFIX_RE (pi-subagents strips these when resolving fuzzily);
    // update both together if pi's thinking levels ever change.
    const stripThinking = (spec: string): string =>
      spec.replace(/:(?:none|off|minimal|low|medium|high|max)$/i, "");
    return stripThinking(c.model).startsWith(
      stripThinking(`${rules[i].provider}/${rules[i].model}`),
    );
  });
  if (!orderTrustworthy) return orchestrator;

  const rulesRun: string[] = [];
  const rulesFailed: string[] = [];
  // Null-prototype: a rule literally named "__proto__" would otherwise not set an
  // own property, and the later lookup would return Object.prototype (truthy) and
  // render "[object Object]" as the reason.
  const ruleFailureReasons: Record<string, string> = Object.create(null) as Record<string, string>;
  const recovered: Finding[] = [];
  captured.forEach((c, i) => {
    const rule = rules[i];
    if (!taskSucceeded(c)) {
      rulesFailed.push(rule.name);
      ruleFailureReasons[rule.name] = classifyTaskFailure(c, rule);
      // Smoke-test finding: this was previously silent — a rule failed and NOTHING,
      // not even stderr, said why. The RAW error goes to the CI logs; only the
      // classified reason above reaches the PR comment. (On a public repo the logs
      // are readable too — but GitHub masks registered secrets there, and a comment
      // is pushed into every reviewer's face while a log line is not.)
      const raw = c.error ?? classifyTaskFailure(c, rule);
      console.warn(
        `dispatchRules: rule "${rule.name}" (${rule.provider}/${rule.model}) failed: ${raw}`,
      );
      return;
    }
    rulesRun.push(rule.name);
    if (!recoverFindings) return;
    const orchestratorHasFindings = orchestrator.findings.some((f) => f.ruleName === rule.name);
    if (!orchestratorHasFindings && c.finalOutput) {
      recovered.push(...parseFindingsFromFinalOutput(c.finalOutput, rule.name));
    }
  });

  const runSet = new Set(rulesRun);
  const kept = orchestrator.findings.filter((f) => runSet.has(f.ruleName));
  return { findings: [...kept, ...recovered], rulesRun, rulesFailed, ruleFailureReasons };
}
