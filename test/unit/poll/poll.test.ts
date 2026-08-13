import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandArgs, type PollArgs } from "../../../src/cli-args.js";
import { MAX_COMMAND_BODY_SCALARS } from "../../../src/conversation/command-parser.js";
import { computeRepositoryDigest } from "../../../src/conversation/markers.js";
import { deriveConversationStatePaths } from "../../../src/conversation/state-paths.js";
import { createConversationStateStore } from "../../../src/conversation/state-store.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import type {
  ConversationAdapter,
  OpenReviewPage,
  OpenReviewSummary,
  ReviewActivityEvent,
  ReviewEventCursor,
  ReviewEventPage,
} from "../../../src/vcs/conversation-adapter.js";
import type { ReviewIdentity } from "../../../src/conversation/types.js";
import { poll } from "../../../src/poll/poll.js";

const repo = parseRepositoryRef("owner/repo", "github");
const repositoryDigest = computeRepositoryDigest("github", repo.canonicalUrl);
const bot = { provider: "github" as const, login: "tgdbot", mention: "@tgdbot" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-poll-runtime-")));
  temporaryDirectories.push(directory);
  return path.join(directory, "state");
}

function pollArgs(stateDir: string, overrides: Partial<PollArgs> = {}): PollArgs {
  return {
    ...parseCommandArgs(["poll", "--repo", "owner/repo", "--state-dir", stateDir]),
    ...overrides,
    command: "poll",
    repo: "owner/repo",
    stateDir,
  };
}

function identity(reviewNumber: number): ReviewIdentity {
  return {
    provider: "github",
    repositoryDigest,
    reviewNumber,
    reviewId: `PR_${reviewNumber}`,
    url: `https://github.com/owner/repo/pull/${reviewNumber}`,
  };
}

function summary(reviewNumber: number): OpenReviewSummary {
  return {
    identity: identity(reviewNumber),
    title: `Review ${reviewNumber}`,
    headSha: "b".repeat(40),
    updatedAt: "2026-08-13T00:00:00.000Z",
    orderKey: `2026-08-13T00:00:00.000Z|${String(reviewNumber).padStart(16, "0")}`,
  };
}

function commentEvent(eventId: string, body: string, updatedAt = "2026-08-14T00:00:00.000Z"): ReviewActivityEvent {
  return {
    kind: "general-comment",
    provider: "github",
    repositoryDigest,
    reviewNumber: 1,
    eventId,
    revisionId: `${eventId}:1`,
    orderKey: `${updatedAt}|${eventId}`,
    authorLogin: "alice",
    authorIsBot: false,
    createdAt: updatedAt,
    updatedAt,
    body,
    url: `https://github.com/owner/repo/pull/1#issuecomment-${eventId}`,
    commentId: eventId,
  };
}

function encodeEventCursor(events: readonly ReviewActivityEvent[]): ReviewEventCursor {
  const last = events.at(-1);
  const at = last?.updatedAt ?? "1970-01-01T00:00:00.000Z";
  return {
    scope: "review-events",
    provider: "github",
    repositoryDigest,
    reviewNumber: 1,
    opaque: JSON.stringify({
      at,
      seen: events.filter((event) => event.updatedAt === at).map((event) => event.eventId),
    }),
    orderKey: last?.orderKey ?? at,
  };
}

class ClassificationAdapter implements ConversationAdapter {
  readonly writes: string[] = [];

  constructor(
    private events: ReviewActivityEvent[],
    private readonly open: OpenReviewSummary[] = [summary(1)],
  ) {}

  replaceEvents(events: ReviewActivityEvent[]): void {
    this.events = events;
  }

  async getAuthenticatedBotIdentity() {
    return bot;
  }

  async listOpenReviews(): Promise<OpenReviewPage> {
    return {
      reviews: this.open,
      nextCursor: {
        scope: "open-review-discovery",
        provider: "github",
        repositoryDigest,
        opaque: "open",
        orderKey: this.open.at(-1)?.orderKey ?? "open",
      },
    };
  }

  async listReviewEvents(review: ReviewIdentity, after?: ReviewEventCursor): Promise<ReviewEventPage> {
    const remaining = after === undefined
      ? this.events
      : this.events.filter((event) => {
          const boundary = JSON.parse(after.opaque) as { at: string; seen: string[] };
          return event.updatedAt > boundary.at ||
            (event.updatedAt === boundary.at && !boundary.seen.includes(event.eventId));
        });
    return { events: remaining, nextCursor: encodeEventCursor(this.events) };
  }

  async listReviewThreads() {
    return { threads: [] };
  }

  async getReviewThread(): Promise<never> {
    throw new Error("unused");
  }

  async postGeneralReply(): Promise<never> {
    this.writes.push("general");
    throw new Error("provider writes are not implemented");
  }

  async postThreadReply(): Promise<never> {
    this.writes.push("thread");
    throw new Error("provider writes are not implemented");
  }

  async findBotChildMarker() {
    return null;
  }
}

describe("classification-only poll", () => {
  it("classifies irrelevant, oversized, invalid, and recognized events without posting replies", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    adapter.replaceEvents([
      commentEvent("irr", "looks good"),
      commentEvent("big", `${"x".repeat(MAX_COMMAND_BODY_SCALARS + 1)}`),
      commentEvent("bad", "@tgdbot frobnicate"),
      commentEvent("cmd", "@tgdbot explain"),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
      expect(adapter.writes).toEqual([]);
      expect(log.mock.calls.flat().join("\n")).toMatch(/@tgdbot explain/i);
      expect(log.mock.calls.flat().join("\n")).toMatch(/executor unavailable/i);
    } finally {
      log.mockRestore();
    }

    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const observed = snapshot.events.filter((entry) => entry.state === "observed");
    const prepared = snapshot.events.filter((entry) => entry.state === "prepared");
    expect(observed).toHaveLength(4);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.manifest).toEqual([]);
  });

  it("stops after 200 events, exits 0, and continues on the next invocation", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    adapter.replaceEvents(Array.from({ length: 250 }, (_, index) =>
      commentEvent(`n${index}`, `comment ${index}`, "2026-08-14T00:00:00.000Z")));
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const first = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(first.events.filter((entry) => entry.state === "observed")).toHaveLength(200);

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const second = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(second.events.filter((entry) => entry.state === "observed")).toHaveLength(250);
  });

  it("does not persist classified activity during dry-run after initialization", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const before = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();

    adapter.replaceEvents([commentEvent("cmd", "@tgdbot memories")]);
    await expect(poll(pollArgs(stateDir, { dryRun: true }), { conversationAdapter: adapter })).resolves.toBe(0);
    const after = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(after.events).toEqual(before.events);
    expect(after.cursor).toEqual(before.cursor);
  });

  it("returns 0 after first-run bootstrap with no historical handling", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([commentEvent("old", "@tgdbot explain", "2026-08-01T00:00:00.000Z")]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(/initialized.*0 processed events/i);
    } finally {
      log.mockRestore();
    }
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.events).toEqual([]);
    const paths = deriveConversationStatePaths(stateDir, repo);
    await expect(lstat(paths.cursorPath)).resolves.toBeDefined();
  });
});
