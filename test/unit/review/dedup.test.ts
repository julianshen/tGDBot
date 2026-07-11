import { describe, expect, it } from "vitest";
import { decideDedup, formatMarker } from "../../../src/review/dedup.js";
import type { BotComment, PullRequestInfo } from "../../../src/vcs/adapter.js";

function makePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    id: "42",
    headSha: "abc123",
    baseSha: "def456",
    title: "Some PR",
    description: "Some description",
    ...overrides,
  };
}

function makeBotComment(overrides: Partial<BotComment> = {}): BotComment {
  return {
    id: "999",
    body: "<!-- tgd-review-agent:sha=abc123 -->",
    lastReviewedSha: "abc123",
    ...overrides,
  };
}

describe("decideDedup", () => {
  // AC-3.1: Given botComment is null, When decideDedup(pr, null) is called,
  // Then it returns "review" (US-01: first-ever review must not be skipped).
  it("AC-3.1: returns 'review' when botComment is null", () => {
    const pr = makePr();

    expect(decideDedup(pr, null)).toBe("review");
  });

  // AC-3.2: Given botComment.lastReviewedSha === pr.headSha, When decideDedup
  // is called, Then it returns "skip-no-new-commits".
  it("AC-3.2: returns 'skip-no-new-commits' when lastReviewedSha matches pr.headSha", () => {
    const pr = makePr({ headSha: "abc123" });
    const botComment = makeBotComment({ lastReviewedSha: "abc123" });

    expect(decideDedup(pr, botComment)).toBe("skip-no-new-commits");
  });

  // AC-3.3: Given botComment.lastReviewedSha !== pr.headSha (new commits
  // landed), When decideDedup is called, Then it returns "review".
  it("AC-3.3: returns 'review' when lastReviewedSha differs from pr.headSha", () => {
    const pr = makePr({ headSha: "new789" });
    const botComment = makeBotComment({ lastReviewedSha: "abc123" });

    expect(decideDedup(pr, botComment)).toBe("review");
  });

  // AC-3.4: Given botComment.lastReviewedSha is an empty string
  // (malformed/unparseable marker), When decideDedup is called, Then it
  // returns "review" (never throws, never skips).
  it("AC-3.4: returns 'review' and never throws when lastReviewedSha is an empty string", () => {
    const pr = makePr({ headSha: "abc123" });
    const botComment = makeBotComment({ lastReviewedSha: "" });

    expect(() => decideDedup(pr, botComment)).not.toThrow();
    expect(decideDedup(pr, botComment)).toBe("review");
  });
});

describe("formatMarker", () => {
  it("formats the HTML marker with the given head SHA", () => {
    expect(formatMarker("abc123")).toBe("<!-- tgd-review-agent:sha=abc123 -->");
  });
});
