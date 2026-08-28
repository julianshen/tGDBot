import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandArgs, type PollArgs } from "../../../src/cli-args.js";
import { MAX_COMMAND_BODY_SCALARS } from "../../../src/conversation/command-parser.js";
import {
  computeContentDigest,
  computeRepositoryDigest,
  formatChildMarker,
  parseChildMarker,
  verifyChildMarkerBinding,
} from "../../../src/conversation/markers.js";
import { encodeMemoryPublicId } from "../../../src/conversation/memories.js";
import { resolvePollConfig } from "../../../src/poll/config.js";
import type { VcsAdapter } from "../../../src/vcs/adapter.js";
import { deriveConversationStatePaths } from "../../../src/conversation/state-paths.js";
import { createConversationStateStore } from "../../../src/conversation/state-store.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import type {
  ChildMarkerLookup,
  ConversationAdapter,
  GeneralReplyInput,
  OpenReviewPage,
  OpenReviewSummary,
  ReviewActivityEvent,
  ReviewEventCursor,
  ReviewEventPage,
  ReviewEventPageToken,
  ReviewThreadSnapshot,
  ThreadReplyInput,
} from "../../../src/vcs/conversation-adapter.js";
import type { ConversationItemIdentity, ReviewIdentity } from "../../../src/conversation/types.js";
import {
  bindFindingLedgerIdentity,
  prepareFindingLedgerEntry,
  type ConversationEventEntry,
  type FindingLedgerEntry,
} from "../../../src/conversation/state-schema.js";
import type { ConversationStateStore } from "../../../src/conversation/state-store.js";
import { decodeReviewProgress } from "../../../src/poll/discovery.js";
import {
  createPreparedClarification,
  transitionClarification,
} from "../../../src/conversation/clarification.js";
import { extractFileHunk, poll } from "../../../src/poll/poll.js";
import { createPiSessionStub } from "../../fixtures/pi-session-stub.js";
import type { ConversationSessionFactory } from "../../../src/conversation/session.js";
import type { RuleDefinition } from "../../../src/rules/types.js";
import { parseBotMarker } from "../../../src/review/comment-marker.js";
import { validateConversationItemIdentity } from "../../../src/vcs/adapter.js";
import type { BotComment } from "../../../src/vcs/adapter.js";
import type { PublicationExecutorHooks } from "../../../src/conversation/publication-manifest.js";

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

function commentEvent(
  eventId: string,
  body: string,
  updatedAt = "2026-08-14T00:00:00.000Z",
  extras: Partial<ReviewActivityEvent> = {},
): ReviewActivityEvent {
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
    ...extras,
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
  // Every recognized command now has an executor, so the only events that are
  // classified without a reply are the ones that are not commands at all:
  // ordinary prose, and anything tGDBot itself authored.
  it("classifies irrelevant and self-authored events without posting replies", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    adapter.replaceEvents([
      commentEvent("irr", "looks good"),
      commentEvent("self", "@tgdbot explain", "2026-08-14T00:00:00.000Z", { authorLogin: "tgdbot", authorIsBot: true }),
    ]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
    expect(adapter.writes).toEqual([]);

    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const snapshot = await store.readContextSnapshot();
    expect(snapshot.events.filter((entry) => entry.state === "prepared")).toHaveLength(0);
    const journal = await journalEvents(store);
    expect(journal.filter((entry) => entry.state === "observed")).toHaveLength(2);
    expect(journal.filter((entry) => entry.state === "completed")).toHaveLength(2);
    expect(journal.filter((entry) => entry.state === "prepared")).toHaveLength(0);
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

  // Dry-run is the only way to inspect what tGDBot would do against a real
  // repository, so it has to be trustworthy across EVERY command, not just the
  // one that happened to be implemented when it was written. Each of these can
  // otherwise write: to the provider, to the memory ledger, to pending
  // directions, or by dispatching a review.
  it("dry-run writes nothing for any recognized command", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const before = await store.readContextSnapshot();
    const createSession = vi.fn(sessionFor("{}"));
    const runReview = vi.fn(async () => 0);
    adapter.replaceEvents([
      commentEvent("irr", "looks good", "2026-08-14T00:00:01.000Z"),
      commentEvent("bad", "@tgdbot frobnicate", "2026-08-14T00:00:02.000Z"),
      commentEvent("rem", "@tgdbot remember prefer explicit null checks", "2026-08-14T00:00:03.000Z"),
      commentEvent("forget", `@tgdbot forget mem_${"a".repeat(26)}`, "2026-08-14T00:00:04.000Z"),
      commentEvent("list", "@tgdbot memories", "2026-08-14T00:00:05.000Z"),
      commentEvent("focus", "@tgdbot review focus: the error handling", "2026-08-14T00:00:06.000Z"),
      commentEvent("force", "@tgdbot check latest", "2026-08-14T00:00:07.000Z"),
      commentEvent("exp", "@tgdbot explain", "2026-08-14T00:00:08.000Z"),
    ]);

    await expect(poll(pollArgs(stateDir, { dryRun: true, model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }), runReview,
    })).resolves.toBe(0);

    // Nothing reached the provider, the model, or the review flow.
    expect(adapter.postedBodies).toEqual([]);
    expect(adapter.writes).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
    // ...and no local domain state moved, including the ledgers the memory and
    // focus commands would otherwise append to.
    const after = await store.readContextSnapshot();
    expect(after.events).toEqual(before.events);
    expect(after.cursor).toEqual(before.cursor);
    expect(after.memories).toEqual(before.memories);
    expect(after.memoryLedger).toEqual(before.memoryLedger);
    expect(after.pending).toEqual(before.pending);
    expect(after.findings).toEqual(before.findings);
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

const FINDING_ID = `finding_${"1".repeat(32)}`;
const currentHunk = "@@ -12,3 +12,4 @@\n export function dump(user) {\n+  console.log(user.token);\n   return user;\n }";
const commentableAuthDiff = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -12,3 +12,4 @@",
  " export function dump(user) {",
  "+  console.log(user.token);",
  "   return user;",
  " }",
].join("\n");

it("extracts only the addressed file section for focused model context", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-old auth",
    "+new auth",
    "diff --git a/src/other.ts b/src/other.ts",
    "--- a/src/other.ts",
    "+++ b/src/other.ts",
    "@@ -1 +1 @@",
    "-old other",
    "+new other",
  ].join("\n");

  expect(extractFileHunk(diff, "src/auth.ts")).toContain("+new auth");
  expect(extractFileHunk(diff, "src/auth.ts")).not.toContain("src/other.ts");
  expect(extractFileHunk(diff, "missing.ts")).toBe(diff);
});

function postedInlineIdentity(commentId: string) {
  return validateConversationItemIdentity({
    provider: "github",
    commentId,
    threadId: `thread-${commentId}`,
    url: `https://github.com/owner/repo/pull/1#discussion_r${commentId}`,
  }, { repo, reviewNumber: 1 });
}

function silentReviewVcs(options: {
  readonly failNextInline?: "throw" | "accept-then-fail" | null;
} = {}) {
  let stored: BotComment | null = null;
  const postedInlines: Array<{ clientId: string; path: string; line: number; body: string }> = [];
  const summaries: string[] = [];
  const publishedByMarker = new Map<string, ReturnType<typeof postedInlineIdentity>>();
  let failNextInline = options.failNextInline ?? null;
  const adapter = {
    createInlineReview: vi.fn(async (
      _locator: unknown,
      _head: string,
      comments: Array<{ clientId: string; path: string; line: number; body: string }>,
    ) => {
      if (failNextInline === "throw") {
        failNextInline = null;
        throw new Error("inline publish failed");
      }
      return comments.map((comment) => {
        postedInlines.push(comment);
        const commentId = `inline-${postedInlines.length}`;
        const identity = postedInlineIdentity(commentId);
        const marker = comment.body.split(/\r?\n/u).findLast?.((line) => line.includes("<!-- tgd-"))
          ?? comment.body.split(/\r?\n/u).at(-1)?.trim()
          ?? "";
        if (marker.includes("<!--")) publishedByMarker.set(marker, identity);
        if (failNextInline === "accept-then-fail") {
          failNextInline = null;
          throw new Error("transport failed after accepted write");
        }
        return { clientId: comment.clientId, status: "posted" as const, identity };
      });
    }),
    findBotComment: vi.fn(async () => stored),
    upsertComment: vi.fn(async (_locator: unknown, body: string, existing: BotComment | null) => {
      summaries.push(body);
      const parsed = parseBotMarker(body);
      stored = {
        id: existing?.id ?? "written-summary-1",
        body,
        ...(parsed ?? { lastReviewedSha: "", reviewedConfig: "" }),
      };
      return stored;
    }),
    findPublishedMarker: vi.fn(async (_locator: unknown, marker: string) => publishedByMarker.get(marker) ?? null),
    resolveStaleReviewThreads: vi.fn(async () => 0),
    getPullRequest: vi.fn(async () => ({
      id: "1",
      reviewId: "PR_1",
      headSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      title: "Review",
      description: "",
      url: "https://github.com/owner/repo/pull/1",
    })),
    getDiff: vi.fn(async () => commentableAuthDiff),
    getRuleFilesFromBase: vi.fn(async () => []),
    resolveRelatedWork: vi.fn(async (references: unknown) => references),
  };
  return { adapter, postedInlines, summaries, publishedByMarker, get stored() { return stored; } };
}
const currentRule: RuleDefinition = {
  name: "no-token-logs",
  provider: "anthropic",
  model: "claude-opus-4-5",
  dependsOn: [],
  body: "Never log credentials, tokens, or secrets.",
  sourcePath: "/rules/no-token-logs.md",
};
const visibleFindingBody = "_🔒 security_ | _🔴 Blocking_ | _`no-token-logs`_\n\n**Do not log tokens.**\n<!-- tgd-review-agent:inline -->";

