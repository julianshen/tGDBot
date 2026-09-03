// Rendering for the two surfaces a review now writes to:
//
//   1. INLINE review comments, anchored to a line of the diff (the CodeRabbit /
//      Cursor Bugbot model — a finding is most useful sitting next to the code
//      it is about, not in a list a reader has to cross-reference by hand).
//   2. A SUMMARY comment, which carries the counts, the run metadata, the
//      failed-rule reasons, and any finding that could NOT be anchored.
//
// Both are plain string builders: pure, synchronous, no I/O.
import { describeCheck, describeCheckCompact } from "./structural-check.js";
import { crossFileGroups } from "./finding-clusters.js";
import type { Finding, ScanCoverage } from "./types.js";
import type { HunkSnippet } from "./diff-anchors.js";
import type { DiscussionMemory } from "./existing-discussion.js";
import {
  isValidRelatedWorkProjectPath,
  validateResolvedRelatedWork,
  type RelatedWorkItem,
  type RelatedWorkKind,
  type RelatedWorkReference,
} from "./related-work.js";

/**
 * Machine-detectable tag appended to every inline comment THIS TOOL posts
 * (caught during an earlier review). Stale-thread cleanup must not treat
 * "authored by the same account" as "posted by this tool": a developer running
 * the CLI under their personal provider login also writes MANUAL review
 * comments as that same identity, and those must never be auto-resolved.
 * resolveStaleReviewThreads
 * therefore requires BOTH the verified author match AND this marker in the
 * thread's first comment. Unforgeable from finding content: sanitizeText
 * defangs `<!--` in all finding-derived text, so a crafted diff cannot make a
 * finding smuggle this marker in.
 */
export const INLINE_COMMENT_MARKER = "<!-- tgd-review-agent:inline -->";

/**
 * HUMAN-visible counterpart to the machine markers: the last rendered line of
 * every comment this tool writes, on every surface (inline findings, the
 * managed summary, and conversation replies).
 *
 * The marker above is an HTML comment — invisible in the rendered page, which
 * is the point for stale-thread cleanup and exactly the problem for a reader.
 * On a provider account named for the bot the avatar carries that signal, but
 * the common local case is a developer running the CLI under their OWN login
 * (the same case that forces resolveStaleReviewThreads to check the marker and
 * not just the author): their teammates then see review comments apparently
 * hand-written by a colleague. The signature says which ones the tool wrote.
 *
 * Static text, appended AFTER all sanitized content and never interpolated
 * with finding-derived values, so nothing a diff can say reaches this line.
 * It is decoration, not a machine signal: nothing parses it, and stale-thread
 * cleanup still keys on INLINE_COMMENT_MARKER alone. Content-addressed
 * publication digests cover the rendered body, so this line participates in
 * them like any other rendered text and must stay byte-stable per release.
 */
export const BOT_SIGNATURE =
  "_🤖 Posted by [tGDBot](https://github.com/julianshen/tGDBot)_";

/** The signature as its own block: a rule, then the line. */
export const BOT_SIGNATURE_BLOCK = `---\n\n${BOT_SIGNATURE}`;

/**
 * The signature block, as a pattern.
 *
 * Naming the model made the block's bytes vary, and `stripSignature` had
 * anchored on a constant. This is the single definition both sides use, so the
 * renderer cannot emit a footer the stripper fails to recognise. Deliberately
 * tight — the model list is a bracketed tail on one line — because the strip's
 * safety rests on this matching only what a renderer wrote.
 */
export const BOT_SIGNATURE_BLOCK_RE =
  /---\n\n_🤖 Posted by \[tGDBot\]\(https:\/\/github\.com\/julianshen\/tGDBot\)(?: using [^\n]*)?_/gu;

/** How many distinct models the signature names before summarising the rest. */
const MAX_SIGNED_MODELS = 3;

/**
 * How long one model label may be.
 *
 * The count was bounded and the LENGTH was not, so three pathological specs
 * could push the signature — and with it the digest — past its declared cap
 * (PR #72 review).
 */
const MAX_SIGNED_MODEL_CHARS = 64;

/**
 * The signature, naming the model or models that actually produced the review.
 *
 * A reader who disagrees with a finding should be able to tell what wrote it
 * without digging through CI logs, and a repository that changes models should
 * leave old comments attributable to the one that actually ran.
 *
 * A run can pin different models per rule, so this names every DISTINCT one —
 * claiming a single model would be wrong about the others. When no model is
 * known, which is the honest state for unpinned rules running on a provider's
 * own default, it falls back to the unadorned line rather than guessing.
 *
 * The spec is configuration rather than diff content, but it reaches a
 * world-readable comment, so it goes through the shared sanitizer like every
 * other interpolated value (ADR-006).
 */
export function botSignature(models?: readonly string[]): string {
  const distinct = [...new Set((models ?? []).map((model) => sanitizeInline(model).trim()))]
    .filter((model) => model.length > 0);
  if (distinct.length === 0) return BOT_SIGNATURE;
  const shown = distinct
    .slice(0, MAX_SIGNED_MODELS)
    .map((model) => model.length <= MAX_SIGNED_MODEL_CHARS
      ? model
      : `${model.slice(0, MAX_SIGNED_MODEL_CHARS - 1)}…`);
  const hidden = distinct.length - shown.length;
  const named = shown.map((model) => `\`${model}\``).join(", ")
    + (hidden > 0 ? ` +${hidden} more` : "");
  return `_🤖 Posted by [tGDBot](https://github.com/julianshen/tGDBot) using ${named}_`;
}

/** The model-aware signature as its own block. */
export function botSignatureBlock(models?: readonly string[]): string {
  return `---\n\n${botSignature(models)}`;
}

export interface InlineComment {
  clientId: string;
  /** Repo-relative path, as it appears on the NEW side of the diff. */
  path: string;
  /**
   * NEW-file line number the comment anchors to. For a multi-line committable
   * suggestion this is the LAST line of the provider-neutral range, with
   * `startLine` carrying the first. Guaranteed commentable (see diff-anchors).
   */
  line: number;
  /** First line of a multi-line range (ADR-007). Omitted for a single line. */
  startLine?: number;
  position: import("./diff-anchors.js").DiffPositionRange;
  body: string;
}

// A finding's severity drives the badge. These are the three values the JSON
// contract allows, so the map is total.
const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  blocking: "🔴 Blocking",
  warning: "🟠 Warning",
  suggestion: "🔵 Suggestion",
};

// Issue #38: how much work the fix is, as its own chip. Kept visually distinct
// from the severity badge so the two are never read as one grade — a heavy
// blocker is still a blocker.
const EFFORT_BADGE: Record<NonNullable<Finding["effort"]>, string> = {
  quick: "⚡ Quick fix",
  heavy: "🏗️ Heavy lift",
};

// `category` is free-form (rule authors pick it), so this is a best-effort
// prettifier with a neutral fallback — never a validation gate.
const CATEGORY_ICONS: { match: RegExp; icon: string }[] = [
  { match: /secur|vuln|inject|auth/i, icon: "🔒" },
  { match: /correct|bug|logic|race|concurren/i, icon: "🎯" },
  { match: /test|coverage/i, icon: "🧪" },
  { match: /perf|latency|memory/i, icon: "⚡" },
  { match: /read|maintain|style|clean|simplif/i, icon: "🧹" },
  { match: /doc/i, icon: "📝" },
];

function categoryBadge(category: string): string {
  const icon = CATEGORY_ICONS.find((c) => c.match.test(category))?.icon ?? "🏷️";
  return `${icon} ${category}`;
}

// Markdown/HTML hardening.
//
// Finding text is LLM output over an ATTACKER-CONTROLLED diff (reviewing the diff
// IS the job), and it now lands in a REVIEW comment on the diff — a surface with
// powers an issue comment does not have. The escalation that matters:
//
//   ```suggestion
//   <attacker code>
//   ```
//
// Review providers can render that as a committable suggestion with a one-click
// commit action when it appears in an inline diff comment. On a summary surface
// the same fence may be inert, but the shared formatter never relies on that.
// Moving untrusted finding text inline could otherwise turn prompt injection
// into one click from committing attacker-chosen code into the change branch.
// Neutralising the `suggestion` info-string is therefore not
// hardening-in-general; it closes a hole this very change would otherwise have
// opened.
//
// Code fences themselves are KEPT — findings legitimately contain ```go blocks and
// they are genuinely useful. Only the `suggestion` (and `suggestions`) info-string
// is defanged. Provider adapters remain responsible for their exact suggestion
// and position constraints.
// The prefix class covers blockquote/list markers too: a fence nested in `> ` or
// `- ` must be defanged as well — guarantee 1 is load-bearing enough that it must
// not rest on an unverified detail of how a provider parses nested fences.
const SUGGESTION_FENCE_RE = /^([ \t>*+\-]*(?:`{3,}|~{3,})[ \t]*)suggestions?\b/gim;

function sanitizeText(text: string): string {
  return text
    .replace(/<!--/g, "&lt;!--") // can't OPEN an HTML comment (would swallow the rest)
    // ...nor CLOSE one — our dedup marker is an HTML comment. HTML's error
    // tolerance also accepts `--!>` as a comment end, so the defang covers
    // both spellings, preserving the text verbatim up to the escaped `>`
    // (CodeQL js/bad-tag-filter).
    .replace(/--!?>/g, (match) => `${match.slice(0, -1)}&gt;`)
    .replace(/<\/?(?:details|summary|script|style|iframe|img|a)\b/gi, (m) => `&lt;${m.slice(1)}`)
    // A committable suggestion must never originate from finding text.
    .replace(SUGGESTION_FENCE_RE, "$1text")
    .replace(SIGNATURE_LOOKALIKE_RE, quoteSignatureLookalike)
    .trim();
}

// A finding whose text contains the signature renders it verbatim ABOVE the real
// one, so the comment appears to carry two — and the first one appears to end the
// tool's content, with attacker text below it reading as something else.
//
// Matches the rendered shape rather than one exact string, so dropping the
// italics or pointing the link elsewhere does not evade it. What it CANNOT do is
// stop an approximation ("🤖 Posted by tGDBot" as plain prose); free text can
// always be made to resemble a line of free text. That is why the signature is a
// courtesy label and never an authentication signal: what proves authorship is
// the verified account plus INLINE_COMMENT_MARKER, neither of which finding text
// can reach.
const SIGNATURE_LOOKALIKE_RE = /_?\s*🤖\s*Posted by\s*\[?tGDBot\]?(?:\([^)\n]*\))?\s*_?/giu;

// Rendered as an inline code span: the words survive, so a finding that
// legitimately quotes a signature still reads, but it can no longer be mistaken
// for the comment's own footer. The italic markers are dropped rather than
// escaped so the signature's exact byte sequence does not survive anywhere in
// the body — "how many signatures does this comment contain" then has one
// answer, countable by a test.
function quoteSignatureLookalike(match: string): string {
  const inner = match.replace(/[`\r\n]+/g, " ").replace(/^[\s_]+|[\s_]+$/gu, "");
  return `\`${inner}\``;
}

