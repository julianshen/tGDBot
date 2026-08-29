import { describe, expect, it } from "vitest";
import {
  validateInlinePublishOutcomes,
  validateConversationItemIdentity,
  type InlinePublishOutcome,
  type InlineReviewComment,
} from "../../../src/vcs/adapter.js";
import {
  MAX_CURSOR_BYTES,
  MAX_CURSOR_ORDER_KEY_BYTES,
  MAX_PAGE_TOKEN_BYTES,
  validateOpenReviewPageToken,
  validateReviewEventPageToken,
  validateReviewThreadPageToken,
  validateReviewDiscoveryCursor,
  validateReviewEventCursor,
  validateConversationAnchor,
} from "../../../src/vcs/conversation-adapter.js";

const comments = [
  { clientId: "finding-0", path: "a.ts", line: 1, body: "a", position: {} as never },
] satisfies InlineReviewComment[];

const identity = {
  provider: "github" as const,
  commentId: "123",
  threadId: "456",
  url: "https://github.com/owner/repo/pull/42#discussion_r123",
};
const githubRepo = {
  provider: "github" as const, host: "github.com" as const, owner: "owner", repo: "repo",
  canonicalUrl: "https://github.com/owner/repo",
};
const githubBinding = { repo: githubRepo, reviewNumber: 42 };
const gitlabRepo = {
  provider: "gitlab" as const, host: "gitlab.example.com", port: 8443,
  namespace: ["group"], repo: "project",
  canonicalUrl: "https://gitlab.example.com:8443/group/project",
};
const gitlabBinding = { repo: gitlabRepo, reviewNumber: 42 };
const gitlabIdentity = {
  provider: "gitlab" as const, commentId: "701", threadId: "discussion-1",
  url: "https://gitlab.example.com:8443/group/project/-/merge_requests/42#note_701",
};