function sessionFor(text: string | undefined): ConversationSessionFactory {
  return async () => createPiSessionStub(text).session;
}

function lastMarker(body: string): string {
  const start = body.lastIndexOf("<!-- tgd-child:");
  return start < 0 ? "" : body.slice(start).trim();
}

function threadComment(
  eventId: string,
  body: string,
  extras: Partial<ReviewActivityEvent> & { readonly threadId?: string } = {},
): ReviewActivityEvent {
  const threadId = extras.threadId ?? "T1";
  return {
    kind: "thread-comment",
    provider: "github",
    repositoryDigest,
    reviewNumber: 1,
    eventId,
    revisionId: `${eventId}:1`,
    orderKey: `${extras.updatedAt ?? "2026-08-14T00:00:00.000Z"}|${eventId}`,
    authorLogin: extras.authorLogin ?? "alice",
    authorIsBot: extras.authorIsBot ?? false,
    createdAt: extras.createdAt ?? extras.updatedAt ?? "2026-08-14T00:00:00.000Z",
    updatedAt: extras.updatedAt ?? "2026-08-14T00:00:00.000Z",
    body,
    url: `https://github.com/owner/repo/pull/1#discussion_r${eventId}`,
    commentId: eventId,
    threadId,
    ...extras,
    kind: extras.kind === "comment-edit" ? "comment-edit" : "thread-comment",
    threadId,
  } as ReviewActivityEvent;
}

class ExecutionAdapter extends ClassificationAdapter {
  readonly postedBodies: string[] = [];
  readonly postedKinds: Array<"general" | "thread"> = [];
  readonly publishedByMarker = new Map<string, ConversationItemIdentity>();
  readonly acceptedBodies: string[] = [];
  failNextWrite: "throw" | "accept-then-fail" | null = null;
  threads = new Map<string, ReviewThreadSnapshot>();
  headSha = "c".repeat(40);

  override async postGeneralReply(_review: ReviewIdentity, input: GeneralReplyInput): Promise<ConversationItemIdentity> {
    return this.recordWrite("general", input.body);
  }

  override async postThreadReply(_review: ReviewIdentity, input: ThreadReplyInput): Promise<ConversationItemIdentity> {
    // BOTH real adapters refuse this, so a stub that accepts it hides a class
    // of failure: a reply with no parent fails publication as transient and is
    // retried on every poll forever.
    if (input.parentCommentId === undefined || input.parentCommentId === "") {
      throw new Error("thread replies require parentCommentId");
    }
    return this.recordWrite("thread", input.body, input.threadId);
  }

  override async findBotChildMarker(_review: ReviewIdentity, marker: ChildMarkerLookup): Promise<ConversationItemIdentity | null> {
    const key = formatChildMarker({ version: 1, ...marker });
    return this.publishedByMarker.get(key) ?? null;
  }

  failNextThreadRead = false;
  threadReads = 0;

  override async getReviewThread(_review: ReviewIdentity, threadId: string): Promise<ReviewThreadSnapshot> {
    this.threadReads += 1;
    if (this.failNextThreadRead) {
      this.failNextThreadRead = false;
      throw new Error("thread read is temporarily unavailable");
    }
    const thread = this.threads.get(threadId);
    if (thread === undefined) throw new Error(`thread not found: ${threadId}`);
    return thread;
  }

  private recordWrite(kind: "general" | "thread", body: string, threadId?: string): ConversationItemIdentity {
    const marker = lastMarker(body);
    const identity: ConversationItemIdentity = {
      provider: "github",
      commentId: `posted-${this.postedBodies.length + 1}`,
      url: kind === "thread"
        ? `https://github.com/owner/repo/pull/1#discussion_rposted-${this.postedBodies.length + 1}`
        : `https://github.com/owner/repo/pull/1#issuecomment-posted-${this.postedBodies.length + 1}`,
      ...(threadId === undefined ? {} : { threadId }),
    };
    if (this.failNextWrite === "throw") {
      this.failNextWrite = null;
      this.writes.push(kind);
      throw new Error("provider write failed");
    }
    this.acceptedBodies.push(body);
    if (marker.length > 0) this.publishedByMarker.set(marker, identity);
    if (this.failNextWrite === "accept-then-fail") {
      this.failNextWrite = null;
      this.writes.push(kind);
      throw new Error("transport failed after accepted write");
    }
    this.writes.push(kind);
    this.postedKinds.push(kind);
    this.postedBodies.push(body);
    return identity;
  }
}

async function bootstrapAndSeed(
  adapter: ExecutionAdapter,
  // `bindThreadId` seeds the finding WITH its published thread identity, as
  // `bindFindingLedgerIdentity` gives it after a successful inline write.
  // Automatic verification (#57) matches a thread event to a finding through
  // that identity, so a ledger without one is a shape production never has.
  options: {
    readonly seedFinding?: boolean;
    readonly bindThreadId?: string;
    /** A distinct finding id, so several can be seeded into one repository. */
    readonly findingId?: string;
    /** Seed a finding whose review recorded no model, so none can be resolved. */
    readonly withoutModel?: boolean;
  } = {},
): Promise<{ stateDir: string; ledger?: FindingLedgerEntry; findingMarker?: string }> {
  const stateDir = await tempStateDir();
  await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
  if (options.seedFinding !== true) return { stateDir };
  const { ledger: seeded, findingMarker } = await seedFindingInto(stateDir, options);
  return { stateDir, ledger: seeded, findingMarker };
}

/** Places one published finding into an ALREADY bootstrapped repository. */
async function seedFindingInto(
  stateDir: string,
  options: { readonly bindThreadId?: string; readonly findingId?: string } = {},
): Promise<{ ledger: FindingLedgerEntry; findingMarker: string }> {
  const store = createConversationStateStore({ root: stateDir, repository: repo });
  const binding = store.repositoryBinding;
  const ledger = prepareFindingLedgerEntry({
    repository: binding,
    id: options.findingId ?? FINDING_ID,
    reviewNumber: 1,
    reviewId: "PR_1",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    finding: {
      file: "src/auth.ts",
      line: 14,
      severity: "blocking",
      category: "security",
      message: "Tokens must not be logged.",
      ruleName: "no-token-logs",
      title: "Do not log tokens",
    },
    ruleSnapshot: "Never log credentials or session tokens.",
    reviewOptions: {
      advisor: "on",
      suggestions: "off",
      disableBuiltinRule: false,
      trustLocalRules: false,
      rulesDir: ".review/rules",
      ...(options.withoutModel === true ? {} : { model: "anthropic/claude-opus-4-5" }),
      dispatch: "direct",
    },
    placement: {
      file: "src/auth.ts",
      side: "new",
      line: 14,
      originalHeadSha: "c".repeat(40),
      currentHeadSha: "c".repeat(40),
      outdated: false,
    },
    body: visibleFindingBody,
    at: "2026-08-14T00:00:00.000Z",
  });
  const seeded = options.bindThreadId === undefined
    ? ledger
    : bindFindingLedgerIdentity(ledger, {
        provider: "github",
        commentId: "900",
        threadId: options.bindThreadId,
        url: "https://github.com/octo-org/octo-repo/pull/1#discussion_r900",
      });
  await store.transact((tx) => tx.appendFinding(seeded));
  const findingMarker = formatChildMarker({
    kind: "finding",
    parentId: `act_${"2".repeat(32)}`,
    childId: ledger.id,
    repositoryDigest,
    reviewNumber: 1,
    contentDigest: ledger.contentDigest,
  });
  return { ledger: seeded, findingMarker };
}

