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
  ReviewEventPageToken,
} from "../../../src/vcs/conversation-adapter.js";
import type { ReviewIdentity } from "../../../src/conversation/types.js";
import type { ConversationEventEntry } from "../../../src/conversation/state-schema.js";
import type { ConversationStateStore } from "../../../src/conversation/state-store.js";
import { decodeReviewProgress } from "../../../src/poll/discovery.js";
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
  readonly eventCalls: Array<{ after?: string; pageToken?: string }> = [];
  readonly emittedEventIds: string[][] = [];

  constructor(
    private events: ReviewActivityEvent[],
    private readonly open: OpenReviewSummary[] = [summary(1)],
    private readonly pageSize = 100,
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

  async listReviewEvents(
    _review: ReviewIdentity,
    after?: ReviewEventCursor,
    pageToken?: ReviewEventPageToken,
  ): Promise<ReviewEventPage> {
    const startAfter = after?.opaque ?? null;
    const continuation = pageToken === undefined
      ? { page: 0, after: startAfter }
      : JSON.parse(pageToken.opaque) as { page: number; after: string | null };
    if (continuation.after !== startAfter) throw new Error("continuation cursor binding mismatch");
    this.eventCalls.push({ after: after?.opaque, pageToken: pageToken?.opaque });
    const remaining = after === undefined
      ? this.events
      : this.events.filter((event) => {
          const boundary = JSON.parse(after.opaque) as { at: string; seen: string[] };
          return event.updatedAt > boundary.at ||
            (event.updatedAt === boundary.at && !boundary.seen.includes(event.eventId));
        });
    const start = continuation.page * this.pageSize;
    const events = remaining.slice(start, start + this.pageSize);
    const hasMore = remaining.length > start + events.length;
    this.emittedEventIds.push(events.map((event) => event.eventId));
    const nextCursor = hasMore
      ? after ?? {
          scope: "review-events" as const,
          provider: "github" as const,
          repositoryDigest,
          reviewNumber: 1,
          opaque: JSON.stringify({ at: "1970-01-01T00:00:00.000Z", seen: [] }),
          orderKey: "1970-01-01T00:00:00.000Z",
        }
      : after !== undefined && events.length === 0
        ? after
        : encodeEventCursor(this.events.filter((event) => !remaining.slice(start + events.length).includes(event)));
    return {
      events,
      nextCursor,
      ...(hasMore
        ? {
            nextPageToken: {
              scope: "review-event-page" as const,
              provider: "github" as const,
              repositoryDigest,
              reviewNumber: 1,
              opaque: JSON.stringify({ page: continuation.page + 1, after: startAfter }),
            },
          }
        : {}),
    };
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

async function journalEvents(store: ConversationStateStore): Promise<ConversationEventEntry[]> {
  const entries: ConversationEventEntry[] = [];
  let cursor = null;
  for (;;) {
    const page = await store.readAuditPage("events", cursor, 100);
    entries.push(...(page.entries as ConversationEventEntry[]));
    if (page.nextCursor === null) return entries;
    cursor = page.nextCursor;
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

    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const snapshot = await store.readContextSnapshot();
    const observed = snapshot.events.filter((entry) => entry.state === "observed");
    const prepared = snapshot.events.filter((entry) => entry.state === "prepared");
    expect(observed).toHaveLength(1);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.manifest).toEqual([]);
    expect(snapshot.events.filter((entry) => entry.state === "completed")).toHaveLength(0);
    const journal = await journalEvents(store);
    expect(journal.filter((entry) => entry.state === "observed")).toHaveLength(4);
    expect(journal.filter((entry) => entry.state === "completed")).toHaveLength(3);
    expect(journal.filter((entry) => entry.state === "prepared")).toHaveLength(1);
  });

  it("stops after 200 events, exits 0, and continues on the next invocation", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const startAfter = decodeReviewProgress(
      (await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot())
        .cursor.reviews[0]?.cursor ?? null,
    )?.eventOpaque;

    adapter.replaceEvents(Array.from({ length: 250 }, (_, index) =>
      commentEvent(`n${index}`, `comment ${index}`, "2026-08-14T00:00:00.000Z")));
    adapter.eventCalls.length = 0;
    adapter.emittedEventIds.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const firstStore = createConversationStateStore({ root: stateDir, repository: repo });
    const first = await firstStore.readContextSnapshot();
    expect((await journalEvents(firstStore)).filter((entry) => entry.state === "observed")).toHaveLength(200);
    expect(first.events.filter((entry) => entry.state === "observed")).toHaveLength(0);
    expect(decodeReviewProgress(first.cursor.reviews[0]?.cursor ?? null)?.eventOpaque).toBe(startAfter);
    expect(first.cursor.reviews[0]?.eventPageToken).toBeDefined();
    expect(adapter.emittedEventIds.flat()).toEqual(Array.from({ length: 200 }, (_, index) => `n${index}`));

    adapter.eventCalls.length = 0;
    adapter.emittedEventIds.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.eventCalls[0]).toEqual(
      expect.objectContaining({ pageToken: first.cursor.reviews[0]?.eventPageToken }),
    );
    expect(adapter.eventCalls.some((call) => call.pageToken === undefined && call.after === startAfter)).toBe(false);
    expect(adapter.emittedEventIds[0]).toEqual(Array.from({ length: 50 }, (_, index) => `n${index + 200}`));
    expect(adapter.emittedEventIds.flat()).not.toContain("n0");
    const secondStore = createConversationStateStore({ root: stateDir, repository: repo });
    const second = await secondStore.readContextSnapshot();
    expect((await journalEvents(secondStore)).filter((entry) => entry.state === "observed")).toHaveLength(250);
    expect(second.events.filter((entry) => entry.state === "observed")).toHaveLength(0);
    expect(second.cursor.reviews[0]).not.toHaveProperty("eventPageToken");
  }, 30_000);

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

  it("does not throw or stall after more than 1000 irrelevant events across polls", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([], [summary(1)], 1200);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const bootstrapped = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const startAfter = decodeReviewProgress(bootstrapped.cursor.reviews[0]?.cursor ?? null)?.eventOpaque;

    adapter.replaceEvents(Array.from({ length: 1100 }, (_, index) =>
      commentEvent(
        `irr-${index}`,
        `noise ${index}`,
        new Date(Date.parse("2026-08-14T00:00:00.000Z") + index * 1000).toISOString(),
      )));

    for (let invocation = 0; invocation < 8; invocation += 1) {
      await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    }

    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const snapshot = await store.readContextSnapshot();
    expect(snapshot.events.length).toBeLessThan(1000);
    expect(decodeReviewProgress(snapshot.cursor.reviews[0]?.cursor ?? null)?.eventOpaque).not.toBe(startAfter);
    const journal = await journalEvents(store);
    expect(journal.filter((entry) => entry.state === "observed").length).toBe(1100);
    expect(journal.filter((entry) => entry.state === "completed").length).toBe(1100);
    expect(snapshot.events.filter((entry) => entry.state === "observed")).toHaveLength(0);
  }, 120_000);
});
