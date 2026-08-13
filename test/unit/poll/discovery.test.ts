import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandArgs } from "../../../src/cli-args.js";
import { computeRepositoryDigest } from "../../../src/conversation/markers.js";
import {
  createConversationStateStore,
} from "../../../src/conversation/state-store.js";
import { deriveConversationStatePaths } from "../../../src/conversation/state-paths.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import type {
  ConversationAdapter,
  OpenReviewPage,
  OpenReviewPageToken,
  OpenReviewSummary,
  ReviewActivityEvent,
  ReviewEventCursor,
  ReviewEventPage,
  ReviewEventPageToken,
} from "../../../src/vcs/conversation-adapter.js";
import type { ReviewIdentity } from "../../../src/conversation/types.js";
import { decodeReviewProgress, nextRoundRobinIndex } from "../../../src/poll/discovery.js";
import { poll } from "../../../src/poll/poll.js";
import type { PollArgs } from "../../../src/cli-args.js";
import type { ConversationEventEntry, ReviewCursorRecord } from "../../../src/conversation/state-schema.js";
import type { ConversationStateStore } from "../../../src/conversation/state-store.js";

const repo = parseRepositoryRef("owner/repo", "github");
const repositoryDigest = computeRepositoryDigest("github", repo.canonicalUrl);
const bot = { provider: "github" as const, login: "tgdbot", mention: "@tgdbot" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-poll-discovery-")));
  temporaryDirectories.push(directory);
  return path.join(directory, "state");
}

