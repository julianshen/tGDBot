import type { BotIdentity, CommandParseResult, ConversationCommand } from "./types.js";

export const MAX_COMMAND_ARGUMENT_SCALARS = 2_000;
export const MAX_COMMAND_BODY_SCALARS = 16_384;
export const COMMAND_ID_BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const ILLEGAL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const FORMAT_RE = /\p{Cf}/u;
const VARIATION_SELECTOR_RE = /[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
const NON_ASCII_WHITESPACE_RE = /[\u000b\u000c\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const ID_RE = new RegExp(`^[${COMMAND_ID_BASE32_ALPHABET}]{12,32}$`, "u");
const PROVIDER_QUOTE_START = {
  github: "<!-- tgd-provider-quote:github:start -->",
  gitlab: "<!-- tgd-provider-quote:gitlab:start -->",
} as const;
const PROVIDER_QUOTE_END = {
  github: "<!-- tgd-provider-quote:github:end -->",
  gitlab: "<!-- tgd-provider-quote:gitlab:end -->",
} as const;

export interface CommandParseInput {
  readonly authorIsBot: boolean;
  readonly botIdentity: BotIdentity;
  readonly body: string;
}

function scalarLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; count += 1) {
    const point = value.codePointAt(index)!;
    index += point > 0xffff ? 2 : 1;
  }
  return count;
}

function inspectBody(value: string): { readonly scalars: number; readonly hasUnpairedSurrogate: boolean } {
  let scalars = 0;
  let hasUnpaired = false;
  for (let index = 0; index < value.length; index += 1) {
    scalars += 1;
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else hasUnpaired = true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      hasUnpaired = true;
    }
  }
  return { scalars, hasUnpairedSurrogate: hasUnpaired };
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function isMentionContinuation(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}\p{M}_.@-]|\p{Cf}|[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(value);
}

function codePointBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  let start = index - 1;
  const unit = value.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
    const previous = value.charCodeAt(start - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
  }
  const point = value.codePointAt(start);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function codePointAt(value: string, index: number): string | undefined {
  const point = value.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

export interface MentionOccurrenceScan {
  readonly positions: readonly number[];
  /** Exact mention substrings inspected before the valid-match cap was reached. */
  readonly candidatesExamined: number;
}

/** Linear scan capped after two valid mentions, the only states the parser needs. */
export function scanMentionOccurrences(body: string, mention: string): MentionOccurrenceScan {
  const asciiIdentity = /^[\x00-\x7f]+$/u.test(mention);
  const comparableBody = asciiIdentity ? asciiFold(body) : body;
  const comparableMention = asciiIdentity ? asciiFold(mention) : mention;
  const positions: number[] = [];
  let candidatesExamined = 0;
  let cursor = 0;
  while (positions.length < 2 && cursor <= body.length - mention.length) {
    const position = comparableBody.indexOf(comparableMention, cursor);
    if (position < 0) break;
    candidatesExamined += 1;
    const previous = codePointBefore(body, position);
    const next = codePointAt(body, position + mention.length);
    if (!isMentionContinuation(previous) && !isMentionContinuation(next)) positions.push(position);
    cursor = position + Math.max(mention.length, 1);
  }
  return { positions, candidatesExamined };
}

function blank(value: string): string {
  return value.replace(/[^\n]/gu, " ");
}

/**
 * Provider adapters may wrap an unavailable native quote range in these exact
 * sentinels before parsing:
 * `<!-- tgd-provider-quote:<github|gitlab>:start -->` and the matching `end`.
 * The sentinels and everything between them are non-executable. An unclosed
 * region is non-executable through EOF.
 */
function maskProviderQuoteRegions(body: string): string {
  const lines = body.split("\n");
  let quoted: keyof typeof PROVIDER_QUOTE_START | undefined;
  return lines.map((line) => {
    if (!quoted) {
      for (const provider of ["github", "gitlab"] as const) {
        if (line === PROVIDER_QUOTE_START[provider]) {
          quoted = provider;
          return blank(line);
        }
      }
    }
    if (quoted) {
      if (line === PROVIDER_QUOTE_END[quoted]) quoted = undefined;
      return blank(line);
    }
    return line;
  }).join("\n");
}

function maskFencesAndBlockquotes(body: string): string {
  const lines = body.split("\n");
  let fenceLength = 0;
  let fenceCharacter: "`" | "~" | undefined;
  let quotedParagraph = false;
  return lines.map((line) => {
    if (fenceCharacter) {
      const closer = line.match(/^ {0,3}(`+|~+)[ \t]*$/u);
      if (closer && closer[1]![0] === fenceCharacter && closer[1]!.length >= fenceLength) {
        fenceLength = 0;
        fenceCharacter = undefined;
      }
      return blank(line);
    }

    if (/^[ \t]*$/u.test(line)) {
      quotedParagraph = false;
      return line;
    }

    let indentationColumns = 0;
    for (const character of line) {
      if (character === " ") indentationColumns += 1;
      else if (character === "\t") indentationColumns += 4 - (indentationColumns % 4);
      else break;
      if (indentationColumns >= 4) return blank(line);
    }

    if (/^ {0,3}>/u.test(line)) {
      const content = line.replace(/^ {0,3}(?:>[ \t]?)+/u, "");
      quotedParagraph = /[^ \t]/u.test(content);
      return blank(line);
    }

    const opener = line.match(/^ {0,3}(`{3,})([^`]*)$/u) ?? line.match(/^ {0,3}(~{3,})(.*)$/u);
    const listBlock = /^ {0,3}(?:[-+*][ \t]+|\d{1,9}[.)][ \t]+)/u.test(line);
    if (quotedParagraph && !opener && !listBlock) return blank(line);
    if (quotedParagraph) quotedParagraph = false;

    if (opener) {
      fenceLength = opener[1]!.length;
      fenceCharacter = opener[1]![0] as "`" | "~";
      return blank(line);
    }
    return line;
  }).join("\n");
}

function maskDelimited(body: string, start: number, end: number): string {
  return `${body.slice(0, start)}${blank(body.slice(start, end))}${body.slice(end)}`;
}

function maskHtmlComments(body: string): string {
  let masked = body;
  let cursor = 0;
  while (cursor < masked.length) {
    const start = masked.indexOf("<!--", cursor);
    if (start < 0) break;
    const close = masked.indexOf("-->", start + 4);
    const end = close < 0 ? masked.length : close + 3;
    masked = maskDelimited(masked, start, end);
    cursor = end;
  }
  return masked;
}

function maskInlineCode(body: string): string {
  let masked = body;
  let cursor = 0;
  while (cursor < masked.length) {
    const opener = /`+/gu;
    opener.lastIndex = cursor;
    const match = opener.exec(masked);
    if (!match) break;
    const run = match[0];
    const start = match.index;
    let closerStart = -1;
    const candidates = /`+/gu;
    candidates.lastIndex = start + run.length;
    for (let candidate = candidates.exec(masked); candidate; candidate = candidates.exec(masked)) {
      if (candidate[0].length === run.length) {
        closerStart = candidate.index;
        break;
      }
    }
    if (closerStart < 0) {
      cursor = start + run.length;
      continue;
    }
    const end = closerStart + run.length;
    masked = maskDelimited(masked, start, end);
    cursor = end;
  }
  return masked;
}

function maskMarkdown(body: string): string {
  return maskInlineCode(maskHtmlComments(maskFencesAndBlockquotes(maskProviderQuoteRegions(body))));
}

function normalizeArgument(value: string): string {
  return value.normalize("NFC").replace(/^[ \t]+|[ \t]+$/gu, "").replace(/[ \t]+/gu, " ");
}

function commandResult(command: ConversationCommand, normalized: string): CommandParseResult {
  return { kind: "command", command, normalized };
}

function malformed(): CommandParseResult {
  return { kind: "invalid", reason: "malformed" };
}

/**
 * Case-insensitive presence check for the authenticated mention, used only to
 * decide whether an unparseable body was addressed to tGDBot. This is not the
 * command grammar's mention match — that is exact and anchored.
 */
function mentionsBot(body: string, botIdentity: BotIdentity): boolean {
  return body.toLowerCase().includes(botIdentity.mention.toLowerCase());
}

export function parseConversationCommand(input: CommandParseInput): CommandParseResult {
  if (input.authorIsBot) return { kind: "irrelevant" };
  if (typeof input.body !== "string") return { kind: "invalid", reason: "malformed" };
  const bodyInspection = inspectBody(input.body);
  if (bodyInspection.scalars > MAX_COMMAND_BODY_SCALARS) {
    // Too large to parse, so it can never be a valid command. Whether that is
    // worth a public reply depends on whether the author was talking to us: a
    // long comment between humans must stay irrelevant, or tGDBot answers with
    // usage help nobody asked for. A body this size cannot be a well-formed
    // command anyway, so the mention only decides silence versus help.
    return mentionsBot(input.body, input.botIdentity)
      ? { kind: "invalid", reason: "oversized" }
      : { kind: "irrelevant" };
  }
  if (
    !/^[\x00-\x7f]+$/u.test(input.botIdentity.mention) ||
    !/^[\x00-\x7f]+$/u.test(input.botIdentity.login) ||
    asciiFold(input.botIdentity.mention) !== `@${asciiFold(input.botIdentity.login)}`
  ) return { kind: "irrelevant" };

  const lineNormalizedBody = input.body.replace(/\r\n?|\n/gu, "\n");
  const rawMasked = maskMarkdown(lineNormalizedBody);
  const rawMention = input.botIdentity.mention;
  const rawMentions = scanMentionOccurrences(rawMasked, rawMention).positions;
  if (rawMentions.length === 1) {
    const afterRawMention = rawMasked.slice(rawMentions[0]! + rawMention.length);
    const rawKeyword = /^[ \t]+([^ \t\n]+)/u.exec(afterRawMention)?.[1];
    if (rawKeyword && !/^[\x00-\x7f]+$/u.test(rawKeyword)) return { kind: "invalid", reason: "unknown" };
  }

  const body = lineNormalizedBody.normalize("NFC");
  const masked = maskMarkdown(body);
  const mention = input.botIdentity.mention.normalize("NFC");
  const mentions = scanMentionOccurrences(masked, mention).positions;
  if (mentions.length === 0) return { kind: "irrelevant" };
  if (mentions.length > 1) return { kind: "invalid", reason: "multiple" };
  if (
    ILLEGAL_CONTROL_RE.test(body) ||
    FORMAT_RE.test(masked) ||
    VARIATION_SELECTOR_RE.test(masked) ||
    NON_ASCII_WHITESPACE_RE.test(masked) ||
    bodyInspection.hasUnpairedSurrogate
  ) return malformed();

  let offset = 0;
  const nonemptyLines = masked.split("\n").flatMap((line) => {
    const entry = /[^ \t]/u.test(line) ? [{ line, offset }] : [];
    offset += line.length + 1;
    return entry;
  });
  if (nonemptyLines.length !== 1) return malformed();
  const { line, offset: lineOffset } = nonemptyLines[0]!;
  const leadingLength = /^[ \t]*/u.exec(line)![0].length;
  if (mentions[0] !== lineOffset + leadingLength) return malformed();
  const afterMention = line.slice(leadingLength + mention.length);
  const separator = /^[ \t]+/u.exec(afterMention);
  if (!separator) return malformed();
  const action = afterMention.slice(separator[0].length).replace(/[ \t]+$/u, "");
  const foldedAction = asciiFold(action);
  const canonicalMention = asciiFold(mention);

  if (foldedAction === "explain") return commandResult({ kind: "explain" }, `${canonicalMention} explain`);
  if (/^check[ \t]+latest$/u.test(foldedAction)) return commandResult({ kind: "check-latest" }, `${canonicalMention} check latest`);
  if (foldedAction === "memories") return commandResult({ kind: "memories" }, `${canonicalMention} memories`);

  const argumentCommands: readonly [RegExp, "reconsider" | "remember"][] = [
    [/^reconsider[ \t]+(.+)$/u, "reconsider"],
    [/^remember[ \t]+(.+)$/u, "remember"],
  ];
  for (const [pattern, kind] of argumentCommands) {
    const match = pattern.exec(foldedAction);
    if (!match) continue;
    const argument = normalizeArgument(action.slice(action.length - match[1]!.length));
    if (scalarLength(argument) > MAX_COMMAND_ARGUMENT_SCALARS) return { kind: "invalid", reason: "oversized" };
    if (argument.length === 0) return malformed();
    const command: ConversationCommand = kind === "reconsider"
      ? { kind, reason: argument }
      : { kind, lesson: argument };
    return commandResult(command, `${canonicalMention} ${kind} ${argument}`);
  }

  const focus = /^review[ \t]+focus:[ \t]*(.*)$/u.exec(foldedAction);
  if (focus) {
    const direction = normalizeArgument(action.slice(action.length - focus[1]!.length));
    if (scalarLength(direction) > MAX_COMMAND_ARGUMENT_SCALARS) return { kind: "invalid", reason: "oversized" };
    if (direction.length === 0) return malformed();
    return commandResult({ kind: "review-focus", direction }, `${canonicalMention} review focus: ${direction}`);
  }

  const forget = /^forget[ \t]+(\S+)$/u.exec(foldedAction);
  if (forget) {
    const memoryId = action.slice(action.length - forget[1]!.length);
    if (!memoryId.startsWith("mem_") || !ID_RE.test(memoryId.slice(4))) return malformed();
    return commandResult({ kind: "forget", memoryId }, `${canonicalMention} forget ${memoryId}`);
  }

  const answer = /^answer[ \t]+(\S+?)[ \t]*:[ \t]*(.*)$/u.exec(foldedAction);
  if (answer) {
    const prefixLength = answer[0].length - answer[2]!.length;
    const pendingIdStart = foldedAction.indexOf(answer[1]!);
    const pendingId = action.slice(pendingIdStart, pendingIdStart + answer[1]!.length);
    const response = normalizeArgument(action.slice(prefixLength));
    if (!pendingId.startsWith("clar_") || !ID_RE.test(pendingId.slice(5)) || response.length === 0) return malformed();
    if (scalarLength(response) > MAX_COMMAND_ARGUMENT_SCALARS) return { kind: "invalid", reason: "oversized" };
    return commandResult({ kind: "answer", pendingId, answer: response }, `${canonicalMention} answer ${pendingId}: ${response}`);
  }

  const keyword = /^([^ \t]+)/u.exec(foldedAction)?.[1];
  if (keyword && !["explain", "check", "memories", "reconsider", "review", "remember", "forget", "answer"].includes(keyword)) {
    return { kind: "invalid", reason: "unknown" };
  }
  return malformed();
}
