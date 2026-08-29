import { describe, expect, it } from "vitest";
import { summarizeExistingDiscussion } from "../../../src/review/existing-discussion.js";
import type { ReviewActivityEvent, ReviewThreadSnapshot } from "../../../src/vcs/conversation-adapter.js";

type ThreadCommentEvent = Extract<ReviewActivityEvent, { kind: "thread-comment" }>;

function event(over: Partial<ThreadCommentEvent> = {}): ThreadCommentEvent {
  return {
    provider: "github",
    repositoryDigest: "a".repeat(64),
    reviewNumber: 7,
    eventId: "event-1",
    revisionId: "revision-1",
    orderKey: "0001",
    commentId: "comment-1",
    threadId: "thread-1",
    authorLogin: "alice",
    authorIsBot: false,
    body: "  The nil case is already covered.\nPlease do not report it again.  ",
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    url: "https://github.com/acme/app/pull/7#discussion_r1",
    ...over,
    kind: "thread-comment",
  };
}

function thread(overrides: Partial<ReviewThreadSnapshot> = {}): ReviewThreadSnapshot {
  return {
    provider: "github",
    repositoryDigest: "a".repeat(64),
    reviewNumber: 7,
    threadId: "thread-1",
    rootCommentId: "comment-1",
    orderKey: "0001",
    resolved: false,
    outdated: false,
    updatedAt: "2026-08-15T00:00:00Z",
    url: "https://github.com/acme/app/pull/7#discussion_r1",
    placement: {
      file: "src/foo.ts",
      line: 10,
      side: "new",
      currentHeadSha: "b".repeat(40),
      outdated: false,
    },
    events: [event()],
    ...overrides,
  };
}

describe("summarizeExistingDiscussion", () => {
  it("uses unresolved anchors to suppress duplicate findings and summarizes human comments", () => {
    const result = summarizeExistingDiscussion([thread()]);

    expect(result.existingIssues).toEqual([
      { threadId: "thread-1", file: "src/foo.ts", line: 10 },
    ]);
    expect(result.discussionMemories).toEqual([{
      threadId: "thread-1",
      file: "src/foo.ts",
      line: 10,
      author: "alice",
      summary: "The nil case is already covered. Please do not report it again.",
      url: "https://github.com/acme/app/pull/7#discussion_r1",
    }]);
  });

  it("does not suppress from resolved or outdated threads and never remembers bot comments", () => {
    const bot = thread({
      threadId: "bot-thread",
      rootCommentId: "bot-comment",
      events: [event({
        eventId: "bot-event",
        revisionId: "bot-revision",
        commentId: "bot-comment",
        threadId: "bot-thread",
        authorLogin: "tgd-bot",
        authorIsBot: true,
      })],
    });
    const result = summarizeExistingDiscussion([
      thread({ threadId: "resolved", resolved: true }),
      thread({ threadId: "outdated", outdated: true }),
      bot,
    ]);

    expect(result.existingIssues).toEqual([
      { threadId: "bot-thread", file: "src/foo.ts", line: 10 },
    ]);
    expect(result.discussionMemories).toEqual([]);
  });

  it("remembers human general comments without treating them as anchored issues", () => {
    const general = thread({ placement: undefined });

    const result = summarizeExistingDiscussion([general]);

    expect(result.existingIssues).toEqual([]);
    expect(result.discussionMemories).toEqual([{
      threadId: "thread-1",
      author: "alice",
      summary: "The nil case is already covered. Please do not report it again.",
      url: "https://github.com/acme/app/pull/7#discussion_r1",
    }]);
  });

  it("turns a human thumbs-up on a bot finding into advisory feedback", () => {
    const botRoot = event({
      authorLogin: "tgd-bot",
      authorIsBot: true,
      body: "Missing nil guard can crash the request handler.",
      reactions: [{
        id: "reaction-7",
        content: "thumbs-up" as const,
        authorLogin: "alice",
        authorIsBot: false,
        createdAt: "2026-08-15T00:01:00Z",
      }],
    });
    const result = summarizeExistingDiscussion([thread({ events: [botRoot] })]);

    expect(result.discussionMemories).toContainEqual({
      threadId: "thread-1",
      file: "src/foo.ts",
      line: 10,
      author: "alice",
      summary: "👍 Endorsed tGDBot finding: Missing nil guard can crash the request handler.",
      url: "https://github.com/acme/app/pull/7#discussion_r1",
    });
  });

  it("ignores thumbs-up reactions authored by the bot itself", () => {
    const botRoot = event({
      authorLogin: "tgd-bot",
      authorIsBot: true,
      reactions: [{
        id: "reaction-self",
        content: "thumbs-up" as const,
        authorLogin: "tgd-bot",
        authorIsBot: true,
        createdAt: "2026-08-15T00:01:00Z",
      }],
    });

    expect(summarizeExistingDiscussion([thread({ events: [botRoot] })]).discussionMemories).toEqual([]);
  });
});
