import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PollArgs, SharedReviewOptions } from "../cli-args.js";
import type { ReviewInvocation } from "../cli.js";
import {
  conversationActionIdentity,
  conversationCommandKey,
  conversationSuccessorIdentity,
  explainFinding,
  isExecutableConversationCommand,
  reassessClarification,
  reconsiderFinding,
  resolveMarkedFindingThread,
} from "../conversation/actions.js";
import {
  associateClarificationEvent,
  clarificationLifecycleState,
  mayBeClarificationAnswer,
  transitionClarification,
} from "../conversation/clarification.js";
import { parseConversationCommand } from "../conversation/command-parser.js";
import { redactedMessage } from "../conversation/redact.js";
import {
  encodeMemoryPublicId,
  listMemories,
  planForget,
  planRemember,
} from "../conversation/memories.js";
import {
  computeContentDigest,
  computeRepositoryDigest,
  formatChildMarker,
  parseChildMarker,
} from "../conversation/markers.js";
import {
  actionFromEvent,
  clarificationFindingPublicationIdentity,
  clarificationQuestionWriter,
  eventFromAction,
  executePublication,
  latestPublication,
  observePublication,
  publishClarificationQuestion,
  supersedeWithSuccessor,
  type PublicationAction,
  type PublicationExecutorHooks,
  type PublicationWriter,
} from "../conversation/publication-manifest.js";
import {
  publishConfirmedClarificationFinding,
} from "../review/review-publication.js";
import {
  childMarkerSuffix,
  createConversationPublicationChild,
  publicationBody,
  renderClarificationReply,
  renderExplainReply,
  renderInactiveRuleReply,
  renderMemoryReply,
  renderReconsiderReply,
  renderScopeErrorReply,
  renderUnsupportedHistoryReply,
  renderUsageReply,
  type MemoryReply,
  type RenderedConversationBody,
} from "../conversation/render.js";
import type { ConversationSessionFactory } from "../conversation/session.js";
import {
  createConversationStateStore,
  replacePendingClarification,
  type ConversationStateStore,
} from "../conversation/state-store.js";
import {
  prepareFindingLedgerEntry,
  type ConversationEventEntry,
  type MemoryEntry,
} from "../conversation/state-schema.js";
import type {
  BotIdentity,
  CommandParseResult,
  ConversationCommand,
  RepositoryBinding,
} from "../conversation/types.js";
import { loadRules } from "../rules/loader.js";
import type { RuleDefinition } from "../rules/types.js";
import type {
  ConversationAdapter,
  ReviewActivityEvent,
  ReviewEventPage,
  ReviewEventPageToken,
  ReviewThreadSnapshot,
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
const EXIT_TRANSIENT = 1;
const MAX_STALE_HEAD_RETRIES = 3;

export interface PollReviewMetadata {
  readonly headSha: string;
  readonly baseSha?: string;
  readonly diff: string;
}

export interface PollDependencies {
  readonly resolvePollConfig?: (args: PollArgs) => ResolvedPollConfig;
  readonly conversationAdapter?: ConversationAdapter;
  readonly createStateStore?: typeof createConversationStateStore;
  readonly now?: () => string;
  readonly createSession?: ConversationSessionFactory;
  readonly getReviewMetadata?: (reviewNumber: number) => Promise<PollReviewMetadata>;
  readonly loadConversationRules?: (input: {
    readonly reviewNumber: number;
    readonly headSha: string;
    readonly baseSha?: string;
  }) => Promise<{ readonly rules: readonly RuleDefinition[]; readonly error?: Error }>;
  readonly publicationHooks?: PublicationExecutorHooks;
  /**
   * Injected rather than imported: cli.ts already imports poll(), so importing
   * review() back would close a module cycle. main() supplies the real one.
   */
  readonly runReview?: (
    args: ReviewCommandArgs,
    deps: { readonly invocation: ReviewInvocation },
  ) => Promise<number>;
}

/** The subset of review CliArgs poll constructs from its own resolved options. */
export type ReviewCommandArgs = Omit<SharedReviewOptions, "command"> & { readonly pr: string };

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
  if (!config.dryRun) {
    await recoverPreparedClarificationQuestions({
      adapter, binding, store, now, config,
    });
  }
  return classifyOpenReviewEvents({
    adapter, binding, store, dryRun: config.dryRun, now, config, deps,
  });
}