function installFindingThread(
  adapter: ExecutionAdapter,
  findingMarker: string,
  command: ReviewActivityEvent,
  extras: { readonly rootAuthorIsBot?: boolean } = {},
): ReviewActivityEvent {
  const root = threadComment("root", `${visibleFindingBody}\n${findingMarker}`, {
    authorLogin: extras.rootAuthorIsBot === false ? "mallory" : "tgdbot",
    authorIsBot: extras.rootAuthorIsBot !== false,
    updatedAt: "2026-08-13T23:00:00.000Z",
    threadId: command.threadId ?? "T1",
  });
  const reply = { ...command, threadId: command.threadId ?? "T1", parentCommentId: "root" };
  adapter.threads.set(reply.threadId ?? "T1", {
    provider: "github",
    repositoryDigest,
    reviewNumber: 1,
    threadId: reply.threadId ?? "T1",
    rootCommentId: "root",
    url: "https://github.com/owner/repo/pull/1#discussion_rroot",
    resolved: false,
    outdated: false,
    updatedAt: reply.updatedAt,
    orderKey: reply.threadId ?? "T1",
    events: [root, reply],
  });
  return reply;
}

function executionDeps(adapter: ExecutionAdapter, extras: {
  readonly createSession?: ConversationSessionFactory;
  readonly heads?: string[];
  readonly rules?: readonly RuleDefinition[];
  readonly ruleLoadError?: Error;
  readonly diff?: string;
  readonly vcs?: ReturnType<typeof silentReviewVcs>;
  readonly publicationHooks?: PublicationExecutorHooks;
} = {}) {
  const heads = extras.heads === undefined ? undefined : [...extras.heads];
  const vcs = extras.vcs ?? silentReviewVcs();
  return {
    conversationAdapter: adapter,
    createSession: extras.createSession ?? sessionFor(JSON.stringify({ explanation: "The logger prints user.token." })),
    publicationHooks: extras.publicationHooks,
    resolvePollConfig: (pollInput: PollArgs) => ({
      ...resolvePollConfig(pollInput),
      vcsAdapter: vcs.adapter as unknown as VcsAdapter,
    }),
    getReviewMetadata: async () => ({
      headSha: heads === undefined ? adapter.headSha : (heads.shift() ?? adapter.headSha),
      baseSha: "b".repeat(40),
      diff: extras.diff ?? currentHunk,
    }),
    loadConversationRules: async () => ({
      rules: extras.rules ?? [currentRule],
      ...(extras.ruleLoadError === undefined ? {} : { error: extras.ruleLoadError }),
    }),
    vcs,
  };
}

