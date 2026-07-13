// Rendering for the two surfaces a review now writes to:
//
//   1. INLINE review comments, anchored to a line of the diff (the CodeRabbit /
//      Cursor Bugbot model — a finding is most useful sitting next to the code
//      it is about, not in a list a reader has to cross-reference by hand).
//   2. A SUMMARY comment, which carries the counts, the run metadata, the
//      failed-rule reasons, and any finding that could NOT be anchored.
//
// Both are plain string builders: pure, synchronous, no I/O.
import type { Finding } from "./types.js";

export interface InlineComment {
  /** Repo-relative path, as it appears on the NEW side of the diff. */
  path: string;
  /** NEW-file line number. Guaranteed commentable (see diff-anchors). */
  line: number;
  body: string;
}

// A finding's severity drives the badge. These are the three values the JSON
// contract allows, so the map is total.
const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  blocking: "🔴 Blocking",
  warning: "🟠 Warning",
  suggestion: "🔵 Suggestion",
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
// GitHub renders that as a COMMITTABLE SUGGESTION with a one-click "Commit
// suggestion" button — but ONLY inside a review comment on a diff. In the issue
// comment this tool used to post, the same fence was inert. So moving to inline
// comments would have turned a prompt-injected finding into one click from
// committing attacker-chosen code into the PR branch. Neutralising the
// `suggestion` info-string is therefore not hardening-in-general; it closes a hole
// this very change would otherwise have opened.
//
// Code fences themselves are KEPT — findings legitimately contain ```go blocks and
// they are genuinely useful. Only the `suggestion` (and `suggestions`) info-string
// is defanged, and only GitHub treats that one as committable.
const SUGGESTION_FENCE_RE = /^([ \t]*(?:`{3,}|~{3,})[ \t]*)suggestions?\b/gim;

function sanitizeText(text: string): string {
  return text
    .replace(/<!--/g, "&lt;!--") // can't OPEN an HTML comment (would swallow the rest)
    .replace(/-->/g, "--&gt;") // ...nor CLOSE one — our dedup marker is an HTML comment
    .replace(/<\/?(?:details|summary|script|style|iframe|img|a)\b/gi, (m) => `&lt;${m.slice(1)}`)
    // A committable suggestion must never originate from finding text.
    .replace(SUGGESTION_FENCE_RE, "$1text")
    .trim();
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
 * Split a finding into a short bold headline + prose body — the shape CodeRabbit
 * uses, and far more scannable than one undifferentiated paragraph.
 *
 * Our Finding carries only `message` (no separate title), so the headline has to
 * be derived:
 *   - a first sentence that is short enough  → headline = it, body = the rest
 *   - a first sentence that is too long      → headline = a word-boundary
 *     truncation of it, body = the FULL message (nothing is lost; the headline
 *     is a title, and a title repeating its first line is normal)
 *   - a single short sentence                → headline only, no body
 */
function splitHeadline(message: string): { headline: string; body: string } {
  const trimmed = message.trim();

  const sentence = /^(.+?[.!?])(?:\s+(.+))?$/s.exec(trimmed);
  const first = sentence?.[1]?.trim() ?? trimmed;
  const rest = sentence?.[2]?.trim() ?? "";

  // A headline is a single bold LINE: newlines and list markup inside it produce
  // literal `**` and a mangled list on GitHub.
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
export function renderInlineComment(finding: Finding): string {
  const full = sanitizeText(finding.message);
  const file = sanitizeInline(finding.file);
  const { headline, body } = splitHeadline(full);
  const lineRef = typeof finding.line === "number" ? ` around line ${finding.line}` : "";

  // Exactly ONE of these shapes — never the message twice:
  //   headline + body : a short first sentence as the title, the rest as prose
  //   headline only   : the finding IS one short sentence
  //   prose only      : no sentence short enough to be a title (see splitHeadline)
  const parts = [metaLine(finding), ""];
  if (headline) {
    parts.push(`**${headline}**`);
    if (body) parts.push("", body);
  } else {
    parts.push(full);
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
  );

  return parts.join("\n");
}

function metaLine(finding: Finding): string {
  return `_${categoryBadge(sanitizeInline(finding.category))}_ | _${SEVERITY_BADGE[finding.severity]}_ | _\`${sanitizeInline(finding.ruleName)}\`_`;
}

export interface SummaryInput {
  /** Every deduped finding (inline + unanchored) — used for the severity counts. */
  allFindings: Finding[];
  /** Findings that WERE posted inline — counted, not repeated, in the summary. */
  inlineCount: number;
  /** Findings that could NOT be anchored to the diff; rendered in full here. */
  unanchored: Finding[];
  filesReviewed: string[];
  rulesRun: string[];
  rulesFailed: string[];
  ruleFailureReasons?: Record<string, string>;
  /**
   * True when inline posting was unavailable (e.g. the reviews API call failed).
   * The summary then carries EVERY finding, so a finding is never lost — it is
   * only ever relocated.
   */
  inlineUnavailable?: boolean;
}

function renderUnanchoredFinding(finding: Finding): string {
  const file = sanitizeInline(finding.file);
  const loc = typeof finding.line === "number" ? `${file}:${finding.line}` : file;
  const full = sanitizeText(finding.message);
  const { headline, body } = splitHeadline(full);

  const parts = [`**\`${loc}\`**`, "", metaLine(finding), ""];
  if (headline) {
    parts.push(`**${headline}**`);
    if (body) parts.push("", body);
  } else {
    parts.push(full);
  }
  return parts.join("\n");
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

export function renderSummaryComment(input: SummaryInput): string {
  const total = input.inlineCount + input.unanchored.length;
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
    parts.push(`**Actionable comments posted: ${total}**${severityCounts(input)}`);
  }

  if (input.inlineUnavailable && total > 0) {
    parts.push(
      "> [!NOTE]\n" +
        "> Inline comments could not be posted for this run, so every finding is listed below instead.",
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
    parts.push(
      `${heading}${note}\n\n${input.unanchored.map(renderUnanchoredFinding).join("\n\n---\n\n")}`,
    );
  }

  if (input.rulesFailed.length > 0) {
    const items = input.rulesFailed.map((name) => {
      const reason = input.ruleFailureReasons?.[name];
      return reason ? `* \`${name}\` — ${reason}` : `* \`${name}\``;
    });
    parts.push(
      `### ⚠️ Rules that failed (${input.rulesFailed.length})\n\n${items.join("\n")}`,
    );
  }

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
