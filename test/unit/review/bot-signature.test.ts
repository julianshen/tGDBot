// The signature names the model that produced the review. A reader looking at
// a finding they disagree with should be able to tell what wrote it without
// digging through CI logs — and when a repository changes models, old comments
// stay attributable to the one that actually ran.
import { describe, expect, it } from "vitest";
import {
  BOT_SIGNATURE,
  BOT_SIGNATURE_BLOCK,
  botSignature,
  botSignatureBlock,
} from "../../../src/review/comment-format.js";
import { stripSignature } from "../../../src/review/review-publication.js";

describe("botSignature", () => {
  it("names the model when one ran", () => {
    expect(botSignature(["anthropic/claude-opus-4-5"]))
      .toContain("anthropic/claude-opus-4-5");
  });

  it("still identifies the bot", () => {
    expect(botSignature(["anthropic/claude-opus-4-5"])).toContain("tGDBot");
  });

  // A run can pin different models per rule, and claiming one of them would be
  // wrong about the others.
  it("names every distinct model when rules pinned different ones", () => {
    const line = botSignature(["anthropic/claude-opus-4-5", "openai/gpt-5"]);

    expect(line).toContain("anthropic/claude-opus-4-5");
    expect(line).toContain("openai/gpt-5");
  });

  it("says each model once, however many rules used it", () => {
    const line = botSignature([
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-5",
    ]);

    expect(line.match(/claude-opus-4-5/gu)).toHaveLength(1);
  });

  it("bounds a pathological list rather than growing without limit", () => {
    const line = botSignature(Array.from({ length: 50 }, (_, i) => `p/model-${i}`));

    expect(line.length).toBeLessThan(200);
    expect(line).toMatch(/more/);
  });

  // The model spec is configuration, not diff content — but it reaches a
  // world-readable comment, so it goes through the same sanitizer as everything
  // else per ADR-006.
  it("sanitizes a hostile model spec", () => {
    const line = botSignature(["```suggestion\nrm -rf /\n```"]);

    expect(line).not.toContain("```suggestion");
    expect(line).not.toContain("\n");
  });

  // Unpinned rules on a provider default mean the host genuinely does not know
  // which model ran. Saying nothing beats naming the wrong one.
  it("falls back to the unadorned signature when no model is known", () => {
    expect(botSignature([])).toBe(BOT_SIGNATURE);
    expect(botSignature(undefined)).toBe(BOT_SIGNATURE);
  });
});

// The signature is STRIPPED when a body is composed into a larger comment
// (#64). Making it name a model means the strip can no longer match fixed
// bytes — and must still keep the properties that fix established.
describe("stripSignature — with a model-aware signature", () => {
  it("removes a model-signed footer", () => {
    const body = `Some finding text.\n\n${botSignatureBlock(["anthropic/claude-opus-4-5"])}`;

    expect(stripSignature(body)).toBe("Some finding text.");
  });

  it("still removes the unadorned footer", () => {
    expect(stripSignature(`Text.\n\n${BOT_SIGNATURE_BLOCK}`)).toBe("Text.");
  });

  it("keeps machine markers that follow it", () => {
    const body = `Text.\n\n${botSignatureBlock(["p/m"])}\n\n<!-- tgd-inline-comment id=1 -->`;

    expect(stripSignature(body)).toBe("Text.\n\n<!-- tgd-inline-comment id=1 -->");
  });

  // The property #64 established: a suggestion may legitimately contain the
  // block — a proposed edit to a Markdown footer — and removing it would
  // silently corrupt the proposed fix.
  it("leaves a signature that only appears inside a suggestion", () => {
    const body = [
      "Proposed fix:",
      "",
      "```suggestion",
      botSignatureBlock(["p/m"]),
      "```",
      "",
      "More text.",
    ].join("\n");

    expect(stripSignature(body)).toBe(body.trimEnd());
  });

  it("removes only the last footer when a suggestion also carries one", () => {
    const inner = botSignatureBlock(["p/m"]);
    const body = `Fix:\n\n\`\`\`suggestion\n${inner}\n\`\`\`\n\n${inner}`;

    const stripped = stripSignature(body);

    expect(stripped).toContain("```suggestion");
    expect(stripped).toContain(inner);
    expect(stripped.endsWith("```")).toBe(true);
  });
});

// End to end: the model has to travel from where dispatch resolved it to the
// comment a reader sees, or naming it is a function nobody calls.
describe("the model reaches the comments a run publishes", () => {
  const dispatchResult = {
    findings: [{
      ruleName: "tgd-review",
      file: "src/a.ts",
      line: 3,
      category: "correctness",
      severity: "warning" as const,
      message: "Something is wrong.",
      decision: "new" as const,
    }],
    rulesRun: ["tgd-review"],
    rulesFailed: [],
    modelsUsed: ["anthropic/claude-opus-4-5"],
  };

  // A diff the finding can actually anchor to, so this exercises the inline
  // path rather than the relocation path. The summary is signed later, by
  // composeFrozenSummary at publication time.
  const anchoredDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    " const b = 2;",
    "+const c = 3;",
  ].join("\n");

  it("names it on an inline comment", async () => {
    const { orchestrate } = await import("../../../src/review/orchestrate.js");

    const result = orchestrate(dispatchResult, anchoredDiff, { inline: true });

    expect(result.inlineComments.length).toBeGreaterThan(0);
    expect(result.inlineComments[0]!.body).toContain("anthropic/claude-opus-4-5");
  });

  it("carries the models on the orchestration result for the publisher", () => {
    expect(dispatchResult.modelsUsed).toEqual(["anthropic/claude-opus-4-5"]);
  });

  it("leaves comments unadorned when no model resolved", async () => {
    const { orchestrate } = await import("../../../src/review/orchestrate.js");
    const { modelsUsed: _dropped, ...withoutModels } = dispatchResult;

    const result = orchestrate(withoutModels, anchoredDiff, { inline: true });

    expect(result.inlineComments[0]!.body).not.toContain(" using ");
  });
});