describe("event-to-action poll", () => {
  it("records irrelevant and self-authored events without a reply or model call", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([
      commentEvent("irr", "looks good"),
      commentEvent("self", "@tgdbot explain", "2026-08-14T00:00:01.000Z", { authorLogin: "tgdbot", authorIsBot: true }),
    ]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
    const journal = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    expect(journal.filter((entry) => entry.state === "completed")).toHaveLength(2);
    expect(journal.some((entry) => entry.state === "prepared")).toBe(false);
  });

  it("answers invalid command usage once and still processes later events", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    adapter.replaceEvents([
      commentEvent("bad", "@tgdbot frobnicate"),
      // Addressed to tGDBot but too large to parse: worth usage help.
      commentEvent("big", `@tgdbot ${"x".repeat(MAX_COMMAND_BODY_SCALARS)}`, "2026-08-14T00:00:01.000Z"),
      // Equally oversized but never addressed to tGDBot — a long comment
      // between humans, which must not draw an unprompted reply.
      commentEvent("huge", "x".repeat(MAX_COMMAND_BODY_SCALARS + 1), "2026-08-14T00:00:02.000Z"),
      commentEvent("later", "thanks", "2026-08-14T00:00:03.000Z"),
    ]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(2);
    expect(adapter.postedBodies.every((body) => body.includes("## Command usage"))).toBe(true);
    expect(adapter.postedBodies.every((body) => parseChildMarker(lastMarker(body))?.kind === "action")).toBe(true);
    const journal = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    expect(journal.filter((entry) => entry.state === "completed").length).toBeGreaterThanOrEqual(3);
    expect(adapter.postedBodies).toHaveLength(2);
  });

  it("posts a deterministic scope error for explain or reconsider outside a marked bot thread", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([
      commentEvent("gen", "@tgdbot explain"),
      commentEvent("re", "@tgdbot reconsider because it is safe", "2026-08-14T00:00:01.000Z"),
    ]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(2);
    expect(adapter.postedBodies.every((body) => body.includes("## Out of scope"))).toBe(true);
  });

  it("records a remembered lesson locally and acknowledges it without a model", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([commentEvent("rem", "@tgdbot remember prefer explicit null checks")]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);

    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toContain("## Memory recorded");
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo })
      .readContextSnapshot();
    expect(snapshot.memories.map((memory) => memory.text)).toEqual([
      "prefer explicit null checks",
    ]);
  });

  it("lists an active memory and stops listing it once forgotten", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    adapter.replaceEvents([commentEvent("rem", "@tgdbot remember prefer explicit null checks")]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter),
    })).resolves.toBe(0);

    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const created = (await store.readContextSnapshot()).memories[0]!;
    const publicId = encodeMemoryPublicId(created.id);

    adapter.replaceEvents([
      commentEvent("list", "@tgdbot memories", "2026-08-14T00:00:01.000Z"),
      commentEvent("forget", `@tgdbot forget ${publicId}`, "2026-08-14T00:00:02.000Z"),
      commentEvent("list2", "@tgdbot memories", "2026-08-14T00:00:03.000Z"),
    ]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter),
    })).resolves.toBe(0);

    const [firstList, forgotten, secondList] = adapter.postedBodies.slice(-3);
    expect(firstList).toContain(publicId);
    expect(firstList).toContain("prefer explicit null checks");
    expect(forgotten).toContain("## Memory forgotten");
    expect(secondList).toContain("no active memories");
    expect((await store.readContextSnapshot()).memories).toHaveLength(0);
  });

  // Config parity: the forced review must run with the flags poll itself was
  // given, never with ambient review defaults, or `check latest` would silently
  // review under a different rule set than the poll it came from.
  it("check latest runs a forced review with poll's own resolved options", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const runReview = vi.fn(async () => 0);
    adapter.replaceEvents([commentEvent("force", "@tgdbot check latest")]);

    await expect(poll(pollArgs(stateDir, {
      model: "anthropic/claude-opus-4-5",
      rulesDir: ".custom/rules",
      advisor: "off",
      suggestions: "off",
      dispatch: "legacy",
      disableBuiltinRule: true,
      trustLocalRules: true,
      maxDiffChars: 4242,
    }), { ...executionDeps(adapter), runReview })).resolves.toBe(0);

    expect(runReview).toHaveBeenCalledTimes(1);
    const [reviewArgs, reviewDeps] = runReview.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(reviewArgs).toMatchObject({
      pr: "1",
      repo: "owner/repo",
      vcs: "github",
      model: "anthropic/claude-opus-4-5",
      rulesDir: ".custom/rules",
      advisor: "off",
      suggestions: "off",
      dispatch: "legacy",
      disableBuiltinRule: true,
      trustLocalRules: true,
      maxDiffChars: 4242,
      stateDir,
    });
    expect(reviewDeps.invocation).toMatchObject({ kind: "forced-command" });
  });

  // The direction has to be durable BEFORE the supplemental run: if the review
  // fails transiently, the retry must still know what was asked, and a later
  // normal review on the same head has to be able to pick it up as context.
  it("review focus stores the direction bound to the head before running the focused review", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    let directionsAtRunTime: readonly { text: string; headSha: string }[] = [];
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const runReview = vi.fn(async () => {
      directionsAtRunTime = (await store.readContextSnapshot()).pending.directions
        .map((item) => ({ text: item.text, headSha: item.headSha }));
      return 0;
    });
    adapter.replaceEvents([
      commentEvent("focus", "@tgdbot review focus: check the error handling"),
    ]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter), runReview,
    })).resolves.toBe(0);

    expect(runReview).toHaveBeenCalledTimes(1);
    const [, reviewDeps] = runReview.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(reviewDeps.invocation).toMatchObject({
      kind: "focused-command",
      direction: "check the error handling",
    });
    // Durable BEFORE the supplemental run, not after it: a transient failure
    // must leave the direction recorded for the retry.
    expect(directionsAtRunTime).toEqual([
      { text: "check the error handling", headSha: adapter.headSha.toLowerCase() },
    ]);
    const stored = (await store.readContextSnapshot()).pending.directions;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      reviewNumber: 1,
      author: "alice",
      text: "check the error handling",
    });
  });

  it("retires obsolete focus directions before appending at the pending-state cap", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    await store.transact((tx) => {
      tx.replacePending({
        ...tx.snapshot.pending,
        directions: Array.from({ length: 1_000 }, (_, index) => ({
          id: `direction_${index.toString(16).padStart(32, "0")}`,
          reviewNumber: 1,
          headSha: "a".repeat(40),
          text: `old focus ${index}`,
          createdAt: "2026-08-13T00:00:00.000Z",
        })),
      });
    });
    adapter.replaceEvents([commentEvent("focus-cap", "@tgdbot review focus: current head only")]);

    await expect(poll(pollArgs(stateDir), {
      ...executionDeps(adapter),
      runReview: vi.fn(async () => 0),
    })).resolves.toBe(0);

    const directions = (await store.readContextSnapshot()).pending.directions;
    expect(directions).toHaveLength(1);
    expect(directions[0]).toMatchObject({ headSha: adapter.headSha, text: "current head only" });
  });

  it("evicts the oldest direction when other reviews already fill the repository cap", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    await store.transact((tx) => {
      tx.replacePending({
        ...tx.snapshot.pending,
        directions: Array.from({ length: 1_000 }, (_, index) => ({
          id: `direction_${index.toString(16).padStart(32, "0")}`,
          reviewNumber: index + 2,
          headSha: "a".repeat(40),
          text: `other review ${index}`,
          createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
        })),
      });
    });
    adapter.replaceEvents([commentEvent("focus-global-cap", "@tgdbot review focus: newest direction")]);

    await expect(poll(pollArgs(stateDir), {
      ...executionDeps(adapter),
      runReview: vi.fn(async () => 0),
    })).resolves.toBe(0);

    const directions = (await store.readContextSnapshot()).pending.directions;
    expect(directions).toHaveLength(1_000);
    expect(directions.some((entry) => entry.text === "other review 0")).toBe(false);
    expect(directions.at(-1)).toMatchObject({ reviewNumber: 1, text: "newest direction" });
  });

  // The provider keeps returning a comment forever; what stops a second review
  // is that the review's cursor advanced past it. Verified here for a focus
  // command specifically, since it both dispatches a review AND writes a
  // direction — running twice would steer the next review twice over.
  //
  // Note this exercises cursor advancement, not the completed-action guard:
  // the second pass never sees the event at all. Re-delivery of an already
  // completed action is a separate path and is not covered here.
  it("does not re-run a focus command once its review has advanced the cursor", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const runReview = vi.fn(async () => 0);
    const focus = commentEvent("focus", "@tgdbot review focus: check the error handling");
    adapter.replaceEvents([focus]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter), runReview,
    })).resolves.toBe(0);

    // The provider still reports the same comment on the next pass.
    adapter.replaceEvents([focus]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter), runReview,
    })).resolves.toBe(0);

    expect(runReview).toHaveBeenCalledTimes(1);
    const directions = (await createConversationStateStore({ root: stateDir, repository: repo })
      .readContextSnapshot()).pending.directions;
    expect(directions).toHaveLength(1);
  });

  it("executes explain and reconsider only in a marked bot-started finding thread", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const explain = installFindingThread(adapter, findingMarker!, threadComment("exp", "@tgdbot explain"));
    const reconsider = installFindingThread(
      adapter,
      findingMarker!,
      threadComment("rec", "@tgdbot reconsider because the logger redacts tokens", {
        updatedAt: "2026-08-14T00:00:01.000Z",
        threadId: "T2",
      }),
    );
    adapter.threads.set("T2", {
      ...adapter.threads.get("T2")!,
    });
    let sessionCalls = 0;
    const sequenced: ConversationSessionFactory = async () => {
      sessionCalls += 1;
      const payload = sessionCalls === 1
        ? { explanation: "The logger prints user.token on line 14." }
        : {
            outcome: "confirmed",
            rationale: "The current hunk still logs the token.",
            finding: {
              file: "src/auth.ts", line: 14, severity: "blocking", category: "security",
              message: "Tokens must not be logged.", ruleName: "no-token-logs", title: "Do not log tokens",
              decision: "still-valid",
            },
          };
      return createPiSessionStub(JSON.stringify(payload)).session;
    };
    adapter.replaceEvents([explain, reconsider]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession: sequenced }),
    })).resolves.toBe(0);
    expect(sessionCalls).toBe(2);
    expect(adapter.postedKinds).toEqual(["thread", "thread"]);
    expect(adapter.postedBodies[0]).toMatch(/## Explanation/);
    expect(adapter.postedBodies[1]).toMatch(/## Reconsideration/);
    expect(adapter.postedBodies).toHaveLength(2);
  });

  // Seeded WITH the thread identity, so this covers automatic verification (#57)
  // too: that path acts without a command to parse, so the thread being rooted
  // by someone other than the bot is the only thing left to refuse on.
  it("treats a spoofed finding marker as a scope error without model work", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const spoofed = installFindingThread(
      adapter,
      findingMarker!,
      threadComment("spoof", "@tgdbot explain"),
      { rootAuthorIsBot: false },
    );
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([spoofed]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## Out of scope/);
  });

  it("posts unsupported history when the marked finding is missing from the ledger", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const orphanMarker = formatChildMarker({
      kind: "finding",
      parentId: `act_${"2".repeat(32)}`,
      childId: FINDING_ID,
      repositoryDigest,
      reviewNumber: 1,
      contentDigest: computeContentDigest(visibleFindingBody),
    });
    const command = installFindingThread(adapter, orphanMarker, threadComment("lost", "@tgdbot explain"));
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([command]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## History unavailable/);
  });

  it("re-executes a material edit and ignores a formatting-only edit", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const original = installFindingThread(adapter, findingMarker!, threadComment("cmd", "@tgdbot explain"));
    adapter.replaceEvents([original]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);

    const formatted = {
      ...original,
      kind: "comment-edit" as const,
      revisionId: "cmd:2",
      editedRevisionId: "cmd:2",
      body: "@TGDBot   explain  ",
      updatedAt: "2026-08-14T00:00:02.000Z",
      orderKey: "2026-08-14T00:00:02.000Z|cmd",
    };
    adapter.threads.set("T1", {
      ...adapter.threads.get("T1")!,
      events: [adapter.threads.get("T1")!.events[0]!, formatted],
    });
    adapter.replaceEvents([formatted]);
    const createSession = vi.fn(sessionFor(JSON.stringify({ explanation: "should not run" })));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(1);

    const material = {
      ...original,
      kind: "comment-edit" as const,
      revisionId: "cmd:3",
      editedRevisionId: "cmd:3",
      body: "@tgdbot reconsider because the wrapper redacts the token",
      updatedAt: "2026-08-14T00:00:03.000Z",
      orderKey: "2026-08-14T00:00:03.000Z|cmd",
    };
    adapter.threads.set("T1", {
      ...adapter.threads.get("T1")!,
      events: [adapter.threads.get("T1")!.events[0]!, material],
    });
    adapter.replaceEvents([material]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession: sessionFor(JSON.stringify({
          outcome: "withdrawn",
          rationale: "The wrapper redacts the token on this line.",
        })),
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(2);
    expect(adapter.postedBodies[1]).toMatch(/## Reconsideration/);
  });

  it("treats a model transient failure as incomplete and exits nonzero", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const command = installFindingThread(adapter, findingMarker!, threadComment("fail", "@tgdbot explain"));
    adapter.replaceEvents([command]);
    const createSession = vi.fn(sessionFor(undefined));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
        ...executionDeps(adapter, { createSession }),
      })).resolves.toBe(1);
    } finally {
      warn.mockRestore();
    }
    expect(adapter.postedBodies).toEqual([]);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.events.some((entry) => entry.state === "prepared" || entry.state === "observed")).toBe(true);
    expect(snapshot.events.some((entry) => entry.state === "completed" && entry.manifest.length > 0)).toBe(false);
  });

  // Provider CLIs quote the request they attempted when it fails, so the error
  // can carry the token used to make it. These diagnostics get pasted into
  // issues, so the credential must not survive the trip to the console.
  it("keeps a credential out of the diagnostic when a provider call fails", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    adapter.replaceEvents([commentEvent("focus", "@tgdbot review focus: the error handling")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let logged = "";
    try {
      await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
        ...executionDeps(adapter),
        runReview: async () => 0,
        getReviewMetadata: async () => {
          throw new Error(`HTTP 401 on GET /repos/o/r using Authorization: Bearer ${secret}`);
        },
      })).resolves.toBe(1);
      // Read before restoring: mockRestore also clears the recorded calls.
      logged = warn.mock.calls.flat().join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(logged).not.toContain(secret);
    expect(logged).toContain("[redacted]");
    // The reason for the failure still has to survive redaction.
    expect(logged).toContain("401");
    expect(adapter.postedBodies).toEqual([]);
  });

  it("produces one response per recognized event", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const command = installFindingThread(adapter, findingMarker!, threadComment("once", "@tgdbot explain"));
    adapter.replaceEvents([command, command]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);
  });

  it("embeds a contentDigest that matches GitHub's visible-prefix contract", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    adapter.replaceEvents([commentEvent("bad", "@tgdbot frobnicate")]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    const body = adapter.postedBodies[0];
    expect(body).toBeDefined();
    const candidate = body!.split(/\r?\n/u).at(-1) ?? "";
    const parsed = parseChildMarker(candidate);
    expect(parsed).not.toBeNull();
    const canonicalBody = body!.replace(/\r\n?/gu, "\n");
    const suffix = `\n${candidate}`;
    expect(canonicalBody.endsWith(suffix)).toBe(true);
    expect(canonicalBody.endsWith(`\n\n${candidate}`)).toBe(false);
    const visibleBody = canonicalBody.slice(0, -suffix.length);
    expect(computeContentDigest(visibleBody)).toBe(parsed!.contentDigest);
  });
});

