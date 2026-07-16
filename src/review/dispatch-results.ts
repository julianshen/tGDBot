// Everything downstream of the orchestrating session's OUTPUT: parsing its
// final JSON (never-throws), recovering findings from raw task output,
// deterministic reconciliation against the subagent tool's captured
// per-task results, suggestion provenance (ADR-007), and failure
// classification. Split out of dispatch.ts (design-review #8) — pure and
// synchronous, no SDK, no I/O beyond console.warn.
import type { EffectiveRule, RuleDefinition } from "../rules/types.js";
import type { DispatchResult, Finding } from "./types.js";

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

// Validates a single Finding's required fields/types. `line` is optional/
// nullable (per the JSON contract, `number | null`) so it's checked only
// when present. If any element of `findings` fails this check, the whole
// response is treated as malformed (see dispatch.ts's caller) rather than
// silently keeping the well-formed findings and dropping the bad ones —
// a response that gets the shape wrong for one finding is not trustworthy
// for the others either.
// The optional ADR-007/ADR-008 fields. Kept LENIENT on purpose: a rule that emits
// a malformed `title`/`suggestion`/`endLine` should lose that ENRICHMENT, not have
// its whole finding (or its rule's whole run) thrown away — the finding's core
// (file/line/severity/message) is still worth posting. So these are validated
// where they are USED, and simply dropped when wrong, rather than failing the
// finding here.

function isValidFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.file !== "string") return false;
  if (!VALID_SEVERITIES.has(candidate.severity as string)) return false;
  if (typeof candidate.category !== "string") return false;
  if (typeof candidate.message !== "string") return false;
  if (typeof candidate.ruleName !== "string") return false;
  if (
    candidate.line !== undefined &&
    candidate.line !== null &&
    typeof candidate.line !== "number"
  ) {
    return false;
  }
  // NOTE: title/suggestion/endLine are deliberately NOT validated here. They are
  // OPTIONAL ENRICHMENT, and rejecting a finding over one would be catastrophic:
  // isValidFinding feeds looksLikeDispatchResult, which is all-or-nothing — a
  // single bad field on a single finding would discard the ENTIRE orchestrator
  // result, and (with the advisor on, the default) recovery is disabled, so the
  // comment would announce "✅ No actionable comments" on a review that found
  // blocking issues. `"endLine": "12"` — a number emitted as a string — is a
  // routine LLM slip, and these are three brand-new model-authored fields. They
  // are stripped in normalizeFinding() instead. Found in review; the first draft
  // shipped exactly this kill switch.
  return true;
}

/**
 * Drops any optional enrichment that is the wrong type, keeping the finding.
 * The core (file/line/severity/category/message/ruleName) is already validated;
 * a malformed title/suggestion/endLine costs only itself.
 */
function normalizeFinding(finding: Finding): Finding {
  const raw = finding as unknown as Record<string, unknown>;
  return {
    ...finding,
    title: typeof raw.title === "string" ? raw.title : undefined,
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion : undefined,
    endLine: Number.isInteger(raw.endLine) ? (raw.endLine as number) : undefined,
  };
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

  return { ...parsed, findings: parsed.findings.map(normalizeFinding) };
}

// Like isValidFinding but WITHOUT requiring ruleName — a dispatched task's raw
// finalOutput follows FINDING_JSON_CONTRACT (`[{file,line,severity,category,
// message}]`), which has no ruleName (the orchestrator adds it during merge;
// when we recover a dropped task's findings we stamp it ourselves).
function isValidRawFinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.file !== "string") return false;
  if (!VALID_SEVERITIES.has(c.severity as string)) return false;
  if (typeof c.category !== "string") return false;
  if (typeof c.message !== "string") return false;
  if (c.line !== undefined && c.line !== null && typeof c.line !== "number") return false;
  // Same rule as isValidFinding: optional enrichment must never invalidate a
  // finding. extractFindingsArray uses `p.every(isValidRawFinding)`, so a bad
  // `title` here would lose ALL of that rule's recovered findings.
  return true;
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
  return parsed.map((f) => {
    const c = f as Record<string, unknown>;
    return {
      file: c.file as string,
      // The contract allows `number | null`; Finding.line is `number?`, so a
      // null (or absent) line becomes undefined rather than being kept as null.
      line: typeof c.line === "number" ? c.line : undefined,
      severity: c.severity as Finding["severity"],
      category: c.category as string,
      message: c.message as string,
      ruleName,
      // ADR-007/008 enrichment. Carried through the RECOVERY path too — a rule
      // whose findings had to be recovered from its raw output must not silently
      // lose its titles and suggestions.
      title: typeof c.title === "string" ? c.title : undefined,
      suggestion: typeof c.suggestion === "string" ? c.suggestion : undefined,
      endLine: typeof c.endLine === "number" ? c.endLine : undefined,
    };
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
