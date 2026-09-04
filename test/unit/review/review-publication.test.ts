// Issue #128: ONLY_MARKERS_RE (the whitespace + whole-line HTML-comment check
// that decides whether the text after the signature block is strippable) was a
// single regex with a quantifier nested in a loop — it backtracked
// exponentially on `--><!--` repetitions and missed HTML's error-tolerant
// `--!>` comment end. These fixtures pin the replacement's linearity and the
// accepted/rejected language.
import { describe, expect, it } from "vitest";
import { isOnlyWholeLineMarkers } from "../../../src/review/review-publication.js";

describe("isOnlyWholeLineMarkers (issue #128)", () => {
  it("completes quickly on adversarial `--><!--` repetitions", () => {
    const adversarial = "<!--" + "--><!--".repeat(4000) + "-->";
    const started = Date.now();
    // Whatever the verdict, it must be reached in linear time.
    isOnlyWholeLineMarkers(adversarial);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("accepts whole-line comments in either end spelling, several per line", () => {
    expect(isOnlyWholeLineMarkers("<!-- tgd-review-agent:sha=abc -->")).toBe(true);
    expect(isOnlyWholeLineMarkers("<!-- tgd-child:v1... --!>")).toBe(true);
    expect(isOnlyWholeLineMarkers("<!--a--><!--b-->\n\n  <!--c--!>  \n")).toBe(true);
    expect(isOnlyWholeLineMarkers("")).toBe(true);
  });

  it("rejects anything content-shaped", () => {
    // Unclosed comment: content, not a strippable marker line.
    expect(isOnlyWholeLineMarkers("<!-- unterminated")).toBe(false);
    // Prose after a comment on the same line.
    expect(isOnlyWholeLineMarkers("<!-- c --> prose")).toBe(false);
    // Prose without any comment.
    expect(isOnlyWholeLineMarkers("just text")).toBe(false);
    // Inline (not whole-line) comment.
    expect(isOnlyWholeLineMarkers("text <!-- c --> more")).toBe(false);
  });
});