describe("ambiguous-write recovery", () => {
  it.each([
    ["usage", commentEvent("bad", "@tgdbot frobnicate"), /## Command usage/, undefined],
    ["scope", commentEvent("gen", "@tgdbot explain"), /## Out of scope/, undefined],
  ] as const)("recovers a %s reply from the provider marker without a second write", async (_name, event, heading) => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    adapter.replaceEvents([event]);
    adapter.failNextWrite = "accept-then-fail";
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(1);
    expect(adapter.postedBodies).toEqual([]);
    expect(adapter.writes).toEqual(["general"]);
    expect(adapter.publishedByMarker.size).toBe(1);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    expect(adapter.writes).toEqual(["general"]);
    expect(adapter.postedBodies).toEqual([]);
    const journal = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    const completed = journal.find((entry) =>
      entry.state === "completed" && entry.manifest.some((child) => child.status === "posted"));
    expect(completed?.manifest[0]?.body).toMatch(heading);
    expect(completed?.manifest[0]?.identity).toBeDefined();
  });

  it("recovers explain after an accepted write without a second model call", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const command = installFindingThread(adapter, findingMarker!, threadComment("exp", "@tgdbot explain"));
    adapter.replaceEvents([command]);
    adapter.failNextWrite = "accept-then-fail";
    const createSession = vi.fn(sessionFor(JSON.stringify({ explanation: "The logger prints user.token." })));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(adapter.postedBodies).toEqual([]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(adapter.writes.filter((item) => item === "thread")).toHaveLength(1);
    expect(adapter.postedBodies).toEqual([]);
    const journal = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    const completed = journal.find((entry) =>
      entry.state === "completed" && entry.manifest.some((child) => child.status === "posted"));
    expect(completed?.manifest[0]?.body).toMatch(/## Explanation/);
    expect(completed?.manifest[0]?.identity).toBeDefined();
  });

  it("recovers reconsider after an accepted write without a second model call", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const command = installFindingThread(
      adapter,
      findingMarker!,
      threadComment("rec", "@tgdbot reconsider because the wrapper redacts the token"),
    );
    adapter.replaceEvents([command]);
    adapter.failNextWrite = "accept-then-fail";
    const createSession = vi.fn(sessionFor(JSON.stringify({
      outcome: "withdrawn",
      rationale: "The wrapper redacts the token on this line.",
    })));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(1);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(adapter.postedBodies).toEqual([]);
    const journal = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    const completed = journal.find((entry) =>
      entry.state === "completed" && entry.manifest.some((child) => child.status === "posted"));
    expect(completed?.manifest[0]?.body).toMatch(/## Reconsideration/);
    expect(completed?.manifest[0]?.identity).toBeDefined();
  });

  it("recovers identity when lookup uses the real adapter digest contract", async () => {
    class DigestContractAdapter extends ExecutionAdapter {
      override async findBotChildMarker(
        _review: ReviewIdentity,
        marker: ChildMarkerLookup,
      ): Promise<ConversationItemIdentity | null> {
        const expected = {
          kind: marker.kind,
          parentId: marker.parentId,
          childId: marker.childId,
          repositoryDigest: marker.repositoryDigest,
          reviewNumber: marker.reviewNumber,
          contentDigest: marker.contentDigest,
        };
        for (const body of this.acceptedBodies) {
          const candidate = body.split(/\r?\n/u).at(-1) ?? "";
          if (!verifyChildMarkerBinding(candidate, expected)) continue;
          const canonicalBody = body.replace(/\r\n?/gu, "\n");
          const suffix = `\n${candidate}`;
          if (!canonicalBody.endsWith(suffix)) {
            throw new Error("Authenticated GitHub child marker is not a separable terminal suffix");
          }
          const visibleBody = canonicalBody.slice(0, -suffix.length);
          if (computeContentDigest(visibleBody) !== marker.contentDigest) {
            throw new Error("visible body digest mismatch");
          }
          return this.publishedByMarker.get(candidate) ?? null;
        }
        return null;
      }
    }

    const adapter = new DigestContractAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    adapter.replaceEvents([commentEvent("bad", "@tgdbot frobnicate")]);
    adapter.failNextWrite = "accept-then-fail";
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(1);
    expect(adapter.acceptedBodies).toHaveLength(1);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), executionDeps(adapter)))
      .resolves.toBe(0);
    expect(adapter.writes).toEqual(["general"]);
    const journal = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    const completed = journal.find((entry) =>
      entry.state === "completed" && entry.manifest.some((child) => child.status === "posted"));
    expect(completed?.manifest[0]?.identity).toBeDefined();
    const candidate = adapter.acceptedBodies[0]!.split(/\r?\n/u).at(-1) ?? "";
    const parsed = parseChildMarker(candidate);
    const visibleBody = adapter.acceptedBodies[0]!.replace(/\r\n?/gu, "\n").slice(0, -`\n${candidate}`.length);
    expect(computeContentDigest(visibleBody)).toBe(parsed!.contentDigest);
  });
});

describe("stale-head successors", () => {
  it("supersedes stale prepared work and does not publish until the head is stable", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const command = installFindingThread(adapter, findingMarker!, threadComment("stale", "@tgdbot explain"));
    adapter.replaceEvents([command]);
    const createSession = vi.fn(sessionFor(JSON.stringify({ explanation: "stale output must not publish" })));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession,
        heads: ["c".repeat(40), "d".repeat(40)],
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toEqual([]);
    const first = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    expect(first.some((entry) => entry.state === "superseded")).toBe(true);
    expect(first.some((entry) => entry.state === "prepared" && entry.successorActionId === null)).toBe(true);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession,
        heads: ["e".repeat(40), "f".repeat(40)],
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toEqual([]);
    const second = await journalEvents(createConversationStateStore({ root: stateDir, repository: repo }));
    expect(second.filter((entry) => entry.state === "superseded").length).toBeGreaterThanOrEqual(2);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession,
        heads: ["f".repeat(40), "f".repeat(40), "f".repeat(40)],
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## Explanation/);
    expect(createSession.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("default trusted poll rule loading", () => {
  it("loads base-branch rules via the VCS adapter and can execute explain", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const command = installFindingThread(adapter, findingMarker!, threadComment("exp", "@tgdbot explain"));
    adapter.replaceEvents([command]);
    const getRuleFilesFromBase = vi.fn().mockResolvedValue([{
      path: "no-token-logs.md",
      content: [
        "---",
        "name: no-token-logs",
        "provider: anthropic",
        "model: claude-opus-4-5",
        "---",
        "Never log credentials, tokens, or secrets.",
        "",
      ].join("\n"),
    }]);
    const createSession = vi.fn(sessionFor(JSON.stringify({ explanation: "The logger prints user.token." })));
    const args = pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" });
    expect(args.trustLocalRules).toBe(false);

    await expect(poll(args, {
      conversationAdapter: adapter,
      createSession,
      getReviewMetadata: async () => ({
        headSha: adapter.headSha,
        baseSha: "b".repeat(40),
        diff: currentHunk,
      }),
      resolvePollConfig: (pollInput) => ({
        ...resolvePollConfig(pollInput),
        vcsAdapter: { getRuleFilesFromBase } as unknown as VcsAdapter,
      }),
    })).resolves.toBe(0);

    expect(getRuleFilesFromBase).toHaveBeenCalledWith(
      { kind: "repository", repo, number: 1 },
      "b".repeat(40),
      ".review/rules",
    );
    expect(createSession).toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## Explanation/);
  });

  it("retries instead of treating a malformed trusted rule as inactive", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    adapter.replaceEvents([installFindingThread(adapter, findingMarker!, threadComment("exp-bad-rule", "@tgdbot explain"))]);
    const createSession = vi.fn(sessionFor(JSON.stringify({ explanation: "must not run" })));

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      conversationAdapter: adapter,
      createSession,
      getReviewMetadata: async () => ({ headSha: adapter.headSha, baseSha: "b".repeat(40), diff: currentHunk }),
      resolvePollConfig: (pollInput) => ({
        ...resolvePollConfig(pollInput),
        vcsAdapter: {
          getRuleFilesFromBase: vi.fn().mockResolvedValue([{ path: "broken.md", content: "not valid rule frontmatter" }]),
        } as unknown as VcsAdapter,
      }),
    })).resolves.toBe(1);

    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toEqual([]);
  });
});