async function classifyOpenReviewEvents(options: {
  readonly adapter: ConversationAdapter;
  readonly binding: RepositoryBinding;
  readonly store: ConversationStateStore;
  readonly dryRun: boolean;
  readonly now: () => string;
  readonly config: ResolvedPollConfig;
  readonly deps: PollDependencies;
}): Promise<number> {
  const botIdentity = await options.adapter.getAuthenticatedBotIdentity();
  let snapshot = await options.store.readContextSnapshot();
  const knownActionIds = new Set(
    snapshot.events.filter((entry) => entry.state === "completed").map((entry) => entry.actionId),
  );
  const active = activeReviews(snapshot.cursor.reviews);
  if (active.length === 0) return EXIT_OK;

  let index = nextRoundRobinIndex(snapshot.cursor.reviews, snapshot.cursor.nextRoundRobinKey);
  let processed = 0;
  let idleTurns = 0;
  const pageTokens = new Map<number, ReviewEventPageToken>();
  const seenEventKeys = new Set<string>();

  while (processed < MAX_POLL_EVENTS && idleTurns < active.length) {
    snapshot = options.dryRun ? snapshot : await options.store.readContextSnapshot();
    const currentActive = activeReviews(snapshot.cursor.reviews);
    if (currentActive.length === 0) return EXIT_OK;
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

    const pageIdentities = page.events.map((event) => {
      const parsed = classifyEvent(event, botIdentity);
      return { event, parsed, identity: identityFor(event, parsed) };
    });
    const unchecked = pageIdentities.filter((item) => !knownActionIds.has(item.identity.actionId));
    const recorded = unchecked.length === 0
      ? new Map()
      : await options.store.findTerminalActions(unchecked.map((item) => item.identity));
    for (const item of unchecked) {
      const terminal = recorded.get(item.identity.actionId);
      if (terminal?.state === "completed") knownActionIds.add(item.identity.actionId);
    }
    const unseen = pageIdentities.filter((item) => {
      const eventKey = `${item.event.eventId}:${item.event.revisionId}`;
      if (seenEventKeys.has(eventKey) || knownActionIds.has(item.identity.actionId)) return false;
      return true;
    });
    const fresh = unseen.slice(0, Math.max(0, MAX_POLL_EVENTS - processed));
    const stoppedEarly = unseen.length > fresh.length;

    let haltTransient = false;
    let haltCursor = false;
    const classified: typeof fresh = [];
    for (const item of fresh) {
      const eventKey = `${item.event.eventId}:${item.event.revisionId}`;
      if (seenEventKeys.has(eventKey) || knownActionIds.has(item.identity.actionId)) continue;
      seenEventKeys.add(eventKey);
      classified.push(item);
    }

    if (options.dryRun) {
      for (const item of classified) {
        if (item.parsed.kind === "command") {
          console.log(
            `tgd-review-agent: recognized ${item.parsed.normalized} on review #${item.event.reviewNumber} (executor unavailable)`,
          );
        }
      }
    } else {
      const pending: typeof classified = [];
      for (const item of classified) {
        const live = latestPublication(snapshot.events, item.identity.actionId)
          ?? snapshot.events.findLast?.((entry) => entry.identityDigest === item.identity.identityDigest)
          ?? [...snapshot.events].reverse().find((entry) => entry.identityDigest === item.identity.identityDigest);
        const terminal = recorded.get(item.identity.actionId);
        if (live?.state === "completed" || terminal?.state === "completed") {
          knownActionIds.add(item.identity.actionId);
          continue;
        }
        if (live === undefined && terminal === undefined) pending.push(item);
      }
      if (pending.length > 0) {
        await options.store.transact((tx) => {
          for (const item of pending) {
            appendObservation(tx, item.identity, item.event.reviewNumber, options.now());
            const pendingForReview = tx.snapshot.pending.clarifications.filter((entry) =>
              entry.reviewNumber === item.event.reviewNumber);
            const answerCommand = item.parsed.kind === "command" && item.parsed.command.kind === "answer";
            if (item.parsed.kind === "command" || item.parsed.kind === "invalid" || answerCommand ||
              mayBeClarificationAnswer({ event: item.event, pending: pendingForReview })) {
              appendPrepared(tx, item.identity, item.event.reviewNumber, options.now());
            } else {
              appendClassifiedAndIgnored(tx, item.identity, item.event.reviewNumber, options.now());
            }
          }
        });
      }
    }

    for (const item of classified) {
      if (options.dryRun) continue;

      const pendingForReview = (options.dryRun ? snapshot : await options.store.readContextSnapshot())
        .pending.clarifications.filter((entry) => entry.reviewNumber === item.event.reviewNumber);
      const maybeAnswer = mayBeClarificationAnswer({ event: item.event, pending: pendingForReview });
      if (knownActionIds.has(item.identity.actionId) || (item.parsed.kind === "irrelevant" && !maybeAnswer)) {
        if (item.parsed.kind === "irrelevant" && !maybeAnswer) knownActionIds.add(item.identity.actionId);
        continue;
      }
      if (item.parsed.kind === "command" && item.parsed.command.kind !== "answer" &&
        !isMemoryCommand(item.parsed.command) &&
        !isReviewCommand(item.parsed.command) &&
        !isExecutableConversationCommand(item.parsed.command)) {
        console.log(
          `tgd-review-agent: recognized ${item.parsed.normalized} on review #${item.event.reviewNumber} (executor unavailable)`,
        );
        continue;
      }

      const outcome = await executeConversationEvent({
        item,
        reviewIdentity: identity,
        options,
      });
      if (outcome === "transient") {
        haltTransient = true;
        haltCursor = true;
        break;
      }
      if (outcome === "stale") {
        haltCursor = true;
        break;
      }
      if (outcome === "completed") knownActionIds.add(item.identity.actionId);
    }

    const completedPage = !stoppedEarly && !haltCursor;
    const listingComplete = page.nextPageToken === undefined;
    const nextRoundRobinKey = stoppedEarly || haltCursor
      ? String(review.reviewNumber)
      : nextKey(currentActive, index);
    const advancedProgress = listingComplete && page.events.length > 0 && !haltCursor
      ? {
          ...progress,
          eventOpaque: page.nextCursor.opaque,
          eventOrderKey: page.nextCursor.orderKey,
        }
      : progress;

    if (!options.dryRun && (classified.length > 0 || completedPage) && !haltCursor) {
      await options.store.transact((tx) => {
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
    } else if (!options.dryRun && haltCursor) {
      await options.store.transact((tx) => {
        tx.replaceCursor({
          ...tx.snapshot.cursor,
          nextRoundRobinKey,
        });
      });
    }

    processed += classified.length;
    if (haltTransient) return EXIT_TRANSIENT;
    if (haltCursor) return EXIT_OK;
    if (classified.length === 0 && completedPage) idleTurns += 1;
    else idleTurns = 0;
    if (stoppedEarly || processed >= MAX_POLL_EVENTS) return EXIT_OK;
    index = (index + 1) % currentActive.length;
  }
  return EXIT_OK;
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

function pollEventIdentity(event: ReviewActivityEvent): { actionId: string; identityDigest: string } {
  const material = [
    event.provider, event.repositoryDigest, String(event.reviewNumber), event.eventId, event.revisionId,
  ].join("\0");
  const identityDigest = createHash("sha256").update(`tgd:poll-action:v1\0${material}`, "utf8").digest("hex");
  return { actionId: `action_${identityDigest.slice(0, 32)}`, identityDigest };
}

function identityFor(
  event: ReviewActivityEvent,
  parsed: CommandParseResult,
): { actionId: string; identityDigest: string } {
  if (parsed.kind === "irrelevant") return pollEventIdentity(event);
  return conversationActionIdentity({
    provider: event.provider,
    repositoryDigest: event.repositoryDigest,
    reviewNumber: event.reviewNumber,
    eventId: event.eventId,
    commandKey: conversationCommandKey(parsed),
  });
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

function appendClassifiedAndIgnored(
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
    state: "completed",
    at,
    successorActionId: null,
    manifest: [],
  });
}

async function resolveLatestAction(
  store: ConversationStateStore,
  identity: { actionId: string; identityDigest: string },
): Promise<ConversationEventEntry | undefined> {
  const snapshot = await store.readContextSnapshot();
  const lineageLive = snapshot.events.filter((entry) => entry.identityDigest === identity.identityDigest);
  if (lineageLive.length > 0) {
    const latestLive = lineageLive[lineageLive.length - 1]!;
    if (latestLive.state !== "superseded" || latestLive.successorActionId === null) return latestLive;
  }
  let actionId = identity.actionId;
  const seen = new Set<string>();
  while (!seen.has(actionId)) {
    seen.add(actionId);
    const live = latestPublication(snapshot.events, actionId);
    if (live !== undefined) {
      if (live.state === "superseded" && live.successorActionId !== null) {
        actionId = live.successorActionId;
        continue;
      }
      return live;
    }
    const terminal = await store.findTerminalAction({ actionId, identityDigest: identity.identityDigest })
      ?? await store.findTerminalActionById(actionId);
    if (terminal === undefined) return undefined;
    if (terminal.state === "superseded" && terminal.successorActionId !== null) {
      actionId = terminal.successorActionId;
      continue;
    }
    return {
      version: 1,
      repository: snapshot.cursor.repository,
      actionId: terminal.actionId,
      identityDigest: terminal.identityDigest,
      reviewNumber: snapshot.cursor.reviews[0]?.reviewNumber ?? 0,
      state: terminal.state,
      at: terminal.at,
      successorActionId: terminal.successorActionId,
      manifest: [],
    };
  }
  return undefined;
}

type ReplyPlan =
  | { readonly kind: "usage" }
  | {
      readonly kind: "memory";
      readonly reply: MemoryReply;
      /** Absent for a listing or a refusal: those change nothing locally. */
      readonly operation?: MemoryEntry;
    }
  | { readonly kind: "scope" }
  | { readonly kind: "history" }
  | { readonly kind: "inactive"; readonly ruleName: string }
  | { readonly kind: "explain"; readonly explanation: string; readonly headSha: string }
  | {
      readonly kind: "reconsider";
      readonly outcome: "confirmed" | "revised" | "withdrawn";
      readonly rationale: string;
      readonly headSha: string;
    }
  | {
      readonly kind: "clarification";
      readonly outcome: "confirmed" | "revised" | "withdrawn" | "stale";
      readonly rationale: string;
      readonly question?: string;
      readonly answer?: string;
      readonly headSha: string;
    };

async function executeConversationEvent(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult; readonly identity: { actionId: string; identityDigest: string } };
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<"completed" | "transient" | "stale"> {
  const { item, reviewIdentity, options } = input;
  const identity = item.identity;
  const latest = await resolveLatestAction(options.store, identity);
  if (latest?.state === "completed") return "completed";

  if (latest !== undefined && (latest.state === "manifest-ready" || latest.state === "published")) {
    const result = await publishPreparedReply({
      event: item.event,
      identity,
      latest,
      reviewIdentity,
      options,
    });
    if (result === "completed") {
      await finalizeClarificationIfAnswered(item.event, options.store);
    }
    return result;
  }

  if (item.parsed.kind === "command" && isReviewCommand(item.parsed.command)) {
    return executeReviewCommand({ item, command: item.parsed.command, options });
  }

  const clarificationOutcome = await maybeExecuteClarification({ item, reviewIdentity, options, latest });
  if (clarificationOutcome !== undefined) return clarificationOutcome;

  const planned = await planConversationReply({ item, reviewIdentity, options });
  if (planned.status === "transient") return "transient";
  return publishReplyPlan({
    event: item.event,
    identity,
    plan: planned.plan,
    reviewIdentity,
    options,
  });
}

/** Commands that re-run the review itself rather than posting a composed reply. */
function isReviewCommand(command: ConversationCommand): command is
  | { readonly kind: "check-latest" }
  | { readonly kind: "review-focus"; readonly direction: string } {
  return command.kind === "check-latest" || command.kind === "review-focus";
}

/**
 * Builds the review configuration from poll's OWN resolved options so a command
 * runs under the same rules, model, and dispatch engine as the poll that saw
 * it. Reading ambient review defaults here would silently review under a
 * different configuration than the operator asked for.
 */
function reviewArgsFor(config: ResolvedPollConfig, reviewNumber: number): ReviewCommandArgs {
  return {
    pr: String(reviewNumber),
    vcs: config.vcs,
    repo: config.repo,
    rulesDir: config.rulesDir,
    disableBuiltinRule: config.disableBuiltinRule,
    advisor: config.advisor,
    suggestions: config.suggestions,
    dryRun: config.dryRun,
    trustLocalRules: config.trustLocalRules,
    dispatch: config.dispatch,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.maxDiffChars === undefined ? {} : { maxDiffChars: config.maxDiffChars }),
    ...(config.stateDir === undefined ? {} : { stateDir: config.stateDir }),
  };
}

async function executeReviewCommand(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly identity: { actionId: string; identityDigest: string } };
  readonly command: { readonly kind: "check-latest" } | { readonly kind: "review-focus"; readonly direction: string };
  readonly options: {
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<"completed" | "transient" | "stale"> {
  const { item, command, options } = input;
  const runReview = options.deps.runReview;
  if (runReview === undefined) {
    console.warn("tgd-review-agent: review command executor is not configured");
    return "transient";
  }
  const invocation: ReviewInvocation = command.kind === "check-latest"
    ? { kind: "forced-command", actionId: item.identity.actionId }
    : {
        kind: "focused-command",
        actionId: item.identity.actionId,
        direction: command.direction,
        ...(item.event.threadId === undefined ? {} : { threadId: item.event.threadId }),
      };

  // The direction is durable BEFORE the supplemental run. If the review fails
  // transiently, the retry still knows what was asked; and a later normal
  // review on the same head picks it up as additive context. It never becomes a
  // trusted rule — every trusted rule still runs unchanged.
  if (command.kind === "review-focus") {
    const stored = await storeReviewDirection({
      identity: item.identity,
      event: item.event,
      direction: command.direction,
      options,
    });
    if (stored === "transient") return "transient";
  }

  let exitCode: number;
  try {
    exitCode = await runReview(reviewArgsFor(options.config, item.event.reviewNumber), { invocation });
  } catch (error) {
    console.warn(`tgd-review-agent: review command failed (${redactedMessage(error)})`);
    return "transient";
  }
  if (exitCode !== 0 && exitCode !== 2) return "transient";
  // This action carries no manifest of its own — review() owns and recovers the
  // one that publishes its output — so it walks the remaining states with an
  // empty manifest: nothing to freeze, nothing to write, every child terminal.
  // Failing before this leaves the action incomplete, and the retry re-runs the
  // review, whose own dedup and pending-summary recovery make that safe.
  await completeReviewCommandAction(item, options);
  return "completed";
}

/**
 * Idempotent in the action identity: a retry recomputes the same direction ID
 * and finds its own earlier record rather than steering the review twice.
 */
async function storeReviewDirection(input: {
  readonly identity: { actionId: string; identityDigest: string };
  readonly event: ReviewActivityEvent;
  readonly direction: string;
  readonly options: {
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<"stored" | "transient"> {
  const metadata = await loadReviewMetadata(input.event.reviewNumber, input.options);
  if (metadata === undefined) return "transient";
  const directionId = `direction_${createHash("sha256")
    .update("tgd:direction:v1\0", "utf8")
    .update(input.identity.actionId)
    .digest("hex")
    .slice(0, 32)}`;
  await input.options.store.transact((tx) => {
    const pending = tx.snapshot.pending;
    if (pending.directions.some((entry) => entry.id === directionId)) return;
    tx.replacePending({
      ...pending,
      directions: [...pending.directions, {
        id: directionId,
        reviewNumber: input.event.reviewNumber,
        headSha: metadata.headSha.toLowerCase(),
        text: input.direction,
        createdAt: input.options.now(),
        actionId: input.identity.actionId,
        ...(input.event.authorLogin === undefined ? {} : { author: input.event.authorLogin }),
        source: input.event.url,
      }],
    });
  });
  return "stored";
}

/**
 * Walks the remaining states with an empty manifest: this action publishes
 * nothing of its own, so there is nothing to freeze, nothing to write, and
 * every (zero) child is terminal.
 */
async function completeReviewCommandAction(
  item: { readonly event: ReviewActivityEvent; readonly identity: { actionId: string; identityDigest: string } },
  options: { readonly store: ConversationStateStore; readonly now: () => string },
): Promise<void> {
  await options.store.transact((tx) => {
    for (const state of ["manifest-ready", "published", "completed"] as const) {
      tx.appendEvent(pollActionEvent(item.identity, item.event.reviewNumber,
        options.store.repositoryBinding, state, options.now()));
    }
  });
}

function pollActionEvent(
  identity: { actionId: string; identityDigest: string },
  reviewNumber: number,
  repository: RepositoryBinding,
  state: "manifest-ready" | "published" | "completed",
  at: string,
): ConversationEventEntry {
  return {
    version: 1,
    repository,
    actionId: identity.actionId,
    state,
    at,
    successorActionId: null,
    manifest: [],
    identityDigest: identity.identityDigest,
    reviewNumber,
  };
}

async function planConversationReply(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult };
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<
  | { readonly status: "ready"; readonly plan: ReplyPlan }
  | { readonly status: "transient" }
> {
  const { item, reviewIdentity, options } = input;
  if (item.parsed.kind === "invalid") return { status: "ready", plan: { kind: "usage" } };
  // Memory commands need no marked thread, no rules, and no model: they are
  // deterministic local operations valid in any comment on the review. They are
  // resolved before the model-backed gate below, which only admits the two
  // commands that reason about a finding.
  const memory = await planMemoryCommand(item, options);
  if (memory !== undefined) return { status: "ready", plan: memory };
  if (item.parsed.kind !== "command" || !isExecutableConversationCommand(item.parsed.command)) {
    return { status: "ready", plan: { kind: "usage" } };
  }

  let thread: ReviewThreadSnapshot | undefined;
  if (item.event.threadId !== undefined) {
    try {
      thread = await options.adapter.getReviewThread(reviewIdentity, item.event.threadId);
    } catch (error) {
      console.warn(`tgd-review-agent: could not load addressed thread (${redactedMessage(error)})`);
      return { status: "transient" };
    }
  }
  const snapshot = await options.store.readContextSnapshot();
  const publicDigest = computeRepositoryDigest(options.config.repository.provider, options.config.repository.canonicalUrl);
  const resolution = resolveMarkedFindingThread({
    event: item.event,
    thread,
    findings: snapshot.findings,
    repository: options.store.repositoryBinding,
    markerRepositoryDigest: publicDigest,
  });
  if (resolution.status === "scope-error") return { status: "ready", plan: { kind: "scope" } };
  if (resolution.status === "unsupported-history") return { status: "ready", plan: { kind: "history" } };

  const metadata = await loadReviewMetadata(item.event.reviewNumber, options);
  if (metadata === undefined) return { status: "transient" };
  const rules = await loadActiveRules(item.event.reviewNumber, metadata, options);
  if (rules.error !== undefined) {
    console.warn(`tgd-review-agent: conversation rule loading failed (${rules.error.message})`);
    return { status: "transient" };
  }
  const currentRule = rules.rules.find((rule) => rule.name === resolution.ledger.finding.ruleName);
  if (currentRule === undefined) {
    return { status: "ready", plan: { kind: "inactive", ruleName: resolution.ledger.finding.ruleName } };
  }

  const model = options.config.model ?? resolution.ledger.reviewOptions.model;
  if (model === undefined) {
    console.warn("tgd-review-agent: conversation model is not configured");
    return { status: "transient" };
  }
  const command = item.parsed.command;
  const runModel = async (headSha: string, diff: string): Promise<ReplyPlan | "transient"> => {
    const actionInput = {
      ledger: resolution.ledger,
      currentRule,
      currentCodeHunk: extractFileHunk(diff, resolution.ledger.finding.file),
      model,
      createSession: options.deps.createSession,
    };
    if (command.kind === "explain") {
      const result = await explainFinding(actionInput);
      if (result.status === "transient-error") return "transient";
      if (result.status === "unsupported-history") return { kind: "history" };
      if (result.status === "inactive-rule") return { kind: "inactive", ruleName: result.ruleName };
      return { kind: "explain", explanation: result.result.explanation, headSha };
    }
    const result = await reconsiderFinding({
      ...actionInput,
      addressedThread: formatAddressedThread(thread),
      reason: command.reason,
    });
    if (result.status === "transient-error") return "transient";
    if (result.status === "unsupported-history") return { kind: "history" };
    if (result.status === "inactive-rule") return { kind: "inactive", ruleName: result.ruleName };
    return {
      kind: "reconsider",
      outcome: result.result.outcome,
      rationale: result.result.rationale,
      headSha,
    };
  };

  const planned = await runModel(metadata.headSha, metadata.diff);
  if (planned === "transient") return { status: "transient" };
  return { status: "ready", plan: planned };
}

/**
 * Returns undefined for any non-memory command so the caller falls through to
 * the finding-thread path. The plan carries both the reply to render and the
 * exact ledger entry to apply; publication applies it under the lock.
 */
/** Deterministic local commands: no marked thread, no trusted rules, no model. */
function isMemoryCommand(command: ConversationCommand): command is
  | { readonly kind: "memories" }
  | { readonly kind: "remember"; readonly lesson: string }
  | { readonly kind: "forget"; readonly memoryId: string } {
  return command.kind === "memories" || command.kind === "remember" || command.kind === "forget";
}

async function planMemoryCommand(
  item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult },
  options: { readonly store: ConversationStateStore; readonly now: () => string },
): Promise<ReplyPlan | undefined> {
  if (item.parsed.kind !== "command" || !isMemoryCommand(item.parsed.command)) return undefined;
  const command = item.parsed.command;

  const snapshot = await options.store.readContextSnapshot();
  if (command.kind === "memories") {
    return { kind: "memory", reply: { kind: "list", items: listMemories(snapshot.memoryLedger) } };
  }

  const binding = options.store.repositoryBinding;
  const actionId = identityFor(item.event, item.parsed).actionId;
  const at = options.now();
  if (command.kind === "remember") {
    const plan = planRemember({
      binding,
      actionId,
      lesson: command.lesson,
      attribution: item.event.authorLogin ?? "unknown",
      source: item.event.url,
      at,
      activeMemories: snapshot.memories,
    });
    if (plan.kind === "at-capacity") {
      return { kind: "memory", reply: { kind: "at-capacity", limit: plan.limit } };
    }
    return {
      kind: "memory",
      reply: { kind: "remembered", publicId: encodeMemoryPublicId(plan.entry.id) },
      operation: plan.kind === "created" ? plan.entry : undefined,
    };
  }

  const plan = planForget({
    binding,
    actionId,
    publicId: command.memoryId,
    at,
    ledger: snapshot.memoryLedger,
  });
  if (plan.kind === "not-found") return { kind: "memory", reply: { kind: "not-found" } };
  return {
    kind: "memory",
    reply: { kind: "forgotten", publicId: encodeMemoryPublicId(plan.entry.id) },
    operation: plan.kind === "tombstoned" ? plan.entry : undefined,
  };
}

async function publishReplyPlan(input: {
  readonly event: ReviewActivityEvent;
  readonly identity: { actionId: string; identityDigest: string };
  readonly plan: ReplyPlan;
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<"completed" | "transient" | "stale"> {
  const plan = input.plan;
  let identity = input.identity;
  for (let attempt = 0; attempt <= MAX_STALE_HEAD_RETRIES; attempt += 1) {
    const latest = await resolveLatestAction(input.options.store, identity);
    if (latest?.state === "completed") return "completed";
    const actionIdentity = latest === undefined ? identity : { actionId: latest.actionId, identityDigest: latest.identityDigest };
    const memoryOperation = plan.kind === "memory" ? plan.operation : undefined;
    const capturedHead = plan.kind === "explain" || plan.kind === "reconsider" ||
      (plan.kind === "clarification" && plan.outcome !== "stale")
      ? plan.headSha
      : undefined;
    if (capturedHead !== undefined) {
      const metadata = await loadReviewMetadata(input.event.reviewNumber, input.options);
      if (metadata !== undefined && metadata.headSha.toLowerCase() !== capturedHead.toLowerCase()) {
        const current = latest ?? await resolveLatestAction(input.options.store, identity);
        if (current !== undefined && current.state === "prepared") {
          const successor = conversationSuccessorIdentity(actionFromEvent(current), metadata.headSha);
          const pair = supersedeWithSuccessor(actionFromEvent(current), successor);
          await input.options.store.transact((tx) => {
            tx.appendEvent(eventFromAction(pair.superseded, input.options.now()));
            tx.appendEvent(eventFromAction(observePublication(pair.successor), input.options.now()));
            tx.appendEvent(eventFromAction(pair.successor, input.options.now()));
          });
        }
        return "stale";
      }
    }
    const child = buildReplyChild({
      event: input.event,
      actionId: actionIdentity.actionId,
      reviewNumber: input.event.reviewNumber,
      repository: input.options.store.repositoryBinding,
      publicDigest: computeRepositoryDigest(
        input.options.config.repository.provider,
        input.options.config.repository.canonicalUrl,
      ),
      plan,
      renderBinding: {
        provider: input.options.config.repository.provider,
        repository: input.options.config.repository,
        reviewNumber: input.event.reviewNumber,
      },
    });
    const action: PublicationAction = {
      actionId: actionIdentity.actionId,
      identityDigest: actionIdentity.identityDigest,
      reviewNumber: input.event.reviewNumber,
      repository: input.options.store.repositoryBinding,
      state: latest?.state === "manifest-ready" || latest?.state === "published" ? latest.state : "prepared",
      successorActionId: null,
      children: latest !== undefined && latest.manifest.length > 0 ? latest.manifest : [child],
    };
    try {
      const published = await executePublication({
        store: input.options.store,
        action,
        writer: conversationWriter(input.options.adapter, input.reviewIdentity, input.event),
        now: input.options.now,
        hooks: {
          beforeFreeze: capturedHead === undefined && memoryOperation === undefined
            ? undefined
            : async (session, current) => {
            // `remember`/`forget` must land locally BEFORE the acknowledgement is
            // frozen, so a crash between the two leaves a memory whose reply is
            // still owed rather than a reply for a memory that was never stored.
            // The entry is deterministic in the action identity, so re-applying
            // on retry is a no-op rather than a second write.
            if (memoryOperation !== undefined) {
              const applied = session.snapshot().memoryLedger.some((entry) =>
                entry.operation === memoryOperation.operation && entry.id === memoryOperation.id);
              if (!applied) await session.commit((tx) => { tx.appendMemory(memoryOperation); });
            }
            if (capturedHead === undefined) return;
            const metadata = await loadReviewMetadata(input.event.reviewNumber, input.options);
            if (metadata === undefined) throw Object.assign(new Error("review metadata unavailable"), { transient: true });
            if (metadata.headSha.toLowerCase() === capturedHead.toLowerCase()) return;
            const successor = conversationSuccessorIdentity(current, metadata.headSha);
            const pair = supersedeWithSuccessor(current, successor);
            await session.commit((tx) => {
              tx.appendEvent(eventFromAction(pair.superseded, input.options.now()));
              tx.appendEvent(eventFromAction(observePublication(pair.successor), input.options.now()));
              tx.appendEvent(eventFromAction(pair.successor, input.options.now()));
            });
            throw Object.assign(new Error("stale-head"), {
              staleHead: true,
              successor,
              headSha: metadata.headSha,
            });
          },
        },
      });
      if (published.state === "completed") return "completed";
      if (published.state === "superseded") {
        identity = { actionId: published.successorActionId ?? identity.actionId, identityDigest: identity.identityDigest };
        continue;
      }
      return "transient";
    } catch (error) {
      const stale = error as { staleHead?: boolean; successor?: { actionId: string; identityDigest: string }; headSha?: string; transient?: boolean };
      if (stale.transient === true) return "transient";
      if (stale.staleHead === true && stale.successor !== undefined) {
        return "stale";
      }
      console.warn(`tgd-review-agent: conversation reply failed (${redactedMessage(error)})`);
      return "transient";
    }
  }
  return "stale";
}

async function publishPreparedReply(input: {
  readonly event: ReviewActivityEvent;
  readonly identity: { actionId: string; identityDigest: string };
  readonly latest: ConversationEventEntry;
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
  };
}): Promise<"completed" | "transient"> {
  try {
    const published = await executePublication({
      store: input.options.store,
      action: actionFromEvent(input.latest),
      writer: conversationWriter(input.options.adapter, input.reviewIdentity, input.event),
      now: input.options.now,
    });
    return published.state === "completed" ? "completed" : "transient";
  } catch (error) {
    console.warn(`tgd-review-agent: conversation reply recovery failed (${redactedMessage(error)})`);
    return "transient";
  }
}

function conversationWriter(
  adapter: ConversationAdapter,
  reviewIdentity: ReturnType<typeof reviewIdentityFrom>,
  event: ReviewActivityEvent,
): PublicationWriter {
  return {
    async lookupChild(child) {
      const parsed = parseChildMarker((child.body.split(/\r?\n/u).at(-1) ?? "").trim())
        ?? parseChildMarker(child.marker);
      if (parsed === null) return null;
      return adapter.findBotChildMarker(reviewIdentity, {
        provider: reviewIdentity.provider,
        repositoryDigest: parsed.repositoryDigest,
        reviewNumber: parsed.reviewNumber,
        kind: parsed.kind,
        parentId: parsed.parentId,
        childId: parsed.childId,
        contentDigest: parsed.contentDigest,
      });
    },
    async writeChild(child) {
      const input = {
        provider: reviewIdentity.provider,
        repositoryDigest: reviewIdentity.repositoryDigest,
        reviewNumber: reviewIdentity.reviewNumber,
        body: child.body,
      };
      if (child.placement.kind === "group-reply" && child.placement.threadId !== undefined) {
        const identity = await adapter.postThreadReply(reviewIdentity, {
          ...input,
          threadId: child.placement.threadId,
          ...(event.commentId === undefined ? {} : { parentCommentId: event.commentId }),
        });
        return { status: "posted", identity };
      }
      const identity = await adapter.postGeneralReply(reviewIdentity, input);
      return { status: "posted", identity };
    },
  };
}

function buildReplyChild(input: {
  readonly event: ReviewActivityEvent;
  readonly actionId: string;
  readonly reviewNumber: number;
  readonly repository: RepositoryBinding;
  readonly publicDigest: string;
  readonly plan: ReplyPlan;
  readonly renderBinding: {
    readonly provider: "github" | "gitlab";
    readonly repository: ResolvedPollConfig["repository"];
    readonly reviewNumber: number;
  };
}) {
  const childHex = createHash("sha256").update(`tgd:conversation-reply:v1\0${input.actionId}`, "utf8").digest("hex").slice(0, 32);
  const childId = `output_${childHex}`;
  const markerChildId = `out_${childHex}`;
  const parentId = `act_${input.actionId.slice("action_".length)}`;
  const render = (marker: string): RenderedConversationBody => {
    if (input.plan.kind === "usage") return renderUsageReply(marker);
    if (input.plan.kind === "memory") return renderMemoryReply(input.plan.reply, marker);
    if (input.plan.kind === "scope") return renderScopeErrorReply(marker);
    if (input.plan.kind === "history") return renderUnsupportedHistoryReply(marker);
    if (input.plan.kind === "inactive") return renderInactiveRuleReply({ ruleName: input.plan.ruleName }, marker);
    if (input.plan.kind === "explain") {
      return renderExplainReply({ explanation: input.plan.explanation }, marker, input.renderBinding);
    }
    if (input.plan.kind === "clarification") {
      return renderClarificationReply({
        outcome: input.plan.outcome,
        rationale: input.plan.rationale,
        question: input.plan.question,
        answer: input.plan.answer,
      }, marker, input.renderBinding);
    }
    return renderReconsiderReply({
      outcome: input.plan.outcome,
      rationale: input.plan.rationale,
    }, marker, input.renderBinding);
  };
  const provisional = formatChildMarker({
    kind: "action",
    parentId,
    childId: markerChildId,
    repositoryDigest: input.publicDigest,
    reviewNumber: input.reviewNumber,
    contentDigest: "0".repeat(64),
  });
  const first = publicationBody(render(provisional));
  const suffix = childMarkerSuffix(provisional);
  const visible = first.endsWith(suffix) ? first.slice(0, -suffix.length) : first;
  const marker = formatChildMarker({
    kind: "action",
    parentId,
    childId: markerChildId,
    repositoryDigest: input.publicDigest,
    reviewNumber: input.reviewNumber,
    contentDigest: computeContentDigest(visible),
  });
  return createConversationPublicationChild({
    id: childId,
    kind: "group-reply",
    placement: input.event.threadId === undefined
      ? { kind: "group-reply" }
      : { kind: "group-reply", threadId: input.event.threadId },
    body: render(marker),
    marker: `<!-- tgd-conversation:${input.actionId}:${childId} -->`,
  });
}

async function loadReviewMetadata(
  reviewNumber: number,
  options: { readonly config: ResolvedPollConfig; readonly deps: PollDependencies },
): Promise<PollReviewMetadata | undefined> {
  try {
    if (options.deps.getReviewMetadata !== undefined) return await options.deps.getReviewMetadata(reviewNumber);
    const locator = { kind: "repository" as const, repo: options.config.repository, number: reviewNumber };
    const pr = await options.config.vcsAdapter.getPullRequest(locator);
    const diff = await options.config.vcsAdapter.getDiff(locator);
    return { headSha: pr.headSha, baseSha: pr.baseSha, diff };
  } catch (error) {
    console.warn(`tgd-review-agent: could not load review metadata (${redactedMessage(error)})`);
    return undefined;
  }
}

function resolveSafeRuleFilePath(tempDir: string, filePath: string): string | null {
  const dest = path.resolve(tempDir, filePath);
  const relative = path.relative(tempDir, dest);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return dest;
}

async function loadTrustedBaseRules(
  reviewNumber: number,
  metadata: PollReviewMetadata,
  options: { readonly config: ResolvedPollConfig },
): Promise<{ readonly rules: readonly RuleDefinition[] }> {
  const includeBuiltin = !options.config.disableBuiltinRule;
  if (options.config.trustLocalRules) {
    const loaded = await loadRules(options.config.rulesDir, includeBuiltin);
    return { rules: loaded.rules };
  }
  if (metadata.baseSha === undefined || metadata.baseSha.length === 0) {
    throw new Error("conversation rule loading requires the review base SHA");
  }
  const locator = { kind: "repository" as const, repo: options.config.repository, number: reviewNumber };
  const ruleFiles = await options.config.vcsAdapter.getRuleFilesFromBase(
    locator,
    metadata.baseSha,
    options.config.rulesDir,
  );
  const tempRulesDir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-rules-"));
  try {
    await Promise.all(ruleFiles.map(async (file) => {
      const dest = resolveSafeRuleFilePath(tempRulesDir, file.path);
      if (dest === null) {
        console.warn(
          `tgd-review-agent: skipping rule file with unsafe path "${file.path}" (resolves outside the rules directory)`,
        );
        return;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, file.content, "utf-8");
    }));
    const loaded = await loadRules(tempRulesDir, includeBuiltin);
    return { rules: loaded.rules };
  } finally {
    await rm(tempRulesDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(
        `tgd-review-agent: failed to remove temp rules directory ${tempRulesDir} (${redactedMessage(err)})`,
      );
    });
  }
}

async function loadActiveRules(
  reviewNumber: number,
  metadata: PollReviewMetadata,
  options: { readonly config: ResolvedPollConfig; readonly deps: PollDependencies },
): Promise<{ readonly rules: readonly RuleDefinition[]; readonly error?: Error }> {
  try {
    if (options.deps.loadConversationRules !== undefined) {
      return await options.deps.loadConversationRules({
        reviewNumber,
        headSha: metadata.headSha,
        baseSha: metadata.baseSha,
      });
    }
    return await loadTrustedBaseRules(reviewNumber, metadata, options);
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function normalizedDiffHeaderPath(line: string): string | undefined {
  const raw = line.slice(4).trim();
  if (raw === "/dev/null") return undefined;
  let decoded = raw;
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "string") return undefined;
      decoded = parsed;
    } catch {
      return undefined;
    }
  }
  return decoded.startsWith("a/") || decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}

export function extractFileHunk(diff: string, file: string): string {
  if (file.length === 0) return diff;
  const sections = diff.split(/\n(?=diff --git )/u);
  for (const section of sections) {
    const lines = section.split("\n");
    const oldPath = lines.find((line) => line.startsWith("--- "));
    const newPath = lines.find((line) => line.startsWith("+++ "));
    if (
      (oldPath !== undefined && normalizedDiffHeaderPath(oldPath) === file) ||
      (newPath !== undefined && normalizedDiffHeaderPath(newPath) === file)
    ) {
      return section;
    }
  }
  return diff;
}

async function finalizeClarificationIfAnswered(
  event: ReviewActivityEvent,
  store: ConversationStateStore,
): Promise<void> {
  const snapshot = await store.readContextSnapshot();
  const current = snapshot.pending.clarifications.find((entry) =>
    entry.reviewNumber === event.reviewNumber &&
    clarificationLifecycleState(entry) === "answer-observed" &&
    entry.answerEventId === event.eventId);
  if (current === undefined) return;
  await store.transact((tx) => {
    tx.replacePending(replacePendingClarification(tx.snapshot.pending, transitionClarification(current, "terminal", {
      terminalOutcome: current.terminalOutcome ?? "confirmed",
    })));
  });
}

async function recoverPreparedClarificationQuestions(options: {
  readonly adapter: ConversationAdapter;
  readonly binding: RepositoryBinding;
  readonly store: ConversationStateStore;
  readonly now: () => string;
  readonly config: ResolvedPollConfig;
}): Promise<void> {
  const snapshot = await options.store.readContextSnapshot();
  const publicDigest = computeRepositoryDigest(options.config.repository.provider, options.config.repository.canonicalUrl);
  for (const pending of snapshot.pending.clarifications) {
    const state = clarificationLifecycleState(pending);
    if (state === "terminal" || state === "answer-observed") continue;
    if (state === "published" && pending.identity !== undefined) continue;
    const review = snapshot.cursor.reviews.find((entry) => entry.reviewNumber === pending.reviewNumber && !entry.retired);
    if (review === undefined) continue;
    const progress = decodeReviewProgress(review.cursor);
    if (progress === null) continue;
    const identity = reviewIdentityFrom(options.binding, pending.reviewNumber, progress);
    await publishClarificationQuestion({
      store: options.store,
      pending,
      repository: options.store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: clarificationQuestionWriter({ adapter: options.adapter, reviewIdentity: identity }),
      now: options.now,
    });
  }
}

async function maybeExecuteClarification(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult; readonly identity: { actionId: string; identityDigest: string } };
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
  readonly latest: ConversationEventEntry | undefined;
}): Promise<"completed" | "transient" | "stale" | undefined> {
  const snapshot = await input.options.store.readContextSnapshot();
  const pending = snapshot.pending.clarifications.filter((entry) => entry.reviewNumber === input.item.event.reviewNumber);
  const answerCommand = input.item.parsed.kind === "command" && input.item.parsed.command.kind === "answer";
  if (pending.length === 0 && !answerCommand) return undefined;

  let thread: ReviewThreadSnapshot | undefined;
  if (input.item.event.threadId !== undefined) {
    try {
      thread = await input.options.adapter.getReviewThread(input.reviewIdentity, input.item.event.threadId);
    } catch (error) {
      if (answerCommand || mayBeClarificationAnswer({ event: input.item.event, pending })) {
        console.warn(`tgd-review-agent: could not load clarification thread (${redactedMessage(error)})`);
        return "transient";
      }
    }
  }
  const metadata = await loadReviewMetadata(input.item.event.reviewNumber, input.options);
  const publicDigest = computeRepositoryDigest(
    input.options.config.repository.provider,
    input.options.config.repository.canonicalUrl,
  );
  const association = associateClarificationEvent({
    event: input.item.event,
    pending,
    thread,
    repositoryDigest: publicDigest,
    reviewNumber: input.item.event.reviewNumber,
    headSha: metadata?.headSha ?? input.item.event.repositoryDigest.slice(0, 40),
    mentioned: input.item.parsed.kind === "command",
  });
  if (association.kind === "ignore") {
    const preparedAsAnswer = input.latest?.state === "prepared" && (
      answerCommand || mayBeClarificationAnswer({ event: input.item.event, pending })
    );
    if (preparedAsAnswer) return completeEmptyPrepared(input);
    return undefined;
  }
  return executeClarificationAnswer({
    item: input.item,
    reviewIdentity: input.reviewIdentity,
    options: input.options,
    association,
    metadata,
  });
}

async function completeEmptyPrepared(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly identity: { actionId: string; identityDigest: string } };
  readonly options: { readonly store: ConversationStateStore; readonly now: () => string };
  readonly latest: ConversationEventEntry | undefined;
}): Promise<"completed" | "transient"> {
  const identity = input.latest === undefined
    ? input.item.identity
    : { actionId: input.latest.actionId, identityDigest: input.latest.identityDigest };
  try {
    const published = await executePublication({
      store: input.options.store,
      action: {
        actionId: identity.actionId,
        identityDigest: identity.identityDigest,
        reviewNumber: input.item.event.reviewNumber,
        repository: input.options.store.repositoryBinding,
        state: "prepared",
        successorActionId: null,
        children: [],
      },
      writer: {
        lookupChild: async () => null,
        writeChild: async () => ({ status: "posted" }),
      },
      now: input.options.now,
    });
    return published.state === "completed" ? "completed" : "transient";
  } catch (error) {
    console.warn(`tgd-review-agent: could not close ignored clarification event (${redactedMessage(error)})`);
    return "transient";
  }
}

