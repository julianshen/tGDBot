import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_BODY_SCALARS,
  parseConversationCommand,
  scanMentionOccurrences,
} from "../../../src/conversation/command-parser.js";
import type { BotIdentity } from "../../../src/conversation/types.js";

const botIdentity: BotIdentity = { provider: "github", login: "tGDBot", mention: "@tGDBot" };
const parse = (body: string, authorIsBot = false) => parseConversationCommand({ authorIsBot, botIdentity, body });
const mem = `mem_${"a".repeat(12)}`;
const pending = `clar_${"b".repeat(12)}`;

describe("conversation command parser", () => {
  it.each([
    ["@tGDBot explain", { kind: "explain" }, "@tgdbot explain"],
    ["@tGDBot check latest", { kind: "check-latest" }, "@tgdbot check latest"],
    ["@tGDBot memories", { kind: "memories" }, "@tgdbot memories"],
    ["@tGDBot reconsider because This is safe", { kind: "reconsider", reason: "because This is safe" }, "@tgdbot reconsider because This is safe"],
    ["@tGDBot review focus: concurrency", { kind: "review-focus", direction: "concurrency" }, "@tgdbot review focus: concurrency"],
    ["@tGDBot remember Prefer explicit types", { kind: "remember", lesson: "Prefer explicit types" }, "@tgdbot remember Prefer explicit types"],
    [`@tGDBot forget ${mem}`, { kind: "forget", memoryId: mem }, `@tgdbot forget ${mem}`],
    [`@tGDBot answer ${pending}: It is intentional`, { kind: "answer", pendingId: pending, answer: "It is intentional" }, `@tgdbot answer ${pending}: It is intentional`],
  ])("parses %s", (body, command, normalized) => {
    expect(parse(body)).toEqual({ kind: "command", command, normalized });
  });

  it("matches authenticated mentions and keywords case-insensitively", () => {
    expect(parse("  @TGDBOT\tChEcK\tLaTeSt  ")).toEqual({
      kind: "command",
      command: { kind: "check-latest" },
      normalized: "@tgdbot check latest",
    });
    expect(parseConversationCommand({
      authorIsBot: false,
      botIdentity: { provider: "gitlab", login: "review-bot", mention: "@review-bot" },
      body: "@REVIEW-BOT memories",
    }).kind).toBe("command");
  });

  it.each(["", " ", "  ", "   "])("allows commands indented by at most three columns: %j", (indent) => {
    expect(parse(`${indent}@tGDBot explain`)).toEqual({
      kind: "command", command: { kind: "explain" }, normalized: "@tgdbot explain",
    });
  });

  it.each([
    ["four spaces", "    "],
    ["one leading tab", "\t"],
    ["space then tab", " \t"],
    ["two spaces then tab", "  \t"],
    ["three spaces then tab", "   \t"],
    ["four spaces and tab", "    \t"],
  ])("masks CommonMark indented code using indentation columns: %s", (_name, indent) => {
    expect(parse(`${indent}@tGDBot explain`)).toEqual({ kind: "irrelevant" });
  });

  it("masks indented code lines without hiding a later ordinary command", () => {
    expect(parse("    old example: @tGDBot memories\n\n@tGDBot explain")).toEqual({
      kind: "command", command: { kind: "explain" }, normalized: "@tgdbot explain",
    });
    expect(parse("    prose\n    @tGDBot explain\nordinary prose")).toEqual({ kind: "irrelevant" });
  });

  it("caps linear mention scanning after the second valid occurrence", () => {
    const repeated = "@tGDBot explain ".repeat(900);
    const scan = scanMentionOccurrences(repeated, "@tGDBot");
    expect(scan.positions).toHaveLength(2);
    expect(scan.candidatesExamined).toBe(2);
    expect(parse(repeated)).toEqual({ kind: "invalid", reason: "multiple" });

    const lookalikes = "@tGDBotx ".repeat(1_600);
    expect(Array.from(lookalikes).length).toBeLessThanOrEqual(MAX_COMMAND_BODY_SCALARS);
    expect(scanMentionOccurrences(lookalikes, "@tGDBot").positions).toEqual([]);
  });

  it("uses ASCII-only case folding for mentions and command keywords", () => {
    expect(parse("@tGDBot memorieſ")).toEqual({ kind: "invalid", reason: "unknown" });
    expect(parse("@tGDBot checK latest")).toEqual({ kind: "invalid", reason: "unknown" });
    expect(parse("@tGDBot check lateſt")).toEqual({ kind: "invalid", reason: "malformed" });
    expect(parse("@tGDBot review focuſ: security")).toEqual({ kind: "invalid", reason: "malformed" });
    expect(parseConversationCommand({
      authorIsBot: false,
      botIdentity: { provider: "github", login: "ask-bot", mention: "@ask-bot" },
      body: "@aſk-bot explain",
    })).toEqual({ kind: "irrelevant" });
    expect(parseConversationCommand({
      authorIsBot: false,
      botIdentity: { provider: "github", login: "böt", mention: "@böt" },
      body: "@BÖT explain",
    })).toEqual({ kind: "irrelevant" });
    expect(parseConversationCommand({
      authorIsBot: false,
      botIdentity: { provider: "github", login: "böt", mention: "@böt" },
      body: "@böt explain",
    })).toEqual({ kind: "irrelevant" });
    expect(parseConversationCommand({
      authorIsBot: false,
      botIdentity: { provider: "github", login: "someone-else", mention: "@tGDBot" },
      body: "@tGDBot explain",
    })).toEqual({ kind: "irrelevant" });
  });

  it("normalizes line endings, NFC, and argument horizontal whitespace stably", () => {
    const a = parse("@tGDBot remember Cafe\u0301\t  au\t lait\r\n");
    const b = parse("@TGDBOT\tREMEMBER Café au lait\n");
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "command", command: { kind: "remember", lesson: "Café au lait" }, normalized: "@tgdbot remember Café au lait" });
  });

  it.each([
    ["one scalar", "😀", "command"],
    ["exactly 2000 scalars", "😀".repeat(2000), "command"],
    ["2001 scalars", "😀".repeat(2001), "oversized"],
  ])("counts Unicode scalars for argument bounds: %s", (_name, argument, expected) => {
    const result = parse(`@tGDBot remember ${argument}`);
    expect(result.kind === "invalid" ? result.reason : result.kind).toBe(expected);
  });

  it.each([12, 32])("accepts %i-character lowercase base32 IDs", (length) => {
    const memoryId = `mem_${"234567abcdefghijkmnpqrstuvwxyz".slice(0, length).padEnd(length, "a")}`;
    const pendingId = `clar_${"z".repeat(length)}`;
    expect(parse(`@tGDBot forget ${memoryId}`).kind).toBe("command");
    expect(parse(`@tGDBot answer ${pendingId}: yes`).kind).toBe("command");
  });

  it.each([
    `mem_${"a".repeat(11)}`,
    `mem_${"a".repeat(33)}`,
    `mem_${"A".repeat(12)}`,
    `mem_${"0".repeat(12)}`,
    `mem_${"1".repeat(12)}`,
  ])("rejects a noncanonical memory ID: %s", (id) => {
    expect(parse(`@tGDBot forget ${id}`)).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("masks fenced and inline code, blockquotes, HTML comments, and provider quote regions", () => {
    for (const body of [
      "```md\n@tGDBot explain\n```",
      "````\n```\n@tGDBot explain\n```\n````",
      "`````\n@tGDBot explain",
      "~~~md\n@tGDBot explain\n~~~~  ",
      "  ~~~~~\n@tGDBot explain",
      "~~~~\n@tGDBot explain\n~~~\n@tGDBot memories",
      "~~~\n@tGDBot explain\n```\n@tGDBot memories",
      "text `@tGDBot explain`",
      "text ``code ` @tGDBot explain``",
      "> @tGDBot explain",
      "  >> @tGDBot explain",
      "<!-- @tGDBot explain -->",
      "<!-- tgd-provider-quote:github:start -->\n@tGDBot explain\n<!-- tgd-provider-quote:github:end -->",
      "<!-- tgd-provider-quote:gitlab:start -->\n@tGDBot explain\n<!-- tgd-provider-quote:gitlab:end -->",
    ]) expect(parse(body)).toEqual({ kind: "irrelevant" });
  });

  it("does not treat unmatched backticks as code spans", () => {
    expect(parse("`@tGDBot explain")).toEqual({ kind: "invalid", reason: "malformed" });
    expect(parse("unmatched ` then @tGDBot explain")).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("recognizes only exact, provider-matched native quote sentinels", () => {
    expect(parse("<!-- tgd-provider-quote:github:start -->\n@tGDBot explain\n<!-- tgd-provider-quote:gitlab:end -->")).toEqual({ kind: "irrelevant" });
    expect(parse("<!-- tgd-provider-quote:github:start -->\n@tGDBot explain\n<!-- tgd-provider-quote:github:END -->")).toEqual({ kind: "irrelevant" });
    expect(parse("<!--  tgd-provider-quote:github:start -->\n@tGDBot explain\n<!-- tgd-provider-quote:github:end -->")).toEqual({
      kind: "command", command: { kind: "explain" }, normalized: "@tgdbot explain",
    });
  });

  it("allows one command beside masked quoted material", () => {
    expect(parse("> old: @tGDBot forget mem_bad\n\n@tGDBot explain")).toEqual({
      kind: "command", command: { kind: "explain" }, normalized: "@tgdbot explain",
    });
  });

  it("masks lazy continuation lines in blockquote paragraphs", () => {
    expect(parse("> quoted text\n@tGDBot explain")).toEqual({ kind: "irrelevant" });
    expect(parse("> first quoted line\n> second quoted line\n@tGDBot memories")).toEqual({ kind: "irrelevant" });
    expect(parse("> > nested quote\n>> nested again\n@tGDBot explain")).toEqual({ kind: "irrelevant" });
  });

  it("ends lazy blockquote continuation at deterministic block boundaries", () => {
    expect(parse("> quoted text\n\n@tGDBot explain")).toEqual({
      kind: "command", command: { kind: "explain" }, normalized: "@tgdbot explain",
    });
    expect(parse("> quoted text\n```\n@tGDBot explain\n```")).toEqual({ kind: "irrelevant" });
    expect(parse("> quoted text\n- new list block\n@tGDBot explain")).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it.each([
    ["surrounding prose", "please @tGDBot explain", "malformed"],
    ["trailing prose", "@tGDBot explain please", "malformed"],
    ["multiline argument", "@tGDBot remember first\nsecond", "malformed"],
    ["two commands", "@tGDBot explain\n@tGDBot memories", "multiple"],
    ["two commands same line", "@tGDBot explain @tGDBot memories", "multiple"],
    ["missing argument", "@tGDBot remember", "malformed"],
    ["bad focus punctuation", "@tGDBot review focus： security", "malformed"],
    ["unknown keyword", "@tGDBot dance", "unknown"],
    ["control", "@tGDBot remember bad\u0000value", "malformed"],
    ["C1 control", "@tGDBot remember bad\u0085value", "malformed"],
    ["bidi", "@tGDBot remember bad\u202evalue", "malformed"],
    ["unpaired surrogate", "@tGDBot remember bad\ud800value", "malformed"],
    ["function application format", "@tGDBot remember bad\u2061value", "malformed"],
    ["invisible separator format", "@tGDBot remember bad\u2063value", "malformed"],
    ["variation selector", "@tGDBot remember bad\ufe0fvalue", "malformed"],
    ["supplemental variation selector", "@tGDBot remember bad\u{e0100}value", "malformed"],
    ["soft hyphen format", "@tGDBot remember bad\u00advalue", "malformed"],
    ["invisible plus format", "@tGDBot remember bad\u2064value", "malformed"],
    ["NBSP grammar whitespace", "@tGDBot\u00a0explain", "malformed"],
    ["em-space argument", "@tGDBot remember bad\u2003value", "malformed"],
  ])("classifies %s", (_name, body, reason) => {
    expect(parse(body)).toEqual({ kind: "invalid", reason });
  });

  it.each([
    "ordinary prose",
    "@anotherBot explain",
    "＠tGDBot explain",
    "@tGDBоt explain",
    "email@tGDBot explain",
    "@tGDBotany explain",
    "@tGDBot\u0301 explain",
    "@tGDBoté explain",
    "@tGDBot\u200b explain",
  ])("ignores non-command and mention lookalike text: %s", (body) => {
    expect(parse(body)).toEqual({ kind: "irrelevant" });
  });

  it.each([
    `clar_${"a".repeat(11)}`,
    `clar_${"a".repeat(33)}`,
    `clar_${"A".repeat(12)}`,
    `clar_${"0".repeat(12)}`,
    `clar_${"1".repeat(12)}`,
    `clar_${"8".repeat(12)}`,
    `clar_${"9".repeat(12)}`,
    `pending_${"a".repeat(12)}`,
  ])("rejects a noncanonical pending ID: %s", (id) => {
    expect(parse(`@tGDBot answer ${id}: yes`)).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it.each([
    `mem_${"8".repeat(12)}`,
    `mem_${"9".repeat(12)}`,
    `memory_${"a".repeat(12)}`,
    `mem-${"a".repeat(12)}`,
  ])("rejects another malformed memory ID: %s", (id) => {
    expect(parse(`@tGDBot forget ${id}`)).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it.each([
    `@tGDBot answer ${pending} yes`,
    `@tGDBot answer ${pending}： yes`,
    `@tGDBot answer wrong_${"a".repeat(12)}: yes`,
  ])("rejects malformed pending ID punctuation: %s", (body) => {
    expect(parse(body)).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("rejects bot-authored events before inspecting the body", () => {
    expect(parse("@tGDBot remember bad\u0000value", true)).toEqual({ kind: "irrelevant" });
  });

  it("bounds the raw body even when masked", () => {
    expect(parse(`@tGDBot <!--${"x".repeat(MAX_COMMAND_BODY_SCALARS)}-->`)).toEqual({ kind: "invalid", reason: "oversized" });
  });

  // An oversized body is checked before the body is parsed at all, so without
  // this a long comment that never addressed tGDBot is "invalid" rather than
  // irrelevant — and invalid commands get usage help. That means replying,
  // unprompted, to any sufficiently long comment on the review.
  it("leaves an oversized comment that never mentions the bot irrelevant", () => {
    expect(parse("x".repeat(MAX_COMMAND_BODY_SCALARS + 1))).toEqual({ kind: "irrelevant" });
  });

  it("still answers an oversized comment that does address the bot", () => {
    expect(parse(`@tGDBot ${"x".repeat(MAX_COMMAND_BODY_SCALARS)}`))
      .toEqual({ kind: "invalid", reason: "oversized" });
  });

  it.each([
    `\`@tGDBot\` ${"x".repeat(MAX_COMMAND_BODY_SCALARS)}`,
    `> @tGDBot\n> ${"x".repeat(MAX_COMMAND_BODY_SCALARS)}`,
    `<!-- @tGDBot ${"x".repeat(MAX_COMMAND_BODY_SCALARS)} -->`,
  ])("ignores an oversized comment whose only mention is masked", (body) => {
    expect(parse(body)).toEqual({ kind: "irrelevant" });
  });
});