function pollArgs(stateDir: string, overrides: Partial<PollArgs> = {}): PollArgs {
  return {
    ...parseCommandArgs(["poll", "--repo", "owner/repo", "--state-dir", stateDir]),
    ...overrides,
    command: "poll",
    repo: overrides.repo ?? "owner/repo",
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

function summary(reviewNumber: number, updatedAt = "2026-08-13T00:00:00.000Z"): OpenReviewSummary {
  return {
    identity: identity(reviewNumber),
    title: `Review ${reviewNumber}`,
    headSha: "a".repeat(40),
    updatedAt,
    orderKey: `${updatedAt}|${String(reviewNumber).padStart(16, "0")}`,
  };
}

function commentEvent(
  reviewNumber: number,
  eventId: string,
  body: string,
  updatedAt = "2026-08-13T12:00:00.000Z",
  orderKey = `${updatedAt}|${eventId}`,
): ReviewActivityEvent {
  return {
    kind: "general-comment",
    provider: "github",
    repositoryDigest,
    reviewNumber,
    eventId,
    revisionId: `${eventId}:1`,
    orderKey,
    authorLogin: "alice",
    authorIsBot: false,
    createdAt: updatedAt,
    updatedAt,
    body,
    url: `https://github.com/owner/repo/pull/${reviewNumber}#issuecomment-${eventId}`,
    commentId: eventId,
  };
}

function encodeEventCursor(reviewNumber: number, events: readonly ReviewActivityEvent[]): ReviewEventCursor {
  const last = events.at(-1);
  const at = last?.updatedAt ?? "1970-01-01T00:00:00.000Z";
  const seen = events.filter((event) => event.updatedAt === at).map((event) => event.eventId);
  return {
    scope: "review-events",
    provider: "github",
    repositoryDigest,
    reviewNumber,
    opaque: JSON.stringify({ at, seen }),
    orderKey: last?.orderKey ?? at,
  };
}

function eventsAfter(
  events: readonly ReviewActivityEvent[],
  after?: ReviewEventCursor,
): ReviewActivityEvent[] {
  if (after === undefined) return [...events];
  const boundary = JSON.parse(after.opaque) as { at: string; seen: string[] };
  return events.filter((event) =>
    event.updatedAt > boundary.at ||
    (event.updatedAt === boundary.at && !boundary.seen.includes(event.eventId)));
}

interface FakeAdapterOptions {
  openReviewPages: OpenReviewSummary[][];
  eventsByReview: Map<number, ReviewActivityEvent[]>;
  eventPageSize?: number;
  failOpenReviewPage?: number;
  failEventPage?: { reviewNumber: number; page: number };
  failEventPageTimes?: number;
}

function epochEventCursor(reviewNumber: number): ReviewEventCursor {
  return {
    scope: "review-events",
    provider: "github",
    repositoryDigest,
    reviewNumber,
    opaque: JSON.stringify({ at: "1970-01-01T00:00:00.000Z", seen: [] }),
    orderKey: "1970-01-01T00:00:00.000Z",
  };
}

function encodeEventPageToken(page: number, after: string | null): string {
  return JSON.stringify({ page, after });
}

function decodeEventPageToken(opaque: string): { page: number; after: string | null } {
  const parsed = JSON.parse(opaque) as { page?: number; after?: string | null };
  if (!Number.isSafeInteger(parsed.page) || (parsed.page as number) < 1 ||
    (parsed.after !== null && typeof parsed.after !== "string")) {
    throw new Error("invalid event page token");
  }
  return { page: parsed.page as number, after: parsed.after ?? null };
}

function eventPageIndex(pageToken?: string): number {
  return pageToken === undefined ? 0 : decodeEventPageToken(pageToken).page;
}

class FakeConversationAdapter implements ConversationAdapter {
  readonly openReviewCalls: Array<{ pageToken?: string }> = [];
  readonly eventCalls: Array<{ reviewNumber: number; after?: string; pageToken?: string }> = [];
  readonly emittedEventIds: string[][] = [];
  readonly writes: string[] = [];
  private eventPageFailures = 0;

  constructor(private readonly options: FakeAdapterOptions) {}

  async getAuthenticatedBotIdentity() {
    return bot;
  }

  async listOpenReviews(
    _repository: { provider: "github" | "gitlab"; repositoryDigest: string },
    _after?: { opaque: string },
    pageToken?: OpenReviewPageToken,
  ): Promise<OpenReviewPage> {
    const pageIndex = pageToken === undefined ? 0 : Number(pageToken.opaque);
    this.openReviewCalls.push({ pageToken: pageToken?.opaque });
    if (this.options.failOpenReviewPage === pageIndex + 1) {
      throw new Error(`discovery page ${pageIndex + 1} failed`);
    }
    const reviews = this.options.openReviewPages[pageIndex] ?? [];
    const hasMore = pageIndex + 1 < this.options.openReviewPages.length;
    return {
      reviews,
      nextCursor: {
        scope: "open-review-discovery",
        provider: "github",
        repositoryDigest,
        opaque: `open-${pageIndex}`,
        orderKey: reviews.at(-1)?.orderKey ?? `open-${pageIndex}`,
      },
      ...(hasMore
        ? {
            nextPageToken: {
              scope: "open-review-page" as const,
              provider: "github" as const,
              repositoryDigest,
              opaque: String(pageIndex + 1),
            },
          }
        : {}),
    };
  }

  async listReviewEvents(
    review: ReviewIdentity,
    after?: ReviewEventCursor,
    pageToken?: ReviewEventPageToken,
  ): Promise<ReviewEventPage> {
    const pageSize = this.options.eventPageSize ?? 100;
    const startAfter = after?.opaque ?? null;
    const continuation = pageToken === undefined ? { page: 0, after: startAfter } : decodeEventPageToken(pageToken.opaque);
    if (continuation.after !== startAfter) {
      throw new Error("continuation cursor binding mismatch");
    }
    const pageIndex = continuation.page;
    this.eventCalls.push({
      reviewNumber: review.reviewNumber,
      after: after?.opaque,
      pageToken: pageToken?.opaque,
    });
    if (
      this.options.failEventPage?.reviewNumber === review.reviewNumber &&
      this.options.failEventPage.page === pageIndex + 1
    ) {
      const allowed = this.options.failEventPageTimes ?? Number.POSITIVE_INFINITY;
      if (this.eventPageFailures < allowed) {
        this.eventPageFailures += 1;
        throw new Error(`event page ${pageIndex + 1} for review ${review.reviewNumber} failed`);
      }
    }
    const all = this.options.eventsByReview.get(review.reviewNumber) ?? [];
    const remaining = eventsAfter(all, after);
    const start = pageIndex * pageSize;
    const events = remaining.slice(start, start + pageSize);
    const stillPending = remaining.slice(start + events.length);
    const consumed = all.filter((event) => !stillPending.includes(event));
    const hasMore = stillPending.length > 0;
    this.emittedEventIds.push(events.map((event) => event.eventId));
    return {
      events,
      nextCursor: hasMore
        ? after ?? epochEventCursor(review.reviewNumber)
        : after !== undefined && events.length === 0
          ? after
          : encodeEventCursor(review.reviewNumber, consumed),
      ...(hasMore
        ? {
            nextPageToken: {
              scope: "review-event-page" as const,
              provider: "github" as const,
              repositoryDigest,
              reviewNumber: review.reviewNumber,
              opaque: encodeEventPageToken(pageIndex + 1, startAfter),
            },
          }
        : {}),
    };
  }

  async listReviewThreads() {
    return { threads: [] };
  }

  async getReviewThread(): Promise<never> {
    throw new Error("getReviewThread should not run during discovery");
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

async function expectUninitialized(stateDir: string): Promise<void> {
  const paths = deriveConversationStatePaths(stateDir, repo);
  await expect(lstat(paths.cursorPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(paths.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(paths.journalHeadPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(paths.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("nextRoundRobinIndex", () => {
  it("compares review numbers numerically so review 10 follows 9 instead of wrapping to 8", () => {
    const reviews: ReviewCursorRecord[] = [8, 9, 10].map((reviewNumber) => ({
      reviewNumber,
      cursor: "progress",
      retired: false,
    }));
    // After processing 9 the saved key is "10"; string compare would pick 8 ("8" >= "10").
    expect(nextRoundRobinIndex(reviews, "10")).toBe(2);
    expect(reviews[nextRoundRobinIndex(reviews, "10")]?.reviewNumber).toBe(10);
  });
});

describe("poll discovery and bootstrap", () => {
  it("bootstraps a multi-page open-review set at the current high-water mark with zero handled history", async () => {
    const stateDir = await tempStateDir();
    const historical = new Map<number, ReviewActivityEvent[]>([
      [1, [commentEvent(1, "h1", "@tgdbot explain", "2026-08-01T00:00:00.000Z")]],
      [2, [commentEvent(2, "h2", "@tgdbot memories", "2026-08-02T00:00:00.000Z")]],
      [3, Array.from({ length: 120 }, (_, index) =>
        commentEvent(3, `h3-${index}`, "old note", "2026-08-03T00:00:00.000Z"))],
    ]);
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1), summary(2)], [summary(3)]],
      eventsByReview: historical,
      eventPageSize: 100,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(/initialized.*0 processed events/i);
      expect(adapter.writes).toEqual([]);

      const store = createConversationStateStore({ root: stateDir, repository: repo });
      const snapshot = await store.readContextSnapshot();
      expect(snapshot.cursor.initialized).toBe(true);
      expect(snapshot.cursor.reviews.map((review) => review.reviewNumber)).toEqual([1, 2, 3]);
      expect(snapshot.events).toEqual([]);
      expect(snapshot.cursor.reviews.every((review) => review.cursor !== null && !review.retired)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("performs no state writes during dry-run bootstrap", async () => {
    const stateDir = await tempStateDir();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)], [summary(2)]],
      eventsByReview: new Map([
        [1, [commentEvent(1, "h1", "@tgdbot explain")]],
        [2, [commentEvent(2, "h2", "later")]],
      ]),
    });

    await expect(poll(pollArgs(stateDir, { dryRun: true }), { conversationAdapter: adapter })).resolves.toBe(0);
    await expectUninitialized(stateDir);
    await expect(readdir(path.dirname(stateDir))).resolves.toEqual([]);
  });

  it.each([
    ["open-review page 1", { failOpenReviewPage: 1 }],
    ["open-review page 2", { failOpenReviewPage: 2 }],
    ["event high-water page 1", { failEventPage: { reviewNumber: 1, page: 1 } }],
    ["event high-water page 2", { failEventPage: { reviewNumber: 1, page: 2 } }],
    ["later review high-water page", { failEventPage: { reviewNumber: 2, page: 1 } }],
  ])("leaves the store uninitialized when %s fails during bootstrap", async (_label, failure) => {
    const stateDir = await tempStateDir();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)], [summary(2)]],
      eventsByReview: new Map([
        [1, Array.from({ length: 120 }, (_, index) => commentEvent(1, `e${index}`, "old"))],
        [2, [commentEvent(2, "e2", "old")]],
      ]),
      eventPageSize: 100,
      ...failure,
    });

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).rejects.toThrow(/failed/i);
    await expectUninitialized(stateDir);
  });

  it("commits bootstrap in one transaction only after every page and high-water lookup succeeds", async () => {
    const stateDir = await tempStateDir();
    const paths = deriveConversationStatePaths(stateDir, repo);
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)], [summary(2)]],
      eventsByReview: new Map([
        [1, Array.from({ length: 120 }, (_, index) => commentEvent(1, `e${index}`, "old"))],
        [2, [commentEvent(2, "e2", "old")]],
      ]),
      eventPageSize: 100,
    });
    const originalOpen = adapter.listOpenReviews.bind(adapter);
    const originalEvents = adapter.listReviewEvents.bind(adapter);
    adapter.listOpenReviews = async (...args) => {
      await expectUninitialized(stateDir);
      return originalOpen(...args);
    };
    adapter.listReviewEvents = async (...args) => {
      await expectUninitialized(stateDir);
      return originalEvents(...args);
    };

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.openReviewCalls).toHaveLength(2);
    expect(adapter.eventCalls.some((call) => call.reviewNumber === 1 && eventPageIndex(call.pageToken) === 1)).toBe(true);
    expect(adapter.eventCalls.filter((call) => call.reviewNumber === 1).every((call) => call.after === undefined)).toBe(true);
    await expect(lstat(paths.cursorPath)).resolves.toBeDefined();
  });

  it("lets the second concurrent initializer recheck under the lock and refuse to overwrite the first snapshot", async () => {
    const stateDir = await tempStateDir();
    let started = 0;
    let releaseStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const first = new FakeConversationAdapter({
      openReviewPages: [[summary(1)]],
      eventsByReview: new Map([[1, [commentEvent(1, "first-only", "hello")]]]),
    });
    const second = new FakeConversationAdapter({
      openReviewPages: [[summary(1), summary(2)]],
      eventsByReview: new Map([
        [1, [commentEvent(1, "second", "hello")]],
        [2, [commentEvent(2, "extra", "hello")]],
      ]),
    });
    const firstOpen = first.listOpenReviews.bind(first);
    const secondOpen = second.listOpenReviews.bind(second);
    first.listOpenReviews = async (...args) => {
      if (++started === 2) releaseStarted();
      await bothStarted;
      return firstOpen(...args);
    };
    second.listOpenReviews = async (...args) => {
      if (++started === 2) releaseStarted();
      await bothStarted;
      await firstFinished;
      return secondOpen(...args);
    };

    const firstRun = poll(pollArgs(stateDir), { conversationAdapter: first }).then((code) => {
      finishFirst();
      return code;
    });
    const secondRun = poll(pollArgs(stateDir), { conversationAdapter: second });
    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([0, 0]);

    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.cursor.reviews.map((review) => review.reviewNumber)).toEqual([1]);
    expect(snapshot.cursor.reviews).toHaveLength(1);
  });

  it("starts later-created reviews at creation instead of a sibling review's high-water mark", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>([
      [1, [commentEvent(1, "old-1", "@tgdbot explain", "2026-08-01T00:00:00.000Z")]],
    ]);
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)]],
      eventsByReview,
    });

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    eventsByReview.set(1, [
      commentEvent(1, "old-1", "@tgdbot explain", "2026-08-01T00:00:00.000Z"),
      commentEvent(1, "new-1", "later on one", "2026-08-14T00:00:00.000Z"),
    ]);
    eventsByReview.set(2, [
      commentEvent(2, "created-1", "@tgdbot memories", "2026-08-14T00:00:00.000Z"),
    ]);
    adapter["options"].openReviewPages = [[summary(1), summary(2)]];

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const snapshot = await store.readContextSnapshot();
    const journal = await journalEvents(store);
    expect(journal.some((entry) => entry.reviewNumber === 2)).toBe(true);
    expect(journal.some((entry) => entry.reviewNumber === 1)).toBe(true);
    expect(snapshot.events.some((entry) => entry.reviewNumber === 2)).toBe(true);
    const reviewOneAfter = adapter.eventCalls.filter((call) => call.reviewNumber === 1 && call.after !== undefined);
    expect(reviewOneAfter.length).toBeGreaterThan(0);
    const reviewTwoFromStart = adapter.eventCalls.filter((call) => call.reviewNumber === 2);
    expect(reviewTwoFromStart.some((call) => call.after === undefined)).toBe(true);
  });

  it("keeps independent per-review cursors", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>([
      [1, [commentEvent(1, "seed-1", "seed", "2026-08-01T00:00:00.000Z")]],
      [2, [commentEvent(2, "seed-2", "seed", "2026-08-01T00:00:00.000Z")]],
    ]);
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1), summary(2)]],
      eventsByReview,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const bootstrapped = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const reviewTwoCursor = bootstrapped.cursor.reviews.find((review) => review.reviewNumber === 2)?.cursor;

    eventsByReview.set(1, [
      commentEvent(1, "seed-1", "seed", "2026-08-01T00:00:00.000Z"),
      commentEvent(1, "live-1", "new on one", "2026-08-14T00:00:00.000Z"),
    ]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(decodeReviewProgress(snapshot.cursor.reviews.find((review) => review.reviewNumber === 2)?.cursor ?? null))
      .toMatchObject({
        eventOpaque: decodeReviewProgress(reviewTwoCursor ?? null)?.eventOpaque,
        eventOrderKey: decodeReviewProgress(reviewTwoCursor ?? null)?.eventOrderKey,
      });
    expect(decodeReviewProgress(snapshot.cursor.reviews.find((review) => review.reviewNumber === 1)?.cursor ?? null)
      ?.eventOpaque).not.toBe(decodeReviewProgress(
        bootstrapped.cursor.reviews.find((review) => review.reviewNumber === 1)?.cursor ?? null,
      )?.eventOpaque);
  });

  it("includes an equal-time event omitted from the committed high-water seen-set", async () => {
    const stateDir = await tempStateDir();
    const stamp = "2026-08-14T10:00:00.000Z";
    const eventsByReview = new Map<number, ReviewActivityEvent[]>([
      [1, [commentEvent(1, "seed", "committed at T", stamp, stamp)]],
    ]);
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)]],
      eventsByReview,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const bootstrapped = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const committed = decodeReviewProgress(bootstrapped.cursor.reviews[0]?.cursor ?? null);
    expect(committed?.eventOrderKey).toBe(stamp);
    expect(JSON.parse(committed?.eventOpaque ?? "{}")).toMatchObject({ at: stamp, seen: ["seed"] });

    eventsByReview.set(1, [
      commentEvent(1, "seed", "committed at T", stamp, stamp),
      commentEvent(1, "late", "same time, not in seen-set", stamp, stamp),
    ]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const snapshot = await store.readContextSnapshot();
    expect(snapshot.events.filter((entry) => entry.state === "observed")).toHaveLength(0);
    expect((await journalEvents(store)).filter((entry) => entry.state === "observed")).toHaveLength(1);
  });

  it("bootstraps a review with more than 100 events using a frozen after cursor", async () => {
    const stateDir = await tempStateDir();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)]],
      eventsByReview: new Map([
        [1, Array.from({ length: 150 }, (_, index) =>
          commentEvent(1, `hist-${index}`, "old", "2026-08-03T00:00:00.000Z"))],
      ]),
      eventPageSize: 100,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(adapter.eventCalls.every((call) => call.after === undefined)).toBe(true);
    expect(adapter.eventCalls.some((call) => eventPageIndex(call.pageToken) === 1)).toBe(true);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.events).toEqual([]);
    const progress = decodeReviewProgress(snapshot.cursor.reviews[0]?.cursor ?? null);
    expect(JSON.parse(progress?.eventOpaque ?? "{}").seen).toHaveLength(150);
    expect(snapshot.cursor.reviews[0]).not.toHaveProperty("eventPageToken");
  });

  it("visits known reviews round-robin and resumes from the saved next key", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1), summary(2), summary(3)]],
      eventsByReview,
      eventPageSize: 100,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    for (const reviewNumber of [1, 2, 3]) {
      eventsByReview.set(
        reviewNumber,
        Array.from({ length: 100 }, (_, index) =>
          commentEvent(reviewNumber, `${reviewNumber}-${index}`, `note ${index}`, "2026-08-14T00:00:00.000Z")),
      );
    }
    adapter.eventCalls.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.eventCalls.map((call) => call.reviewNumber)).toEqual([1, 2]);

    const mid = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(mid.cursor.nextRoundRobinKey).toBe("3");

    adapter.eventCalls.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.eventCalls[0]?.reviewNumber).toBe(3);
  }, 30_000);

  it("resumes after review 9 at review 10, not review 8", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(8), summary(9), summary(10)]],
      eventsByReview,
      eventPageSize: 100,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    for (const reviewNumber of [8, 9, 10]) {
      eventsByReview.set(
        reviewNumber,
        Array.from({ length: 100 }, (_, index) =>
          commentEvent(reviewNumber, `${reviewNumber}-${index}`, `note ${index}`, "2026-08-14T00:00:00.000Z")),
      );
    }
    adapter.eventCalls.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.eventCalls.map((call) => call.reviewNumber)).toEqual([8, 9]);

    const mid = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(mid.cursor.nextRoundRobinKey).toBe("10");

    adapter.eventCalls.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.eventCalls[0]?.reviewNumber).toBe(10);
  }, 30_000);

  it("retires reviews that disappear from a completed open-review scan", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>([
      [1, []],
      [2, []],
    ]);
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1), summary(2)]],
      eventsByReview,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    adapter["options"].openReviewPages = [[summary(1)]];
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const closed = snapshot.cursor.reviews.find((review) => review.reviewNumber === 2);
    expect(closed?.retired).toBe(true);
    expect(closed?.retiredAt).toMatch(/Z$/);
    expect(snapshot.cursor.reviews.find((review) => review.reviewNumber === 1)?.retired).toBe(false);
  });

  it("retries the same page token after a repeated fetch failure without advancing the cursor", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)]],
      eventsByReview,
      eventPageSize: 100,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const bootstrapped = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const startAfter = decodeReviewProgress(bootstrapped.cursor.reviews[0]?.cursor ?? null)?.eventOpaque;

    eventsByReview.set(
      1,
      Array.from({ length: 150 }, (_, index) => commentEvent(1, `live-${index}`, "note", "2026-08-14T00:00:00.000Z")),
    );
    adapter["options"].failEventPage = { reviewNumber: 1, page: 2 };
    adapter["options"].failEventPageTimes = 1;

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).rejects.toThrow(/event page 2/);
    const afterFailureStore = createConversationStateStore({ root: stateDir, repository: repo });
    const afterFailure = await afterFailureStore.readContextSnapshot();
    const failedReview = afterFailure.cursor.reviews.find((review) => review.reviewNumber === 1);
    expect((await journalEvents(afterFailureStore)).filter((entry) => entry.state === "observed")).toHaveLength(100);
    expect(decodeReviewProgress(failedReview?.cursor ?? null)?.eventOpaque).toBe(startAfter);
    const pageTwoCalls = () => adapter.eventCalls.filter((call) => eventPageIndex(call.pageToken) === 1);
    expect(pageTwoCalls()).toHaveLength(1);
    const failedToken = pageTwoCalls()[0]?.pageToken;
    expect(failedToken).toEqual(encodeEventPageToken(1, startAfter ?? null));
    expect(failedReview?.eventPageToken).toBe(failedToken);

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(pageTwoCalls().length).toBeGreaterThan(1);
    expect(pageTwoCalls().every((call) => call.pageToken === failedToken)).toBe(true);
    expect(adapter.eventCalls.filter((call) => call.after === startAfter && call.pageToken === undefined)).toHaveLength(1);
    const recoveredStore = createConversationStateStore({ root: stateDir, repository: repo });
    const recovered = await recoveredStore.readContextSnapshot();
    expect((await journalEvents(recoveredStore)).filter((entry) => entry.state === "observed")).toHaveLength(150);
    expect(recovered.cursor.reviews.find((review) => review.reviewNumber === 1)).not.toHaveProperty("eventPageToken");
    expect(decodeReviewProgress(recovered.cursor.reviews[0]?.cursor ?? null)?.eventOpaque).not.toBe(startAfter);
  }, 30_000);

  it("resumes a 250-event review from the same after cursor and next page token", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1)]],
      eventsByReview,
      eventPageSize: 100,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const bootstrapped = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const startAfter = decodeReviewProgress(bootstrapped.cursor.reviews[0]?.cursor ?? null)?.eventOpaque;

    eventsByReview.set(
      1,
      Array.from({ length: 250 }, (_, index) => commentEvent(1, `n${index}`, `comment ${index}`, "2026-08-14T00:00:00.000Z")),
    );
    adapter.eventCalls.length = 0;
    adapter.emittedEventIds.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const firstStore = createConversationStateStore({ root: stateDir, repository: repo });
    const first = await firstStore.readContextSnapshot();
    expect((await journalEvents(firstStore)).filter((entry) => entry.state === "observed")).toHaveLength(200);
    expect(decodeReviewProgress(first.cursor.reviews[0]?.cursor ?? null)?.eventOpaque).toBe(startAfter);
    expect(first.cursor.reviews[0]?.eventPageToken).toBe(encodeEventPageToken(2, startAfter ?? null));
    expect(adapter.emittedEventIds.flat()).toEqual(Array.from({ length: 200 }, (_, index) => `n${index}`));

    adapter.eventCalls.length = 0;
    adapter.emittedEventIds.length = 0;
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.eventCalls[0]).toEqual(
      expect.objectContaining({ after: startAfter, pageToken: encodeEventPageToken(2, startAfter ?? null) }),
    );
    expect(adapter.eventCalls.some((call) => call.after === startAfter && call.pageToken === undefined)).toBe(false);
    expect(adapter.emittedEventIds[0]).toEqual(Array.from({ length: 50 }, (_, index) => `n${index + 200}`));
    expect(adapter.emittedEventIds.flat()).not.toContain("n0");
    const secondStore = createConversationStateStore({ root: stateDir, repository: repo });
    const second = await secondStore.readContextSnapshot();
    expect((await journalEvents(secondStore)).filter((entry) => entry.state === "observed")).toHaveLength(250);
    expect(second.cursor.reviews[0]).not.toHaveProperty("eventPageToken");
  }, 30_000);

  it("does not advance a review cursor when that review's fetch fails after another review succeeds", async () => {
    const stateDir = await tempStateDir();
    const eventsByReview = new Map<number, ReviewActivityEvent[]>();
    const adapter = new FakeConversationAdapter({
      openReviewPages: [[summary(1), summary(2)]],
      eventsByReview,
    });
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    const bootstrapped = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    const reviewTwoCursor = bootstrapped.cursor.reviews.find((review) => review.reviewNumber === 2)?.cursor;

    eventsByReview.set(1, [commentEvent(1, "ok", "new on one", "2026-08-14T00:00:00.000Z")]);
    eventsByReview.set(2, [commentEvent(2, "bad", "new on two", "2026-08-14T00:00:00.000Z")]);
    adapter["options"].failEventPage = { reviewNumber: 2, page: 1 };

    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).rejects.toThrow(/review 2/);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.cursor.reviews.find((review) => review.reviewNumber === 1)?.cursor).not.toBe(
      bootstrapped.cursor.reviews.find((review) => review.reviewNumber === 1)?.cursor,
    );
    expect(decodeReviewProgress(snapshot.cursor.reviews.find((review) => review.reviewNumber === 2)?.cursor ?? null)
      ?.eventOpaque).toBe(decodeReviewProgress(reviewTwoCursor ?? null)?.eventOpaque);
  });
});
