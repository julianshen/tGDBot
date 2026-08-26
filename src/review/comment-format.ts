// Rendering for the two surfaces a review now writes to:
//
//   1. INLINE review comments, anchored to a line of the diff (the CodeRabbit /
//      Cursor Bugbot model — a finding is most useful sitting next to the code
//      it is about, not in a list a reader has to cross-reference by hand).
//   2. A SUMMARY comment, which carries the counts, the run metadata, the
//      failed-rule reasons, and any finding that could NOT be anchored.
//
// Both are plain string builders: pure, synchronous, no I/O.
import { crossFileGroups } from "./finding-clusters.js";
import type { Finding } from "./types.js";
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
    .replace(/-->/g, "--&gt;") // ...nor CLOSE one — our dedup marker is an HTML comment
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
  const suggestion = finding.suggestion?.trim() ? capSuggestion(finding.suggestion) : undefined;
  if (suggestion) {
    // `--suggestions off` DOWNGRADES to a plain, non-committable block. It must not
    // delete the fix: the reviewer who picked the safe mode is the last person who
    // should lose information (caught in review — the first draft dropped it).
    parts.push("", renderSuggestionBlock(suggestion, options.suggestions !== false));
  }

  const citations = renderReferences(finding);
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
    // The visible half of "this was written by the tool". Before the machine
    // marker, because the marker (and any finding marker after it) must stay
    // the last line: recovery reads exactly that line back.
    BOT_SIGNATURE_BLOCK,
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
  /** Optional labels such as "discussion" or "memory". */
  contextUnavailable?: readonly string[];
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
    return suggestion === undefined
      ? [line, ...cited]
      : [line, ...cited, "", renderSuggestionBlock(suggestion, false), ""];
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

function renderContextUnavailable(input: SummaryInput): string | undefined {
  const labels = input.contextUnavailable ?? [];
  const notes = [
    labels.includes("discussion")
      ? "> Discussion context was unavailable for this run. The review used the diff and trusted rules only."
      : undefined,
    labels.includes("memory")
      ? "> Memory context was unavailable for this run."
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
 */
function renderDisputedSection(input: SummaryInput, compact = false): string | undefined {
  const disputed = input.disputed ?? [];
  if (disputed.length === 0) return undefined;
  const items = disputed.flatMap((finding) => {
    const file = sanitizeInline(finding.file);
    const loc = typeof finding.line === "number" ? `${file}:${finding.line}` : file;
    const message = sanitizeText(finding.message);
    // A disputed finding is precisely the one whose evidence a reader needs.
    return [
      `- \`${loc}\` (\`${sanitizeInline(finding.ruleName)}\`) — ${message}`,
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
  const clarification = renderClarificationSection(input);
  const disputed = renderDisputedSection(input, true);
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
    return {
      prefix: `- ${SEVERITY_BADGE[finding.severity]}${effort}${group} \`${loc}\` (\`${rule}\`): `,
      message,
      reference,
    };
  });
  const fixed = [header, notice, contextUnavailable, clarification, disputed, discussionMemory, failedRules, relatedWork, crossFile, ...findings.map(({ prefix, reference }) => `${prefix}${reference}`)]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  const available = Math.max(0, maxLength - fixed.length);
  const messageBudgets = allocateCompactMessageBudgets(
    findings.map(({ message }) => message.length),
    available,
  );
  const body = [
    header,
    notice,
    contextUnavailable,
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
        input.filesReviewed.map((f) => `* \`${f}\``),
      ),
    );
  }
  if (input.rulesRun.length > 0) {
    collapsed.push(
      detailsBlock(
        `⚙️ Rules run (${input.rulesRun.length})`,
        input.rulesRun.map((r) => `* \`${r}\``),
      ),
    );
  }
  if (collapsed.length > 0) parts.push(collapsed.join("\n"));

  return parts.join("\n\n");
}
