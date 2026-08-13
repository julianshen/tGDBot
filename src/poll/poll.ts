import { createHash } from "node:crypto";
import type { PollArgs } from "../cli-args.js";
import { parseConversationCommand } from "../conversation/command-parser.js";
import {
  createConversationStateStore,
  type ConversationStateStore,
} from "../conversation/state-store.js";
import type { ConversationEventEntry } from "../conversation/state-schema.js";
import type { BotIdentity, CommandParseResult, RepositoryBinding } from "../conversation/types.js";
import type {
  ConversationAdapter,
  ReviewActivityEvent,
  ReviewEventPage,
  ReviewEventPageToken,
} from "../vcs/conversation-adapter.js";
import { MAX_POLL_EVENTS, resolvePollConfig, type ResolvedPollConfig } from "./config.js";
import {
  activeReviews,
  adapterRepositoryBinding,
  commitBootstrapIfAbsent,
  conversationStateInitialized,
  decodeReviewProgress,
  encodeReviewProgress,
  eventCursorFrom,
  eventPageTokenFrom,
  fetchBootstrapStaging,
  nextRoundRobinIndex,
  reviewIdentityFrom,
  synchronizeOpenReviews,
} from "./discovery.js";

const EXIT_OK = 0;

export interface PollDependencies {
  readonly resolvePollConfig?: (args: PollArgs) => ResolvedPollConfig;
  readonly conversationAdapter?: ConversationAdapter;
  readonly createStateStore?: typeof createConversationStateStore;
  readonly now?: () => string;
}

export async function poll(args: PollArgs, deps: PollDependencies = {}): Promise<number> {
  const config = (deps.resolvePollConfig ?? resolvePollConfig)(args);
  const adapter = deps.conversationAdapter ?? config.conversationAdapter;
  const now = deps.now ?? (() => new Date().toISOString());
  const createStore = deps.createStateStore ?? createConversationStateStore;
  const binding = adapterRepositoryBinding(config.repository);

  const initialized = await conversationStateInitialized(config.stateRoot, config.repository);
  if (!initialized) {
    const staged = await fetchBootstrapStaging(adapter, binding);
    if (config.dryRun) {
      console.log("tgd-review-agent: dry-run; would initialize repository with 0 processed events");
      return EXIT_OK;
    }
    const store = createStore({ root: config.stateRoot, repository: config.repository });
    await commitBootstrapIfAbsent(store, staged);
    console.log("tgd-review-agent: initialized repository with 0 processed events");
    return EXIT_OK;
  }

  const store = createStore({ root: config.stateRoot, repository: config.repository });
  await synchronizeOpenReviews({
    adapter, binding, store, now, dryRun: config.dryRun,
  });
  await classifyOpenReviewEvents({
    adapter, binding, store, dryRun: config.dryRun, now,
  });
  return EXIT_OK;
}

