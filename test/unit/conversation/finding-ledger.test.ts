import { describe, expect, it } from "vitest";
import {
  formatChildMarker,
  parseChildMarker,
  computeContentDigest,
  computeRepositoryDigest,
} from "../../../src/conversation/markers.js";
import {
  bindFindingLedgerIdentity,
  prepareFindingLedgerEntry,
  requireFindingLedgerRecord,
  validateFindingEntries,
  type FindingLedgerEntry,
  type FindingReviewOptions,
  type FindingSnapshot,
} from "../../../src/conversation/state-schema.js";
import type { ConversationItemIdentity } from "../../../src/conversation/types.js";

const HEX32 = "1".repeat(32);
const DIGEST = "a".repeat(64);
const binding = { provider: "github" as const, repositoryDigest: DIGEST };
const publicRepositoryDigest = computeRepositoryDigest("github", "https://github.com/acme/app");
const finding: FindingSnapshot = {
  file: "src/auth.ts",
  line: 14,
  severity: "blocking",
  category: "security",
  message: "Tokens must not be logged.",
  ruleName: "no-token-logs",
  title: "Do not log tokens",
};
const reviewOptions: FindingReviewOptions = {
  advisor: "on",
  suggestions: "off",
  disableBuiltinRule: false,
  trustLocalRules: false,
  rulesDir: ".review/rules",
  model: "anthropic/claude-opus-4-5",
  dispatch: "direct",
};
const placement = {
  file: "src/auth.ts",
  side: "new" as const,
  line: 14,
  originalHeadSha: "c".repeat(40),
  currentHeadSha: "c".repeat(40),
  outdated: false,
};
const visibleBody = "_🔒 security_ | _🔴 Blocking_ | _`no-token-logs`_\n\n**Do not log tokens.**\n<!-- tgd-review-agent:inline -->";
const childId = `finding_${HEX32}`;
const parentId = `act_${"2".repeat(32)}`;

function preparedInput() {
  return {
    repository: binding,
    id: childId,
    reviewNumber: 42,
    reviewId: "PR_kwDOReview42",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    finding,
    ruleSnapshot: "Never log credentials or session tokens.",
    reviewOptions,
    placement,
    body: visibleBody,
    at: "2026-08-14T00:00:00.000Z",
  };
}

describe("finding ledger preparation", () => {
  it("records a complete prepared entry before provider publication", () => {
    const entry = prepareFindingLedgerEntry(preparedInput());

    expect(entry.version).toBe(1);
    expect(entry.id).toBe(childId);
    expect(entry.repository).toEqual(binding);
    expect(entry.reviewNumber).toBe(42);
    expect(entry.reviewId).toBe("PR_kwDOReview42");
    expect(entry.finding).toEqual(finding);
    expect(entry.ruleSnapshot).toBe("Never log credentials or session tokens.");
    expect(entry.ruleDigest).toBe(computeContentDigest("Never log credentials or session tokens."));
    expect(entry.reviewOptions).toEqual(reviewOptions);
    expect(entry.baseSha).toBe("b".repeat(40));
    expect(entry.headSha).toBe("c".repeat(40));
    expect(entry.placement).toEqual(placement);
    expect(entry.contentDigest).toBe(computeContentDigest(visibleBody));
    expect(entry.bodyDigest).toBe(computeContentDigest(visibleBody));
    expect(entry.identity).toBeUndefined();
    expect(entry.at).toBe("2026-08-14T00:00:00.000Z");
    expect(validateFindingEntries([entry], binding)).toEqual([entry]);
  });

  it("finalizes a validated provider binding after publication", () => {
    const prepared = prepareFindingLedgerEntry(preparedInput());
    const identity: ConversationItemIdentity = {
      provider: "github",
      commentId: "comment-123",
      threadId: "thread-123",
      url: "https://github.com/acme/app/pull/42#discussion_rcomment-123",
    };

    const published = bindFindingLedgerIdentity(prepared, identity);

    expect(published.identity).toEqual(identity);
    expect(published.id).toBe(prepared.id);
    expect(published.finding).toEqual(prepared.finding);
    expect(published.bodyDigest).toBe(prepared.bodyDigest);
    expect(validateFindingEntries([prepared, published], binding)).toEqual([prepared, published]);
  });

  it("rejects a provider binding whose provider does not match the repository", () => {
    const prepared = prepareFindingLedgerEntry(preparedInput());
    expect(() => bindFindingLedgerIdentity(prepared, {
      provider: "gitlab",
      commentId: "note-1",
      url: "https://gitlab.com/acme/app/-/merge_requests/42#note_1",
    })).toThrow(/provider/i);
  });
});

