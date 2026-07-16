import { describe, expect, it } from "vitest";
import { computeReviewConfigHash, decideDedup, formatMarker } from "../../../src/review/dedup.js";
import type { ReviewConfigForDedup } from "../../../src/review/dedup.js";
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
    reviewedConfig: "",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ReviewConfigForDedup> = {}): ReviewConfigForDedup {
  return {
    advisor: "on",
    suggestions: "on",
    disableBuiltinRule: false,
    trustLocalRules: false,
    rulesDir: ".tgd-review/rules",
    model: undefined,
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

// #4: config-aware dedup — a skip now requires the head SHA AND the review
// config to be unchanged, so flipping a flag (advisor, model, rules-dir, ...)
// re-triggers a review on the same commit instead of being skipped as
// "already reviewed" when it would produce a different review.
describe("decideDedup (config-aware)", () => {
  it("skips when the head SHA matches AND the recorded config hash matches the current one", () => {
    const pr = makePr({ headSha: "abc123" });
    const cfg = computeReviewConfigHash(makeConfig());
    const botComment = makeBotComment({ lastReviewedSha: "abc123", reviewedConfig: cfg });

    expect(decideDedup(pr, botComment, cfg)).toBe("skip-no-new-commits");
  });

  it("re-reviews when the head SHA matches but the config hash differs (a flag changed)", () => {
    const pr = makePr({ headSha: "abc123" });
    const oldCfg = computeReviewConfigHash(makeConfig({ advisor: "on" }));
    const newCfg = computeReviewConfigHash(makeConfig({ advisor: "off" }));
    expect(newCfg).not.toBe(oldCfg);
    const botComment = makeBotComment({ lastReviewedSha: "abc123", reviewedConfig: oldCfg });

    expect(decideDedup(pr, botComment, newCfg)).toBe("review");
  });

  it("re-reviews a legacy marker (no recorded config) once, even on a matching SHA, when a config hash is supplied", () => {
    const pr = makePr({ headSha: "abc123" });
    const botComment = makeBotComment({ lastReviewedSha: "abc123", reviewedConfig: "" });

    expect(decideDedup(pr, botComment, computeReviewConfigHash(makeConfig()))).toBe("review");
  });

  it("still returns 'review' on a different SHA regardless of config hash", () => {
    const pr = makePr({ headSha: "new789" });
    const cfg = computeReviewConfigHash(makeConfig());
    const botComment = makeBotComment({ lastReviewedSha: "abc123", reviewedConfig: cfg });

    expect(decideDedup(pr, botComment, cfg)).toBe("review");
  });
});

describe("computeReviewConfigHash", () => {
  it("is deterministic for the same config", () => {
    expect(computeReviewConfigHash(makeConfig())).toBe(computeReviewConfigHash(makeConfig()));
  });

  it("changes when any output-affecting flag changes", () => {
    const base = computeReviewConfigHash(makeConfig());
    expect(computeReviewConfigHash(makeConfig({ advisor: "off" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ suggestions: "off" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ disableBuiltinRule: true }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ trustLocalRules: true }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ rulesDir: "other/rules" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ model: "openai-codex/gpt-5.6-terra" }))).not.toBe(base);
  });

  it("normalizes rulesDir separators so the same logical dir hashes identically across OSes", () => {
    expect(computeReviewConfigHash(makeConfig({ rulesDir: ".tgd-review\\rules" }))).toBe(
      computeReviewConfigHash(makeConfig({ rulesDir: ".tgd-review/rules" })),
    );
  });
});

describe("formatMarker", () => {
  it("formats the HTML marker with the given head SHA", () => {
    expect(formatMarker("abc123")).toBe("<!-- tgd-review-agent:sha=abc123 -->");
  });

  it("includes the config hash when one is provided", () => {
    expect(formatMarker("abc123", "1a2b3c4d5e6f")).toBe(
      "<!-- tgd-review-agent:sha=abc123 cfg=1a2b3c4d5e6f -->",
    );
  });
});