async function classifyOpenReviewEvents(options: {
  readonly adapter: ConversationAdapter;
  readonly binding: RepositoryBinding;
  readonly store: ConversationStateStore;
  readonly dryRun: boolean;
  readonly now: () => string;
}): Promise<void> {
  const botIdentity = await options.adapter.getAuthenticatedBotIdentity();
  let snapshot = await options.store.readContextSnapshot();
  const knownActionIds = new Set(snapshot.events.map((entry) => entry.actionId));
  const active = activeReviews(snapshot.cursor.reviews);
  if (active.length === 0) return;

  let index = nextRoundRobinIndex(snapshot.cursor.reviews, snapshot.cursor.nextRoundRobinKey);
  let processed = 0;
  let idleTurns = 0;
  const pageTokens = new Map<number, ReviewEventPageToken>();

  while (processed < MAX_POLL_EVENTS && idleTurns < active.length) {
    snapshot = options.dryRun ? snapshot : await options.store.readContextSnapshot();
    const currentActive = activeReviews(snapshot.cursor.reviews);
    if (currentActive.length === 0) return;
    index = index % currentActive.length;
    const review = currentActive[index]!;
    const progress = decodeReviewProgress(review.cursor);
    if (progress === null) throw new Error(`Review ${review.reviewNumber} is missing stored progress`);
    const identity = reviewIdentityFrom(options.binding, review.reviewNumber, progress);
    const after = eventCursorFrom(options.binding, review.reviewNumber, progress);
    const pageToken = eventPageTokenFrom(options.binding, review.reviewNumber, review.eventPageToken)
      ?? pageTokens.get(review.reviewNumber);

    const page: ReviewEventPage = await options.adapter.listReviewEvents(identity, after, pageToken);
    if (page.nextPageToken !== undefined) pageTokens.set(review.reviewNumber, page.nextPageToken);
    else pageTokens.delete(review.reviewNumber);

    const fresh: ReviewActivityEvent[] = [];
    for (const event of page.events) {
      const actionId = actionIdentity(event).actionId;
      if (knownActionIds.has(actionId)) continue;
      if (processed + fresh.length >= MAX_POLL_EVENTS) break;
      fresh.push(event);
    }
    const stoppedEarly = processed + fresh.length >= MAX_POLL_EVENTS &&
      page.events.some((event) => !knownActionIds.has(actionIdentity(event).actionId) &&
        !fresh.includes(event));

    const classified = fresh.map((event) => ({ event, parsed: classifyEvent(event, botIdentity) }));
    for (const item of classified) {
      const identityPair = actionIdentity(item.event);
      knownActionIds.add(identityPair.actionId);
      if (item.parsed.kind === "command") {
        console.log(
          `tgd-review-agent: recognized ${item.parsed.normalized} on review #${item.event.reviewNumber} (executor unavailable)`,
        );
      }
    }

    const completedPage = !stoppedEarly;
    const listingComplete = page.nextPageToken === undefined;
    const nextRoundRobinKey = stoppedEarly
      ? String(review.reviewNumber)
      : nextKey(currentActive, index);
    const advancedProgress = listingComplete && page.events.length > 0
      ? {
          ...progress,
          eventOpaque: page.nextCursor.opaque,
          eventOrderKey: page.nextCursor.orderKey,
        }
      : progress;

    if (!options.dryRun && (classified.length > 0 || completedPage)) {
      await options.store.transact((tx) => {
        for (const item of classified) {
          const identityPair = actionIdentity(item.event);
          appendObservation(tx, identityPair, item.event.reviewNumber, options.now());
          if (item.parsed.kind === "command") {
            appendPrepared(tx, identityPair, item.event.reviewNumber, options.now());
          }
        }
        tx.replaceCursor({
          ...tx.snapshot.cursor,
          nextRoundRobinKey,
          reviews: completedPage
            ? tx.snapshot.cursor.reviews.map((entry) =>
                entry.reviewNumber === review.reviewNumber
                  ? {
                      reviewNumber: entry.reviewNumber,
                      cursor: encodeReviewProgress(advancedProgress),
                      retired: false,
                      ...(page.nextPageToken === undefined ? {} : { eventPageToken: page.nextPageToken.opaque }),
                    }
                  : entry)
            : tx.snapshot.cursor.reviews,
        });
      });
    }

    processed += classified.length;
    if (classified.length === 0 && completedPage) idleTurns += 1;
    else idleTurns = 0;
    if (stoppedEarly || processed >= MAX_POLL_EVENTS) return;
    index = (index + 1) % currentActive.length;
  }
}

function nextKey(
  active: readonly { readonly reviewNumber: number }[],
  index: number,
): string {
  return String(active[(index + 1) % active.length]!.reviewNumber);
}

function classifyEvent(event: ReviewActivityEvent, botIdentity: BotIdentity): CommandParseResult {
  if (event.kind === "thread-resolution") {
    return { kind: "irrelevant" };
  }
  return parseConversationCommand({
    authorIsBot: event.authorIsBot === true,
    botIdentity,
    body: event.body,
  });
}

function actionIdentity(event: ReviewActivityEvent): { actionId: string; identityDigest: string } {
  const material = [
    event.provider, event.repositoryDigest, String(event.reviewNumber), event.eventId, event.revisionId,
  ].join("\0");
  const identityDigest = createHash("sha256").update(`tgd:poll-action:v1\0${material}`, "utf8").digest("hex");
  return { actionId: `action_${identityDigest.slice(0, 32)}`, identityDigest };
}

function appendObservation(
  tx: { appendEvent(entry: ConversationEventEntry): void; snapshot: { cursor: { repository: RepositoryBinding } } },
  identity: { actionId: string; identityDigest: string },
  reviewNumber: number,
  at: string,
): void {
  tx.appendEvent({
    version: 1,
    repository: tx.snapshot.cursor.repository,
    actionId: identity.actionId,
    identityDigest: identity.identityDigest,
    reviewNumber,
    state: "observed",
    at,
    successorActionId: null,
    manifest: [],
  });
}

function appendPrepared(
  tx: { appendEvent(entry: ConversationEventEntry): void; snapshot: { cursor: { repository: RepositoryBinding } } },
  identity: { actionId: string; identityDigest: string },
  reviewNumber: number,
  at: string,
): void {
  tx.appendEvent({
    version: 1,
    repository: tx.snapshot.cursor.repository,
    actionId: identity.actionId,
    identityDigest: identity.identityDigest,
    reviewNumber,
    state: "prepared",
    at,
    successorActionId: null,
    manifest: [],
  });
}


