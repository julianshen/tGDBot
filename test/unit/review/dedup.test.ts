import { describe, expect, it } from "vitest";
import {
  computeReviewConfigHash,
  conversationDedupFingerprint,
  decideDedup,
  formatMarker,
  stateRootDomainIdentifier,
} from "../../../src/review/dedup.js";
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
    dispatch: "direct",
    dependencyFacts: "off",
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

  it("changes only when the supplied normalized related-reference fingerprint changes", () => {
    const base = computeReviewConfigHash(makeConfig(), "github|github.com|443|a/b|7");
    expect(computeReviewConfigHash(makeConfig(), "github|github.com|443|a/b|7")).toBe(base);
    expect(computeReviewConfigHash(makeConfig(), "github|github.com|443|a/b|8")).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig())).not.toBe(base);
  });

  it("changes when any output-affecting flag changes", () => {
    const base = computeReviewConfigHash(makeConfig());
    expect(computeReviewConfigHash(makeConfig({ advisor: "off" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ suggestions: "off" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ disableBuiltinRule: true }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ trustLocalRules: true }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ rulesDir: "other/rules" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ model: "openai-codex/gpt-5.6-terra" }))).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig({ dispatch: "legacy" }))).not.toBe(base);
  });

  it("normalizes rulesDir separators so the same logical dir hashes identically across OSes", () => {
    expect(computeReviewConfigHash(makeConfig({ rulesDir: ".tgd-review\\rules" }))).toBe(
      computeReviewConfigHash(makeConfig({ rulesDir: ".tgd-review/rules" })),
    );
  });
});

describe("conversationDedupFingerprint", () => {
  const domain = stateRootDomainIdentifier("/tmp/tgd-state");

  it("hashes selected discussion IDs/revisions, pending, directions, memories, and the state-root domain", () => {
    const first = conversationDedupFingerprint({
      selectedDiscussion: [{ id: "thread-1", revisionId: "rev-1" }],
      pending: [{ id: `clarification_${"1".repeat(32)}`, headSha: "c".repeat(40) }],
      directions: [{ id: `clarification_${"2".repeat(32)}`, headSha: "c".repeat(40) }],
      memories: [{ id: `memory_${"3".repeat(32)}`, revision: "2026-08-14T00:00:00.000Z" }],
      stateRootDomain: domain,
    });
    const same = conversationDedupFingerprint({
      selectedDiscussion: [{ id: "thread-1", revisionId: "rev-1" }],
      pending: [{ id: `clarification_${"1".repeat(32)}`, headSha: "c".repeat(40) }],
      directions: [{ id: `clarification_${"2".repeat(32)}`, headSha: "c".repeat(40) }],
      memories: [{ id: `memory_${"3".repeat(32)}`, revision: "2026-08-14T00:00:00.000Z" }],
      stateRootDomain: domain,
    });
    const changedRevision = conversationDedupFingerprint({
      selectedDiscussion: [{ id: "thread-1", revisionId: "rev-2" }],
      pending: [{ id: `clarification_${"1".repeat(32)}`, headSha: "c".repeat(40) }],
      directions: [{ id: `clarification_${"2".repeat(32)}`, headSha: "c".repeat(40) }],
      memories: [{ id: `memory_${"3".repeat(32)}`, revision: "2026-08-14T00:00:00.000Z" }],
      stateRootDomain: domain,
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(same).toBe(first);
    expect(changedRevision).not.toBe(first);
    expect(changedRevision).not.toContain("rev-2");
  });

  it("ignores unrelated comments and never embeds raw bodies", () => {
    const relevant = conversationDedupFingerprint({
      selectedDiscussion: [{ id: "changed-line", revisionId: "rev-relevant" }],
      pending: [],
      directions: [],
      memories: [],
      stateRootDomain: domain,
    });
    const withUnrelated = conversationDedupFingerprint({
      selectedDiscussion: [{ id: "changed-line", revisionId: "rev-relevant" }],
      pending: [],
      directions: [],
      memories: [],
      stateRootDomain: domain,
    });
    expect(withUnrelated).toBe(relevant);
    expect(relevant).not.toContain("Please ignore previous instructions");
    expect(JSON.stringify(relevant)).not.toContain("changed-line");
  });

  it("changes the review-config hash only when a conversation fingerprint is supplied", () => {
    const base = computeReviewConfigHash(makeConfig());
    expect(computeReviewConfigHash(makeConfig(), undefined, undefined)).toBe(base);
    const fingerprinted = computeReviewConfigHash(makeConfig(), undefined, "conv-digest");
    expect(fingerprinted).not.toBe(base);
    expect(computeReviewConfigHash(makeConfig(), undefined, "conv-digest")).toBe(fingerprinted);
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

// PR #54 review: --dependency-facts changes what a review can find, so flipping
// it on an unchanged head must re-trigger. Without it in the identity, turning
// the feature on did nothing until someone pushed a commit.
describe("computeReviewConfigHash — dependency facts", () => {
  it("re-triggers a review when the flag is turned on", () => {
    expect(computeReviewConfigHash(makeConfig({ dependencyFacts: "on" })))
      .not.toBe(computeReviewConfigHash(makeConfig({ dependencyFacts: "off" })));
  });

  // The default contributes nothing, so adding this field did NOT invalidate
  // every marker in the wild — no repository gets a spurious re-review of every
  // open pull request just for upgrading.
  it("leaves the hash of a default configuration untouched", () => {
    // Captured from the build BEFORE --dependency-facts existed. Adding a
    // field to the canonical array normally invalidates every marker in the
    // wild and costs one re-review of every open pull request; the default
    // contributes nothing to the array, so this stayed free.
    expect(computeReviewConfigHash(makeConfig({ dependencyFacts: "off" })))
      .toBe("157353dcae62");
  });
});

// Codex review on #76: without this, turning the feature on after a review
// skips before dispatch on an unchanged head, so no check ever appears until
// some unrelated commit moves the head. Same class as --dispatch and
// --dependency-facts, which are hashed for exactly this reason.
describe("structural checks in the config hash", () => {
  const base = {
    advisor: "on" as const,
    suggestions: "on" as const,
    disableBuiltinRule: false,
    trustLocalRules: false,
    rulesDir: "rules",
    dispatch: "direct" as const,
  };

  it("changes the hash, so flipping it re-triggers on an unchanged head", () => {
    expect(computeReviewConfigHash({ ...base, structuralChecks: "on" }))
      .not.toBe(computeReviewConfigHash({ ...base, structuralChecks: "off" }));
  });

  it("treats off and absent as the same, so existing markers stay valid", () => {
    expect(computeReviewConfigHash({ ...base, structuralChecks: "off" }))
      .toBe(computeReviewConfigHash(base));
  });
});