// Single-line fields (file, category, ruleName) are interpolated into a code span
// or an italic run. A backtick, newline, or pipe escapes that container and lets
// the value forge review structure — so collapse and strip rather than escape.
function sanitizeInline(value: string): string {
  return sanitizeText(value).replace(/[`|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

// The 🤖 prompt block wraps the message in a fence. If the message contains its
// own ``` run, a fixed 3-backtick fence is CLOSED by it — the block bleeds, the
// trailing </details> is swallowed, and the rest renders as markdown (a forged
// "## ✅ Approved" heading renders fine). Pick a fence longer than anything in the
// content, which is the standard CommonMark answer.
function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

// Maximum length of the bold headline. Past this it stops being scannable and
// becomes a wall of bold text — which is exactly what happened on the first live
// run, where a 175-char first sentence fell through the "short sentence" case
// and the WHOLE five-sentence finding was emitted as one bold blob.
const HEADLINE_MAX = 120;

/**
 * ADR-008: prefer the AUTHORED title.
 *
 * A headline is a title, and a title should be written, not guessed. When a rule
 * supplies one, use it and let the whole message be the prose. Only fall back to
 * deriving one from the first sentence when `title` is absent — which keeps every
 * pre-ADR-008 rule working unchanged.
 */
function resolveHeadline(finding: Finding, sanitizedMessage: string): { headline: string; body: string } {
  const title = finding.title ? sanitizeInline(finding.title) : "";
  if (!title) return splitHeadline(sanitizedMessage);

  // Guard the exact stutter ADR-008 exists to eliminate. The most natural thing a
  // model does is open `message` by restating the title — which would print the
  // same sentence twice, once in bold. If the message's first sentence IS the
  // title, drop it from the prose.
  const split = splitHeadline(sanitizedMessage);
  const sameSentence =
    split.headline && normalizeForCompare(split.headline) === normalizeForCompare(title);
  const body = sameSentence ? split.body : sanitizedMessage;

  return { headline: truncate(title, HEADLINE_MAX), body };
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[\s.!?]+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The fence `value` opens and never closes, under CommonMark rules.
 *
 * A closer must match the opener's character, be at least as long as the
 * opener's run, and carry no info string. A shorter or different-character run
 * inside a fence is CONTENT, not a closer — counting run parity instead let a
 * ``` line inside a ```` fence pass as balanced while the fence stayed open
 * (Codex review of PR #84, round two), and every later compact section then
 * rendered inside that block. A backtick run whose info string contains a
 * backtick is not a fence opener at all.
 *
 * `indent` is the opener line's leading whitespace: the synthetic closer must
 * repeat it, because a closer at column zero when the opener was indented as
 * list-item content leaves the list container — under CommonMark that ends
 * the nested block and the line opens a new ROOT-LEVEL fence instead (Codex
 * review of PR #84, round four).
 */
function unclosedFence(value: string): { char: string; length: number; indent: string } | undefined {
  let open: { char: string; length: number; indent: string } | undefined;
  for (const line of value.split("\n")) {
    const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) continue;
    const indent = match[1]!;
    const marker = match[2]!;
    const rest = match[3]!;
    if (open === undefined) {
      if (marker[0] === "`" && rest.includes("`")) continue;
      open = { char: marker[0]!, length: marker.length, indent };
    } else if (marker[0] === open.char && marker.length >= open.length && rest.trim() === "") {
      open = undefined;
    }
  }
  return open;
}

/**
 * Truncate prose that may quote a fenced code block, without leaving a fence
 * open (Codex review of PR #84, P2). Findings legitimately quote code; a naive
 * cut can keep the opening fence and drop its close, and every later compact
 * section — the host check, the references, the rules that failed — then
 * renders inside that code block.
 *
 * @param linePrefix - what the rendered first line already carries before the
 * text. A disputed item renders its message after the list-item text and em
 * dash, so a fence run opening the message's first line is MID-LINE — not a
 * fence at all. Balancing the message in isolation treated that run as an
 * opener, appended a "closer" that lands on a real line start, and THAT run
 * opened the fence that swallowed the later sections (Codex review of PR #84,
 * round three). The check therefore runs on the composed first line.
 *
 * Never exceeds the budget: an over-budget body is what pushes the summary
 * into the emergency form that drops the Disputed section wholesale, so the
 * close fence is bought by cutting the prose shorter, not by spending more.
 */
function truncateCompactProse(text: string, max: number, linePrefix = ""): string {
  if (max <= 0) return "";
  const first = truncate(text, max);
  // The prefix shares the first line only; the text's later lines stand alone,
  // so composing prefix + candidate reproduces the rendered shape exactly.
  const open = unclosedFence(`${linePrefix}${first}`);
  if (open === undefined) return first;
  // The closer repeats the opener's indentation: a column-zero closer when the
  // opener was indented as list-item content leaves the list container and
  // opens a root-level fence instead of closing the nested one.
  const close = `${open.indent}${open.char.repeat(open.length)}`;
  const retry = truncate(text, max - close.length - 1);
  return unclosedFence(`${linePrefix}${retry}`) === undefined ? retry : `${retry}\n${close}`;
}

function splitHeadline(message: string): { headline: string; body: string } {
  const trimmed = message.trim();

  const sentence = /^(.+?[.!?])(?:\s+(.+))?$/s.exec(trimmed);
  const first = sentence?.[1]?.trim() ?? trimmed;
  const rest = sentence?.[2]?.trim() ?? "";

  // A headline is a single bold LINE: newlines and list markup inside it produce
  // literal `**` and a mangled list on common review renderers.
  const oneLine = first.replace(/\s+/g, " ").trim();

  // Too long to be a title? Then there IS no title. Truncating it and printing the
  // same sentence two lines below reads as a stutter, and the `…` promises
  // information that is then simply... there.
  if (oneLine.length > HEADLINE_MAX) return { headline: "", body: trimmed };

  return { headline: oneLine, body: rest };
}

/**
 * One inline review comment for a finding, anchored to its line.
 *
 * The `🤖 Prompt for AI Agents` block is the highest-leverage part: it gives a
 * coding agent (or the author) a self-contained, copy-pasteable instruction that
 * already names the file and line, so acting on the finding doesn't require
 * re-deriving the context.
 */
export function renderInlineComment(
  finding: Finding,
  options: RenderOptions & { alsoReported?: readonly Finding[]; rules?: readonly string[] } = {},
): string {
  const full = sanitizeText(finding.message);
  const file = sanitizeInline(finding.file);
  const { headline, body } = resolveHeadline(finding, full);
  const lineRef = typeof finding.line === "number" ? ` around line ${finding.line}` : "";

  // Exactly ONE of these shapes — never the message twice:
  //   headline + body : a short first sentence as the title, the rest as prose
  //   headline only   : the finding IS one short sentence
  //   prose only      : no sentence short enough to be a title (see splitHeadline)
  const parts = [metaLine(finding, options.rules), ""];
  if (headline) {
    parts.push(`**${headline}**`);
    if (body) parts.push("", body);
  } else {
    parts.push(full);
  }

  // ADR-007. Only ever from the structured field — never from `message`.
  const suggestion = emitsSuggestion(finding) ? capSuggestion(finding.suggestion!) : undefined;
  if (suggestion) {
    // `--suggestions off` DOWNGRADES to a plain, non-committable block. It must not
    // delete the fix: the reviewer who picked the safe mode is the last person who
    // should lose information (caught in review — the first draft dropped it).
    parts.push("", renderSuggestionBlock(suggestion, options.suggestions !== false));
  }

  // Issue #75. Rendered as a blockquote, immediately under the finding it
  // qualifies, and worded so the HOST is the subject of every sentence: this is
  // the one line in a finding a reader is invited to trust without re-deriving
  // it, so it must be unmistakably not the reviewer talking about itself.
  const hostCheck = renderHostCheck(finding);
  if (hostCheck) parts.push("", hostCheck);

  const citations = emitsReferences(finding) ? renderReferences(finding) : undefined;
  if (citations) parts.push("", citations);
  if (options.alsoReported && options.alsoReported.length > 0) {
    parts.push("", renderAlsoReported(options.alsoReported));
  }

  const prompt = `In \`${file}\`${lineRef}: ${full}\n\nFix only this issue, keep the change minimal, and make sure the tests still pass.`;
  const fence = fenceFor(prompt);

  parts.push(
    "",
    "<details>",
    "<summary>🤖 Prompt for AI Agents</summary>",
    "",
    fence,
    prompt,
    fence,
    "",
    "</details>",
    "",
    // The visible half of "this was written by the tool", naming the model that
    // wrote it. Before the machine marker, because the marker (and any finding
    // marker after it) must stay the last line: recovery reads exactly that
    // line back.
    botSignatureBlock(options.models),
    "",
    // Appended AFTER all sanitized content, like the summary's dedup marker —
    // this is what lets resolveStaleReviewThreads recognize the tool's own
    // threads without touching a same-account human's comments.
    INLINE_COMMENT_MARKER,
    ...(options.findingMarker ? [options.findingMarker] : []),
  );

  return parts.join("\n");
}

function metaLine(finding: Finding, contributingRules?: readonly string[]): string {
  // When several rules independently found ONE defect, the interesting fact is
  // that corroboration — not which rule happened to win the representative slot.
  const rules =
    contributingRules && contributingRules.length > 1
      ? `${contributingRules.map((rule) => `\`${sanitizeInline(rule)}\``).join(", ")} (${contributingRules.length} rules)`
      : `\`${sanitizeInline(finding.ruleName)}\``;
  // Omitted entirely when the rule gave no estimate, so output that predates
  // the field — or a rule that declines to guess — renders exactly as before.
  const effort = finding.effort === undefined ? "" : `_${EFFORT_BADGE[finding.effort]}_ | `;
  return `_${categoryBadge(sanitizeInline(finding.category))}_ | _${SEVERITY_BADGE[finding.severity]}_ | ${effort}_${rules}_`;
}

export interface RenderOptions {
  /**
   * ADR-007: whether to render committable ```suggestion blocks. `--suggestions
   * off` turns them into plain, non-committable code blocks for repos that don't
   * want a one-click commit path from LLM-authored text.
   */
  suggestions?: boolean;
  /** Versioned finding marker storing IDs and digests only. */
  findingMarker?: string;
  /**
   * Resolved `provider/model` specs the rules ran on.
   *
   * Named in the signature, so a reader can tell what produced a finding they
   * disagree with without digging through CI logs. Absent when nothing
   * resolved, which leaves the unadorned signature.
   */
  models?: readonly string[];
}

/**
 * ADR-007: a provider-native committable suggestion on the anchored line range.
 *
 * THE SECURITY BOUNDARY. ADR-006 deliberately defangs any ```suggestion fence
 * appearing in free-text `message`, because that text is LLM output over an
 * ATTACKER-CONTROLLED diff and prompt injection could otherwise mint a
 * committable block. This function is the ONLY place a real one can be created,
 * and it can only be reached from the structured, validated `suggestion` field:
 *
 *  - the fence is sized longer than any backtick run INSIDE the suggestion, so
 *    the content cannot close it early and inject markdown/HTML around the block;
 *  - the content is emitted verbatim and never sanitized, because it is CODE
 *    destined for the file — escaping it would corrupt what gets committed. It is
 *    inert: everything between the fences is literal, and the Git provider/UI
 *    applies it to the anchored line range according to provider constraints;
 *  - the explicit warning below is not decoration. A suggestion is the one thing
 *    this tool emits that a human can accept without reading the reasoning.
 */
function renderSuggestionBlock(suggestion: string, committable: boolean): string {
  const fence = fenceFor(suggestion);
  const body = suggestion.replace(/\s+$/, "");
  if (!committable) {
    return [
      "<details>",
      "<summary>💡 Proposed fix (not committable)</summary>",
      "",
      `${fence}text`,
      body,
      fence,
      "",
      "</details>",
    ].join("\n");
  }
  return [
    "<details>",
    "<summary>📝 Committable suggestion</summary>",
    "",
    "> ‼️ **IMPORTANT**",
    "> Review this carefully before committing. It is generated from an automated",
    "> review of an untrusted diff — make sure it replaces exactly the highlighted",
    "> lines, is complete, is correctly indented, and actually does what you want.",
    "",
    `${fence}suggestion`,
    body,
    fence,
    "",
    "</details>",
  ].join("\n");
}

// Providers cap comment bodies. An unbounded suggestion can make inline
// publishing fail and force findings back to the summary. Cap it rather than
// gamble the review.
const SUGGESTION_MAX = 8000;
const SUMMARY_COMMENT_MAX = 60_000;
function capSuggestion(suggestion: string): string | undefined {
  return suggestion.length > SUGGESTION_MAX ? undefined : suggestion;
}

/** Presentation extras attached to one finding in a fallback section. */
export interface FindingContext {
  /** The diff excerpt around the finding, recovering the context inline gives free. */
  readonly snippet?: HunkSnippet;
  /** Every rule that reported this root cause, when clustering merged several. */
  readonly rules?: readonly string[];
  /**
   * Why THIS finding's inline comment was rejected. Bisection isolates comments
   * that can fail for different statuses at different paths, and GitLab rejects
   * discussions independently — so one section-level reason would misdescribe
   * most of them (Codex review of PR #23).
   */
  readonly publishFailureReason?: string;
  /**
   * The other members of this finding's cluster. Clustering keeps ONE entry per
   * root cause, and these must still be rendered: a merge is a judgement call
   * made by a similarity heuristic, and silently deleting the losing member's
   * text would turn a presentation choice into data loss. (Codex review of
   * PR #23, P1 — the invariant was documented but never actually honoured.)
   */
  readonly alsoReported?: readonly Finding[];
}

export interface ClarificationPresentation {
  readonly id: string;
  readonly question: string;
  readonly finding: Finding;
  readonly publishedUrl?: string;
  readonly publicationPending?: boolean;
}

export interface SummaryInput {
  /** Every deduped finding (inline + unanchored) — used for the severity counts. */
  allFindings: Finding[];
  /** Findings that WERE posted inline — counted, not repeated, in the summary. */
  inlineCount: number;
  /** Findings that could NOT be anchored to the diff; rendered in full here. */
  unanchored: Finding[];
  /**
   * Findings whose anchors WERE valid but whose inline publication the provider
   * rejected. Kept apart from `unanchored` because merging them (as this code
   * used to) makes the summary blame the diff for a provider failure — the
   * reader then goes looking for a bad line number that does not exist.
   */
  publishFailed?: Finding[];
  /** The provider's own reason, so a rejection is diagnosable from the comment. */
  publishFailureReason?: string;
  /** Distinct root causes across `allFindings` (see finding-clusters). */
  uniqueIssueCount?: number;
  /**
   * Findings BEFORE clustering. The rendered entries are one per root cause, so
   * without this the headline could only report the post-clustering number and
   * "14 findings · 9 unique issues" would be unsayable.
   */
  findingCount?: number;
  /**
   * Per-finding presentation extras, keyed by finding IDENTITY — the same object
   * references that appear in `unanchored`/`publishFailed`. Identity keying
   * avoids inventing a synthetic key that two findings on one line would share.
   */
  context?: ReadonlyMap<Finding, FindingContext>;
  filesReviewed: string[];
  rulesRun: string[];
  rulesFailed: string[];
  ruleFailureReasons?: Record<string, string>;
  scanCoverage?: ScanCoverage;
  relatedWork?: readonly RelatedWorkItem[];
  /** Bounded summaries of human-authored active review discussion. */
  discussionMemories?: readonly DiscussionMemory[];
  /**
   * True when inline posting was unavailable (e.g. the reviews API call failed).
   * The summary then carries EVERY finding, so a finding is never lost — it is
   * only ever relocated.
   */
  inlineUnavailable?: boolean;
  /** The single active clarification question, if any. Not a defect. */
  clarification?: ClarificationPresentation;
  /** Other clarification candidates held back for later. */
  deferredClarificationCount?: number;
  /** Non-actionable discussion status. */
  disputed?: readonly Finding[];
  /** Which kinds of context this run went without. See `ContextUnavailableLabel`. */
  contextUnavailable?: readonly ContextUnavailableLabel[];
}

function canonicalRelatedWorkReference(value: unknown): RelatedWorkReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const provider = item.provider;
  const host = item.host;
  const projectPath = item.projectPath;
  const number = item.number;
  const kindHint = item.kindHint;
  if ((provider !== "github" && provider !== "gitlab") || typeof host !== "string" ||
      typeof projectPath !== "string" || !isValidRelatedWorkProjectPath(provider, projectPath) ||
      typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (kindHint !== undefined && kindHint !== "issue" && kindHint !== "pull_request" && kindHint !== "merge_request") return undefined;
  if ((provider === "github" && kindHint === "merge_request") || (provider === "gitlab" && kindHint === "pull_request")) return undefined;
  let authority: URL;
  try { authority = new URL(`https://${host}${typeof item.port === "string" ? `:${item.port}` : ""}/`); } catch { return undefined; }
  if (authority.hostname.toLowerCase() !== host.toLowerCase() || authority.username || authority.password) return undefined;
  const sigil = kindHint === "merge_request" ? "!" : "#";
  const localIdentifier = `${sigil}${number}`;
  const crossIdentifier = `${projectPath}${sigil}${number}`;
  if (item.identifier !== localIdentifier && item.identifier !== crossIdentifier) return undefined;
  return {
    provider, host: host.toLowerCase(),
    ...(typeof item.port === "string" && item.port ? { port: item.port } : {}),
    projectPath, number, ...(kindHint ? { kindHint } : {}), sourceText: "", identifier: item.identifier,
    ...(typeof item.fallbackUrl === "string" ? { fallbackUrl: item.fallbackUrl } : {}),
  };
}

function escapeMarkdownText(value: string): string {
  return sanitizeText(value).replace(/([\\`*_[\]{}()<>#+|~])/g, "\\$1");
}

function kindLabel(kind: RelatedWorkKind): string {
  return kind === "issue" ? "Issue" : kind === "pull_request" ? "PR" : "MR";
}

function renderRelatedWorkItem(value: unknown): string | undefined {
  try {
    const reference = canonicalRelatedWorkReference(value);
    if (!reference) return undefined;
    const validated = validateResolvedRelatedWork(reference, value);
    const resolved = validated.url && validated.kind ? validated : undefined;
    const fallbackKind = reference.kindHint ?? "issue";
    const fallback = reference.fallbackUrl
      ? validateResolvedRelatedWork(reference, { kind: fallbackKind, url: reference.fallbackUrl }).url
      : undefined;
    const url = resolved?.url ?? fallback;
    const identifier = reference.identifier;
    const label = resolved ? `${kindLabel(resolved.kind!)} ${identifier}` : identifier;
    const main = url ? `[${label}](${url})` : escapeMarkdownText(label);
    if (!resolved?.title) return main;
    const state = resolved.state ? ` (${resolved.state})` : "";
    return `${main} — ${escapeMarkdownText(resolved.title)}${state}`;
  } catch {
    return undefined;
  }
}

export function normalizeRelatedWorkForRender(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    const rendered = renderRelatedWorkItem(item);
    return rendered ? [rendered] : [];
  });
}

// The diff excerpt is the whole point of the fallback rendering: an inline
// comment gets the provider's own code context for free, and a finding pushed
// into the summary otherwise becomes an assertion about code the reader has to
// go and look up. Rendered as ```diff so +/- lines keep their colouring.
//
// The excerpt comes from the diff we already fetched, NOT from finding text, so
// it needs no sanitizing for injection — but it is fenced with a run longer than
// any inside it for the same reason renderSuggestionBlock is: a crafted source
// line containing ``` must not be able to close the block early and let the rest
// render as markdown.
function renderDiffExcerpt(snippet: HunkSnippet): string {
  const body = snippet.lines.map((line) => `${line.marker}${line.text}`).join("\n");
  const longestRun = Math.max(2, ...[...body.matchAll(/`+/gu)].map((m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}diff\n${body}\n${fence}`;
}

// Collapsed so one entry stays scannable, present so nothing is lost.
/**
 * Issue #49: the documentation a finding rests on, so a reader can check the
 * claim rather than take it. Already validated against the rule's own text on
 * parse, so nothing here can be a model invention.
 */
/**
 * Whether an inline comment for this finding carries a suggestion block.
 *
 * THE predicate, consulted by `renderInlineComment` and by the digest's legend
 * alike (issue #55). A legend built from a separate prose list describes what
 * someone remembered to write down; one built from this describes what the
 * renderer actually emits, and stops describing it the moment that changes.
 */
export function emitsSuggestion(finding: Finding): boolean {
  return Boolean(finding.suggestion?.trim());
}

/** Whether an inline comment for this finding carries a Reference block. */
export function emitsReferences(finding: Finding): boolean {
  return finding.references !== undefined && finding.references.length > 0;
}

/**
 * The host's answer to a claim the reviewer made, or nothing.
 *
 * `describeCheck` owns the wording — in particular that a clean result says
 * what was searched rather than "there are no callers". Sanitized like every
 * other interpolated value: the symbol reaches here from reviewer output, and
 * although `parseStructuralClaim` already constrains it to an identifier, the
 * escape is a property of the container rather than of the source.
 */
function renderHostCheck(finding: Finding): string | undefined {
  if (finding.claim === undefined || finding.hostCheck === undefined) return undefined;
  return `> ${describeCheck(finding.claim, finding.hostCheck, sanitizeInline)}`;
}

function renderReferences(finding: Finding): string | undefined {
  if (!finding.references || finding.references.length === 0) return undefined;
  const items = finding.references

    .map((url) => `- ${sanitizeInline(url)}`);
  return [`**Reference**`, "", ...items].join("\n");
}

/**
 * The same citations, as sub-bullets, for a finding rendered as a LIST ENTRY.
 *
 * A merged member and a disputed finding are one line each, so the standalone
 * `**Reference**` block would break the list. Dropping them instead — which is
 * what happened until PR #54's review — asks the reader to weigh a claim while
 * the evidence for it sits one layer up, unrendered.
 */
/**
 * The longest citation compact mode will print.
 *
 * Well under the 2,000 characters parsing accepts: this is a size fallback, and
 * a URL long enough to matter against the budget is omitted and declared rather
 * than cut down into something that no longer resolves.
 */
const MAX_COMPACT_REFERENCE_CHARS = 200;

/**
 * The longest disputed message compact mode will REQUEST.
 *
 * A ceiling on demand, not a guarantee of supply: the request goes through the
 * shared compact allocator (see `renderCompactSummary`), so a dispute gets 240
 * characters only when there is room. Stated once because a rule expressed in
 * two places eventually disagrees with itself.
 */
const MAX_COMPACT_DISPUTED_MESSAGE_CHARS = 240;

/**
 * The compact budget: the first citation, and only if it fits WHOLE.
 *
 * The single definition on purpose. It was briefly stated twice — once for
 * rendering and once for the omission counter — and a rule expressed in two
 * places is a rule that will eventually disagree with itself, which here means
 * the notice denying a shortfall that happened.
 */
function compactShownReference(finding: Finding): string | undefined {
  const first = finding.references?.[0];
  return first !== undefined && first.length <= MAX_COMPACT_REFERENCE_CHARS ? first : undefined;
}

/** How many of a finding's citations compact mode cannot show. */
function compactUnshownCount(finding: Finding): number {
  return (finding.references?.length ?? 0) - (compactShownReference(finding) === undefined ? 0 : 1);
}

function compactReferenceBullets(finding: Finding, indent: string): string[] {
  const shown = compactShownReference(finding);
  return shown === undefined ? [] : [`${indent}- Reference: ${sanitizeInline(shown)}`];
}

/**
 * The host's answer to a claim, as an indented bullet for a list-shaped section.
 *
 * This is the SIXTH rendering path to need it (Codex review, round 5 — the
 * disputed section). Each earlier fix patched the site that had been named, and
 * a new one surfaced next round; enumerating them is evidently not how this
 * converges. So it is a shared helper rather than a sixth inline copy: a
 * bulleted section that renders a finding gets the check by calling one
 * function, and the wording cannot drift between them.
 *
 * Empty unless BOTH halves are present. A claim without the host's answer
 * renders nothing at all — publishing the reviewer's raw assertion beside
 * host-authored prose is the confusion the reviewer/host split exists to avoid.
 */
function hostCheckBullets(finding: Finding, indent: string, compact: boolean): string[] {
  if (finding.claim === undefined || finding.hostCheck === undefined) return [];
  return [`${indent}- ${compact
    ? describeCheckCompact(finding.hostCheck, sanitizeInline)
    : describeCheck(finding.claim, finding.hostCheck, sanitizeInline)}`];
}

function referenceBullets(finding: Finding, indent: string): string[] {
  if (!finding.references || finding.references.length === 0) return [];
  return finding.references
    .map((url) => `${indent}- Reference: ${sanitizeInline(url)}`);
}

function renderAlsoReported(members: readonly Finding[]): string {
  const items = members.flatMap((member) => {
    const rule = sanitizeInline(member.ruleName);
    const loc = typeof member.line === "number" ? `:${member.line}` : "";
    const line = `- **\`${rule}\`**${loc}: ${sanitizeText(member.message)}`;
    // A member carries structured content beyond its prose. Dropping its
    // `suggestion` would leave the data-loss fix half done — so the fix is
    // shown, always NON-committable: a merged member is a similarity judgement,
    // and a one-click commit should never rest on one.
    const suggestion = member.suggestion?.trim() ? capSuggestion(member.suggestion) : undefined;
    const cited = referenceBullets(member, "  ");
    // A merged member's own structural claim keeps its own answer. Rendering
    // the representative's check alone published every other member's
    // assertion unqualified — the same defect as the relocated path, one level
    // down (Codex review, round 2).
    const check = hostCheckBullets(member, "  ", true);
    return suggestion === undefined
      ? [line, ...check, ...cited]
      : [line, ...check, ...cited, "", renderSuggestionBlock(suggestion, false), ""];
  });
  return detailsBlock(
    `Also reported by ${members.length} other rule${members.length === 1 ? "" : "s"}`,
    items,
  );
}

function renderUnanchoredFinding(
  finding: Finding,
  includeSuggestion = true,
  context?: FindingContext,
): string {
  const file = sanitizeInline(finding.file);
  const snippet = context?.snippet;
  // A finding whose excerpt spans several lines names the range, so the heading
  // matches what the reader is about to see rather than a single line inside it.
  const lineLabel =
    snippet && snippet.endLine > snippet.startLine
      ? `${snippet.startLine}-${snippet.endLine}`
      : typeof finding.line === "number"
        ? String(finding.line)
        : undefined;
  const loc = lineLabel === undefined ? file : `${file}:${lineLabel}`;
  const full = sanitizeText(finding.message);
  const { headline, body } = resolveHeadline(finding, full);

  const parts = [`**\`${loc}\`**`, "", metaLine(finding, context?.rules), ""];
  if (context?.publishFailureReason) {
    parts.push(`> ${sanitizeInline(context.publishFailureReason)}`, "");
  }
  if (snippet) parts.push(renderDiffExcerpt(snippet), "");
  if (headline) {
    parts.push(`**${headline}**`);
    if (body) parts.push("", body);
  } else {
    parts.push(full);
  }
  const suggestion = finding.suggestion?.trim() ? capSuggestion(finding.suggestion) : undefined;
  if (suggestion) {
    parts.push(
      "",
      includeSuggestion
        ? renderSuggestionBlock(suggestion, false)
        : "> Proposed fix omitted because the summary size budget was exhausted.",
    );
  }
  // Issue #75, review round 1: a finding without a commentable line is
  // RELOCATED here rather than posted inline, and rendering the check only in
  // the inline path silently dropped it — publishing the reviewer's claim with
  // the host's answer to it removed. A contradiction that goes missing is the
  // worst version of that: the reader sees an unchallenged assertion the host
  // had already disproved.
  const hostCheck = renderHostCheck(finding);
  if (hostCheck) parts.push("", hostCheck);

  const references = renderReferences(finding);
  if (references) parts.push("", references);
  if (context?.alsoReported && context.alsoReported.length > 0) {
    parts.push("", renderAlsoReported(context.alsoReported));
  }
  return parts.join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The headline, which has to survive being the ONLY line a busy reader reads.
 *
 * "Actionable comments posted: 14" counted findings, not comments, and PR #281
 * printed it while zero review comments existed on the PR. Three separate
 * numbers are reported instead, because they answer three different questions:
 * how much was found, how much of it is actually distinct, and how much of it
 * the reader will find sitting on the diff.
 *
 * The unique-issue count is omitted when clustering merged nothing — "8 findings
 * · 8 unique issues" is a fact about the renderer, not about the review.
 */
function summaryHeadline(input: SummaryInput, total: number): string {
  const findings = input.findingCount ?? total;
  const segments = [plural(findings, "finding")];
  if (input.uniqueIssueCount !== undefined && input.uniqueIssueCount < findings) {
    segments.push(plural(input.uniqueIssueCount, "unique issue"));
  }
  segments.push(`${plural(input.inlineCount, "inline comment")} posted`);
  return segments.join(" · ");
}

// The number that decides whether a reviewer reads this now or later.
function severityCounts(input: SummaryInput): string {
  const counts = { blocking: 0, warning: 0, suggestion: 0 };
  for (const f of input.allFindings) counts[f.severity] += 1;
  const shown = [
    counts.blocking > 0 ? `🔴 ${counts.blocking} blocking` : "",
    counts.warning > 0 ? `🟠 ${counts.warning} warning` : "",
    counts.suggestion > 0 ? `🔵 ${counts.suggestion} suggestion` : "",
  ].filter(Boolean);
  return shown.length > 0 ? ` — ${shown.join(" · ")}` : "";
}

function detailsBlock(summary: string, lines: string[]): string {
  return ["<details>", `<summary>${summary}</summary>`, "", ...lines, "", "</details>"].join("\n");
}

function renderRelatedWorkSection(input: SummaryInput): string | undefined {
  const relatedWork = normalizeRelatedWorkForRender(input.relatedWork ?? []);
  return relatedWork.length > 0
    ? `### Related work\n\n${relatedWork.map((item) => `- ${item}`).join("\n")}`
    : undefined;
}

function safeDiscussionUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && !/[\s)]/u.test(url)
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function renderDiscussionMemorySection(input: SummaryInput): string | undefined {
  const memories = input.discussionMemories ?? [];
  if (memories.length === 0) return undefined;
  const items = memories.map((memory) => {
    const location = memory.file === undefined
      ? "`general discussion`"
      : `\`${sanitizeInline(memory.file)}${memory.line === undefined ? "" : `:${memory.line}`}\``;
    const author = `@${sanitizeInline(memory.author)}`;
    const summary = sanitizeInline(memory.summary);
    const url = safeDiscussionUrl(memory.url);
    const source = url === undefined ? "" : ` ([thread](${url}))`;
    return `- ${location} — ${author}: ${summary}${source}`;
  });
  return [
    "### Local review memory",
    "",
    "_Existing unresolved review discussion is retained here and is not reposted as new findings._",
    "",
    ...items,
  ].join("\n");
}

/**
 * The kinds of context a review can go without, named once so the producer and
 * this consumer cannot drift apart. They were two bare literals in two files
 * before: a typo at either end silently dropped the note from the summary, and
 * nothing failed — the operator simply never learned the review had run blind.
 * As a union, the same typo is a compile error.
 */
export type ContextUnavailableLabel = "discussion" | "memory" | "repository";

function renderContextUnavailable(input: SummaryInput): string | undefined {
  const labels = input.contextUnavailable ?? [];
  const notes = [
    labels.includes("discussion")
      ? "> Discussion context was unavailable for this run. The review used the diff and trusted rules only."
      : undefined,
    labels.includes("memory")
      ? "> Memory context was unavailable for this run."
      : undefined,
    labels.includes("repository")
      ? "> Repository context was unavailable for this run. The review used the diff and trusted rules only, without the trusted-base map of the surrounding code."
      : undefined,
  ].filter((note): note is string => note !== undefined);
  if (notes.length === 0) return undefined;
  return `> [!NOTE]\n${notes.join("\n")}`;
}

function safeClarificationUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
    if (/[\s)]/u.test(url)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function renderClarificationSection(input: SummaryInput): string | undefined {
  if (input.clarification === undefined) return undefined;
  const question = sanitizeText(input.clarification.question);
  const id = sanitizeInline(input.clarification.id);
  const deferred = input.deferredClarificationCount ?? 0;
  const deferredLine =
    deferred === 1
      ? "_1 additional clarification deferred._"
      : deferred > 1
        ? `_${deferred} additional clarifications deferred._`
        : undefined;
  const publishedUrl = safeClarificationUrl(input.clarification.publishedUrl);
  const publicationLine = publishedUrl !== undefined
    ? `[Open the question](${publishedUrl})`
    : input.clarification.publicationPending === true
      ? "_Publication is pending._"
      : undefined;
  return [
    "### Needs clarification",
    "",
    question,
    "",
    `\`answer ${id}: <your answer>\``,
    ...(publicationLine === undefined ? [] : ["", publicationLine]),
    ...(deferredLine === undefined ? [] : ["", deferredLine]),
  ].join("\n");
}

/**
 * @param compact - apply the compact citation budget: one per finding, only if
 * it fits whole. Compact mode reused this renderer at full length, so enough
 * disputed citations kept the compact body oversized, dropped it into the
 * emergency status-only form, and took the whole disputed section with it —
 * silently (PR #54 review, round six).
 * @param messageBudgets - per-finding message allowance in compact mode, from
 * the shared compact allocator. Absent entries fall back to
 * `MAX_COMPACT_DISPUTED_MESSAGE_CHARS`. Ignored when `compact` is false.
 */
function renderDisputedSection(
  input: SummaryInput,
  compact = false,
  messageBudgets?: readonly number[],
): string | undefined {
  const disputed = input.disputed ?? [];
  if (disputed.length === 0) return undefined;
  const items = disputed.flatMap((finding, index) => {
    const file = sanitizeInline(finding.file);
    const loc = typeof finding.line === "number" ? `${file}:${finding.line}` : file;
    // The head shares the message's first rendered line: `- \`loc\` (\`rule\`) — `.
    // Truncation must balance fences against THIS line, not the message alone —
    // a fence run opening the message is mid-line here and therefore not a
    // fence at all (Codex review of PR #84, round three).
    const head = `- \`${loc}\` (\`${sanitizeInline(finding.ruleName)}\`) — `;
    const message = compact
      ? truncateCompactProse(sanitizeText(finding.message), messageBudgets?.[index] ?? MAX_COMPACT_DISPUTED_MESSAGE_CHARS, head)
      : sanitizeText(finding.message);
    // A disputed finding is precisely the one whose evidence a reader needs —
    // which is why the host check belongs here most of all. A finding the
    // reviewer itself marked disputed, published with the host's answer to its
    // structural claim removed, leaves the reader the weakest version of both.
    return [
      `${head}${message}`,
      ...hostCheckBullets(finding, "  ", compact),
      ...(compact
        ? compactReferenceBullets(finding, "  ")
        : referenceBullets(finding, "  ")),
    ];
  });
  return `### Disputed\n\n${items.join("\n")}`;
}


/**
 * Issue #48: one defect spread across several files arrives as several inline
 * comments, each correct and each looking unrelated. They stay where they are —
 * an inline comment belongs on the file it is about — and the RELATIONSHIP is
 * named here instead.
 *
 * Pointers, never prose. Every member is already posted inline or rendered
 * below, so repeating its text would undo the "counted, not repeated" property
 * the summary depends on. A reader gets "these are one problem" and where to
 * look.
 */
/** A finding's one-line claim: its authored title, else its first sentence. */
function claimOf(finding: Finding): string {
  const title = finding.title?.trim();
  if (title) return title;
  return /^(.*?[.!?])(?:\s|$)/su.exec(finding.message.trim())?.[1] ?? finding.message;
}

function renderCrossFileGroupsSection(input: SummaryInput): string | undefined {
  const groups = crossFileGroups(input.allFindings);
  if (groups.length === 0) return undefined;
  const rendered = groups.map((group: import("./finding-clusters.js").FindingCluster) => {
    const headline = truncate(
      sanitizeInline(claimOf(group.representative)),
      160,
    );
    const members = group.members.map((member: Finding) => {
      const loc = typeof member.line === "number"
        ? `${sanitizeInline(member.file)}:${member.line}`
        : sanitizeInline(member.file);
      const rule = sanitizeInline(member.ruleName);
      const claim = truncate(
        sanitizeInline(claimOf(member)),
        120,
      );
      return `  - \`${loc}\` (\`${rule}\`) — ${claim}`;
    });
    return [`- **${headline}**`, ...members].join("\n");
  });
  return [
    `### 🔗 Findings that share one root cause (${groups.length})`,
    "",
    "These are reported separately above, on the files they affect. Listed here",
    "because they appear to be one problem seen from several places.",
    "",
    ...rendered,
  ].join("\n");
}

export function renderSummaryComment(
  input: SummaryInput,
  maxLength = SUMMARY_COMMENT_MAX,
): string {
  const includedSuggestions = new Set<Finding>();
  let best = renderSummaryCommentWithIncludedSuggestions(input, includedSuggestions);
  if (best.length > maxLength) return renderCompactSummary(input, maxLength);

  // BOTH relocated groups are charged against the budget. Previously only
  // `unanchored` was, while publication failures rendered their fixes
  // unconditionally — so one large suggestion on a rejected finding could push
  // the render over the limit and drop the whole thing into compact mode, which
  // loses every excerpt and every fix.
  for (const finding of [...input.unanchored, ...(input.publishFailed ?? [])]) {
    if (!finding.suggestion?.trim() || !capSuggestion(finding.suggestion)) continue;
    includedSuggestions.add(finding);
    const candidate = renderSummaryCommentWithIncludedSuggestions(input, includedSuggestions);
    if (candidate.length <= maxLength) {
      best = candidate;
    } else {
      includedSuggestions.delete(finding);
    }
  }
  return best;
}

// The reason may arrive as ONE shared string or as a per-finding value on each
// context. Compact mode read only the shared field, so the normal mapped-reason
// path kept the failure label and lost every diagnosis (Codex review).
function compactFailureReasons(input: SummaryInput, failed: ReadonlySet<Finding>): string {
  if (input.publishFailureReason) {
    return `: ${truncate(sanitizeInline(input.publishFailureReason), 240)}`;
  }
  const distinct = [...new Set(
    [...failed]
      .map((finding) => input.context?.get(finding)?.publishFailureReason)
      .filter((value): value is string => value !== undefined),
  )];
  if (distinct.length === 0) return ".";
  // Bounded like every other compact field: a handful of reasons, each capped.
  const shown = distinct.slice(0, 3).map((reason) => truncate(sanitizeInline(reason), 160));
  const more = distinct.length > shown.length ? ` (+${distinct.length - shown.length} more)` : "";
  return `:\n> ${shown.map((reason) => `- ${reason}`).join("\n> ")}${more}`;
}

function renderScanCoverage(coverage: ScanCoverage | undefined): string | undefined {
  if (coverage === undefined || coverage.completeness === "complete") return undefined;
  return `> [!WARNING]\n> Codex Security coverage is **${coverage.completeness}** (` +
    `${coverage.deferredCount} deferred, ${coverage.droppedFindings} unmappable); ` +
    "absence of security findings is not an all-clear.";
}

function renderCompactSummary(input: SummaryInput, maxLength: number): string {
  // Compact mode must carry the SAME finding set as the full renderer — it is a
  // size fallback, not a scope fallback. Publication failures were previously
  // absent from this list because they only ever reached it via `unanchored`;
  // now that they are their own group they must be appended explicitly, or a
  // long review would silently drop them.
  const relocated = [...input.unanchored, ...(input.publishFailed ?? [])].flatMap(
    (finding) => [finding, ...(input.context?.get(finding)?.alsoReported ?? [])],
  );
  const header =
    `**${summaryHeadline(input, input.inlineCount + relocated.length)}**` +
    `${severityCounts(input)}`;
  const publishFailedSet = new Set(input.publishFailed ?? []);
  // Every finding compact mode renders, not just the relocated ones. Disputed
  // entries take the same budget, so leaving them out of the count made the
  // notice deny a shortfall that had actually happened.
  const unshownReferences = [...relocated, ...(input.disputed ?? [])]
    .reduce((total, finding) => total + compactUnshownCount(finding), 0);
  const notice =
    "> [!WARNING]\n" +
    "> Review details were compacted to fit the provider limit; proposed fixes were omitted." +
    // Compact mode is a SIZE fallback, not an ATTRIBUTION fallback: a large
    // review must not lose WHY its findings are not inline (Codex review of
    // PR #23, P2). The reason is bounded like every other compact field.
    (publishFailedSet.size > 0
      ? `\n> ${publishFailedSet.size} inline comment(s) had valid anchors but publication failed` +
        compactFailureReasons(input, publishFailedSet)
      : "") +
    (unshownReferences > 0
      ? `\n> ${unshownReferences} further reference(s) omitted; one is shown per finding`
      : "");
  const contextUnavailable = renderContextUnavailable(input);
  const scanCoverage = renderScanCoverage(input.scanCoverage);
  const clarification = renderClarificationSection(input);
  const disputedFindings = input.disputed ?? [];
  const failedRules = input.rulesFailed.length > 0
    ? `### ⚠️ Rules that failed (${input.rulesFailed.length})\n\n${input.rulesFailed
        .map((name) => {
          const label = `* \`${truncate(sanitizeInline(name), 80)}\``;
          const reason = input.ruleFailureReasons?.[name];
          return reason
            ? `${label} — ${truncate(sanitizeInline(reason), 240)}`
            : label;
        })
        .join("\n")}`
    : undefined;
  // Related work is review context, not optional detail. Keep its already
  // bounded/sanitized representation in compact summaries and charge it
  // against the same provider-size budget as failed rules and finding labels.
  const relatedWork = renderRelatedWorkSection(input);
  const discussionMemory = renderDiscussionMemorySection(input);
  // Charged against the same budget as every other section: it is review
  // context, not optional detail.
  const crossFile = renderCrossFileGroupsSection(input);
  const findings = relocated.map((finding) => {
    const file = truncate(sanitizeInline(finding.file), 160);
    const loc = typeof finding.line === "number" ? `${file}:${finding.line}` : file;
    const rule = truncate(sanitizeInline(finding.ruleName), 80);
    const message = sanitizeInline(finding.message);
    const group = publishFailedSet.has(finding) ? " 📌" : "";
    // Issue #38: this path builds its own prefix rather than going through
    // metaLine, so the estimate has to be repeated here — and this is the path
    // that fires on the LARGE reviews where ordering the list matters most.
    // The badge is charged against the same budget as everything else below,
    // so it costs message characters rather than overflowing the limit.
    const effort = finding.effort === undefined ? "" : ` ${EFFORT_BADGE[finding.effort]}`;
    // The FIRST citation only. A citation is the evidence a claim rests on, and
    // dropping it silently on the large reviews — where the reader has least
    // context — was the worst place to drop it (PR #54 review). It rides in the
    // prefix so it is charged against the fixed budget and shrinks the message
    // allowance rather than overflowing the provider limit; the rest are
    // declared missing in the notice above rather than quietly discarded.
    const citation = compactShownReference(finding);
    const reference = citation === undefined ? "" : `\n  - Reference: ${sanitizeInline(citation)}`;
    // Compact mode is a SIZE fallback, not a TRUTH fallback. A claimed finding
    // whose check went missing here would publish an unqualified assertion on
    // exactly the large reviews where a reader has least context — the same
    // reasoning that keeps the first citation and the publication reason. It
    // rides in the prefix, so it is charged against the fixed budget and
    // shrinks the message allowance rather than overflowing the limit.
    const check = finding.claim !== undefined && finding.hostCheck !== undefined
      ? `\n  - ${describeCheckCompact(finding.hostCheck, sanitizeInline)}`
      : "";
    return {
      prefix: `- ${SEVERITY_BADGE[finding.severity]}${effort}${group} \`${loc}\` (\`${rule}\`): `,
      message,
      reference: `${check}${reference}`,
    };
  });
  // Disputed messages draw from the SAME pool as the relocated findings'
  // messages. The first fix gave each dispute a fixed 240-character cap, but
  // enough disputes at the cap still pushed the body past the limit —
  // `available` hit zero and the emergency fallback took the whole Disputed
  // section, the exact failure this path exists to prevent (Codex review of
  // PR #84, P1). The skeleton below prices the section WITHOUT its messages;
  // the messages then compete for the remaining space through the shared
  // allocator, so the section shrinks instead of vanishing.
  const disputedSkeleton = renderDisputedSection(input, true, disputedFindings.map(() => 0));
  const fixed = [header, notice, contextUnavailable, scanCoverage, clarification, disputedSkeleton, discussionMemory, failedRules, relatedWork, crossFile, ...findings.map(({ prefix, reference }) => `${prefix}${reference}`)]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  const available = Math.max(0, maxLength - fixed.length);
  const messageBudgets = allocateCompactMessageBudgets(
    [
      ...findings.map(({ message }) => message.length),
      // Demand is capped, not granted: a dispute requests at most
      // MAX_COMPACT_DISPUTED_MESSAGE_CHARS and receives whatever the shared
      // allocator grants from what is left after the fixed parts.
      ...disputedFindings.map((finding) =>
        Math.min(sanitizeText(finding.message).length, MAX_COMPACT_DISPUTED_MESSAGE_CHARS)),
    ],
    available,
  );
  const disputed = disputedFindings.length > 0
    ? renderDisputedSection(input, true, messageBudgets.slice(findings.length))
    : undefined;
  const body = [
    header,
    notice,
    contextUnavailable,
    scanCoverage,
    clarification,
    disputed,
    discussionMemory,
    failedRules,
    relatedWork,
    crossFile,
    ...findings.map(
      ({ prefix, message, reference }, index) =>
        `${prefix}${truncate(message, messageBudgets[index] ?? 0)}${reference}`,
    ),
  ].filter((part): part is string => part !== undefined).join("\n\n");

  if (body.length <= maxLength) return body;
  // The full section is gone by here, but the RELATIONSHIP is the thing this
  // feature exists to surface, and dropping it wholesale would remove it
  // exactly when a review is large enough to need it (PR #53 review). One line
  // costs almost nothing and still tells a reader the findings are connected.
  const groups = crossFileGroups(input.allFindings);
  const crossFileSummary = groups.length === 0
    ? undefined
    : `${groups.length} group(s) of findings appear to share one root cause across files.`;
  const compactStatus = [
    header,
    notice,
    scanCoverage,
    input.rulesFailed.length > 0
      ? `${input.rulesFailed.length} rule(s) failed to run.`
      : undefined,
    crossFileSummary,
    `${relocated.length} finding(s) could not fit in the provider comment.`,
  ].filter((part): part is string => part !== undefined);
  const withRelatedWork = relatedWork
    ? [...compactStatus.slice(0, 2), relatedWork, ...compactStatus.slice(2)].join("\n\n")
    : compactStatus.join("\n\n");
  if (withRelatedWork.length <= maxLength) return withRelatedWork;
  // Related-work entries contain Markdown links and are already atomic. When
  // the final emergency representation cannot fit them whole, omit the entire
  // section instead of slicing through a label or URL.
  return truncate(compactStatus.join("\n\n"), maxLength);
}

function allocateCompactMessageBudgets(lengths: number[], available: number): number[] {
  const budgets = lengths.map(() => 0);
  let remaining = available;
  let active = lengths.map((_, index) => index);

  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length);
    const settled = active.filter((index) => lengths[index]! <= share);
    if (settled.length === 0) {
      for (const [position, index] of active.entries()) {
        budgets[index] = share + (position < remaining % active.length ? 1 : 0);
      }
      break;
    }
    for (const index of settled) {
      budgets[index] = lengths[index]!;
      remaining -= lengths[index]!;
    }
    active = active.filter((index) => !settled.includes(index));
  }
  return budgets;
}

