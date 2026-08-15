// Provider-neutral sanitizers and reply renderers. Action code returns
// structured results; this module is the only place those become public Markdown.
import { computeContentDigest } from "./markers.js";
import type { PublicationChild } from "./publication-manifest.js";
import type { PublicationChildKind, PublicationPlacement } from "./state-schema.js";
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
  const budget = Math.max(0, MAX_PUBLIC_CONVERSATION_BODY_CHARS - suffix.length);
  const trimmed = content.length <= budget ? content : content.slice(0, budget);
  return `${trimmed}${suffix}`;
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
    "- `@bot reconsider <reason>`",
    "- `@bot review focus: <direction>`",
    "- `@bot check latest`",
    "- `@bot remember <lesson>`",
    "- `@bot forget <memory-id>`",
    "- `@bot memories`",
    "Replace `@bot` with the authenticated bot mention. Quoted, fenced, or multiple commands are ignored or rejected.",
  ], marker);
}

export function renderScopeErrorReply(marker: string): RenderedConversationBody {
  return renderSections("## Out of scope", [
    "`explain` and `reconsider` only work inside a thread started by a marked tGDBot finding.",
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