async function executeClarificationAnswer(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult; readonly identity: { actionId: string; identityDigest: string } };
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
  readonly association: Exclude<ReturnType<typeof associateClarificationEvent>, { kind: "ignore" }>;
  readonly metadata: PollReviewMetadata | undefined;
}): Promise<"completed" | "transient" | "stale"> {
  const pending = input.association.pending;
  const observed = clarificationLifecycleState(pending) === "published"
    ? transitionClarification(pending, "answer-observed", {
        answerIdentity: input.association.answerIdentity,
        answerText: input.association.answerText,
        answerEventId: input.item.event.eventId,
      })
    : pending;
  if (clarificationLifecycleState(pending) === "published") {
    await input.options.store.transact((tx) => {
      tx.replacePending(replacePendingClarification(tx.snapshot.pending, observed));
    });
  }

  let plan: Extract<ReplyPlan, { kind: "clarification" }>;
  if (input.association.kind === "stale") {
    plan = {
      kind: "clarification",
      outcome: "stale",
      rationale: "This question applied to an earlier review head and will not be turned into a current finding.",
      question: pending.question,
      answer: input.association.answerText,
      headSha: input.metadata?.headSha ?? pending.headSha,
    };
  } else {
    if (input.metadata === undefined) return "transient";
    const rules = await loadActiveRules(input.item.event.reviewNumber, input.metadata, input.options);
    if (rules.error !== undefined) {
      console.warn(`tgd-review-agent: conversation rule loading failed (${rules.error.message})`);
      return "transient";
    }
    const ruleName = observed.finding?.ruleName ?? observed.ruleName;
    const currentRule = rules.rules.find((rule) => rule.name === ruleName);
    const sessionLedger = observed.finding === undefined ? undefined : prepareFindingLedgerEntry({
      repository: input.options.store.repositoryBinding,
      id: `finding_${createHash("sha256").update(`tgd:clarification-finding:v1\0${observed.id}`, "utf8").digest("hex").slice(0, 32)}`,
      reviewNumber: observed.reviewNumber,
      reviewId: input.reviewIdentity.reviewId,
      baseSha: input.metadata.baseSha ?? "0".repeat(40),
      headSha: observed.headSha,
      finding: observed.finding,
      ruleSnapshot: observed.ruleSnapshot ?? currentRule?.body ?? ruleName ?? observed.question,
      reviewOptions: {
        advisor: input.options.config.advisor,
        suggestions: input.options.config.suggestions,
        disableBuiltinRule: input.options.config.disableBuiltinRule,
        trustLocalRules: input.options.config.trustLocalRules,
        rulesDir: input.options.config.rulesDir,
        dispatch: input.options.config.dispatch,
        ...(input.options.config.model === undefined ? {} : { model: input.options.config.model }),
      },
      placement: {
        file: observed.finding.file,
        outdated: false,
        ...(observed.finding.line === undefined ? {} : { line: observed.finding.line, side: "new" }),
        originalHeadSha: observed.headSha,
        currentHeadSha: observed.headSha,
      },
      body: observed.question,
      at: observed.createdAt,
    });
    const model = input.options.config.model ?? currentRule?.model;
    if (model === undefined) {
      console.warn("tgd-review-agent: conversation model is not configured");
      return "transient";
    }
    const result = await reassessClarification({
      ledger: sessionLedger,
      currentRule,
      currentCodeHunk: extractFileHunk(input.metadata.diff, observed.finding?.file ?? ""),
      model,
      createSession: input.options.deps.createSession,
      originalQuestion: observed.question,
      selectedAnswer: input.association.answerText,
      currentDiffPosition: observed.finding === undefined ? undefined : {
        file: observed.finding.file,
        ...(observed.finding.line === undefined ? {} : { line: observed.finding.line }),
      },
    });
    if (result.status === "transient-error") return "transient";
    if (result.status === "unsupported-history") {
      plan = { kind: "clarification", outcome: "withdrawn", rationale: "The original finding is no longer available.", question: observed.question, answer: input.association.answerText, headSha: input.metadata.headSha };
    } else if (result.status === "inactive-rule") {
      plan = { kind: "clarification", outcome: "withdrawn", rationale: `The trusted rule ${result.ruleName} is no longer active.`, question: observed.question, answer: input.association.answerText, headSha: input.metadata.headSha };
    } else {
      plan = {
        kind: "clarification",
        outcome: result.result.outcome,
        rationale: result.result.rationale,
        question: observed.question,
        answer: input.association.answerText,
        headSha: input.metadata.headSha,
      };
      if (result.result.outcome === "confirmed" || result.result.outcome === "revised") {
        if (!("finding" in result.result) || result.result.finding === undefined) return "transient";
        try {
          const publishedFinding = await publishConfirmedClarificationFinding({
            store: input.options.store,
            finding: result.result.finding,
            rules: rules.rules,
            reviewOptions: {
              advisor: input.options.config.advisor,
              suggestions: input.options.config.suggestions,
              disableBuiltinRule: input.options.config.disableBuiltinRule,
              trustLocalRules: input.options.config.trustLocalRules,
              rulesDir: input.options.config.rulesDir,
              dispatch: input.options.config.dispatch,
              ...(input.options.config.model === undefined ? {} : { model: input.options.config.model }),
            },
            publicationIdentity: clarificationFindingPublicationIdentity({
              repository: input.options.store.repositoryBinding,
              reviewNumber: observed.reviewNumber,
              clarificationId: observed.id,
              answerEventId: input.item.event.eventId,
              headSha: input.metadata.headSha,
            }),
            reviewIdentity: input.reviewIdentity,
            context: {
              vcsAdapter: input.options.config.vcsAdapter,
              locator: {
                kind: "repository",
                repo: input.options.config.repository,
                number: input.item.event.reviewNumber,
              },
              provider: input.options.config.repository.provider,
              repository: input.options.config.repository,
            },
            pr: {
              id: String(input.item.event.reviewNumber),
              reviewId: input.reviewIdentity.reviewId,
              headSha: input.metadata.headSha,
              baseSha: input.metadata.baseSha ?? "0".repeat(40),
              title: "",
              description: "",
              url: input.reviewIdentity.url,
            },
            diff: input.metadata.diff,
            now: input.options.now,
            hooks: input.options.deps.publicationHooks,
          });
          if (publishedFinding !== 0) return "transient";
        } catch (error) {
          console.warn(`tgd-review-agent: could not publish clarified finding (${redactedMessage(error)})`);
          return "transient";
        }
      }
    }
  }

  const published = await publishReplyPlan({
    event: input.item.event,
    identity: input.item.identity,
    plan,
    reviewIdentity: input.reviewIdentity,
    options: input.options,
  });
  if (published === "completed") {
    const current = (await input.options.store.readContextSnapshot()).pending.clarifications.find((entry) =>
      entry.id === observed.id) ?? observed;
    if (clarificationLifecycleState(current) === "answer-observed") {
      await input.options.store.transact((tx) => {
        tx.replacePending(replacePendingClarification(tx.snapshot.pending, transitionClarification(current, "terminal", {
          terminalOutcome: plan.outcome,
        })));
      });
    }
  }
  return published;
}

function formatAddressedThread(thread: ReviewThreadSnapshot | undefined): string {
  if (thread === undefined) return "";
  return thread.events
    .filter((event) => event.kind === "thread-comment" || event.kind === "comment-edit" || event.kind === "general-comment")
    .map((event) => `${event.authorLogin ?? "unknown"}: ${event.body}`)
    .join("\n");
}
