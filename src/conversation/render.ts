// Provider-neutral sanitizers and reply renderers. Action code returns
// structured results; this module is the only place those become public Markdown.
import { computeContentDigest } from "./markers.js";
import type { PublicationChild } from "./publication-manifest.js";
import type { PublicationChildKind, PublicationPlacement } from "./state-schema.js";
import { BOT_SIGNATURE_BLOCK } from "../review/comment-format.js";
import type { Finding } from "../review/types.js";
import type { RepositoryRef } from "../target/types.js";

export const MAX_PUBLIC_CONVERSATION_BODY_CHARS = 32_000;

const RENDERED_BODY_BRAND: unique symbol = Symbol("tgd.rendered-conversation-body");

export interface RenderedConversationBody {
  readonly [RENDERED_BODY_BRAND]: true;
  readonly text: string;
}

export interface ConversationRenderBinding {
  readonly provider: "github" | "gitlab";
  readonly repository: RepositoryRef;
  readonly reviewNumber: number;
}

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const BIDI_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu;
const SUGGESTION_FENCE_RE = /^([ \t>*+\-]*(?:`{3,}|~{3,})[ \t]*)suggestions?\b/gim;
const MARKDOWN_ESCAPE_RE = /([\\`*_[\]{}()<>#+|~])/g;

export function isRenderedConversationBody(value: unknown): value is RenderedConversationBody {
  return typeof value === "object"
    && value !== null
    && (value as RenderedConversationBody)[RENDERED_BODY_BRAND] === true
    && typeof (value as RenderedConversationBody).text === "string";
}

export function publicationBody(body: RenderedConversationBody): string {
  if (!isRenderedConversationBody(body)) {
    throw new Error("publication body must be a branded rendered conversation body");
  }
  return body.text;
}

function brand(text: string): RenderedConversationBody {
  return { [RENDERED_BODY_BRAND]: true, text };
}

function stripInvisible(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(CONTROL_RE, "").replace(BIDI_RE, "");
}

function defangGeneratedMarkup(value: string): string {
  return value
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/<\/?(?:details|summary|script|style|iframe|img|a)\b/gi, (match) => `&lt;${match.slice(1)}`)
    .replace(SUGGESTION_FENCE_RE, "$1text");
}

function escapeMarkdown(value: string): string {
  return defangGeneratedMarkup(value).replace(MARKDOWN_ESCAPE_RE, "\\$1");
}

function flatten(value: string): string {
  return escapeMarkdown(stripInvisible(value)).replace(/\s+/g, " ").trim();
}

export function flattenAuthor(name: string): string {
  return flatten(name);
}

export function flattenExcerpt(text: string): string {
  return flatten(text);
}

export function sanitizeMemoryText(text: string): string {
  return escapeMarkdown(stripInvisible(text)).trim();
}

function sanitizeMultiline(text: string): string {
  return escapeMarkdown(stripInvisible(text)).trim();
}

export function validateBoundHttpsUrl(
  url: string,
  binding: ConversationRenderBinding,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
  const canonical = new URL(binding.repository.canonicalUrl);
  if (parsed.origin !== canonical.origin) return undefined;
  const basePath = canonical.pathname.replace(/\/$/u, "");
  const expectedPath = binding.provider === "github"
    ? `${basePath}/pull/${binding.reviewNumber}`
    : `${basePath}/-/merge_requests/${binding.reviewNumber}`;
  const actualPath = parsed.pathname.replace(/\/$/u, "");
  const pathMatches = binding.provider === "github"
    ? actualPath.toLowerCase() === expectedPath.toLowerCase()
    : actualPath === expectedPath;
  if (!pathMatches) return undefined;
  return url;
}

export function childMarkerSuffix(marker: string): string {
  return `\n${marker}`;
}

function capToLimit(content: string, marker: string): string {
  const suffix = childMarkerSuffix(marker);
  // The signature is part of the body the provider stores, so it is charged
  // against the same budget as the marker — never appended after the cap.
  const signature = `\n\n${BOT_SIGNATURE_BLOCK}`;
  const budget = Math.max(0, MAX_PUBLIC_CONVERSATION_BODY_CHARS - suffix.length - signature.length);
  const trimmed = content.length <= budget ? content : content.slice(0, budget);
  return `${trimmed}${signature}${suffix}`;
}

function attributionLines(
  input: { readonly author?: string; readonly excerpt?: string; readonly sourceUrl?: string },
  binding?: ConversationRenderBinding,
): string[] {
  const lines: string[] = [];
  if (input.author) {
    const author = flattenAuthor(input.author);
    if (author) lines.push(`_From ${author}_`);
  }
  if (input.sourceUrl && binding) {
    const url = validateBoundHttpsUrl(input.sourceUrl, binding);
    if (url) lines.push(url);
  }
  if (input.excerpt) {
    const excerpt = flattenExcerpt(input.excerpt);
    if (excerpt) lines.push(`> ${excerpt}`);
  }
  return lines;
}

function renderSections(heading: string, parts: readonly (string | undefined)[], marker: string): RenderedConversationBody {
  const body = [heading, "", ...parts.filter((part): part is string => part !== undefined && part.length > 0)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return brand(capToLimit(body, marker));
}

export function renderExplainReply(
  input: {
    readonly explanation: string;
    readonly author?: string;
    readonly excerpt?: string;
    readonly sourceUrl?: string;
  },
  marker: string,
  binding?: ConversationRenderBinding,
): RenderedConversationBody {
  return renderSections("## Explanation", [
    ...attributionLines(input, binding),
    sanitizeMultiline(input.explanation),
  ], marker);
}

export function renderReconsiderReply(
  input: {
    readonly outcome: "confirmed" | "revised" | "withdrawn";
    readonly rationale: string;
    readonly finding?: Finding;
    readonly author?: string;
    readonly excerpt?: string;
    readonly sourceUrl?: string;
  },
  marker: string,
  binding?: ConversationRenderBinding,
): RenderedConversationBody {
  const outcome = input.outcome === "confirmed"
    ? "Confirmed."
    : input.outcome === "revised"
      ? "Revised."
      : "Withdrawn.";
  return renderSections("## Reconsideration", [
    ...attributionLines(input, binding),
    outcome,
    sanitizeMultiline(input.rationale),
  ], marker);
}

/**
 * The reply an AUTOMATIC verification posts (#57).
 *
 * Deliberately not `renderReconsiderReply`. That one answers a human who asked;
 * this one speaks unprompted, so it says what made it look — a reader who finds
 * a bot comment in their thread should not have to guess why it appeared.
 *
 * It never restates the finding. The original is directly above it in the same
 * thread, and repeating it is noise the acceptance criteria explicitly forbid;
 * what this carries is the reading of the code AS IT STANDS NOW, which is the
 * part a reader cannot get anywhere else.
 */
/**
 * How much of the model's reading of the code the reply carries.
 *
 * Generous for a paragraph and far short of the body limit, so the lines after
 * it — the invitation to disagree — cannot be truncated away.
 */
const MAX_VERIFICATION_RATIONALE_CHARS = 4_000;

export function renderVerificationReply(
  input: {
    readonly verdict: "confirmed" | "revised" | "withdrawn";
    readonly trigger: "thread-comment" | "thread-resolution" | "head-change" | "reaction";
    readonly rationale: string;
    /** Named so the invitation to disagree is a command that actually works. */
    readonly botLogin?: string;
  },
  marker: string,
): RenderedConversationBody {
  const because = input.trigger === "thread-comment"
    ? "You replied in this thread, so I re-read the finding against the current code."
    : input.trigger === "thread-resolution"
      ? "This thread was resolved, so I re-read the finding against the current code."
      : input.trigger === "reaction"
        ? "This finding was acknowledged, so I re-read it against the current code."
        : "A new commit changed the lines this finding was anchored to, so I re-read it.";

  const verdict = input.verdict === "withdrawn"
    ? "It no longer holds — treating this as addressed."
    : input.verdict === "revised"
      ? "Part of it is addressed; part still stands."
      : "It still stands.";

  // A LOGIN, not prose. `sanitizeMultiline` escapes Markdown, so a GitLab
  // account like `acme_bot` rendered as `acme\_bot` — a command that copies to
  // a mention matching no account (PR #73 review). Invisible characters,
  // whitespace and backticks are still stripped; nothing else is touched.
  const login = input.botLogin === undefined
    ? undefined
    : stripInvisible(input.botLogin).replace(/[\s`]/gu, "");
  // Only when there is something left to disagree ABOUT.
  const invitation = input.verdict === "withdrawn" || login === undefined || login.length === 0
    ? undefined
    : [
      "Reply with one of:",
      `- \`@${login} accept\` — intentional; stop raising it on this PR`,
      `- \`@${login} defer\` — real, not now; tGDBot drafts a follow-up issue`,
      `- \`@${login} reconsider <why>\` — you disagree with the reading above`,
    ].join("\n");

  // The rationale is capped BEFORE assembly, not after. The body is truncated
  // from the end, so a verbose model could otherwise push the invitation off
  // it — leaving a reader told they may disagree but not how (PR #73 review).
  const rationale = sanitizeMultiline(input.rationale).slice(0, MAX_VERIFICATION_RATIONALE_CHARS);
  return renderSections("## Verification", [
    because,
    verdict,
    rationale,
    invitation,
  ], marker);
}

export function renderClarificationQuestion(
  input: { readonly question: string; readonly pendingId: string },
  marker: string,
): RenderedConversationBody {
  return renderSections("## Needs clarification", [
    sanitizeMultiline(input.question),
    `Reply in this thread, or post: \`answer ${input.pendingId.replace(/`/gu, "")}: <your answer>\``,
  ], marker);
}

export function renderClarificationReply(
  input: {
    readonly outcome: "confirmed" | "revised" | "withdrawn" | "stale";
    readonly rationale: string;
    readonly question?: string;
    readonly answer?: string;
    readonly finding?: Finding;
  },
  marker: string,
  binding?: ConversationRenderBinding,
): RenderedConversationBody {
  void binding;
  const outcome = input.outcome === "confirmed"
    ? "Confirmed."
    : input.outcome === "revised"
      ? "Revised."
      : input.outcome === "stale"
        ? "This question applied to an earlier review head and will not be turned into a current finding."
        : "Withdrawn.";
  return renderSections("## Clarification", [
    input.question ? `Question: ${sanitizeMultiline(input.question)}` : undefined,
    input.answer ? `Answer: ${sanitizeMultiline(input.answer)}` : undefined,
    outcome,
    input.outcome === "stale" ? undefined : sanitizeMultiline(input.rationale),
  ], marker);
}

export function renderFocusReply(
  input: { readonly direction: string; readonly summary: string },
  marker: string,
): RenderedConversationBody {
  return renderSections("## Focused review", [
    `Direction: ${sanitizeMultiline(input.direction)}`,
    sanitizeMultiline(input.summary),
  ], marker);
}

/**
 * Every memory reply in one renderer, because they share a hard rule: the only
 * untrusted text that reaches a public body is a lesson a human wrote, and it
 * is always escaped. IDs are generated, so they are safe by construction.
 */
export type MemoryReply =
  | { readonly kind: "remembered"; readonly publicId: string }
  | { readonly kind: "forgotten"; readonly publicId: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "at-capacity"; readonly limit: number }
  | {
      readonly kind: "list";
      readonly items: readonly {
        readonly publicId: string;
        readonly text: string;
        readonly attribution: string;
        readonly at: string;
      }[];
    };

export function renderMemoryReply(reply: MemoryReply, marker: string): RenderedConversationBody {
  if (reply.kind === "remembered") {
    return renderSections("## Memory recorded", [
      `Recorded as \`${reply.publicId}\`. Use \`forget ${reply.publicId}\` to remove it.`,
    ], marker);
  }
  if (reply.kind === "forgotten") {
    return renderSections("## Memory forgotten", [
      `\`${reply.publicId}\` is no longer applied to reviews in this repository.`,
    ], marker);
  }
  // Deliberately identical for an ID that never existed, one already forgotten,
  // and one belonging to another repository: the reply must not confirm which.
  if (reply.kind === "not-found") {
    return renderSections("## Memory not found", [
      "No active memory with that ID exists for this repository. Use `memories` to list the active ones.",
    ], marker);
  }
  if (reply.kind === "at-capacity") {
    return renderSections("## Memory limit reached", [
      `This repository already holds the maximum of ${reply.limit} active memories, so nothing was recorded.`,
      "Use `memories` to review them and `forget <memory-id>` to free a slot, then issue `remember` again.",
    ], marker);
  }
  if (reply.items.length === 0) {
    return renderSections("## Active memories", [
      "This repository has no active memories.",
    ], marker);
  }
  return renderSections("## Active memories", [
    ...reply.items.map((item) =>
      `- \`${item.publicId}\` — ${sanitizeMemoryText(item.text)} _(${sanitizeMemoryText(item.attribution)})_`),
  ], marker);
}

export function renderUsageReply(marker: string): RenderedConversationBody {
  return renderSections("## Command usage", [
    "tGDBot accepts exactly one command per comment. Use one of:",
    "- `@bot explain`",
    "- `@bot accept`",
    "- `@bot defer`",
    "- `@bot reconsider <reason>`",
    "- `@bot review focus: <direction>`",
    "- `@bot check latest`",
    "- `@bot remember <lesson>`",
    "- `@bot forget <memory-id>`",
    "- `@bot memories`",
    "Replace `@bot` with the authenticated bot mention. Quoted, fenced, or multiple commands are ignored or rejected.",
  ], marker);
}

export function renderDispositionReply(
  input: {
    readonly disposition: "accepted" | "deferred";
    readonly file: string;
    readonly line?: number;
    readonly ruleName: string;
    readonly severity: "blocking" | "warning" | "suggestion";
    readonly botLogin?: string;
  },
  marker: string,
): RenderedConversationBody {
  const file = flattenAuthor(input.file) || "the file";
  const ruleName = flattenAuthor(input.ruleName) || "this rule";
  const where = input.line === undefined ? `\`${file}\`` : `\`${file}:${input.line}\``;
  if (input.disposition === "accepted") {
    return renderSections("## Accepted", [
      `Recorded as accepted on this review at ${where} (\`${ruleName}\`). I will not raise this finding again on this PR.`,
    ], marker);
  }
  const login = input.botLogin === undefined
    ? undefined
    : stripInvisible(input.botLogin).replace(/[\s`]/gu, "");
  const mention = login === undefined || login.length === 0 ? "@bot" : `@${login}`;
  return renderSections("## Deferred", [
    `Real, not now — at ${where} (\`${ruleName}\`, ${input.severity}).`,
    "Draft follow-up (not filed):",
    `**Title:** \`${ruleName}\` at ${where}`,
    "File this yourself if you want it tracked. Nothing was opened.",
    `Reply \`${mention} accept\` if this should stop being raised on this PR instead.`,
  ], marker);
}

export function renderScopeErrorReply(marker: string): RenderedConversationBody {
  return renderSections("## Out of scope", [
    "`explain`, `reconsider`, `accept` and `defer` only work inside a thread started by a marked tGDBot finding.",
  ], marker);
}

export function renderClarificationUnavailableReply(marker: string): RenderedConversationBody {
  return renderSections("## Clarification unavailable", [
    "That clarification ID is not active in this review. Check the ID and answer an open clarification from this review.",
  ], marker);
}

export function renderUnsupportedHistoryReply(marker: string): RenderedConversationBody {
  return renderSections("## History unavailable", [
    "This thread's original finding is no longer in the local ledger, so tGDBot cannot explain or reconsider it.",
  ], marker);
}

export function renderInactiveRuleReply(
  input: { readonly ruleName: string },
  marker: string,
): RenderedConversationBody {
  const ruleName = flattenAuthor(input.ruleName) || "this rule";
  return renderSections("## Rule no longer active", [
    `The trusted rule \`${ruleName}\` is missing or disabled on the current base branch, so this finding cannot be reassessed.`,
  ], marker);
}

export function createConversationPublicationChild(input: {
  readonly id: string;
  readonly kind: PublicationChildKind;
  readonly placement: PublicationPlacement;
  readonly body: RenderedConversationBody;
  readonly marker: string;
  readonly replacesId?: string;
}): PublicationChild {
  const text = publicationBody(input.body);
  return {
    id: input.id,
    kind: input.kind,
    status: "pending",
    placement: input.placement,
    body: text,
    bodyDigest: computeContentDigest(text),
    marker: input.marker,
    ...(input.replacesId === undefined ? {} : { replacesId: input.replacesId }),
  };
}
