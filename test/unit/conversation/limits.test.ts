// The resource-limit contract, in one place.
//
// Individual limits are exercised where they are enforced; what this file adds
// is the pair of properties those tests cannot state on their own: that each
// ceiling still holds the value the rest of the system was designed and
// documented around, and that the boundary is where it claims to be. Several
// of these ceilings were previously asserted only through literals, so a
// constant could be changed without a single test noticing.
import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_ARGUMENT_SCALARS,
  MAX_COMMAND_BODY_SCALARS,
  parseConversationCommand,
} from "../../../src/conversation/command-parser.js";
import { MAX_CONTEXT_CHARS, MAX_CONTEXT_COMMENTS } from "../../../src/conversation/context.js";
import { MAX_PUBLIC_CONVERSATION_BODY_CHARS } from "../../../src/conversation/render.js";
import {
  MAX_CONVERSATION_PROMPT_CHARS,
  MAX_CONVERSATION_RESPONSE_CHARS,
} from "../../../src/conversation/session.js";
import { MAX_ACTIVE_MEMORIES } from "../../../src/conversation/state-schema.js";
import { MAX_POLL_EVENTS } from "../../../src/poll/config.js";

const botIdentity = { provider: "github" as const, login: "tgdbot", mention: "@tgdbot" };

function parse(body: string) {
  return parseConversationCommand({ body, botIdentity, authorIsBot: false });
}

describe("resource ceilings", () => {
  // Changing any of these changes behaviour a human was told about — the
  // README quotes several of them — so a change has to be deliberate enough to
  // update this table too.
  it("holds the values the system is documented and designed around", () => {
    expect({
      pollEventsPerInvocation: MAX_POLL_EVENTS,
      commandBodyScalars: MAX_COMMAND_BODY_SCALARS,
      commandArgumentScalars: MAX_COMMAND_ARGUMENT_SCALARS,
      activeMemories: MAX_ACTIVE_MEMORIES,
      contextComments: MAX_CONTEXT_COMMENTS,
      contextChars: MAX_CONTEXT_CHARS,
      modelPromptChars: MAX_CONVERSATION_PROMPT_CHARS,
      modelResponseChars: MAX_CONVERSATION_RESPONSE_CHARS,
      publicReplyChars: MAX_PUBLIC_CONVERSATION_BODY_CHARS,
    }).toEqual({
      pollEventsPerInvocation: 200,
      commandBodyScalars: 16_384,
      commandArgumentScalars: 2_000,
      activeMemories: 200,
      contextComments: 100,
      contextChars: 100_000,
      modelPromptChars: 100_000,
      modelResponseChars: 100_000,
      publicReplyChars: 32_000,
    });
  });

  it("defines the poll batch size exactly once", async () => {
    // It lived in both poll/config.ts and poll/discovery.ts, and only the
    // config one was imported. Changing the other looked like it would resize
    // the batch and did nothing at all.
    const discovery = await import("../../../src/poll/discovery.js");
    expect(Object.hasOwn(discovery, "MAX_POLL_EVENTS")).toBe(false);
  });
});

describe("command ceilings are enforced at their stated boundary", () => {
  it("accepts an argument of exactly the limit and rejects one scalar more", () => {
    expect(parse(`@tgdbot remember ${"a".repeat(MAX_COMMAND_ARGUMENT_SCALARS)}`))
      .toMatchObject({ kind: "command" });
    expect(parse(`@tgdbot remember ${"a".repeat(MAX_COMMAND_ARGUMENT_SCALARS + 1)}`))
      .toEqual({ kind: "invalid", reason: "oversized" });
  });

  it("counts an argument in Unicode scalars, not UTF-16 units", () => {
    // Astral characters are two UTF-16 units each; counting those instead
    // would halve the real limit without anyone noticing.
    expect(parse(`@tgdbot remember ${"😀".repeat(MAX_COMMAND_ARGUMENT_SCALARS)}`))
      .toMatchObject({ kind: "command" });
    expect(parse(`@tgdbot remember ${"😀".repeat(MAX_COMMAND_ARGUMENT_SCALARS + 1)}`))
      .toEqual({ kind: "invalid", reason: "oversized" });
  });

  // The body ceiling bounds the RAW comment, before masking, so it has to be
  // measured with padding that the grammar ignores. Padding with a long
  // argument instead would hit the 2,000-scalar argument limit first and prove
  // nothing about the body limit at all.
  it("bounds the raw body at exactly the limit, counting masked regions", () => {
    const command = "@tgdbot remember ok";
    const wrapper = "<!---->".length;
    const padding = MAX_COMMAND_BODY_SCALARS - command.length - wrapper;
    expect(parse(`${command}<!--${"x".repeat(padding)}-->`)).toMatchObject({ kind: "command" });
    expect(parse(`${command}<!--${"x".repeat(padding + 1)}-->`))
      .toEqual({ kind: "invalid", reason: "oversized" });
  });
});
