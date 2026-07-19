import { describe, expect, it } from "vitest";
import { parseReviewTarget } from "../../../src/target/review-target.js";

describe("parseReviewTarget", () => {
  it("AC-1.1: parses and normalizes a canonical GitHub pull-request URL without Git state", () => {
    const target = parseReviewTarget("https://github.com/Example-Org/Review_Tool/pull/42/");

    expect(target).toEqual({
      provider: "github",
      host: "github.com",
      owner: "Example-Org",
      repo: "Review_Tool",
      pullNumber: 42,
      canonicalUrl: "https://github.com/Example-Org/Review_Tool/pull/42",
    });
  });

  it.each([
    ["a non-GitHub host", "https://gitlab.com/acme/widget/pull/42"],
    ["a non-HTTPS scheme", "http://github.com/acme/widget/pull/42"],
    ["a malformed pull path", "https://github.com/acme/widget/issues/42"],
    ["a missing owner", "https://github.com/widget/pull/42"],
    ["an extra path segment", "https://github.com/acme/widget/pull/42/files"],
    ["a zero pull number", "https://github.com/acme/widget/pull/0"],
    ["a negative pull number", "https://github.com/acme/widget/pull/-1"],
    ["a query", "https://github.com/acme/widget/pull/42?repo=other"],
    ["a fragment", "https://github.com/acme/widget/pull/42#discussion"],
    ["encoded path data", "https://github.com/acme%2Fadmin/widget/pull/42"],
    ["an encoded dot segment", "https://github.com/acme/%2e%2e/widget/pull/42"],
    ["a backslash path separator", "https://github.com/acme\\widget/pull/42"],
    ["an ASCII tab", "https://github.com/acme/wi\tdget/pull/42"],
    ["an ASCII newline", "https://github.com/acme/widget/pull/4\n2"],
  ])("AC-1.2: rejects %s with an actionable validation error", (_case, input) => {
    expect(() => parseReviewTarget(input)).toThrow(/GitHub PR URL/);
  });

  it("AC-1.2: rejects credentials without echoing credential material", () => {
    const input = "https://operator:super-secret@github.com/acme/widget/pull/42";

    let caught: unknown;
    try {
      parseReviewTarget(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/credentials/i);
    expect((caught as Error).message).not.toContain("operator");
    expect((caught as Error).message).not.toContain("super-secret");
  });
});
