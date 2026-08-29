import { describe, expect, it } from "vitest";
import { acceptanceKey, isAcceptedOnReview } from "../../../src/conversation/disposition.js";
import { prepareFindingOutcome } from "../../../src/conversation/state-schema.js";
import { renderDispositionReply } from "../../../src/conversation/render.js";
import type { RepositoryBinding } from "../../../src/conversation/types.js";

const repository: RepositoryBinding = {
  provider: "github",
  repositoryDigest: "a".repeat(64),
};

const finding = { ruleName: "no-token-logs", file: "src/auth.ts", line: 14 };

function accepted(over: Record<string, unknown> = {}) {
  return prepareFindingOutcome({
    repository,
    id: "outcome_" + "a".repeat(32),
    findingId: "finding_" + "b".repeat(32),
    reviewNumber: 1,
    headSha: "c".repeat(40),
    ruleName: finding.ruleName,
    category: "security",
    severity: "blocking",
    verdict: "confirmed",
    trigger: "thread-comment",
    anchorChanged: false,
    at: "2026-08-29T00:00:00.000Z",
    disposition: "accepted",
    actor: "alice",
    file: finding.file,
    line: finding.line,
    ...over,
  });
}

describe("isAcceptedOnReview", () => {
  it("matches the same rule, file and line on the same review", () => {
    expect(isAcceptedOnReview(finding, [accepted()], 1)).toBe(true);
  });

  it("does not match a different review", () => {
    expect(isAcceptedOnReview(finding, [accepted()], 2)).toBe(false);
  });

  it("does not match a different rule or line", () => {
    expect(isAcceptedOnReview({ ...finding, ruleName: "other" }, [accepted()], 1)).toBe(false);
    expect(isAcceptedOnReview({ ...finding, line: 15 }, [accepted()], 1)).toBe(false);
  });

  it("ignores a deferred record", () => {
    expect(isAcceptedOnReview(finding, [accepted({ disposition: "deferred" })], 1)).toBe(false);
  });

  it("is the same key prepareFindingOutcome stores", () => {
    const entry = accepted();
    expect(acceptanceKey(finding)).toBe(
      JSON.stringify([entry.ruleDigest, entry.fileDigest, entry.line ?? null]),
    );
  });
});

describe("renderDispositionReply", () => {
  const marker = "<!-- tgd-disposition -->";

  it("says an accepted finding will not be raised again on this PR", () => {
    const body = renderDispositionReply({
      disposition: "accepted",
      file: "src/auth.ts",
      line: 14,
      ruleName: "no-token-logs",
      severity: "blocking",
    }, marker).text;

    expect(body).toMatch(/## Accepted/);
    expect(body).toContain("src/auth.ts:14");
    expect(body).toMatch(/this PR/i);
    expect(body).toContain(marker);
  });

  it("drafts a follow-up issue without filing it", () => {
    const body = renderDispositionReply({
      disposition: "deferred",
      file: "src/auth.ts",
      line: 14,
      ruleName: "no-token-logs",
      severity: "blocking",
      botLogin: "tgdbot",
    }, marker).text;

    expect(body).toMatch(/## Deferred/);
    expect(body).toMatch(/not filed/i);
    expect(body).toContain("@tgdbot accept");
    expect(body).not.toMatch(/opened an issue|filed #/i);
  });
});