function renderSummaryCommentWithIncludedSuggestions(
  input: SummaryInput,
  includedSuggestions: ReadonlySet<Finding>,
): string {
  const publishFailed = input.publishFailed ?? [];
  const total = input.inlineCount + input.unanchored.length + publishFailed.length;
  const parts: string[] = [];

  if (total === 0) {
    // A green tick on a run where nothing actually RAN is a lie — and it was a
    // regression: the old renderer suppressed the all-clear when rules failed.
    parts.push(
      input.rulesFailed.length > 0
        ? `**No findings — but ${input.rulesFailed.length} rule(s) failed to run.**`
        : "**No actionable comments.** ✅",
    );
  } else {
    parts.push(`**${summaryHeadline(input, total)}**${severityCounts(input)}`);
  }

  if (input.inlineUnavailable && total > 0) {
    parts.push(
      "> [!NOTE]\n" +
        "> Inline comments could not be posted for this run, so every finding is listed below instead.",
    );
  }

  const contextUnavailable = renderContextUnavailable(input);
  if (contextUnavailable) parts.push(contextUnavailable);

  const scanCoverage = renderScanCoverage(input.scanCoverage);
  if (scanCoverage) parts.push(scanCoverage);

  // Anchors were VALID; the provider refused the write. Named separately so the
  // reader chases the right problem — and so nobody re-checks line numbers that
  // were never wrong.
  if (publishFailed.length > 0) {
    const distinctReasons = new Set(
      publishFailed
        .map((finding) => input.context?.get(finding)?.publishFailureReason)
        .filter((value): value is string => value !== undefined),
    );
    const shared = input.publishFailureReason ??
      (distinctReasons.size === 1 ? [...distinctReasons][0] : undefined);
    // Only claim a provider REJECTION when the provider actually said
    // something. Publication can fail before any request is made — verified on
    // hmchangw/newchat#281, where a local TypeError aborted it and no call was
    // ever sent — and blaming the provider there sends the reader to the wrong
    // system entirely.
    const blameProvider = shared !== undefined || distinctReasons.size > 0;
    const reason = shared
      ? ` Reason: ${sanitizeInline(shared)}.`
      : distinctReasons.size > 1
        ? " Each finding carries the reason that applies to it."
        : "";
    const cause = blameProvider
      ? `but the provider rejected the inline comment.${reason}`
      : "but publication did not complete, and no provider reason was recorded.";
    parts.push(
      [
        `### 📌 Inline publication failed (${publishFailed.length})`,
        `\n_These anchor to lines that ARE in the diff, ${cause}_\n`,
        "",
        publishFailed
          .map((finding) =>
            renderUnanchoredFinding(
              finding,
              !finding.suggestion?.trim() || includedSuggestions.has(finding),
              input.context?.get(finding),
            ),
          )
          .join("\n\n---\n\n"),
      ].join("\n"),
    );
  }

  // Findings that have no home on the diff still have to be SEEN. This is the
  // section that guarantees the inline path can never silently drop a finding.
  if (input.unanchored.length > 0) {
    const heading = input.inlineUnavailable
      ? `### 💬 Findings (${input.unanchored.length})`
      : `### 💬 Additional comments (${input.unanchored.length})`;
    const note = input.inlineUnavailable
      ? ""
      : "\n_These couldn't be anchored to a line in the diff (no line number, or the line isn't part of this PR's changes)._\n";
    const findings = input.unanchored.map((finding) => {
      const suggestion = finding.suggestion?.trim()
        ? capSuggestion(finding.suggestion)
        : undefined;
      const includeSuggestion = suggestion === undefined || includedSuggestions.has(finding);
      return renderUnanchoredFinding(finding, includeSuggestion, input.context?.get(finding));
    });
    parts.push(
      `${heading}${note}\n\n${findings.join("\n\n---\n\n")}`,
    );
  }

  const clarification = renderClarificationSection(input);
  if (clarification) parts.push(clarification);
  const disputed = renderDisputedSection(input);
  if (disputed) parts.push(disputed);

  if (input.rulesFailed.length > 0) {
    const items = input.rulesFailed.map((name) => {
      const reason = input.ruleFailureReasons?.[name];
      return reason ? `* \`${name}\` — ${reason}` : `* \`${name}\``;
    });
    parts.push(
      `### ⚠️ Rules that failed (${input.rulesFailed.length})\n\n${items.join("\n")}`,
    );
  }

  const relatedWork = renderRelatedWorkSection(input);
  if (relatedWork) parts.push(relatedWork);

  const crossFile = renderCrossFileGroupsSection(input);
  if (crossFile) parts.push(crossFile);

  const discussionMemory = renderDiscussionMemorySection(input);
  if (discussionMemory) parts.push(discussionMemory);

  const collapsed: string[] = [];
  if (input.filesReviewed.length > 0) {
    collapsed.push(
      detailsBlock(
        `📒 Files reviewed (${input.filesReviewed.length})`,
        // A path here is a PR AUTHOR's filename, and git writes a name
        // containing a backtick bare (backtick is not one of the characters
        // that force git's C-style quoting), so it arrives intact. Interpolated
        // raw it closes this code span, and the rest of the line renders as
        // markdown inside the published summary. Same sanitizer, and the same
        // reason, as every other single-line field in this file.
        input.filesReviewed.map((f) => `* \`${sanitizeInline(f)}\``),
      ),
    );
  }
  if (input.rulesRun.length > 0) {
    collapsed.push(
      detailsBlock(
        `⚙️ Rules run (${input.rulesRun.length})`,
        // Rule names come from the base branch and are trusted, but the escape
        // is a property of the code span rather than of the source: sanitized
        // for the same reason the finding table sanitizes `finding.ruleName`.
        input.rulesRun.map((r) => `* \`${sanitizeInline(r)}\``),
      ),
    );
  }
  if (collapsed.length > 0) parts.push(collapsed.join("\n"));

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Issue #55: the review BODY.
//
// GitHub treats this as the review ITSELF — it is what the timeline shows above
// the batch of inline comments, what the notification email leads with, and
// what any PR-summarising agent reads from the reviews API. It used to be the
// four words "tGD inline review".
//
// The digest DESCRIBES and POINTS; it never restates a finding. The summary
// comment stays the single place carrying finding text.
// ---------------------------------------------------------------------------

/**
 * The digest's whole budget, signature and marker included.
 *
 * Far under GitHub's 65,536-character body limit, and small enough that the
 * digest can never be the reason a review fails to post — it is charged against
 * the run's atomic payload accounting like everything else.
 */
export const MAX_REVIEW_DIGEST_CHARS = 4_000;

/** How many names a bounded list prints before it summarises the rest. */
const MAX_LISTED_RULES = 8;

/**
 * A machine marker in its own namespace.
 *
 * Deliberately not `sha=` or `pending`, which is what `parseBotMarker` scans
 * for on summary notes. A review body is not reachable by `findBotComment`
 * today; this is defence against that changing.
 */
const REVIEW_DIGEST_MARKER = "tgd-review-agent:review-digest";

export interface ReviewDigestInput {
  readonly headSha: string;
  readonly allFindings: readonly Finding[];
  readonly inlineCount: number;
  readonly unanchored: readonly Finding[];
  readonly publishFailed?: readonly Finding[];
  readonly filesReviewed: readonly string[];
  readonly rulesRun: readonly string[];
  readonly rulesFailed: readonly string[];
  /** Provider URL of the summary comment this run wrote, when it wrote one. */
  readonly summaryUrl?: string;
  /** The bot's real login, so the tips name it rather than a placeholder. */
  readonly botLogin?: string;
  /** Set for a focused run, which must not present itself as a full review. */
  readonly focusDirection?: string;
  /** Whether suggestion blocks are committable this run. */
  readonly suggestions?: boolean;
  /** Resolved `provider/model` specs the rules ran on, for the signature. */
  readonly models?: readonly string[];
  /**
   * The findings that will be rendered as INLINE comments.
   *
   * Drives the legend, which describes what those comments contain. Falls back
   * to `allFindings` for callers that do not distinguish them.
   */
  readonly inlineFindings?: readonly Finding[];
}

/** `a1b2c3d4e5f6` → `a1b2c3d`, the length a reader recognises. */
function shortSha(sha: string): string {
  return sanitizeInline(sha).slice(0, 7);
}

/** A bounded, sanitized list of names with a `+N more` tail. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED_RULES).map((name) => `\`${sanitizeInline(name)}\``);
  const hidden = names.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} +${hidden} more` : shown.join(", ");
}

/**
 * The legend for the badges an inline comment carries.
 *
 * Built by mapping the SAME tables `renderInlineComment` renders from, so it
 * cannot describe a badge the renderer no longer emits. Written as prose it
 * would go stale the first time a severity was added, and nothing would fail.
 */
function badgeLegend(): string[] {
  return [
    `- Severity is one of ${Object.values(SEVERITY_BADGE).join(" · ")}.`,
    `- Effort is ${Object.values(EFFORT_BADGE).join(" or ")} — the SIZE of the change, not its importance.`,
  ];
}

/**
 * A legend row per optional section the renderer can emit, driven by the same
 * predicates `renderInlineComment` consults.
 *
 * The first draft of #55 hand-wrote this list and missed citations entirely,
 * which had landed in #54 while the issue sat. A row appears only when this
 * run's findings actually trigger its section.
 */
function sectionLegend(input: ReviewDigestInput): string[] {
  // The findings that will actually be rendered INLINE. `allFindings` includes
  // unanchored ones, so a suggestion on a finding destined for the summary
  // added a legend row for a block no inline comment carries (PR #72 review).
  const findings = input.inlineFindings ?? input.allFindings;
  const rows: string[] = [];
  if (findings.some((finding) => emitsSuggestion(finding))) {
    rows.push(input.suggestions === false
      ? "- A fix block shows the proposed change; it is not committable this run."
      : "- A suggestion block is committable, and applies verbatim — read it first, it is generated text.");
  }
  if (findings.some((finding) => emitsReferences(finding))) {
    rows.push("- A **Reference** block lists sources the finding rests on; a rule may cite only URLs its own text declared.");
  }
  rows.push("- The collapsed 🤖 block is a ready-made prompt for handing that one finding to a coding agent.");
  return rows;
}

/**
 * The conversation commands, collapsed so repeated runs do not stack walls of
 * text — and OMITTED when the account is not known.
 *
 * The command parser requires the authenticated account's exact mention, so a
 * placeholder renders every command here inert on any installation not called
 * `tgdbot` — the bring-your-own-token case (PR #72 review). Showing commands
 * that cannot work is worse than showing none.
 */
function tips(botLogin: string | undefined): string | undefined {
  if (botLogin === undefined || botLogin.trim().length === 0) return undefined;
  const bot = `@${sanitizeInline(botLogin)}`;
  return detailsBlock(`Replying to ${bot}`, [
    `In a finding's own thread: \`${bot} explain\`, \`${bot} reconsider <reason>\`.`,
    "",
    `Anywhere on the pull request: \`${bot} check latest\`, \`${bot} review focus: <direction>\`,`,
    `\`${bot} remember <lesson>\`, \`${bot} memories\`, \`${bot} forget <memory-id>\`.`,
    "",
    "One command per comment.",
  ]);
}

/**
 * The review body for one RUN.
 *
 * Every sentence stays true however many review events it ends up attached to:
 * a bisected run reuses these exact bytes on each accepted subset, so the
 * wording is run-scoped ("this run posted 6 findings inline"), never
 * event-scoped ("the 6 comments below"). That is what removes the need for any
 * per-attempt branch.
 */
export function renderReviewDigest(input: ReviewDigestInput): string {
  const sha = shortSha(input.headSha);
  const counts = { blocking: 0, warning: 0, suggestion: 0 };
  for (const finding of input.allFindings) counts[finding.severity] += 1;
  const severities = (Object.keys(counts) as Finding["severity"][])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${SEVERITY_BADGE[severity].toLowerCase()}`)
    .join(" · ");

  const fileCount = input.filesReviewed.length;
  const total = input.allFindings.length;

  const headline = input.focusDirection === undefined
    ? `### tGDBot review of \`${sha}\` — ${total} finding${total === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`
    : `### tGDBot focused review of \`${sha}\` — asked to look at: ${sanitizeInline(input.focusDirection)}`;

  // No claim about how many findings were POSTED. This body is composed before
  // the write and is reused byte-for-byte by every bisect attempt, so an
  // accepted subset would otherwise carry a count that never happened and can
  // never be corrected — review bodies are append-only (PR #72 review).
  //
  // It also does not say WHY a finding is not inline. An unanchorable finding
  // and one the provider rejected are different failures, and only the summary
  // knows which happened, because that is decided after this composes.
  const placement = input.summaryUrl === undefined
    ? "Findings not shown inline are in the review summary."
    : `Findings not shown inline are in the [review summary](${input.summaryUrl}), which is authoritative for what this run found and where each finding went.`;

  const rules = [
    input.rulesRun.length > 0 ? `Rules: ${nameList(input.rulesRun)}` : undefined,
    input.rulesFailed.length > 0
      ? `${input.rulesFailed.length} rule${input.rulesFailed.length === 1 ? "" : "s"} failed (${nameList(input.rulesFailed)}) — reason in the summary.`
      : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");

  const guide = detailsBlock("How to read an inline comment", [
    "- Each one opens with `category | severity | effort | rule`.",
    ...badgeLegend(),
    ...sectionLegend(input),
  ]);

  const body = [
    headline,
    "",
    severities,
    placement,
    ...(rules === "" ? [] : [rules]),
    "",
    guide,
    ...(tips(input.botLogin) === undefined ? [] : ["", tips(input.botLogin)!]),
  ].join("\n");

  const suffix = `\n\n${botSignatureBlock(input.models)}\n\n<!-- ${REVIEW_DIGEST_MARKER} sha=${sha} -->`;
  // The signature and the marker are what make this body identifiable as ours,
  // so truncation is charged against the DIGEST, never against them.
  const room = MAX_REVIEW_DIGEST_CHARS - suffix.length;
  const trimmed = body.length <= room ? body : `${body.slice(0, Math.max(0, room - 2))}…`;
  return `${trimmed}${suffix}`;
}

/**
 * Whether one atomic inline review would exceed what the provider accepts.
 *
 * GitHub caps a single comment body at 65,536 characters and the whole request
 * well below a megabyte. The arithmetic lived in two places — the CLI's
 * pre-flight and the publication path's — which is two copies of a limit that
 * can drift apart, and it made the accounting untestable without driving a
 * whole run. One definition, used by both.
 *
 * The review BODY is charged at its MAXIMUM rather than its composed length
 * (issue #55). The publication pre-flight runs before the summary is written,
 * and composing the digest there would memoize it without the summary link it
 * exists to carry — so being bounded by construction is what lets it be
 * accounted for without being built.
 */
export function exceedsAtomicPayload(
  entries: readonly { readonly bodyChars: number; readonly markerChars: number }[],
): boolean {
  const total = MAX_REVIEW_DIGEST_CHARS + entries.reduce(
    (sum, entry) => sum + entry.bodyChars + entry.markerChars + PER_COMMENT_OVERHEAD_CHARS,
    0,
  );
  return total > MAX_ATOMIC_PAYLOAD_CHARS
    || entries.some((entry) => entry.bodyChars + entry.markerChars + PER_COMMENT_HEADROOM_CHARS > MAX_COMMENT_CHARS);
}

/** Request framing per comment: JSON keys, path, line, quoting. */
const PER_COMMENT_OVERHEAD_CHARS = 256;
/** Headroom when checking ONE comment against the provider's body limit. */
const PER_COMMENT_HEADROOM_CHARS = 128;
/** The provider's per-comment body limit. */
const MAX_COMMENT_CHARS = 65_536;
/** The whole request's safe ceiling. */
const MAX_ATOMIC_PAYLOAD_CHARS = 1_000_000;