describe("validateInlinePublishOutcomes", () => {
  it("accepts a posted outcome only with a validated provider identity", () => {
    expect(validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "posted", identity },
    ], githubBinding)).toEqual([{ clientId: "finding-0", status: "posted", identity }]);
  });

  it("validates canonical GitHub and GitLab identities against repository and review", () => {
    const validated = validateConversationItemIdentity(identity, githubBinding);
    expect(validated).toEqual(identity);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(() => { (validated as { commentId: string }).commentId = "999"; }).toThrow();
    expect(validated.commentId).toBe("123");
    expect(validateConversationItemIdentity(gitlabIdentity, gitlabBinding)).toEqual(gitlabIdentity);
  });

  it("accepts a mixed-case GitHub locator against a lowercase identity URL", () => {
    const mixedRepo = {
      provider: "github" as const, host: "github.com" as const, owner: "Azure", repo: "sdk",
      canonicalUrl: "https://github.com/Azure/sdk",
    };
    const lowercaseIdentity = {
      provider: "github" as const,
      commentId: "123",
      threadId: "456",
      url: "https://github.com/azure/sdk/pull/42#discussion_r123",
    };
    const binding = { repo: mixedRepo, reviewNumber: 42 };
    expect(validateConversationItemIdentity(lowercaseIdentity, binding)).toEqual(lowercaseIdentity);
    expect(validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "posted", identity: lowercaseIdentity },
    ], binding)).toEqual([{ clientId: "finding-0", status: "posted", identity: lowercaseIdentity }]);
  });

  it("cannot create an unbound brand or forge/reuse a branded identity", () => {
    // @ts-expect-error Identity validation always requires a canonical binding.
    expect(() => validateConversationItemIdentity(identity)).toThrow(/binding/i);
    const branded = validateConversationItemIdentity(identity, githubBinding);
    expect(validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "posted", identity: branded },
    ])).toMatchObject([{ status: "posted", identity: branded }]);
    expect(() => validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "posted", identity: { ...branded } },
    ])).toThrow(/validated|binding/i);
    expect(() => validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "posted", identity: branded },
    ], { ...githubBinding, reviewNumber: 43 })).toThrow(/review|binding/i);
    expect(() => validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "posted", identity: branded },
    ], gitlabBinding)).toThrow(/provider|binding/i);
  });

  it.each([
    ["provider", { ...identity, provider: "gitlab" }],
    ["http", { ...identity, url: identity.url.replace("https:", "http:") }],
    ["host", { ...identity, url: identity.url.replace("github.com", "github.example") }],
    ["repository", { ...identity, url: identity.url.replace("/owner/repo/", "/owner/repository/") }],
    ["review", { ...identity, url: identity.url.replace("/42", "/43") }],
    ["lookalike path", { ...identity, url: `${identity.url}/evil` }],
  ])("rejects a GitHub identity with wrong %s binding", (_name, value) => {
    expect(() => validateConversationItemIdentity(value, githubBinding)).toThrow(/identity|provider|URL|binding/i);
  });

  it.each([
    ["port", gitlabIdentity.url.replace(":8443", ":9443")],
    ["project", gitlabIdentity.url.replace("/group/project/", "/group/other/")],
    ["review", gitlabIdentity.url.replace("/42", "/420")],
    ["fragment", gitlabIdentity.url.replace("#note_701", "#note_701/evil")],
  ])("rejects a GitLab identity with wrong %s binding", (_name, url) => {
    expect(() => validateConversationItemIdentity({ ...gitlabIdentity, url }, gitlabBinding)).toThrow(/identity|URL|binding/i);
  });

  it("rejects identity accessors, symbols, and extra fields without invoking getters", () => {
    let calls = 0;
    const accessor = { ...identity } as Record<string, unknown>;
    Object.defineProperty(accessor, "url", { enumerable: true, get: () => { calls += 1; return identity.url; } });
    expect(() => validateConversationItemIdentity(accessor, githubBinding)).toThrow(/data propert|accessor/i);
    expect(calls).toBe(0);
    expect(() => validateConversationItemIdentity({ ...identity, extra: true }, githubBinding)).toThrow(/key/i);
    expect(() => validateConversationItemIdentity({ ...identity, [Symbol("x")]: true }, githubBinding)).toThrow(/key/i);
    const hidden = { ...identity } as Record<string, unknown>;
    Object.defineProperty(hidden, "extra", { enumerable: false, value: true });
    expect(() => validateConversationItemIdentity(hidden, githubBinding)).toThrow(/key/i);
    expect(() => validateConversationItemIdentity(
      Object.assign(Object.create({ poisoned: true }), identity),
      githubBinding,
    )).toThrow(/prototype/i);
  });

  it.each([
    ["missing identity", { clientId: "finding-0", status: "posted" }],
    ["bad provider", { clientId: "finding-0", status: "posted", identity: { ...identity, provider: "bitbucket" } }],
    ["empty comment ID", { clientId: "finding-0", status: "posted", identity: { ...identity, commentId: "" } }],
    ["control in comment ID", { clientId: "finding-0", status: "posted", identity: { ...identity, commentId: "12\n3" } }],
    ["oversized comment ID", { clientId: "finding-0", status: "posted", identity: { ...identity, commentId: "1".repeat(257) } }],
    ["empty thread ID", { clientId: "finding-0", status: "posted", identity: { ...identity, threadId: "" } }],
    ["relative URL", { clientId: "finding-0", status: "posted", identity: { ...identity, url: "/comment/123" } }],
    ["credential URL", { clientId: "finding-0", status: "posted", identity: { ...identity, url: "https://user:pass@example.com/comment/123" } }],
  ])("rejects posted outcomes with %s", (_name, outcome) => {
    expect(() => validateInlinePublishOutcomes(comments, [outcome as InlinePublishOutcome])).toThrow(/identity|provider|commentId|threadId|URL/i);
  });

  it.each([
    ["missing", { clientId: "finding-0", status: "failed" }],
    ["empty", { clientId: "finding-0", status: "failed", reason: "" }],
    ["whitespace", { clientId: "finding-0", status: "failed", reason: "   " }],
    ["control", { clientId: "finding-0", status: "failed", reason: "bad\nsecret" }],
    ["too long", { clientId: "finding-0", status: "failed", reason: "x".repeat(513) }],
  ])("rejects failed outcomes with a %s reason", (_name, outcome) => {
    expect(() => validateInlinePublishOutcomes(comments, [outcome as InlinePublishOutcome])).toThrow(/reason/i);
  });

  it("rejects unknown runtime statuses even when they carry a plausible reason", () => {
    const outcome = { clientId: "finding-0", status: "accepted", reason: "safe" };
    expect(() => validateInlinePublishOutcomes(comments, [outcome as unknown as InlinePublishOutcome])).toThrow(/status/i);
  });

  it("still rejects duplicate, unknown, and incomplete outcome sets", () => {
    const two = [...comments, { ...comments[0], clientId: "finding-1" }];
    const failed = (clientId: string): InlinePublishOutcome => ({ clientId, status: "failed", reason: "safe" });
    expect(() => validateInlinePublishOutcomes(two, [failed("finding-0")])).toThrow(/incomplete/i);
    expect(() => validateInlinePublishOutcomes(two, [failed("finding-0"), failed("finding-0")])).toThrow(/duplicate/i);
    expect(() => validateInlinePublishOutcomes(two, [failed("finding-0"), failed("unknown")])).toThrow(/unknown/i);
  });
});

