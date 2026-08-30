// Issue #59: what the PR says it is doing, as UNTRUSTED evidence for the
// dispatched reviewer. The title and description are attacker-controlled —
// anyone who can open a PR writes them, and the body can be edited after a
// review ran — so they travel in their own boundary-token section next to the
// diff, never in trusted context. The instruction that bounds what a reviewer
// may DO with them lives in dispatch-prompt.ts; this module owns the SHAPE,
// the bounds (truncation, control characters), the section body text, and the
// dedup fingerprint that makes a description edit re-trigger a review.
import { createHash } from "node:crypto";
import type { RelatedWorkState } from "./related-work.js";

/** One linked issue/PR: identifier + resolved title + state. Never a body. */
export interface PrIntentReference {
  readonly identifier: string;
  readonly title?: string;
  readonly state?: RelatedWorkState;
}

/** The sanitized, bounded intent a reviewer is shown. */
export interface PrIntent {
  readonly title?: string;
  readonly description?: string;
  readonly linked?: readonly PrIntentReference[];
}

export const MAX_INTENT_TITLE_CHARS = 200;
export const MAX_INTENT_DESCRIPTION_CHARS = 4000;

const TRUNCATED_MARKER = " [truncated]";

// Control characters are stripped — except \n and \t, which multi-line prose
// needs to stay readable inside its section. The section is delimited by a
// collision-resistant boundary token, not by prose shape, so newlines are
// safe; what a raw \u0000 or \u007F could do to a terminal or a log parser is
// not. (Conversation inputs make the same trade, minus the newlines, because
// their adapter stores single-line values.)
const CONTROL_RE = /[^\P{C}\n\t]/gu;

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(CONTROL_RE, "").replace(/[ \t]+/g, " ").trim();
}

/** Description prose keeps its newlines; everything else flattens to one line. */
function sanitizeProse(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").trim();
}

/**
 * Truncates on a CODE-POINT boundary — a UTF-16 slice can split a surrogate
 * pair and end the value on a lone half character.
 */
function truncate(value: string, max: number): string | undefined {
  if (!value) return undefined;
  const points = [...value];
  if (points.length <= max) return value;
  return points.slice(0, max - [...TRUNCATED_MARKER].length).join("") + TRUNCATED_MARKER;
}

export function sanitizePrIntentReference(reference: PrIntentReference): PrIntentReference | undefined {
  const identifier = sanitizeLine(reference.identifier);
  if (!identifier) return undefined;
  const title = reference.title === undefined ? undefined : sanitizeLine(reference.title);
  const state = reference.state;
  return {
    identifier,
    ...(title ? { title } : {}),
    ...(state ? { state } : {}),
  };
}

/**
 * Applies the published bounds. Returns undefined when there is nothing to
 * say — no title, no description, no linked references — so a caller can skip
 * the section entirely instead of rendering an empty one a rule would have to
 * reason about the absence of.
 */
export function sanitizePrIntent(input: {
  title: string;
  description: string;
  linked?: readonly PrIntentReference[];
}): PrIntent | undefined {
  const title = truncate(sanitizeLine(input.title), MAX_INTENT_TITLE_CHARS);
  const description = truncate(sanitizeProse(input.description), MAX_INTENT_DESCRIPTION_CHARS);
  const linked = (input.linked ?? [])
    .map(sanitizePrIntentReference)
    .filter((reference): reference is PrIntentReference => reference !== undefined);
  if (title === undefined && description === undefined && linked.length === 0) return undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(linked.length === 0 ? {} : { linked }),
  };
}

/** The section body, line-shaped for embedding under the boundary token. */
export function prIntentText(intent: PrIntent): string {
  const lines: string[] = [];
  if (intent.title !== undefined) lines.push(`Title: ${intent.title}`);
  if (intent.description !== undefined) lines.push(`Description:\n${intent.description}`);
  for (const reference of intent.linked ?? []) {
    const title = reference.title === undefined ? "" : ` "${reference.title}"`;
    const state = reference.state === undefined ? "" : ` (${reference.state})`;
    lines.push(`Linked: ${reference.identifier}${title}${state}`);
  }
  return lines.join("\n");
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update(":");
  hash.update(value);
}

/**
 * Fingerprints the sanitized intent for same-SHA deduplication: the PR body is
 * editable, and an edit changes review input, so it must re-trigger a review
 * instead of matching a stale marker. Resolved linked titles and states ride
 * along — they are rendered into the section, so a change upstream is a change
 * in what the reviewer reads. Undefined when there is no intent, mirroring the
 * optional relatedWorkFingerprint this extends.
 */
export function prIntentFingerprint(intent: PrIntent | undefined): string | undefined {
  if (intent === undefined) return undefined;
  const canonical = JSON.stringify([
    intent.title ?? null,
    intent.description ?? null,
    (intent.linked ?? []).map((reference) => [
      reference.identifier,
      reference.title ?? null,
      reference.state ?? null,
    ]),
  ]);
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, canonical);
  return hash.digest("hex").slice(0, 16);
}
