import { createHash } from "node:crypto";
import type { PollArgs } from "../cli-args.js";
import {
  conversationActionIdentity,
  conversationCommandKey,
  conversationSuccessorIdentity,
  explainFinding,
  isExecutableConversationCommand,
  reconsiderFinding,
  resolveMarkedFindingThread,
} from "../conversation/actions.js";
import { parseConversationCommand } from "../conversation/command-parser.js";
import {
  computeContentDigest,
  computeRepositoryDigest,
  formatChildMarker,
  parseChildMarker,
} from "../conversation/markers.js";
import {
  actionFromEvent,
  eventFromAction,
  executePublication,
  latestPublication,
  observePublication,
  supersedeWithSuccessor,
  type PublicationAction,
  type PublicationWriter,
} from "../conversation/publication-manifest.js";
import {
  createConversationPublicationChild,
  publicationBody,
  renderExplainReply,
  renderInactiveRuleReply,
  renderReconsiderReply,
  renderScopeErrorReply,
  renderUnsupportedHistoryReply,
  renderUsageReply,
  type RenderedConversationBody,
} from "../conversation/render.js";
import type { ConversationSessionFactory } from "../conversation/session.js";
import {
  createConversationStateStore,
  type ConversationStateStore,
} from "../conversation/state-store.js";
import type { ConversationEventEntry } from "../conversation/state-schema.js";
import type { BotIdentity, CommandParseResult, RepositoryBinding } from "../conversation/types.js";
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
      const pending = [];
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
            if (item.parsed.kind === "command" || item.parsed.kind === "invalid") {
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

      if (knownActionIds.has(item.identity.actionId) || item.parsed.kind === "irrelevant") {
        if (item.parsed.kind === "irrelevant") knownActionIds.add(item.identity.actionId);
        continue;
      }
      if (item.parsed.kind === "command" && !isExecutableConversationCommand(item.parsed.command)) {
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
  | { readonly kind: "scope" }
  | { readonly kind: "history" }
  | { readonly kind: "inactive"; readonly ruleName: string }
  | { readonly kind: "explain"; readonly explanation: string; readonly headSha: string }
  | {
      readonly kind: "reconsider";
      readonly outcome: "confirmed" | "revised" | "withdrawn";
      readonly rationale: string;
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
    return publishPreparedReply({
      event: item.event,
      identity,
      latest,
      reviewIdentity,
      options,
    });
  }

  const planned = await planConversationReply({ item, reviewIdentity, options });
  if (planned.status === "transient") return "transient";
  return publishReplyPlan({
    event: item.event,
    identity,
    plan: planned.plan,
    reviewIdentity,
    options,
    rerun: planned.rerun,
  });
}

async function planConversationReply(input: {
  readonly item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult };
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<
  | { readonly status: "ready"; readonly plan: ReplyPlan }
  | { readonly status: "transient" }
> {
  const { item, reviewIdentity, options } = input;
  if (item.parsed.kind === "invalid") return { status: "ready", plan: { kind: "usage" } };
  if (item.parsed.kind !== "command" || !isExecutableConversationCommand(item.parsed.command)) {
    return { status: "ready", plan: { kind: "usage" } };
  }

  let thread: ReviewThreadSnapshot | undefined;
  if (item.event.threadId !== undefined) {
    try {
      thread = await options.adapter.getReviewThread(reviewIdentity, item.event.threadId);
    } catch (error) {
      console.warn(`tgd-review-agent: could not load addressed thread (${(error as Error).message})`);
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
    const capturedHead = plan.kind === "explain" || plan.kind === "reconsider" ? plan.headSha : undefined;
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
          beforeFreeze: capturedHead === undefined ? undefined : async (session, current) => {
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
      console.warn(`tgd-review-agent: conversation reply failed (${(error as Error).message})`);
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
    console.warn(`tgd-review-agent: conversation reply recovery failed (${(error as Error).message})`);
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
    if (input.plan.kind === "scope") return renderScopeErrorReply(marker);
    if (input.plan.kind === "history") return renderUnsupportedHistoryReply(marker);
    if (input.plan.kind === "inactive") return renderInactiveRuleReply({ ruleName: input.plan.ruleName }, marker);
    if (input.plan.kind === "explain") {
      return renderExplainReply({ explanation: input.plan.explanation }, marker, input.renderBinding);
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
  const suffix = `\n\n${provisional}`;
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
    console.warn(`tgd-review-agent: could not load review metadata (${(error as Error).message})`);
    return undefined;
  }
}

async function loadActiveRules(
  reviewNumber: number,
  metadata: PollReviewMetadata,
  options: { readonly config: ResolvedPollConfig; readonly deps: PollDependencies },
): Promise<{ readonly rules: readonly RuleDefinition[]; readonly error?: Error }> {
  if (options.deps.loadConversationRules !== undefined) {
    return options.deps.loadConversationRules({
      reviewNumber,
      headSha: metadata.headSha,
      baseSha: metadata.baseSha,
    });
  }
  try {
    if (options.config.trustLocalRules) {
      const loaded = await loadRules(options.config.rulesDir, !options.config.disableBuiltinRule);
      return { rules: loaded.rules };
    }
    return { rules: [], error: new Error("conversation rule loading requires an injected loader or --trust-local-rules") };
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function extractFileHunk(diff: string, file: string): string {
  if (diff.includes(file)) return diff;
  return diff;
}

function formatAddressedThread(thread: ReviewThreadSnapshot | undefined): string {
  if (thread === undefined) return "";
  return thread.events
    .filter((event) => event.kind === "thread-comment" || event.kind === "comment-edit" || event.kind === "general-comment")
    .map((event) => `${event.authorLogin ?? "unknown"}: ${event.body}`)
    .join("\n");
}