describe("finding marker ledger binding", () => {
  function markerFor(entry: FindingLedgerEntry, repositoryDigest = publicRepositoryDigest): string {
    return formatChildMarker({
      kind: "finding",
      parentId,
      childId: entry.id,
      repositoryDigest,
      reviewNumber: entry.reviewNumber,
      contentDigest: entry.contentDigest,
    });
  }

  it("accepts a marker that matches the repository/review ledger record", () => {
    const entry = prepareFindingLedgerEntry(preparedInput());
    const marker = markerFor(entry);
    expect(parseChildMarker(marker)?.kind).toBe("finding");
    expect(requireFindingLedgerRecord(marker, [entry], {
      repository: binding,
      reviewNumber: 42,
      markerRepositoryDigest: publicRepositoryDigest,
    })).toEqual(entry);
  });

  it("rejects a marker without a matching repository/review ledger record", () => {
    const entry = prepareFindingLedgerEntry(preparedInput());
    const marker = markerFor(entry);
    const otherRepo = { provider: "github" as const, repositoryDigest: "b".repeat(64) };

    expect(() => requireFindingLedgerRecord(marker, [], {
      repository: binding,
      reviewNumber: 42,
      markerRepositoryDigest: publicRepositoryDigest,
    })).toThrow(/ledger|record|matching/i);

    expect(() => requireFindingLedgerRecord(marker, [entry], {
      repository: otherRepo,
      reviewNumber: 42,
      markerRepositoryDigest: publicRepositoryDigest,
    })).toThrow(/ledger|record|matching|repository/i);

    expect(() => requireFindingLedgerRecord(marker, [entry], {
      repository: binding,
      reviewNumber: 7,
      markerRepositoryDigest: publicRepositoryDigest,
    })).toThrow(/ledger|record|matching|review/i);

    expect(() => requireFindingLedgerRecord(markerFor(entry, "c".repeat(64)), [entry], {
      repository: binding,
      reviewNumber: 42,
      markerRepositoryDigest: publicRepositoryDigest,
    })).toThrow(/ledger|record|matching|repository/i);
  });

  it("stores only IDs and digests in the public finding marker", () => {
    const entry = prepareFindingLedgerEntry(preparedInput());
    const marker = markerFor(entry);
    expect(marker).toMatch(/^<!-- tgd-child:v=1;kind=finding;/u);
    expect(marker).toContain(`child=${entry.id}`);
    expect(marker).toContain(`repo=${publicRepositoryDigest}`);
    expect(marker).toContain("review=42");
    expect(marker).toContain(`content=${entry.contentDigest}`);
    expect(marker).not.toContain(finding.message);
    expect(marker).not.toContain(finding.file);
    expect(marker).not.toContain(visibleBody);
    expect(marker).not.toContain(entry.ruleSnapshot);
  });
});

describe("finding ledger schema", () => {
  it("requires the complete structured finding, review options, and body digest", () => {
    const entry = prepareFindingLedgerEntry(preparedInput());
    const { finding: _finding, ...withoutFinding } = entry;
    const { reviewOptions: _options, ...withoutOptions } = entry;
    const { bodyDigest: _digest, ...withoutBody } = entry;
    void _finding;
    void _options;
    void _digest;
    expect(() => validateFindingEntries([withoutFinding], binding)).toThrow(/finding/i);
    expect(() => validateFindingEntries([withoutOptions], binding)).toThrow(/reviewOptions|options/i);
    expect(() => validateFindingEntries([withoutBody], binding)).toThrow(/bodyDigest/i);
  });

  it("rejects an impossible identity rebind after publication", () => {
    const prepared = prepareFindingLedgerEntry(preparedInput());
    const first = bindFindingLedgerIdentity(prepared, {
      provider: "github",
      commentId: "comment-1",
      url: "https://github.com/acme/app/pull/42#discussion_r1",
    });
    const second = {
      ...first,
      identity: {
        provider: "github" as const,
        commentId: "comment-2",
        url: "https://github.com/acme/app/pull/42#discussion_r2",
      },
    };
    expect(() => validateFindingEntries([prepared, first, second], binding)).toThrow(/identity|bind/i);
  });
});

describe("conversation context error classification", () => {
  it("classifies optional-context failures separately from fail-closed integrity errors", async () => {
    const { classifyConversationContextError } = await import("../../../src/conversation/context.js");
    const unavailable = [
      ["auth", new Error("GitHub authentication failed (HTTP 401)")],
      ["network", Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" })],
      ["rate-limit", new Error("HTTP 429 rate limit exceeded")],
      ["timeout", Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })],
      ["missing-store", new Error("Conversation state store is not available")],
      ["partial-pagination", new Error("Partial thread pagination was discarded")],
    ] as const;
    for (const [kind, error] of unavailable) {
      expect(classifyConversationContextError(error)).toEqual({ class: "unavailable", kind });
    }

    const integrity = [
      ["corrupt", new Error("Malformed conversation ledger JSON")],
      ["oversized", new Error("Conversation state file is too large")],
      ["unknown-schema", new Error("cursor has an unsupported schema version")],
      ["path", new Error("Conversation state path is a symlink")],
      ["permission", new Error("Conversation state file permissions must be 0600")],
      ["impossible-transition", new Error("Impossible action transition from observed to published")],
      ["cross-repository", new Error("State repository binding does not match the requested repository")],
    ] as const;
    for (const [kind, error] of integrity) {
      expect(classifyConversationContextError(error)).toEqual({ class: "integrity", kind });
    }
  });
});
