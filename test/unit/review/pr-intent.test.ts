// Issue #59: the PR's stated intent reaches the reviewer as bounded,
// sanitized, boundary-tokened UNTRUSTED evidence. This file pins the bounds
// (truncation on a code-point boundary, control-character stripping, empty
// collapse) and the dedup fingerprint that makes a description edit
// re-trigger a review.
import { describe, expect, it } from "vitest";
import {
  MAX_INTENT_DESCRIPTION_CHARS,
  MAX_INTENT_TITLE_CHARS,
  prIntentFingerprint,
  prIntentText,
  sanitizePrIntent,
} from "../../../src/review/pr-intent.js";

describe("sanitizePrIntent", () => {
  it("keeps title, description and linked identities intact", () => {
    const intent = sanitizePrIntent({
      title: "Fix the retry budget",
      description: "Makes the budget per-host.\n\nThe old global path was wrong.",
      linked: [{ identifier: "#41", title: "Fix the retry budget", state: "closed" }],
    });
    expect(intent).toEqual({
      title: "Fix the retry budget",
      description: "Makes the budget per-host.\n\nThe old global path was wrong.",
      linked: [{ identifier: "#41", title: "Fix the retry budget", state: "closed" }],
    });
  });

  it("returns undefined when there is nothing to say, so no empty section renders", () => {
    expect(sanitizePrIntent({ title: "", description: "  \n\t " })).toBeUndefined();
    expect(sanitizePrIntent({ title: "  ", description: "" })).toBeUndefined();
    expect(sanitizePrIntent({ title: "", description: "", linked: [] })).toBeUndefined();
  });

  it("keeps the section when only the title survives", () => {
    // An empty or whitespace-only description drops the DESCRIPTION line —
    // a rule never reasons about the absence of one — without discarding a
    // title that still says something.
    const intent = sanitizePrIntent({ title: "Step 1 of 3", description: "   " });
    expect(intent).toEqual({ title: "Step 1 of 3" });
  });

  it("truncates the title at its cap with a visible marker", () => {
    const intent = sanitizePrIntent({ title: "x".repeat(500), description: "" });
    expect(intent?.title?.length).toBe(MAX_INTENT_TITLE_CHARS);
    expect(intent?.title?.endsWith(" [truncated]")).toBe(true);
  });

  it("truncates the description at its cap on a code-point boundary", () => {
    // Emoji are surrogate pairs: a naive UTF-16 slice would end on a lone
    // half character.
    const description = "🦊".repeat(MAX_INTENT_DESCRIPTION_CHARS + 10);
    const intent = sanitizePrIntent({ title: "", description });
    expect([...intent!.description!].length).toBe(MAX_INTENT_DESCRIPTION_CHARS);
    expect(intent!.description!.endsWith(" [truncated]")).toBe(true);
    expect([...intent!.description!.slice(-14)][0]).toBe("🦊");
  });

  it("strips control characters but keeps the newlines prose needs", () => {
    const intent = sanitizePrIntent({
      title: "has\u0000null\u0007bell",
      description: "line one\u000bvertical\u007Fdelete\nline two\tindented",
    });
    expect(intent?.title).toBe("hasnullbell");
    expect(intent?.description).toBe("line oneverticaldelete\nline two\tindented");
  });

  it("flattens newlines in the title and linked titles, never in the description", () => {
    const intent = sanitizePrIntent({
      title: "one\rtwo\nthree",
      description: "paragraph stays",
      linked: [{ identifier: "#2\r\nx", title: "evil\rtitle" }],
    });
    expect(intent?.title).toBe("one two three");
    expect(intent?.linked?.[0]).toEqual({ identifier: "#2 x", title: "evil title" });
  });

  it("drops a linked reference whose identifier sanitizes away entirely", () => {
    const intent = sanitizePrIntent({
      title: "t",
      description: "",
      linked: [{ identifier: "\r\n\u0000", title: "ghost" }],
    });
    expect(intent?.linked).toBeUndefined();
  });
});

describe("prIntentText", () => {
  it("renders the linked list as identifier + title + state, never a body", () => {
    const text = prIntentText({
      title: "T",
      description: "D",
      linked: [{ identifier: "#41", title: "Fix the retry budget", state: "closed" }],
    });
    expect(text).toBe('Title: T\nDescription:\nD\nLinked: #41 "Fix the retry budget" (closed)');
  });

  it("omits the description block when there is none", () => {
    const text = prIntentText({ title: "Only", linked: [{ identifier: "#1" }] });
    expect(text).toBe("Title: Only\nLinked: #1");
  });
});

describe("prIntentFingerprint", () => {
  const base = {
    title: "Fix the retry budget",
    description: "Makes the budget per-host.",
  };

  it("is undefined for undefined input", () => {
    expect(prIntentFingerprint(undefined)).toBeUndefined();
  });

  it("changes when the description is edited — the re-review trigger", () => {
    const before = prIntentFingerprint(sanitizePrIntent(base));
    const after = prIntentFingerprint(
      sanitizePrIntent({ ...base, description: `${base.description}\n\nEDITED after review.` }),
    );
    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("is stable for identical input", () => {
    expect(prIntentFingerprint(sanitizePrIntent(base))).toBe(
      prIntentFingerprint(sanitizePrIntent({ ...base })),
    );
  });

  it("changes when a linked reference's resolved title or state changes", () => {
    const before = prIntentFingerprint(
      sanitizePrIntent({ ...base, linked: [{ identifier: "#41", title: "A", state: "open" }] }),
    );
    const after = prIntentFingerprint(
      sanitizePrIntent({ ...base, linked: [{ identifier: "#41", title: "A", state: "closed" }] }),
    );
    expect(after).not.toBe(before);
  });
});