describe("conversation cursor and anchor contracts", () => {
  const repositoryDigest = "a".repeat(64);
  const eventCursor = {
    scope: "review-events" as const,
    provider: "github" as const,
    repositoryDigest,
    reviewNumber: 42,
    opaque: "provider-state",
    orderKey: "000042",
  };

  it("accepts event cursor limits and enforces exact review binding", () => {
    expect(validateReviewEventCursor({
      ...eventCursor,
      opaque: "é".repeat(MAX_CURSOR_BYTES / 2),
      orderKey: "k",
    }, { provider: "github", repositoryDigest, reviewNumber: 42 })).toBeTruthy();
    expect(validateReviewEventCursor({
      ...eventCursor,
      opaque: "o",
      orderKey: "k".repeat(MAX_CURSOR_ORDER_KEY_BYTES),
    })).toBeTruthy();
    expect(() => validateReviewEventCursor(eventCursor, {
      provider: "github", repositoryDigest: "b".repeat(64), reviewNumber: 42,
    })).toThrow(/repository/i);
    expect(() => validateReviewEventCursor(eventCursor, {
      provider: "github", repositoryDigest, reviewNumber: 43,
    })).toThrow(/review/i);
  });

  it("rejects oversized, controlled, malformed, or cross-provider event cursors", () => {
    expect(() => validateReviewEventCursor(null as never)).toThrow(/cursor/i);
    const circular = { ...eventCursor } as typeof eventCursor & { extra?: unknown };
    circular.extra = circular;
    expect(() => validateReviewEventCursor(circular)).toThrow(/unknown|serializable/i);
    expect(() => validateReviewEventCursor({ ...eventCursor, opaque: "x".repeat(MAX_CURSOR_BYTES + 1) })).toThrow(/opaque/i);
    expect(() => validateReviewEventCursor({ ...eventCursor, orderKey: "x".repeat(MAX_CURSOR_ORDER_KEY_BYTES + 1) })).toThrow(/orderKey/i);
    expect(() => validateReviewEventCursor({ ...eventCursor, opaque: "bad\nstate" })).toThrow(/opaque/i);
    expect(() => validateReviewEventCursor({ ...eventCursor, repositoryDigest: "bad" })).toThrow(/repository/i);
    expect(() => validateReviewEventCursor({ ...eventCursor, reviewNumber: 0 })).toThrow(/review/i);
    expect(() => validateReviewEventCursor(eventCursor, {
      provider: "gitlab", repositoryDigest, reviewNumber: 42,
    })).toThrow(/provider/i);
  });

  it("validates repository-bound discovery high-water cursors independently", () => {
    const cursor = { scope: "open-review-discovery" as const, provider: "gitlab" as const, repositoryDigest, opaque: "state", orderKey: "9" };
    expect(validateReviewDiscoveryCursor(cursor, { provider: "gitlab", repositoryDigest })).toEqual(cursor);
    expect(() => validateReviewDiscoveryCursor(cursor, {
      provider: "gitlab", repositoryDigest: "c".repeat(64),
    })).toThrow(/repository/i);
    expect(() => validateReviewDiscoveryCursor({ ...cursor, opaque: "\u0000" })).toThrow(/opaque/i);
  });

  it("keeps bounded page tokens distinct from discovery high-water cursors", () => {
    const token = { scope: "open-review-page" as const, provider: "gitlab" as const, repositoryDigest, opaque: "p".repeat(MAX_PAGE_TOKEN_BYTES) };
    expect(validateOpenReviewPageToken(token, { provider: "gitlab", repositoryDigest })).toEqual(token);
    expect(() => validateOpenReviewPageToken({ ...token, opaque: `${token.opaque}p` }, { provider: "gitlab", repositoryDigest })).toThrow(/page token/i);
    const reviewToken = { scope: "review-event-page" as const, provider: "gitlab" as const, repositoryDigest, reviewNumber: 42, opaque: "p" };
    expect(validateReviewEventPageToken(reviewToken, { provider: "gitlab", repositoryDigest, reviewNumber: 42 })).toEqual(reviewToken);
    expect(() => validateReviewThreadPageToken({ ...reviewToken, scope: "review-thread-page" }, { provider: "gitlab", repositoryDigest, reviewNumber: 43 })).toThrow(/review/i);
    expect(() => validateReviewThreadPageToken(reviewToken, { provider: "gitlab", repositoryDigest, reviewNumber: 42 })).toThrow(/scope/i);
    let getterCalls = 0;
    const accessor = { ...token } as Record<string, unknown>;
    Object.defineProperty(accessor, "opaque", {
      enumerable: true,
      get: () => { getterCalls += 1; return "p"; },
    });
    expect(() => validateOpenReviewPageToken(accessor, { provider: "gitlab", repositoryDigest })).toThrow(/accessor|data propert/i);
    expect(getterCalls).toBe(0);
    expect(() => validateOpenReviewPageToken(
      Object.assign(Object.create({ poisoned: true }), token),
      { provider: "gitlab", repositoryDigest },
    )).toThrow(/prototype/i);
  });

  it("rejects wrong scopes, unknown own keys, and inherited envelope fields", () => {
    expect(() => validateReviewEventCursor({ ...eventCursor, scope: "open-review-discovery" })).toThrow(/scope/i);
    const discovery = { scope: "open-review-discovery", provider: "github", repositoryDigest, opaque: "o", orderKey: "k" };
    expect(() => validateReviewDiscoveryCursor({ ...discovery, scope: "page-token" }, { provider: "github", repositoryDigest })).toThrow(/scope/i);
    expect(() => validateOpenReviewPageToken({ scope: "review-events", provider: "github", repositoryDigest, opaque: "o" }, { provider: "github", repositoryDigest })).toThrow(/scope/i);
    expect(() => validateReviewEventCursor({ ...eventCursor, extra: "x".repeat(MAX_CURSOR_BYTES * 2) })).toThrow(/unknown|keys/i);
    expect(() => validateOpenReviewPageToken({ scope: "open-review-page", provider: "github", repositoryDigest, opaque: "o", extra: true }, { provider: "github", repositoryDigest })).toThrow(/unknown|keys/i);

    const inherited = Object.create({ scope: "review-events" }) as Record<string, unknown>;
    Object.assign(inherited, eventCursor);
    delete inherited.scope;
    expect(() => validateReviewEventCursor(inherited)).toThrow(/own|scope|prototype/i);
    const customPrototype = Object.assign(Object.create({ polluted: true }), eventCursor);
    expect(() => validateReviewEventCursor(customPrototype)).toThrow(/prototype/i);
  });

  it("returns a fresh canonical envelope and bounds its full JSON encoding", () => {
    const validated = validateReviewEventCursor(eventCursor);
    expect(validated).toEqual(eventCursor);
    expect(validated).not.toBe(eventCursor);

    const oversizedByEncoding = {
      ...eventCursor,
      opaque: "o".repeat(MAX_CURSOR_BYTES),
      orderKey: "k".repeat(MAX_CURSOR_ORDER_KEY_BYTES),
    };
    expect(() => validateReviewEventCursor(oversizedByEncoding)).toThrow(/envelope|JSON|bytes/i);
  });

  it("rejects accessors, symbols, and non-enumerable envelope properties without invoking getters", () => {
    let getterCalls = 0;
    const changingGetter = { ...eventCursor } as Record<string, unknown>;
    Object.defineProperty(changingGetter, "opaque", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? "safe" : "changed";
      },
    });
    expect(() => validateReviewEventCursor(changingGetter)).toThrow(/data property|accessor/i);
    expect(getterCalls).toBe(0);

    const throwingGetter = { ...eventCursor } as Record<string, unknown>;
    Object.defineProperty(throwingGetter, "orderKey", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(() => validateReviewEventCursor(throwingGetter)).toThrow(/data property|accessor/i);

    const symbolKey = { ...eventCursor, [Symbol("hidden")]: "payload" };
    expect(() => validateReviewEventCursor(symbolKey)).toThrow(/key/i);

    const hiddenExtra = { ...eventCursor } as Record<string, unknown>;
    Object.defineProperty(hiddenExtra, "hidden", { enumerable: false, value: "payload" });
    expect(() => validateReviewEventCursor(hiddenExtra)).toThrow(/key/i);

    const hiddenAllowed = { ...eventCursor } as Record<string, unknown>;
    Object.defineProperty(hiddenAllowed, "opaque", { enumerable: false, value: "safe" });
    expect(() => validateReviewEventCursor(hiddenAllowed)).toThrow(/enumerable|data property/i);
  });

  it("retains both original and current heads for outdated anchors", () => {
    expect(validateConversationAnchor({
      file: "src/a.ts", side: "new", line: 10,
      originalHeadSha: "a".repeat(40), currentHeadSha: "b".repeat(40), outdated: true,
    })).toMatchObject({ outdated: true, originalHeadSha: "a".repeat(40), currentHeadSha: "b".repeat(40) });
    expect(() => validateConversationAnchor({
      file: "src/a.ts", line: 10, currentHeadSha: "b".repeat(40), outdated: true,
    })).toThrow(/originalHeadSha/i);
    expect(validateConversationAnchor({
      file: "src/a.ts", line: 10, originalHeadSha: "a".repeat(40), currentHeadSha: "b".repeat(40), outdated: false,
    })).toMatchObject({ outdated: false, originalHeadSha: "a".repeat(40), currentHeadSha: "b".repeat(40) });
    expect(validateConversationAnchor({
      file: "src/a.ts", line: 10, originalHeadSha: "a".repeat(40), currentHeadSha: "a".repeat(40), outdated: false,
    })).toMatchObject({ outdated: false, currentHeadSha: "a".repeat(40) });
  });
});
