// Issue #57, stage 3. The reply a verification posts is not the reply a
// requested reconsideration posts: nobody asked for this one, so it has to say
// why it is speaking, and it must not restate the finding the thread already
// carries above it.
import { describe, expect, it } from "vitest";
import { renderVerificationReply } from "../../../src/conversation/render.js";

const marker = "<!-- tgd-verification -->";

const input = (over: Record<string, unknown> = {}) => ({
  verdict: "confirmed" as const,
  trigger: "thread-comment" as const,
  rationale: "The null check moved, but the early return below it is still reachable.",
  ...over,
});

describe("renderVerificationReply", () => {
  it("says a withdrawn finding no longer holds", () => {
    const body = renderVerificationReply(input({ verdict: "withdrawn" }), marker).text;

    expect(body).toMatch(/no longer|resolved|addressed/i);
  });

  it("carries the reading of the code as it stands now", () => {
    const body = renderVerificationReply(input(), marker).text;

    expect(body).toContain("the early return below it is still reachable");
  });

  // The original finding is directly above this reply in the same thread.
  // Repeating it is noise, and the acceptance criteria forbid it.
  it("does not restate the original finding", () => {
    const body = renderVerificationReply(input({
      finding: {
        ruleName: "r", file: "a.ts", line: 1, category: "c",
        severity: "warning", message: "ORIGINAL-FINDING-TEXT",
      },
    }), marker).text;

    expect(body).not.toContain("ORIGINAL-FINDING-TEXT");
  });

  // Nobody asked for this reply, so it says what prompted it.
  it("says what prompted it", () => {
    expect(renderVerificationReply(input({ trigger: "thread-comment" }), marker).text)
      .toMatch(/repl(y|ied)/i);
    expect(renderVerificationReply(input({ trigger: "head-change" }), marker).text)
      .toMatch(/push|new commit|changed/i);
    expect(renderVerificationReply(input({ trigger: "thread-resolution" }), marker).text)
      .toMatch(/resolved/i);
  });

  it("offers a way to disagree when the finding still stands", () => {
    const body = renderVerificationReply(input({ botLogin: "acme-bot" }), marker).text;

    expect(body).toContain("@acme-bot reconsider");
    expect(body).toContain("@acme-bot accept");
    expect(body).toContain("@acme-bot defer");
  });

  it("omits the invitation when it withdrew the finding", () => {
    const body = renderVerificationReply(
      input({ verdict: "withdrawn", botLogin: "acme-bot" }), marker,
    ).text;

    expect(body).not.toContain("reconsider");
  });

  // The rationale is model output reaching a world-readable comment.
  it("sanitizes the rationale", () => {
    const body = renderVerificationReply(input({
      rationale: "```suggestion\nrm -rf /\n```",
    }), marker).text;

    expect(body).not.toContain("```suggestion");
  });

  it("carries the marker", () => {
    expect(renderVerificationReply(input(), marker).text).toContain(marker);
  });
});

// PR #73 review. Both of these make the invitation useless in a different way:
// one renders a mention that does not match any account, the other drops the
// line entirely when the model is verbose.
describe("renderVerificationReply — the invitation has to survive and to work", () => {
  it("does not markdown-escape a login", () => {
    const body = renderVerificationReply(input({ botLogin: "acme_bot" }), marker).text;

    expect(body).toContain("@acme_bot reconsider");
    expect(body).not.toContain("acme\\_bot");
  });

  // The command itself is wrapped in backticks, so the check is on the LOGIN:
  // nothing that would break out of that span, and no whitespace.
  it("still strips anything that is not part of a login", () => {
    const body = renderVerificationReply(input({ botLogin: "acme`bot with spaces" }), marker).text;

    expect(body).toContain("@acmebotwithspaces reconsider");
    expect(body).not.toContain("acme`bot");
  });

  // The body is truncated from the END, so a long rationale could push the
  // command off it — leaving a reader told they can disagree but not how.
  it("keeps the command when the rationale is enormous", () => {
    const body = renderVerificationReply(input({
      rationale: "x".repeat(100_000),
      botLogin: "acme-bot",
    }), marker).text;

    expect(body).toContain("@acme-bot reconsider");
  });
});