describe("clarification answer lifecycle", () => {
  const CLAR_ID = `clar_${"b".repeat(26)}`;
  const questionIdentity = {
    provider: "github" as const,
    commentId: "question-1",
    threadId: "Q1",
    url: "https://github.com/owner/repo/pull/1#discussion_rquestion-1",
  };

  async function seedPublishedQuestion(stateDir: string, extras: { readonly headSha?: string } = {}) {
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const prepared = createPreparedClarification({
      id: CLAR_ID,
      reviewNumber: 1,
      headSha: extras.headSha ?? "c".repeat(40),
      question: "Is token logging required by audit?",
      createdAt: "2026-08-14T00:00:00.000Z",
      finding: {
        file: "src/auth.ts",
        line: 14,
        severity: "blocking",
        category: "security",
        message: "Tokens must not be logged.",
        ruleName: "no-token-logs",
        decision: "needs-clarification",
        question: "Is token logging required by audit?",
        title: "Do not log tokens",
      },
      ruleSnapshot: currentRule.body,
    });
    const published = transitionClarification(prepared, "published", { identity: questionIdentity });
    await store.transact((tx) => {
      tx.initializeIfAbsent();
      tx.replacePending({
        ...tx.snapshot.pending,
        clarifications: [published],
      });
    });
    return store;
  }

  function installQuestionThread(
    adapter: ExecutionAdapter,
    reply: ReviewActivityEvent,
  ): ReviewActivityEvent {
    const root = threadComment("question-1", "Is token logging required by audit?", {
      authorLogin: "tgdbot",
      authorIsBot: true,
      updatedAt: "2026-08-13T23:00:00.000Z",
      threadId: "Q1",
    });
    const event = { ...reply, threadId: "Q1", parentCommentId: "question-1" };
    adapter.threads.set("Q1", {
      provider: "github",
      repositoryDigest,
      reviewNumber: 1,
      threadId: "Q1",
      rootCommentId: "question-1",
      url: questionIdentity.url,
      resolved: false,
      outdated: false,
      updatedAt: event.updatedAt,
      orderKey: "Q1",
      events: [root, event],
    });
    return event;
  }

  it("reassesses the first human reply on the question thread without a mention", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    const reply = installQuestionThread(
      adapter,
      threadComment("human-1", "Audit does not require raw tokens."),
    );
    adapter.replaceEvents([reply]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession: sessionFor(JSON.stringify({
          outcome: "withdrawn",
          rationale: "The answer says audit does not require raw tokens.",
        })),
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## Clarification/);
    expect(adapter.postedBodies[0]).toMatch(/Withdrawn/);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.pending.clarifications[0]?.state).toBe("terminal");
    expect(snapshot.pending.clarifications[0]?.answerIdentity?.commentId).toBe("human-1");
  });

  it("accepts an unthreaded answer clar_id: without a mention", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("ans", `answer ${CLAR_ID}: keep the current logger`)]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession: sessionFor(JSON.stringify({
          outcome: "confirmed",
          rationale: "The logger still prints the token.",
          finding: {
            file: "src/auth.ts", line: 14, severity: "blocking", category: "security",
            message: "Tokens must not be logged.", ruleName: "no-token-logs",
            decision: "still-valid",
          },
        })),
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## Clarification/);
    expect(adapter.postedBodies[0]).toMatch(/Confirmed/);
  });

  it("ignores a mentionless general comment that is not answer clar_id:", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([commentEvent("noise", "looks good")]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not disclose a question for the wrong repository or review", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([
      commentEvent("other-repo", `answer ${CLAR_ID}: yes`, "2026-08-14T00:00:00.000Z", {
        repositoryDigest: "f".repeat(64),
      }),
      commentEvent("other-review", `answer ${CLAR_ID}: yes`, "2026-08-14T00:00:01.000Z", {
        reviewNumber: 99,
      }),
    ]);
    const createSession = vi.fn(sessionFor("{}"));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies.join("\n")).not.toMatch(/clar_|question|pending/i);
  });

  it("answers an unknown explicit clarification ID instead of silently advancing", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("unknown-answer", `answer clar_${"c".repeat(26)}: yes`)]);
    const createSession = vi.fn(sessionFor("{}"));

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);

    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toContain("## Clarification unavailable");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("acknowledges a stale-head answer without promoting a current finding", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir, { headSha: "a".repeat(40) });
    adapter.headSha = "c".repeat(40);
    adapter.replaceEvents([commentEvent("stale", `answer ${CLAR_ID}: still needed`)]);
    const createSession = vi.fn(sessionFor(JSON.stringify({
      outcome: "confirmed",
      rationale: "should not run",
      finding: {
        file: "src/auth.ts", line: 14, severity: "blocking", category: "security",
        message: "Tokens must not be logged.", ruleName: "no-token-logs",
      },
    })));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession, heads: ["c".repeat(40)] }),
    })).resolves.toBe(0);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/earlier review head|stale/i);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.pending.clarifications[0]?.terminalOutcome).toBe("stale");
    expect(snapshot.findings.some((entry) => entry.finding.message === "Tokens must not be logged.")).toBe(false);
  });

  it("retries a clarification answer when current review metadata is unavailable", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("metadata-down", `answer ${CLAR_ID}: keep the logger`)]);
    const createSession = vi.fn(sessionFor("{}"));

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
      getReviewMetadata: async () => undefined,
    })).resolves.toBe(1);

    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toEqual([]);
    const clarification = (await createConversationStateStore({ root: stateDir, repository: repo })
      .readContextSnapshot()).pending.clarifications[0];
    expect(clarification?.state).toBe("published");
    expect(clarification?.terminalOutcome).toBeUndefined();
  });

  it("revalidates a frozen head-bound reply before recovery", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
    const command = installFindingThread(adapter, findingMarker!, threadComment("frozen-exp", "@tgdbot explain"));
    adapter.replaceEvents([command]);
    const postThreadReply = vi.spyOn(adapter, "postThreadReply").mockRejectedValueOnce(new Error("crash after freeze"));

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter),
    })).resolves.toBe(1);
    expect(adapter.postedBodies).toEqual([]);

    postThreadReply.mockRestore();
    adapter.headSha = "d".repeat(40);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { heads: [adapter.headSha] }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toEqual([]);
  });

  it("stays silent for terminal thread chatter but answers an explicit terminal clarification ID", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    const first = installQuestionThread(
      adapter,
      threadComment("human-1", "Audit does not require raw tokens."),
    );
    adapter.replaceEvents([first]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        createSession: sessionFor(JSON.stringify({
          outcome: "withdrawn",
          rationale: "The answer withdraws the concern.",
        })),
      }),
    })).resolves.toBe(0);
    expect(adapter.postedBodies).toHaveLength(1);

    const later = installQuestionThread(
      adapter,
      threadComment("human-2", "one more thought", { updatedAt: "2026-08-14T00:00:02.000Z" }),
    );
    const unthreaded = commentEvent("again", `answer ${CLAR_ID}: wait no`, "2026-08-14T00:00:03.000Z");
    adapter.replaceEvents([later, unthreaded]);
    const createSession = vi.fn(sessionFor("{}"));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);
    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toHaveLength(2);
    expect(adapter.postedBodies[1]).toContain("## Clarification unavailable");
  });

  const confirmedFinding = {
    file: "src/auth.ts",
    line: 14,
    severity: "blocking" as const,
    category: "security",
    message: "Tokens must not be logged even after audit review.",
    ruleName: "no-token-logs",
    decision: "still-valid" as const,
    title: "Do not log tokens",
  };

  it("publishes a commentable confirmed finding through createInlineReview and ledgers that finding", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("ans", `answer ${CLAR_ID}: keep the current logger`)]);
    const vcs = silentReviewVcs();
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        vcs,
        diff: commentableAuthDiff,
        createSession: sessionFor(JSON.stringify({
          outcome: "revised",
          rationale: "The logger still prints the token.",
          finding: confirmedFinding,
        })),
      }),
    })).resolves.toBe(0);

    expect(vcs.adapter.createInlineReview).toHaveBeenCalledTimes(1);
    const inlineComments = vcs.adapter.createInlineReview.mock.calls[0]?.[2] as Array<{ path: string; line: number; body: string }>;
    expect(inlineComments[0]?.path).toBe("src/auth.ts");
    expect(inlineComments[0]?.line).toBe(14);
    expect(inlineComments[0]?.body).toMatch(/Tokens must not be logged even after audit review/);
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/## Clarification/);
    expect(adapter.postedBodies[0]).toMatch(/Revised|Confirmed/);

    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const snapshot = await store.readContextSnapshot();
    expect(snapshot.findings.some((entry) => entry.finding.decision === "needs-clarification")).toBe(false);
    const ledgers = snapshot.findings.filter((entry) =>
      entry.finding.message === confirmedFinding.message);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]?.finding.decision).toBe("still-valid");
    const fallbackAction = (await journalEvents(store)).find((entry) =>
      entry.manifest.some((child) => child.kind === "inline") &&
      entry.manifest.some((child) => child.kind === "fallback"));
    expect(fallbackAction).toBeDefined();
    expect(fallbackAction?.manifest.some((child) => child.kind === "summary")).toBe(true);
  });

  it("puts an unanchored confirmed finding in the managed summary instead of dropping it", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("ans", `answer ${CLAR_ID}: keep the current logger`)]);
    const vcs = silentReviewVcs();
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        vcs,
        diff: "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,2 @@\n keep\n+added\n",
        createSession: sessionFor(JSON.stringify({
          outcome: "confirmed",
          rationale: "The logger still prints the token.",
          finding: { ...confirmedFinding, line: undefined },
        })),
      }),
    })).resolves.toBe(0);

    expect(vcs.adapter.createInlineReview).not.toHaveBeenCalled();
    expect(vcs.summaries.some((body) => body.includes("Tokens must not be logged even after audit review."))).toBe(true);
    expect(adapter.postedBodies).toHaveLength(1);
    expect(adapter.postedBodies[0]).toMatch(/Confirmed/);
  });

  it("does not publish a finding when the clarification is withdrawn", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("ans", `answer ${CLAR_ID}: audit does not require raw tokens`)]);
    const vcs = silentReviewVcs();
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        vcs,
        diff: commentableAuthDiff,
        createSession: sessionFor(JSON.stringify({
          outcome: "withdrawn",
          rationale: "The answer withdraws the concern.",
        })),
      }),
    })).resolves.toBe(0);

    expect(vcs.adapter.createInlineReview).not.toHaveBeenCalled();
    expect(vcs.summaries).toEqual([]);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.findings.some((entry) => entry.finding.message.includes("Tokens must not be logged"))).toBe(false);
    expect(adapter.postedBodies[0]).toMatch(/Withdrawn/);
  });

  it("does not duplicate a confirmed inline after a crash between accept and persist", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("ans", `answer ${CLAR_ID}: keep the current logger`)]);
    const vcs = silentReviewVcs();
    const session = sessionFor(JSON.stringify({
      outcome: "confirmed",
      rationale: "The logger still prints the token.",
      finding: confirmedFinding,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        vcs,
        diff: commentableAuthDiff,
        createSession: session,
        publicationHooks: {
          afterChildWrite: async (child) => {
            if (child.kind === "inline") throw new Error("crash after inline accept before persist");
          },
        },
      }),
    })).resolves.toBe(1);
    expect(vcs.adapter.createInlineReview).toHaveBeenCalledTimes(1);
    expect(vcs.postedInlines).toHaveLength(1);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        vcs,
        diff: commentableAuthDiff,
        createSession: session,
      }),
    })).resolves.toBe(0);
    expect(vcs.adapter.createInlineReview).toHaveBeenCalledTimes(1);
    expect(vcs.postedInlines).toHaveLength(1);
    expect(adapter.postedBodies).toHaveLength(1);
    const snapshot = await createConversationStateStore({ root: stateDir, repository: repo }).readContextSnapshot();
    expect(snapshot.findings.filter((entry) =>
      entry.finding.message === confirmedFinding.message)).toHaveLength(1);
    expect(snapshot.pending.clarifications[0]?.state).toBe("terminal");
  });

  it("reuses the frozen clarification outcome after a finding publication crash", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    await seedPublishedQuestion(stateDir);
    adapter.replaceEvents([commentEvent("frozen-answer", `answer ${CLAR_ID}: keep the current logger`)]);
    const vcs = silentReviewVcs();
    const confirmedSession = vi.fn(sessionFor(JSON.stringify({
      outcome: "confirmed",
      rationale: "The logger still prints the token.",
      finding: confirmedFinding,
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, {
        vcs,
        diff: commentableAuthDiff,
        createSession: confirmedSession,
        publicationHooks: {
          afterChildWrite: async (child) => {
            if (child.kind === "inline") throw new Error("crash after clarified finding write");
          },
        },
      }),
    })).resolves.toBe(1);

    const changedSession = vi.fn(sessionFor(JSON.stringify({
      outcome: "withdrawn",
      rationale: "A nondeterministic retry changed its mind.",
    })));
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { vcs, diff: commentableAuthDiff, createSession: changedSession }),
    })).resolves.toBe(0);

    expect(confirmedSession).toHaveBeenCalledOnce();
    expect(changedSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies.at(-1)).toMatch(/Confirmed/);
    expect(adapter.postedBodies.at(-1)).not.toMatch(/Withdrawn/);
  });
});

