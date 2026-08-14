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
import { poll } from "../../../src/poll/poll.js";
import { createPiSessionStub } from "../../fixtures/pi-session-stub.js";
import type { ConversationSessionFactory } from "../../../src/conversation/session.js";
import type { RuleDefinition } from "../../../src/rules/types.js";

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
  it("classifies irrelevant and deferred commands without posting replies", async () => {
    const stateDir = await tempStateDir();
    const adapter = new ClassificationAdapter([]);
    await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);

    adapter.replaceEvents([
      commentEvent("irr", "looks good"),
      commentEvent("self", "@tgdbot explain", "2026-08-14T00:00:00.000Z", { authorLogin: "tgdbot", authorIsBot: true }),
      commentEvent("cmd", "@tgdbot memories"),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
      expect(adapter.writes).toEqual([]);
      expect(log.mock.calls.flat().join("\n")).toMatch(/@tgdbot memories/i);
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
    expect(journal.filter((entry) => entry.state === "observed")).toHaveLength(3);
    expect(journal.filter((entry) => entry.state === "completed")).toHaveLength(2);
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

const FINDING_ID = `finding_${"1".repeat(32)}`;
const currentHunk = "@@ -12,3 +12,4 @@\n export function dump(user) {\n+  console.log(user.token);\n   return user;\n }";
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
    return this.recordWrite("thread", input.body, input.threadId);
  }

  override async findBotChildMarker(_review: ReviewIdentity, marker: ChildMarkerLookup): Promise<ConversationItemIdentity | null> {
    const key = formatChildMarker({ version: 1, ...marker });
    return this.publishedByMarker.get(key) ?? null;
  }

  override async getReviewThread(_review: ReviewIdentity, threadId: string): Promise<ReviewThreadSnapshot> {
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
  options: { readonly seedFinding?: boolean } = {},
): Promise<{ stateDir: string; ledger?: FindingLedgerEntry; findingMarker?: string }> {
  const stateDir = await tempStateDir();
  await expect(poll(pollArgs(stateDir), { conversationAdapter: adapter })).resolves.toBe(0);
  if (options.seedFinding !== true) return { stateDir };
  const store = createConversationStateStore({ root: stateDir, repository: repo });
  const binding = store.repositoryBinding;
  const ledger = prepareFindingLedgerEntry({
    repository: binding,
    id: FINDING_ID,
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
      model: "anthropic/claude-opus-4-5",
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
  await store.transact((tx) => tx.appendFinding(ledger));
  const findingMarker = formatChildMarker({
    kind: "finding",
    parentId: `act_${"2".repeat(32)}`,
    childId: ledger.id,
    repositoryDigest,
    reviewNumber: 1,
    contentDigest: ledger.contentDigest,
  });
  return { stateDir, ledger, findingMarker };
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
} = {}) {
  const heads = extras.heads === undefined ? undefined : [...extras.heads];
  return {
    conversationAdapter: adapter,
    createSession: extras.createSession ?? sessionFor(JSON.stringify({ explanation: "The logger prints user.token." })),
    getReviewMetadata: async () => ({
      headSha: heads === undefined ? adapter.headSha : (heads.shift() ?? adapter.headSha),
      baseSha: "b".repeat(40),
      diff: currentHunk,
    }),
    loadConversationRules: async () => ({
      rules: extras.rules ?? [currentRule],
      ...(extras.ruleLoadError === undefined ? {} : { error: extras.ruleLoadError }),
    }),
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
      commentEvent("big", `${"x".repeat(MAX_COMMAND_BODY_SCALARS + 1)}`, "2026-08-14T00:00:01.000Z"),
      commentEvent("later", "thanks", "2026-08-14T00:00:02.000Z"),
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

  it("treats a spoofed finding marker as a scope error without model work", async () => {
    const adapter = new ExecutionAdapter([]);
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
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
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
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
    const { stateDir, findingMarker } = await bootstrapAndSeed(adapter, { seedFinding: true });
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

  it("stays silent after a terminal result until a new mention", async () => {
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
    expect(adapter.postedBodies).toHaveLength(1);
  });
});