// Issue #57: a human reply in a finding's thread produces exactly one
// automatic verification and exactly one bot reply — with no command issued.
describe("automatic verification", () => {
  // These seed with `bindThreadId`, because a published finding carries the
  // thread identity `bindFindingLedgerIdentity` gives it after a successful
  // inline write — and automatic verification finds the finding behind a
  // thread event through exactly that identity.

  const verdict = (outcome: "confirmed" | "withdrawn") => JSON.stringify(
    outcome === "withdrawn"
      ? { outcome, rationale: "The logger redacts the token now." }
      : {
          outcome,
          rationale: "The token is still written on line 14.",
          finding: {
            file: "src/auth.ts", line: 14, severity: "blocking", category: "security",
            message: "Tokens must not be logged.", ruleName: "no-token-logs",
            title: "Do not log tokens", decision: "still-valid",
          },
        },
  );

  it("verifies once when a human replies, without being asked", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true, bindThreadId: "T1" });
    // Ordinary prose: not a command, and nobody mentioned the bot.
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    let sessions = 0;
    const session: ConversationSessionFactory = async () => {
      sessions += 1;
      return createPiSessionStub(verdict("withdrawn")).session;
    };
    adapter.replaceEvents([reply]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession: session }),
    })).resolves.toBe(0);

    expect(sessions).toBe(1);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(1);
    // The record itself is the deliverable: calibration has nothing to read
    // from if the reply lands and the outcome does not.
    const outcomes = await createConversationStateStore({ root: stateDir, repository: repo })
      .readFindingOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.verdict).toBe("withdrawn");
    expect(outcomes[0]!.trigger).toBe("thread-comment");
    expect(outcomes[0]!.headSha).toBe("c".repeat(40));
    // Labels are never stored — only digests of them (#57 design).
    expect(JSON.stringify(outcomes[0])).not.toContain("no-token-logs");
  });

  // THE idempotency criterion: the same page seen twice must not verify twice.
  it("does not verify the same finding again at the same head", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true, bindThreadId: "T1" });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    let sessions = 0;
    const session: ConversationSessionFactory = async () => {
      sessions += 1;
      return createPiSessionStub(verdict("withdrawn")).session;
    };
    adapter.replaceEvents([reply]);
    const deps = { ...executionDeps(adapter, { createSession: session }) };

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    // A SECOND, distinct reply in the same thread. Replaying the first one
    // proves nothing here: the poll's event cursor drops it before the queue
    // ever sees it, so only a genuinely fresh event reaches the layer under
    // test. Recorded outcomes are what make this one verification, not two.
    const again = installFindingThread(
      adapter, findingMarker!, threadComment("human-2", "and here is why", {
        updatedAt: "2026-08-14T00:00:05.000Z",
      }),
    );
    adapter.replaceEvents([again]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);

    expect(sessions).toBe(1);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(1);
  });

  it("says the finding still stands when it does", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true, bindThreadId: "T1" });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "I think this one is wrong"),
    );
    const session: ConversationSessionFactory = async () =>
      createPiSessionStub(verdict("confirmed")).session;
    adapter.replaceEvents([reply]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession: session }),
    })).resolves.toBe(0);

    const body = adapter.postedBodies.find((entry) => /## Verification/.test(entry)) ?? "";
    expect(body).toMatch(/still stands/i);
    expect(body).toContain("still written on line 14");
    // Never restates the finding the thread already carries above it.
    expect(body).not.toContain("Tokens must not be logged");
    // A verdict the reader cannot argue with is worse than no verdict. The
    // invitation names the AUTHENTICATED account, so the mention resolves.
    expect(body).toContain("`@tgdbot reconsider <why>`");
  });

  // A transient provider failure must not consume the reply. The poll marks an
  // ordinary comment classified-and-ignored as soon as it reads it, so an event
  // left on the page is spent whether or not the verification it asked for ever
  // posted.
  it("still answers after a transient failure eats the first attempt", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    const session: ConversationSessionFactory = async () =>
      createPiSessionStub(verdict("withdrawn")).session;
    adapter.replaceEvents([reply]);
    const deps = { ...executionDeps(adapter, { createSession: session }) };

    // Accepted by the provider, then failed before the local record: the
    // orphan case. The reply IS live in the thread.
    adapter.failNextWrite = "accept-then-fail";
    // A transient failure is a non-zero exit: the run did not finish its work.
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(1);

    adapter.replaceEvents([reply]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    // Exactly one reply reaches the thread. The event survived the first poll,
    // so the second could finish the work rather than skip it as spent.
    const posted = [...adapter.postedBodies, ...adapter.acceptedBodies]
      .filter((body) => /## Verification/.test(body));
    expect(posted).toHaveLength(1);
    expect(await createConversationStateStore({ root: stateDir, repository: repo })
      .readFindingOutcomes()).toHaveLength(1);
  });

  // Resolving a thread is not a COMMENT, so the event carries no `commentId`
  // and there is nothing to reply under. Both adapters refuse a thread reply
  // without a parent, so this failed publication as transient and was retried
  // on every poll forever, spending a model call each time.
  it("replies under the thread root when a resolution triggers it", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    // Install the thread, then resolve it.
    installFindingThread(adapter, findingMarker!, threadComment("seed", "noted"));
    const resolution = {
      kind: "thread-resolution" as const,
      provider: "github" as const,
      repositoryDigest,
      reviewNumber: 1,
      eventId: "thread-resolution:T1",
      revisionId: "thread-resolution:T1:1",
      orderKey: "2026-08-14T00:00:02.000Z|thread-resolution:T1",
      createdAt: "2026-08-14T00:00:02.000Z",
      updatedAt: "2026-08-14T00:00:02.000Z",
      body: "",
      url: "https://github.com/owner/repo/pull/1#discussion_rroot",
      threadId: "T1",
      resolved: true,
      outdated: false,
    } as unknown as ReviewActivityEvent;
    const session: ConversationSessionFactory = async () =>
      createPiSessionStub(verdict("withdrawn")).session;
    adapter.replaceEvents([resolution]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession: session }),
    })).resolves.toBe(0);

    // It landed. Without a parent the provider refuses it outright.
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(1);
  });

  // A provider READ outage is not an answer. The event has already been taken
  // off the page by then, so dropping it consumed the reply for good.
  it("retries after a thread read fails", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    const session: ConversationSessionFactory = async () =>
      createPiSessionStub(verdict("withdrawn")).session;
    adapter.replaceEvents([reply]);
    const deps = { ...executionDeps(adapter, { createSession: session }) };

    adapter.failNextThreadRead = true;
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(0);

    adapter.replaceEvents([reply]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(1);
  });

  // A transient VERDICT failure, as opposed to a transient publication.
  it("retries after the verifier fails transiently", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    let attempts = 0;
    const session: ConversationSessionFactory = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("the model is temporarily unavailable");
      return createPiSessionStub(verdict("withdrawn")).session;
    };
    adapter.replaceEvents([reply]);
    const deps = { ...executionDeps(adapter, { createSession: session }) };

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(0);

    adapter.replaceEvents([reply]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(1);
  });

  // A verification that can NEVER succeed must be spent DURABLY. Released from
  // memory only, the next poll re-queues it, and with the budget full of such
  // findings everything behind them starves forever.
  it("spends a finding whose rule is gone, so it never queues again", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    adapter.replaceEvents([reply]);
    // Rules load fine, but the one this finding was raised under is gone. An
    // EMPTY set is a load error, which defers rather than settling — a
    // distinction that made an earlier version of this test vacuous.
    const deps = executionDeps(adapter, {
      rules: [{ ...currentRule, name: "some-other-rule", sourcePath: "/rules/some-other-rule.md" }],
    });
    const store = createConversationStateStore({ root: stateDir, repository: repo });

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(0);
    expect(await store.readFindingOutcomes()).toEqual([]);
    expect(adapter.threadReads).toBe(1);

    // Seen again, as a held cursor would show it.
    adapter.replaceEvents([reply]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);

    // THE point: no second look. The event was taken off the page, so the
    // record the page would have written had to be written when it settled.
    // Without it the finding is queued again on every poll — forever, taking
    // budget from everything behind it.
    expect(adapter.threadReads).toBe(1);
  });

  // Metadata is a provider round-trip like any other, and failing it is an
  // outage rather than an answer.
  it("retries after review metadata fails to load", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    const session: ConversationSessionFactory = async () =>
      createPiSessionStub(verdict("withdrawn")).session;
    adapter.replaceEvents([reply]);
    let failMetadata = true;
    const base = executionDeps(adapter, { createSession: session });
    const deps = {
      ...base,
      getReviewMetadata: async (reviewNumber: number) => {
        if (failMetadata) throw new Error("the pull request is temporarily unavailable");
        return base.getReviewMetadata(reviewNumber);
      },
    };

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(0);

    failMetadata = false;
    adapter.replaceEvents([reply]);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(1);
  });

  // The cost ceiling is ONE allowance for the poll. It was passed fresh into
  // every loop iteration, so a busy repository could spend five model calls per
  // iteration against a documented five per poll.
  it("spends at most five model calls per poll, and answers the rest next poll", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir } = await bootstrapAndSeed(adapter);
    const replies: ReviewActivityEvent[] = [];
    // SEVEN, not six. Six is exactly the old one-past-the-budget lookahead, so
    // a fixture of six passed against an implementation that could not name the
    // seventh candidate at all (PR #74 review).
    for (let index = 0; index < 7; index += 1) {
      const { findingMarker } = await seedFindingInto(stateDir, {
        findingId: `finding_${String(index).repeat(32)}`,
        bindThreadId: `T${index}`,
      });
      replies.push(installFindingThread(
        adapter,
        findingMarker,
        threadComment(`human-${index}`, "fixed this in the latest push", { threadId: `T${index}` }),
      ));
    }
    let sessions = 0;
    const session: ConversationSessionFactory = async () => {
      sessions += 1;
      return createPiSessionStub(verdict("withdrawn")).session;
    };
    adapter.replaceEvents(replies);
    const deps = { ...executionDeps(adapter, { createSession: session }) };

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(sessions).toBe(5);

    // The remaining two are not lost. Nothing persists "this reply is still
    // owed", so the poll takes them off the page and holds the cursor.
    adapter.replaceEvents(replies);
    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), deps)).resolves.toBe(0);
    expect(sessions).toBe(7);
    expect(adapter.postedBodies.filter((body) => /## Verification/.test(body))).toHaveLength(7);
  });

  // A dry run previews; it does not buy anything. Reporting the VERDICT meant
  // asking the model for it, which is a provider charge for a preview the
  // operator asked to be free.
  it("costs no model call in a dry run", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, {
      seedFinding: true, bindThreadId: "T1",
    });
    const reply = installFindingThread(
      adapter, findingMarker!, threadComment("human", "fixed this in the latest push"),
    );
    const createSession = vi.fn(sessionFor("{}"));
    adapter.replaceEvents([reply]);
    const store = createConversationStateStore({ root: stateDir, repository: repo });
    const before = await store.readContextSnapshot();

    await expect(poll(pollArgs(stateDir, { dryRun: true, model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession }),
    })).resolves.toBe(0);

    expect(createSession).not.toHaveBeenCalled();
    expect(adapter.postedBodies).toEqual([]);
    expect(await store.readFindingOutcomes()).toEqual([]);
    expect((await store.readContextSnapshot()).events).toEqual(before.events);
  });

  // The bot's own replies must not trigger it, or a run answers itself forever.
  it("is not triggered by its own reply", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true, bindThreadId: "T1" });
    const own = installFindingThread(
      adapter, findingMarker!,
      threadComment("self", "## Verification", { authorLogin: "tgdbot", authorIsBot: true }),
    );
    let sessions = 0;
    const session: ConversationSessionFactory = async () => {
      sessions += 1;
      return createPiSessionStub(verdict("withdrawn")).session;
    };
    adapter.replaceEvents([own]);

    await expect(poll(pollArgs(stateDir, { model: "anthropic/claude-opus-4-5" }), {
      ...executionDeps(adapter, { createSession: session }),
    })).resolves.toBe(0);

    expect(sessions).toBe(0);
  });
});
