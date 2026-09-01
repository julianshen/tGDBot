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
  parseAnswerSyntax,
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
  toFindingSnapshot,
} from "../review/review-publication.js";
import {
  hasCheckableClaim,
  runStructuralChecks as runStructuralChecksReal,
} from "../review/structural-check.js";
import type { Finding } from "../review/types.js";
import { contextRoots, selectContextRoot } from "../context/root.js";
import { withPreparedWorkspace as withPreparedWorkspaceReal } from "../workspace/manager.js";
import {
  childMarkerSuffix,
  createConversationPublicationChild,
  publicationBody,
  renderClarificationReply,
  renderClarificationUnavailableReply,
  renderExplainReply,
  renderInactiveRuleReply,
  renderMemoryReply,
  renderReconsiderReply,
  renderVerificationReply,
  renderScopeErrorReply,
  renderUnsupportedHistoryReply,
  renderDispositionReply,
  renderUsageReply,
  type MemoryReply,
  type RenderedConversationBody,
} from "../conversation/render.js";
import type { ConversationSessionFactory } from "../conversation/session.js";
import {
  createConversationStateStore,
  replacePendingClarification,
  type ConversationStateStore,
  type ConversationStateTransaction,
} from "../conversation/state-store.js";
import {
  prepareFindingLedgerEntry,
  bindFindingLedgerIdentity,
  prepareFindingOutcome,
  type ConversationEventEntry,
  type FindingSnapshot,
  type MemoryEntry,
} from "../conversation/state-schema.js";
import type {
  BotIdentity,
  CommandParseResult,
  ConversationCommand,
  RepositoryBinding,
} from "../conversation/types.js";
import { observeResolvedThreads, pendingVerifications } from "../conversation/verification-queue.js";
import {
  originInsertAfterLines,
  originTouchedLines,
  removedLinesByFile,
  renameSourcesByHeadPath,
} from "../review/diff-anchors.js";
import { CompareNotDirectError } from "../vcs/adapter.js";
import type { PendingVerification } from "../conversation/verification-queue.js";
import { verifyFinding } from "../conversation/verification.js";
import { MAX_RESOLVED_THREADS } from "../conversation/state-schema.js";
import type {
  FindingLedgerEntry,
  FindingOutcomeEntry,
  FindingVerificationTrigger,
} from "../conversation/state-schema.js";
import { loadRules } from "../rules/loader.js";
import type { RuleDefinition } from "../rules/types.js";
import { CODEX_SECURITY_POLICY } from "../review/codex-security-results.js";
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
  /** Issue #79 seams, named as in cli.ts so both paths read the same. */
  readonly prepareStructuralWorkspace?: typeof withPreparedWorkspaceReal;
  readonly runStructuralChecks?: typeof runStructuralChecksReal;
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
  // ONE allowance for the whole poll, not one per page or per review. It was
  // passed fresh into every loop iteration, so a repository with several active
  // reviews could spend five model calls per iteration against a documented
  // ceiling of five per poll (PR #74 review).
  let verificationBudget = MAX_POLL_VERIFICATIONS;
  const pageTokens = new Map<number, ReviewEventPageToken>();
  const seenEventKeys = new Set<string>();
  // Reviews that deferred a verification this poll. `haltCursor` is per
  // ITERATION, so the next pass over the same review saw a page emptied by the
  // in-memory seen set, called it complete, and advanced the cursor straight
  // past the events it had just deferred (PR #74 review).
  const deferredReviews = new Set<number>();

  while (processed < MAX_POLL_EVENTS && idleTurns < active.length) {
    snapshot = options.dryRun ? snapshot : await options.store.readContextSnapshot();
    const currentActive = activeReviews(snapshot.cursor.reviews);
    if (currentActive.length === 0) return EXIT_OK;
    index = index % currentActive.length;
    const review = currentActive[index]!;
    if (deferredReviews.has(review.reviewNumber)) {
      idleTurns += 1;
      index = (index + 1) % currentActive.length;
      continue;
    }
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

    // BEFORE the page is recorded. The block below marks an ordinary comment
    // classified-and-ignored, which is terminal: an event left in place is an
    // event consumed, so a verification the budget cannot reach this poll must
    // be taken off the page rather than deferred in place (PR #74 review).
    // Everything here is a read, which is also what makes it dry-run safe.
    // The candidate superset, computed HERE rather than inside the queue. The
    // caller is what takes events off the page, so the caller must be able to
    // name them without the queue's help — a queue that throws (a failed
    // outcome read, say) otherwise returned "nothing owed" and the page
    // consumed the reply (PR #74 review).
    const boundThreads = new Set(snapshot.findings
      .filter((entry) => entry.reviewNumber === review.reviewNumber)
      .map((entry) => entry.identity?.threadId)
      .filter((threadId): threadId is string => threadId !== undefined));
    // COMMANDS ARE NOT CANDIDATES. An author who writes `explain` or
    // `reconsider` in a finding thread is asking for one specific answer, and
    // they get it on the command path — verifying on top of that is a second
    // reply to one request. It also removes a contradiction that lost work: the
    // event had to stay on the page for its command to run, which meant it
    // could not be held back for a verification, so a deferred one was silently
    // dropped (PR #74 review). Not being a candidate, it cannot be deferred.
    const candidateEvents = classified
      .filter((item) => item.parsed.kind === "irrelevant" &&
        item.event.kind !== "general-comment" && item.event.authorIsBot !== true &&
        item.event.threadId !== undefined && boundThreads.has(item.event.threadId))
      .map((item) => item.event);
    // Threads with NO bound finding are recovery candidates (issue #85): a
    // finding published before a crash bound its identity is matched by its
    // marker instead. Named here so the queue is entered even when no bound
    // candidate exists — otherwise the page would consume the reply before the
    // queue ever saw it — and held on a queue failure, same as candidates.
    const recoveryEvents = classified
      .filter((item) => item.parsed.kind === "irrelevant" &&
        item.event.kind !== "general-comment" && item.event.authorIsBot !== true &&
        item.event.threadId !== undefined && !boundThreads.has(item.event.threadId))
      .map((item) => item.event);
    const queued = candidateEvents.length === 0 && recoveryEvents.length === 0 && boundThreads.size === 0
      ? { items: [], deferred: false, deferredEvents: [], boundThreads } as VerificationQueue
      : await queueVerifications({
      events: classified.filter((item) => item.parsed.kind === "irrelevant"),
      reviewNumber: review.reviewNumber,
      reviewIdentity: identity,
      resolvedThreads: new Set(review.threadsResolved ?? []),
      headChangeScanSha: review.headChangeScanSha,
      budget: verificationBudget,
      options,
    }).catch((error: unknown) => {
      // Hold everything: which of these were really owed is exactly what the
      // failed call was going to tell us.
      console.warn(`tgd-review-agent: could not queue verifications (${redactedMessage(error)})`);
      return {
        items: [],
        deferred: true,
        boundThreads,
        deferredEvents: [...candidateEvents, ...recoveryEvents],
      } as VerificationQueue;
    });
    // Computed BEFORE retention, which takes triggering events off the page:
    // observing from what survives would never see the resolution that just
    // caused a verification, so the next poll would run it again.
    //
    // Persisted WITH the cursor further down, in the same transaction. Earlier
    // would suppress a verification whose reply had not published; later would
    // re-verify a thread already answered. Both are only safe when the events
    // and the observation advance together.
    const threadsResolved = [...observeResolvedThreads(
      new Set(review.threadsResolved ?? []),
      classified.map((item) => ({
        kind: item.event.kind,
        threadId: item.event.kind === "general-comment" ? undefined : item.event.threadId,
        authorIsBot: item.event.authorIsBot,
        resolved: item.event.kind === "thread-resolution" ? item.event.resolved : undefined,
      })),
      // The queue's set, not the one computed above: recovery binds orphaned
      // findings DURING the call, and a thread first seen that way would
      // otherwise be dropped from the record and re-read as a transition
      // later (PR #94 review).
      queued.boundThreads,
    ).resolved]
      // Last-observed at the end, now that the fold refreshes order.
      .slice(-MAX_RESOLVED_THREADS);

    // THE INVARIANT: an event taken off the page must either complete its
    // verification this poll or hold the cursor. Removal and the cursor
    // decision were independent, so a thread-read outage, a transient verdict,
    // or a candidate past the budget left the event neither answered nor
    // retried — the page had already consumed it (PR #74 review). Ids are
    // struck off below as each reply lands; whatever remains holds the cursor.
    const outstanding = new Set([...queued.items.map((item) => item.event), ...queued.deferredEvents]
      .map((event) => event.eventId));
    // The block below marks an ordinary comment classified-and-ignored, which is
    // terminal, so every named candidate comes OFF the page until its
    // verification completes. Left unmarked, a held cursor shows them again; on
    // success the recorded outcome keeps the second sighting from re-verifying.
    //
    // Only events with nothing else to do. A command in a finding thread can
    // trigger a verification too, and taking it off the page would drop the
    // command the author actually asked for.
    for (let at = classified.length - 1; at >= 0; at -= 1) {
      const item = classified[at]!;
      if (outstanding.has(item.event.eventId)) classified.splice(at, 1);
    }

    if (options.dryRun) {
      for (const item of queued.items) {
        console.log(
          `tgd-review-agent: would verify a finding on review #${review.reviewNumber} ` +
            `(${item.pending.trigger})`,
        );
      }
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
            const explicitAnswer = answerCommand || parseAnswerSyntax(item.event.body) !== undefined;
            if (item.parsed.kind === "command" || item.parsed.kind === "invalid" || explicitAnswer ||
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
      const maybeAnswer = parseAnswerSyntax(item.event.body) !== undefined ||
        mayBeClarificationAnswer({ event: item.event, pending: pendingForReview });
      if (knownActionIds.has(item.identity.actionId) || (item.parsed.kind === "irrelevant" && !maybeAnswer)) {
        if (item.parsed.kind === "irrelevant" && !maybeAnswer) knownActionIds.add(item.identity.actionId);
        continue;
      }
      if (item.parsed.kind === "command" && item.parsed.command.kind !== "answer" &&
        !isMemoryCommand(item.parsed.command) &&
        !isDispositionCommand(item.parsed.command) &&
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
        ...(botIdentity.login === undefined ? {} : { botLogin: botIdentity.login }),
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

    // #57: after the commands, the verifications this page's events call for.
    // Runs only when nothing halted — a transient failure means the page will
    // be seen again, and verifying now would spend model calls on work about to
    // be repeated.
    if (!options.dryRun && !haltTransient && !haltCursor) {
      for (const item of queued.items) {
        const latest = await resolveLatestAction(options.store, item.identity);
        if (latest !== undefined && (latest.state === "manifest-ready" || latest.state === "published" ||
          latest.state === "prepared")) {
          const recoveredAction = actionFromEvent(latest);
          const recoveredVerdict = recoveredAction.children.find((child) =>
            child.placement.kind === "group-reply")?.placement;
          const verificationVerdict = recoveredVerdict?.kind === "group-reply"
            ? recoveredVerdict.verificationVerdict
            : undefined;
          const recoveredMetadata = queued.context?.metadata;
          const recovered = await publishPreparedReply({
            event: item.event,
            identity: item.identity,
            latest,
            reviewIdentity: identity,
            options,
            ...(verificationVerdict !== undefined && recoveredMetadata !== undefined
              ? {
                  onComplete: (tx) => {
                    tx.appendOutcome(prepareFindingOutcome({
                      repository: options.store.repositoryBinding,
                      id: `outcome_${createHash("sha256")
                        .update(`${item.ledger.id}\0${recoveredMetadata.headSha}`, "utf8")
                        .digest("hex").slice(0, 32)}`,
                      findingId: item.ledger.id,
                      reviewNumber: item.ledger.reviewNumber,
                      headSha: recoveredMetadata.headSha,
                      ruleName: item.ledger.finding.ruleName,
                      category: item.ledger.finding.category,
                      severity: item.pending.severity,
                      ...(item.ledger.finding.effort === undefined
                        ? {}
                        : { effort: item.ledger.finding.effort }),
                      verdict: verificationVerdict,
                      trigger: item.pending.trigger,
                      anchorChanged: item.pending.trigger === "head-change",
                      at: options.now(),
                    }));
                  },
                }
              : {}),
          });
          if (recovered === "transient") { haltTransient = true; haltCursor = true; break; }
          if (recovered === "stale") { haltCursor = true; break; }
          knownActionIds.add(item.identity.actionId);
          outstanding.delete(item.event.eventId);
          continue;
        }
        const verification = queued.context === undefined
          ? ({ kind: "transient" } as const)
          : await verifyQueued({ item, context: queued.context, reviewNumber: review.reviewNumber, options });
        // A model call was spent whether or not it produced a verdict, so the
        // budget is charged for the attempt.
        verificationBudget -= 1;
        if (verification.kind === "settled") {
          // Nothing more will ever come of it, so the event is SPENT — and
          // spending it has to be durable. Dropping it from the in-memory set
          // alone consumed nothing: another candidate holding the cursor meant
          // the next poll re-queued the same settled findings, which took the
          // whole budget every time and starved everything behind them
          // (PR #74 review). It was taken off the page, so the record the page
          // would have written has to be written here instead.
          console.log(
            `tgd-review-agent: no verification for a finding on review #${review.reviewNumber} ` +
              `(${verification.reason})`,
          );
          outstanding.delete(item.event.eventId);
          const spent = pageIdentities.find((entry) => entry.event.eventId === item.event.eventId);
          if (spent !== undefined && !knownActionIds.has(spent.identity.actionId)) {
            await options.store.transact((tx) => {
              appendObservation(tx, spent.identity, item.event.reviewNumber, options.now());
              appendClassifiedAndIgnored(tx, spent.identity, item.event.reviewNumber, options.now());
            });
            knownActionIds.add(spent.identity.actionId);
          }
          continue;
        }
        if (verification.kind === "transient") continue;
        const published = await publishReplyPlan({
          event: verification.event,
          identity: verification.identity,
          plan: verification.plan,
          ...(botIdentity.login === undefined ? {} : { botLogin: botIdentity.login }),
          ...(verification.parentCommentId === undefined
            ? {}
            : { parentCommentId: verification.parentCommentId }),
          reviewIdentity: identity,
          options,
        });
        if (published === "transient") { haltTransient = true; haltCursor = true; break; }
        if (published === "stale") { haltCursor = true; break; }
        knownActionIds.add(verification.identity.actionId);
        // Answered, and the outcome recorded with the completed action.
        outstanding.delete(verification.event.eventId);
      }
    }
    const deferredHold = outstanding.size > 0;
    if (deferredHold) deferredReviews.add(review.reviewNumber);

    const completedPage = !stoppedEarly && !haltCursor && !deferredHold;
    const listingComplete = page.nextPageToken === undefined;
    // `deferredHold` deliberately does NOT pin the key. Holding this review's
    // own event cursor is what keeps its deferred work; pinning the ROTATION as
    // well meant a continuously busy review took the whole poll-wide budget
    // first every time, and every later review starved (PR #74 review).
    const nextRoundRobinKey = stoppedEarly || haltCursor
      ? String(review.reviewNumber)
      : nextKey(currentActive, index);
    const advancedProgress = listingComplete && page.events.length > 0 && !haltCursor && !deferredHold
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
                      ...(threadsResolved.length === 0 ? {} : { threadsResolved }),
                      ...((queued.scannedHeadSha ?? entry.headChangeScanSha) === undefined
                        ? {}
                        : { headChangeScanSha: queued.scannedHeadSha ?? entry.headChangeScanSha }),
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
  | { readonly kind: "clarification-unavailable" }
  | {
      readonly kind: "memory";
      readonly reply: MemoryReply;
      /** Absent for a listing or a refusal: those change nothing locally. */
      readonly operation?: MemoryEntry;
    }
  | { readonly kind: "scope" }
  | {
      readonly kind: "disposition";
      readonly disposition: "accepted" | "deferred";
      readonly finding: FindingSnapshot;
      readonly outcome: FindingOutcomeEntry;
    }
  | { readonly kind: "history" }
  | { readonly kind: "inactive"; readonly ruleName: string }
  | { readonly kind: "explain"; readonly explanation: string; readonly headSha: string }
  | {
      readonly kind: "reconsider";
      readonly outcome: "confirmed" | "revised" | "withdrawn";
      readonly rationale: string;
      readonly headSha: string;
    }
  /**
   * An AUTOMATIC verification (#57).
   *
   * Carries the fields the reply is rendered FROM, not a rendered body: a
   * conversation body is branded so only a renderer can produce one, and
   * `buildReplyChild` owns the marker. The outcome record travels with the plan
   * but is appended in its own transaction after the reply is published, so a
   * crash between the two loses the record rather than the reply.
   */
  | {
      readonly kind: "verification";
      readonly verdict: "confirmed" | "revised" | "withdrawn";
      readonly trigger: FindingVerificationTrigger;
      readonly rationale: string;
      readonly outcome: FindingOutcomeEntry;
      readonly headSha: string;
      readonly resolveOwnThread: boolean;
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
  readonly botLogin?: string;
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
    ...(input.botLogin === undefined ? {} : { botLogin: input.botLogin }),
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
    // The operator's --context-mapper selection carries through to reviews
    // poll dispatches, exactly like every other review option (PR #116 review).
    contextMapper: config.contextMapper,
    vcs: config.vcs,
    repo: config.repo,
    rulesDir: config.rulesDir,
    disableBuiltinRule: config.disableBuiltinRule,
    advisor: config.advisor,
    // A polled review must run under the poll's own network setting, not a
    // different one (PR #54 review).
    dependencyFacts: config.dependencyFacts,
    structuralChecks: config.structuralChecks,
    prIntent: config.prIntent,
    suggestions: config.suggestions,
    dryRun: config.dryRun,
    trustLocalRules: config.trustLocalRules,
    dispatch: config.dispatch,
    context: config.context,
    allowDegradedContext: config.allowDegradedContext,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.maxDiffChars === undefined ? {} : { maxDiffChars: config.maxDiffChars }),
    ...(config.contextMaxChars === undefined ? {} : { contextMaxChars: config.contextMaxChars }),
    ...(config.contextDir === undefined ? {} : { contextDir: config.contextDir }),
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
    const currentHead = metadata.headSha.toLowerCase();
    const retainedDirections = pending.directions.filter((entry) =>
      entry.reviewNumber !== input.event.reviewNumber || entry.headSha === currentHead).slice(-999);
    tx.replacePending({
      ...pending,
      directions: [...retainedDirections, {
        id: directionId,
        reviewNumber: input.event.reviewNumber,
        headSha: currentHead,
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
  readonly item: {
    readonly event: ReviewActivityEvent;
    readonly parsed: CommandParseResult;
    readonly identity: { actionId: string };
  };
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
  const disposition = await planDispositionCommand(item, reviewIdentity, options);
  if (disposition !== undefined) {
    if (disposition.status === "transient") return { status: "transient" };
    return { status: "ready", plan: disposition.plan };
  }
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
  const importedScanFinding = resolution.ledger.reviewOptions.codexScanResults === true &&
    resolution.ledger.finding.ruleName === "codex-security";
  let currentRule: RuleDefinition | undefined;
  if (importedScanFinding) {
    currentRule = CODEX_SECURITY_POLICY;
  } else {
    const rules = await loadActiveRules(item.event.reviewNumber, metadata, options);
    if (rules.error !== undefined) {
      console.warn(`tgd-review-agent: conversation rule loading failed (${rules.error.message})`);
      return { status: "transient" };
    }
    currentRule = rules.rules.find((rule) => rule.name === resolution.ledger.finding.ruleName);
  }
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

function isDispositionCommand(command: ConversationCommand): command is
  | { readonly kind: "accept" }
  | { readonly kind: "defer" } {
  return command.kind === "accept" || command.kind === "defer";
}

async function planDispositionCommand(
  item: { readonly event: ReviewActivityEvent; readonly parsed: CommandParseResult; readonly identity: { actionId: string } },
  reviewIdentity: ReturnType<typeof reviewIdentityFrom>,
  options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  },
): Promise<
  | { readonly status: "ready"; readonly plan: ReplyPlan }
  | { readonly status: "transient" }
  | undefined
> {
  if (item.parsed.kind !== "command" || !isDispositionCommand(item.parsed.command)) return undefined;
  const command = item.parsed.command;

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

  const prior = (await options.store.readFindingOutcomes())
    .filter((entry) => entry.findingId === resolution.ledger.id)
    .at(-1);
  const disposition = command.kind === "accept" ? "accepted" as const : "deferred" as const;
  const outcome = prepareFindingOutcome({
    repository: options.store.repositoryBinding,
    id: `outcome_${createHash("sha256")
      .update(`disposition\0${item.identity.actionId}`, "utf8").digest("hex").slice(0, 32)}`,
    findingId: resolution.ledger.id,
    reviewNumber: resolution.ledger.reviewNumber,
    headSha: metadata.headSha,
    ruleName: resolution.ledger.finding.ruleName,
    category: resolution.ledger.finding.category,
    severity: resolution.ledger.finding.severity,
    ...(resolution.ledger.finding.effort === undefined ? {} : { effort: resolution.ledger.finding.effort }),
    verdict: prior?.verdict ?? "confirmed",
    trigger: "thread-comment",
    anchorChanged: false,
    at: options.now(),
    disposition,
    actor: item.event.authorLogin ?? "unknown",
    file: resolution.ledger.finding.file,
    ...(resolution.ledger.finding.line === undefined ? {} : { line: resolution.ledger.finding.line }),
  });
  return {
    status: "ready",
    plan: { kind: "disposition", disposition, finding: resolution.ledger.finding, outcome },
  };
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
  /**
   * The authenticated account, so a verification reply can name a mention that
   * actually works. Absent, `renderVerificationReply` drops the invitation
   * entirely — every confirmed verdict told the reader it stood and nothing
   * about how to disagree (PR #74 review).
   */
  readonly botLogin?: string;
  /** Used when the triggering event has no comment of its own — see the writer. */
  readonly parentCommentId?: string;
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
    const dispositionOutcome = plan.kind === "disposition" ? plan.outcome : undefined;
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
      ...(input.botLogin === undefined ? {} : { botLogin: input.botLogin }),
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
        writer: conversationWriter(input.options.adapter, input.reviewIdentity, input.event,
          input.parentCommentId),
        now: input.options.now,
        finalize: async (publishedAction) => {
          await resolveOwnThreadAfterReply({
            adapter: input.options.adapter,
            reviewIdentity: input.reviewIdentity,
            action: publishedAction,
          });
        },
        ...(plan.kind === "verification"
          ? { onComplete: (tx) => { tx.appendOutcome(plan.outcome); } }
          : {}),
        hooks: {
          beforeFreeze: capturedHead === undefined && memoryOperation === undefined
            && dispositionOutcome === undefined
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
            // Same contract for accept/defer: a completed action is recoverably
            // terminal, so the outcome has to already be in the sidecar before
            // that state is reachable (#86 review).
            if (dispositionOutcome !== undefined) {
              await session.commit((tx) => { tx.appendOutcome(dispositionOutcome); });
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
    readonly deps: PollDependencies;
  };
  readonly onComplete?: (tx: ConversationStateTransaction) => void;
}): Promise<"completed" | "transient" | "stale"> {
  try {
    const action = actionFromEvent(input.latest);
    const capturedHead = action.children.find((child) =>
      child.placement.kind === "group-reply" && child.placement.headSha !== undefined)
      ?.placement;
    if (capturedHead?.kind === "group-reply" && capturedHead.headSha !== undefined) {
      const metadata = await loadReviewMetadata(input.event.reviewNumber, input.options);
      if (metadata === undefined) return "transient";
      if (metadata.headSha.toLowerCase() !== capturedHead.headSha.toLowerCase()) {
        const successor = conversationSuccessorIdentity(action, metadata.headSha);
        const pair = supersedeWithSuccessor(action, successor);
        await input.options.store.transact((tx) => {
          tx.appendEvent(eventFromAction(pair.superseded, input.options.now()));
          tx.appendEvent(eventFromAction(observePublication(pair.successor), input.options.now()));
          tx.appendEvent(eventFromAction(pair.successor, input.options.now()));
        });
        return "stale";
      }
    }
    const published = await executePublication({
      store: input.options.store,
      action,
      writer: conversationWriter(input.options.adapter, input.reviewIdentity, input.event),
      now: input.options.now,
      finalize: async (publishedAction) => {
        await resolveOwnThreadAfterReply({
          adapter: input.options.adapter,
          reviewIdentity: input.reviewIdentity,
          action: publishedAction,
        });
      },
      ...(input.onComplete === undefined ? {} : { onComplete: input.onComplete }),
    });
    return published.state === "completed" ? "completed" : "transient";
  } catch (error) {
    console.warn(`tgd-review-agent: conversation reply recovery failed (${redactedMessage(error)})`);
    return "transient";
  }
}

async function resolveOwnThreadAfterReply(input: {
  readonly adapter: ConversationAdapter;
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  readonly action: PublicationAction;
}): Promise<void> {
  const owed = input.action.children.find((child) =>
    child.placement.kind === "group-reply" && child.placement.resolveOwnThread === true);
  if (owed === undefined || owed.placement.kind !== "group-reply") return;
  const threadId = owed.placement.threadId;
  if (threadId === undefined) return;
  await input.adapter.resolveReviewThread(input.reviewIdentity, threadId);
}

function conversationWriter(
  adapter: ConversationAdapter,
  reviewIdentity: ReturnType<typeof reviewIdentityFrom>,
  event: ReviewActivityEvent,
  /**
   * The parent to reply under when the triggering event has no comment of its
   * own. A `thread-resolution` event carries no `commentId` — resolving is not
   * a comment — and both adapters REJECT a thread reply without a parent, so a
   * resolution-triggered verification spent a model call, failed publication as
   * transient, and was retried on every poll forever (PR #74 review).
   */
  fallbackParentCommentId?: string,
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
          ...(event.commentId ?? fallbackParentCommentId) === undefined
            ? {}
            : { parentCommentId: (event.commentId ?? fallbackParentCommentId)! },
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
  /** The authenticated account, so a reply's commands name one that works. */
  readonly botLogin?: string;
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
    if (input.plan.kind === "verification") {
      return renderVerificationReply({
        verdict: input.plan.verdict,
        trigger: input.plan.trigger,
        rationale: input.plan.rationale,
        ...(input.botLogin === undefined ? {} : { botLogin: input.botLogin }),
      }, marker);
    }
    if (input.plan.kind === "usage") return renderUsageReply(marker);
    if (input.plan.kind === "disposition") {
      return renderDispositionReply({
        disposition: input.plan.disposition,
        file: input.plan.finding.file,
        ...(input.plan.finding.line === undefined ? {} : { line: input.plan.finding.line }),
        ruleName: input.plan.finding.ruleName,
        severity: input.plan.finding.severity,
        ...(input.botLogin === undefined ? {} : { botLogin: input.botLogin }),
      }, marker);
    }
    if (input.plan.kind === "clarification-unavailable") return renderClarificationUnavailableReply(marker);
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
    placement: {
      kind: "group-reply",
      ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
      ...(
        input.plan.kind === "explain" || input.plan.kind === "reconsider" ||
        (input.plan.kind === "clarification" && input.plan.outcome !== "stale")
          ? { headSha: input.plan.headSha }
          : {}
      ),
      ...(input.plan.kind === "verification"
        ? {
            verificationVerdict: input.plan.verdict,
            ...(input.plan.resolveOwnThread ? { resolveOwnThread: true as const } : {}),
          }
        : {}),
    },
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
    const diff = await options.config.vcsAdapter.getDiff(locator, { expectedHeadSha: pr.headSha, expectedBaseSha: pr.baseSha });
    return { headSha: pr.headSha, baseSha: pr.baseSha, diff };
  } catch (error) {
    console.warn(`tgd-review-agent: could not load review metadata (${redactedMessage(error)})`);
    return undefined;
  }
}

/** Head SHA only — idle head-change scans must not download the full PR diff. */
async function loadReviewHead(
  reviewNumber: number,
  options: { readonly config: ResolvedPollConfig; readonly deps: PollDependencies },
): Promise<string | undefined> {
  if (options.deps.getReviewMetadata !== undefined) {
    const metadata = await loadReviewMetadata(reviewNumber, options);
    return metadata?.headSha;
  }
  try {
    const locator = { kind: "repository" as const, repo: options.config.repository, number: reviewNumber };
    return (await options.config.vcsAdapter.getPullRequest(locator)).headSha;
  } catch (error) {
    console.warn(`tgd-review-agent: could not load review head (${redactedMessage(error)})`);
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
    if (loaded.errors.length > 0) {
      throw new Error(`trusted rule loading failed: ${loaded.errors.map((entry) => `${entry.sourcePath}: ${entry.message}`).join("; ")}`);
    }
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
    if (loaded.errors.length > 0) {
      throw new Error(`trusted rule loading failed: ${loaded.errors.map((entry) => `${entry.sourcePath}: ${entry.message}`).join("; ")}`);
    }
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
  const explicitAnswer = answerCommand || parseAnswerSyntax(input.item.event.body) !== undefined;
  if (pending.length === 0 && !explicitAnswer) return undefined;

  let thread: ReviewThreadSnapshot | undefined;
  if (input.item.event.threadId !== undefined) {
    try {
      thread = await input.options.adapter.getReviewThread(input.reviewIdentity, input.item.event.threadId);
    } catch (error) {
      if (explicitAnswer || mayBeClarificationAnswer({ event: input.item.event, pending })) {
        console.warn(`tgd-review-agent: could not load clarification thread (${redactedMessage(error)})`);
        return "transient";
      }
    }
  }
  const metadata = await loadReviewMetadata(input.item.event.reviewNumber, input.options);
  const potentialAnswer = explicitAnswer || mayBeClarificationAnswer({ event: input.item.event, pending });
  if (metadata === undefined) return potentialAnswer ? "transient" : undefined;
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
    headSha: metadata.headSha,
    mentioned: input.item.parsed.kind === "command",
  });
  if (association.kind === "ignore") {
    const boundExplicitAnswer = explicitAnswer &&
      input.item.event.repositoryDigest === publicDigest &&
      input.item.event.reviewNumber === input.reviewIdentity.reviewNumber;
    if (boundExplicitAnswer) {
      return publishReplyPlan({
        event: input.item.event,
        identity: input.item.identity,
        plan: { kind: "clarification-unavailable" },
        reviewIdentity: input.reviewIdentity,
        options: input.options,
      });
    }
    if (explicitAnswer && input.latest?.state === "prepared") return completeEmptyPrepared(input);
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

/**
 * The host's structural check for a clarification-confirmed finding (#79).
 *
 * A reassessment re-runs the model against the CURRENT diff and head and
 * returns a freshly generated finding, so it can carry a claim that has never
 * been checked. Nothing false is published without this — `renderHostCheck`
 * needs both a claim and a check, so an unchecked claim renders as ordinary
 * prose — but the claim then reads unchallenged, which is exactly what the
 * feature exists to stop.
 *
 * The check is computed HERE, at publication time, against the base as it is
 * now. Persisting the one the original review computed would attach a
 * verification of an older base to a finding regenerated against a newer one:
 * a stale answer presented as current, and worse than none. That is why
 * `FindingSnapshot` holds neither `claim` nor `hostCheck`.
 *
 * Every failure degrades to `not-checked` WITH A REASON rather than to
 * silence, and the reason is HOST-AUTHORED: it is rendered into a comment that
 * is world-readable on a public repository, and a workspace failure quotes the
 * absolute path it failed on. Same rule the CLI path follows, arrived at the
 * same way; the raw error goes to stderr, which is private.
 */
function clarificationClaimChecker(input: {
  readonly config: ResolvedPollConfig;
  readonly deps: PollDependencies;
  readonly baseSha: string | undefined;
  readonly diff: string;
}): (finding: Finding) => Promise<Finding> {
  const { config, deps, baseSha, diff } = input;
  return async (finding) => {
    if (finding.claim === undefined) return finding;
    const notChecked = (reason: string): Finding =>
      ({ ...finding, hostCheck: { status: "not-checked" as const, reason } });
    // The SAME predicate the checker applies, exported from the same module so
    // it cannot drift (#80). Preparing a base worktree is a full clone on a
    // cold workspace, and a claim the check would refuse anyway — one on a Go
    // file, say — buys nothing for it.
    if (!hasCheckableClaim(finding)) {
      return notChecked("this claim was not one the host could check");
    }
    // The publication falls back to a zero SHA when the metadata carries no
    // base, and no tree sits at that commit. Refusing here says so plainly
    // instead of letting the clone fail and reporting a workspace problem for
    // what is really missing metadata.
    if (baseSha === undefined || baseSha.length === 0) {
      return notChecked("the review base commit was not available");
    }
    try {
      // Issue #78: the check runs INSIDE the repository lock. Reading the
      // shared worktree after the lock is released lets another job reset it
      // mid-read, and this derives a host-authored fact from what it reads.
      return await (deps.prepareStructuralWorkspace ?? withPreparedWorkspaceReal)({
        // The SAME managed workspace context mapping uses, so a repository is
        // mirrored once whichever feature asked for it first.
        root: contextRoots(selectContextRoot({
          ...(config.contextDir === undefined ? {} : { explicitContextDir: config.contextDir }),
        })).workspaceRoot,
        repo: config.repository,
        baseSha,
        rejectPreviouslySharedRoot: true,
      }, async (prepared) => {
        if (prepared.baseSha !== baseSha) {
          throw new Error("prepared worktree does not sit at the requested base commit");
        }
        // `runStructuralChecks` never throws and returns one finding per input,
        // so the single element is always there.
        return (await (deps.runStructuralChecks ?? runStructuralChecksReal)({
          findings: [finding],
          baseRoot: prepared.baseWorktreePath,
          // A finding names its HEAD path; the base tree holds a renamed file
          // under the old one, and without this the symbol's own declaration
          // reads as a reference from elsewhere.
          renamedFrom: renameSourcesByHeadPath(diff),
          // Lets the checker drop occurrences whose base-side lines may be
          // precisely the ones this PR deletes — per file, so an untouched
          // caller elsewhere survives.
          removedLinesByFile: removedLinesByFile(diff),
          // No `isSuppressed`: this path publishes exactly one finding, so
          // there is nothing for the orchestrator to drop it in favour of.
        }))[0]!;
      });
    } catch (error) {
      const reason = "the base worktree could not be prepared";
      console.warn(
        `tgd-review-agent: structural check skipped for a clarified finding (${reason}: ${redactedMessage(error)})`,
      );
      return notChecked(reason);
    }
  };
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
    let frozenOutcome = observed.frozenOutcome;
    // The reassessment's finding IN FULL, kept only for this pass.
    //
    // What gets frozen is a `FindingSnapshot`, which holds neither `claim` nor
    // `hostCheck` — deliberately, so a verification of an older base can never
    // be attached to a finding regenerated against a newer one. Publishing
    // from the snapshot alone would therefore throw away a claim the model
    // just made, before the check that answers it ever ran, so the publication
    // below prefers this while it exists. A pass that resumes from a frozen
    // outcome written by an earlier poll has no claim to check and publishes
    // exactly the prose it would have published before.
    let reassessedFinding: Finding | undefined;
    if (frozenOutcome === undefined) {
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
        frozenOutcome = { outcome: "withdrawn", rationale: "The original finding is no longer available." };
      } else if (result.status === "inactive-rule") {
        frozenOutcome = { outcome: "withdrawn", rationale: `The trusted rule ${result.ruleName} is no longer active.` };
      } else if (result.result.outcome === "confirmed" || result.result.outcome === "revised") {
        if (!("finding" in result.result) || result.result.finding === undefined) return "transient";
        reassessedFinding = result.result.finding;
        frozenOutcome = {
          outcome: result.result.outcome,
          rationale: result.result.rationale,
          // SNAPSHOT, not the finding itself. `Finding` is structurally
          // assignable to `FindingSnapshot`, so the compiler accepted the raw
          // value — but the store validates keys nominally and rejects any it
          // does not know. A reassessment that returned a `claim` therefore
          // threw inside `replacePending`, and the throw escapes every catch
          // between here and the poll loop: the answer could never be
          // completed, and the cursor it holds never advanced. `claim` is
          // parsed unconditionally from reviewer output, so this needed no
          // flag to be set to happen.
          finding: toFindingSnapshot(result.result.finding),
          // Beside the snapshot, not inside it. The claim must outlive a
          // publication that fails before its manifest is stored — otherwise
          // the next poll resumes from a claim-less snapshot and the assertion
          // is dropped without a word (Codex review of PR #101). The CHECK is
          // still never persisted: it is recomputed against the current base on
          // every attempt.
          ...(result.result.finding.claim === undefined
            ? {}
            : { claim: result.result.finding.claim }),
        };
      } else {
        frozenOutcome = { outcome: "withdrawn", rationale: result.result.rationale };
      }
      await input.options.store.transact((tx) => {
        const current = tx.snapshot.pending.clarifications.find((entry) => entry.id === observed.id) ?? observed;
        tx.replacePending(replacePendingClarification(tx.snapshot.pending, { ...current, frozenOutcome }));
      });
    }
    plan = {
      kind: "clarification",
      outcome: frozenOutcome.outcome,
      rationale: frozenOutcome.rationale,
      question: observed.question,
      answer: input.association.answerText,
      headSha: input.metadata.headSha,
    };
    if (frozenOutcome.outcome === "confirmed" || frozenOutcome.outcome === "revised") {
      if (frozenOutcome.finding === undefined) return "transient";
        try {
          const publishedFinding = await publishConfirmedClarificationFinding({
            store: input.options.store,
            // A resumed pass rebuilds the finding from the snapshot plus the
            // claim frozen beside it, so it is checked on exactly the terms the
            // first attempt would have been.
            finding: reassessedFinding ?? {
              ...frozenOutcome.finding,
              ...(frozenOutcome.claim === undefined ? {} : { claim: frozenOutcome.claim }),
            },
            ...(input.options.config.structuralChecks === "on"
              ? {
                  checkClaim: clarificationClaimChecker({
                    config: input.options.config,
                    deps: input.options.deps,
                    baseSha: input.metadata.baseSha,
                    diff: input.metadata.diff,
                  }),
                }
              : {}),
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

/**
 * How many findings one poll will verify.
 *
 * Each is a model call, so an unbounded loop over every open finding on a busy
 * repository is a cost incident rather than a feature (#57). Deliberately far
 * below MAX_POLL_EVENTS: events are cheap to classify, verifications are not.
 */
export const MAX_POLL_VERIFICATIONS = 5;

/**
 * How many candidates the queue will ENUMERATE, as opposed to verify.
 *
 * Enumeration is a pure function over state already in hand, so it is not what
 * the cost budget protects. Sizing it to the budget was the bug: the queue
 * stopped one past what it could afford, and every candidate beyond that was
 * never named — so retention could not hold it and the page consumed it
 * (PR #74 review). Only what is AFFORDABLE gets a thread fetch and a model call.
 */
const MAX_VERIFICATION_CANDIDATES = 200;

/**
 * How many UNMATCHED thread events one page may spend a thread read on while
 * recovering findings whose publication crashed before identity binding
 * (issue #85). Scoped to unmatched events only, so the ordinary path — every
 * reply in a bound finding's thread — performs no additional provider
 * round-trip.
 *
 * Events past the cap are DEFERRED, not consumed (Codex review of PR #87,
 * round two): a genuine crash orphan sitting behind unrelated threads would
 * otherwise be consumed unread and lost for good. Each poll still consumes
 * durably every non-match it inspects and recovers every match, so the tail
 * drains and the cursor hold terminates — only after an INSPECTION finds an
 * event unmatchable is it consumed.
 */
const MAX_IDENTITY_RECOVERY_READS = 4;

/**
 * Plans the automatic verifications this poll should perform for one review.
 *
 * Ordered cheapest-first on purpose: the QUEUE runs on data already in hand —
 * this page's events, the finding ledger, the recorded outcomes — and only what
 * survives it costs a thread fetch and a model call.
 *
 * Human thread events AND a silent push that removed origin-side lines inside
 * a finding's anchor. Head-change has no page event; the reply is keyed on the
 * finding and the new head, and posted under the bot's own thread root.
 */
/** One verification the queue selected, with everything the verdict needs. */
interface QueuedVerification {
  readonly pending: PendingVerification;
  readonly ledger: FindingLedgerEntry;
  readonly thread: ReviewThreadSnapshot | undefined;
  readonly event: ReviewActivityEvent;
  readonly identity: { actionId: string; identityDigest: string };
}

interface VerificationQueue {
  readonly items: readonly QueuedVerification[];
  /**
   * Whether the queue had more than the budget allowed.
   *
   * The caller holds the page cursor back when this is set. Sliced signals live
   * nowhere: nothing persists "this reply is still owed", so advancing past
   * them left every human reply after the fifth permanently unanswered (PR #74
   * review). Holding the cursor cannot loop, because each verification that
   * does run records an outcome and drops out of the next queue.
   */
  readonly deferred: boolean;
  /**
   * Threads a finding is bound to AFTER recovery.
   *
   * The caller computes its own set before calling, and recovery binds
   * orphaned findings during the call — so a thread first seen through a
   * recovered finding was missing from the caller's set, dropped from the
   * remembered record, and read as a fresh transition on the next re-emission
   * (PR #94 review).
   */
  readonly boundThreads: ReadonlySet<string>;
  /**
   * The trigger events the budget could not reach.
   *
   * They are excluded from this page's processing entirely, because the poll
   * marks an ordinary comment as classified-and-ignored the moment it reads it
   * — so an event left in place is an event permanently consumed, and the reply
   * it asked for is never given (PR #74 review).
   */
  readonly deferredEvents: readonly ReviewActivityEvent[];
  /**
   * Head SHA whose origin compares finished this page. Written to the review
   * cursor so a later idle poll of the same head does not re-download diffs.
   * Absent when a compare failed or the origin list was truncated, so the
   * next poll retries instead of treating an unscanned origin as untouched.
   */
  readonly scannedHeadSha?: string;
  readonly context?: {
    readonly metadata: Awaited<ReturnType<typeof loadReviewMetadata>>;
    readonly rules: Awaited<ReturnType<typeof loadActiveRules>>;
  };
}

/**
 * Selects the verifications this page calls for, WITHOUT running any.
 *
 * Split from the verdict deliberately. Everything here is a read — the finding
 * ledger, recorded outcomes, the thread — so a dry run can report exactly what
 * would happen without spending a model call on a preview (PR #74 review).
 */
async function loadTouchedLinesByOriginHead(input: {
  readonly reviewNumber: number;
  readonly currentHead: string;
  readonly origins: readonly string[];
  readonly findings: readonly FindingLedgerEntry[];
  readonly options: {
    readonly config: ResolvedPollConfig;
  };
}): Promise<{
  readonly lines: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  readonly insertAfter: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  readonly complete: boolean;
}> {
  const touched = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  const insertAfter = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  const locator = {
    kind: "repository" as const,
    repo: input.options.config.repository,
    number: input.reviewNumber,
  };
  let complete = true;
  for (const origin of input.origins) {
    if (origin.toLowerCase() === input.currentHead.toLowerCase()) continue;
    try {
      const diff = await input.options.config.vcsAdapter.getCompareDiff(locator, origin, input.currentHead);
      const key = origin.toLowerCase();
      touched.set(key, originTouchedLines(diff));
      insertAfter.set(key, originInsertAfterLines(diff));
    } catch (error) {
      if (error instanceof CompareNotDirectError) {
        const key = origin.toLowerCase();
        touched.set(key, originAnchorLines(origin, input.findings));
        insertAfter.set(key, new Map());
        continue;
      }
      complete = false;
      console.warn(`tgd-review-agent: could not compare ${origin.slice(0, 8)}…${input.currentHead.slice(0, 8)} (${redactedMessage(error)})`);
    }
  }
  return { lines: touched, insertAfter, complete };
}

function originAnchorLines(
  origin: string,
  findings: readonly FindingLedgerEntry[],
): ReadonlyMap<string, ReadonlySet<number>> {
  const lines = new Map<string, Set<number>>();
  const key = origin.toLowerCase();
  for (const entry of findings) {
    if (entry.headSha.toLowerCase() !== key) continue;
    if (entry.placement === null || entry.placement.line === undefined) continue;
    const path = entry.placement.file;
    const last = entry.placement.line;
    const first = entry.placement.startLine ?? last;
    let set = lines.get(path);
    if (set === undefined) {
      set = new Set();
      lines.set(path, set);
    }
    for (let line = Math.min(first, last); line <= Math.max(first, last); line += 1) {
      set.add(line);
    }
  }
  return lines;
}

function headChangeActivity(input: {
  readonly ledger: FindingLedgerEntry;
  readonly threadId: string;
  readonly headSha: string;
  readonly reviewNumber: number;
  readonly binding: RepositoryBinding;
  readonly at: string;
}): ReviewActivityEvent {
  const eventId = `head-change:${input.ledger.id}`;
  return {
    kind: "thread-resolution",
    provider: input.binding.provider,
    repositoryDigest: input.binding.repositoryDigest,
    reviewNumber: input.reviewNumber,
    eventId,
    revisionId: `${eventId}:${input.headSha}`,
    orderKey: `${input.headSha}|${eventId}`,
    createdAt: input.at,
    updatedAt: input.at,
    body: "",
    url: input.ledger.identity?.url ?? "",
    threadId: input.threadId,
    resolved: false,
    outdated: false,
  };
}

async function queueVerifications(input: {
  readonly events: readonly { readonly event: ReviewActivityEvent }[];
  readonly reviewNumber: number;
  readonly reviewIdentity: ReturnType<typeof reviewIdentityFrom>;
  /** What is left of this POLL's allowance, not this page's. */
  readonly budget: number;
  /** Threads this review last observed resolved, from the durable cursor. */
  readonly resolvedThreads: ReadonlySet<string>;
  /** Last head whose origin compares finished, from the durable cursor. */
  readonly headChangeScanSha?: string;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
    readonly dryRun: boolean;
  };
}): Promise<VerificationQueue> {
  // Store reads FIRST, and no provider call until there is something to ask
  // about. Every EARLY RETURN below this point has to hand back the events it
  // is walking away from: the caller has already taken them off the page, so a
  // return of "nothing" is indistinguishable from "nothing is owed" and the
  // page consumes the reply (PR #74 review).
  const snapshot = await input.options.store.readContextSnapshot();
  let findings = snapshot.findings.filter((entry) => entry.reviewNumber === input.reviewNumber);
  const bound = new Set(findings
    .map((entry) => entry.identity?.threadId)
    .filter((threadId): threadId is string => threadId !== undefined));
  const replyShape = (item: { readonly event: ReviewActivityEvent }): boolean =>
    item.event.kind !== "general-comment" && item.event.authorIsBot !== true &&
    item.event.threadId !== undefined;
  // The cheap superset: a human event in a published finding's own thread.
  // Costs nothing, needs no head, and is what every early return defers. A
  // candidate the real queue would have dismissed is simply dismissed on the
  // next poll instead, which terminates.
  const waiting = input.events
    .filter((item) => replyShape(item) && bound.has(item.event.threadId!))
    .map((item) => item.event);
  // Threads with NO bound finding (issue #85): a finding whose publication
  // crashed after the provider write but before the identity was bound has no
  // threadId in the ledger, so the set above cannot match replies in its
  // thread — and an unmatched event is consumed as classified-and-ignored,
  // spending the human's reply forever. The thread's root is the bot's own
  // comment carrying the authenticated finding marker, so the finding is
  // recognisable WITHOUT the binding: the recovery below loads the thread,
  // parses the marker against the ledger, and repairs the binding.
  const unmatched = input.events
    .filter((item) => replyShape(item) && !bound.has(item.event.threadId!))
    .map((item) => item.event);
  if (waiting.length === 0 && unmatched.length === 0 && bound.size === 0) {
    return { items: [], deferred: false, deferredEvents: [], boundThreads: bound };
  }

  // Identity recovery for crash-orphaned findings (issue #85). Only unmatched
  // events are read, and only up to the cap — the ordinary path performs no
  // additional provider round-trip (issue #85 acceptance). A read outage
  // DEFERS the event rather than consuming it: dropping it here would lose the
  // reply for good, the exact failure being repaired.
  //
  // This runs BEFORE the budget gate deliberately (Codex review of PR #87):
  // recovery needs a provider thread read, not a model call, so a budget
  // exhausted by earlier verifications is no reason to consume a crash
  // orphan's reply — the scarcest thing this path handles.
  const recoveryDeferred: ReviewActivityEvent[] = [];
  // Threads already read during recovery: the verification loop re-reads each
  // candidate's thread, and a recovered finding's thread is already in hand —
  // spending a second read on it would double the recovery path's cost for no
  // information.
  const recoveredThreads = new Map<string, ReviewThreadSnapshot>();
  // The uninspected tail is DEFERRED, not consumed: a genuine crash orphan
  // sitting behind unrelated threads must be inspected on a later poll, not
  // lost unread (Codex review of PR #87, round two). Each poll still consumes
  // durably every non-match it inspects, so the tail drains.
  recoveryDeferred.push(...unmatched.slice(MAX_IDENTITY_RECOVERY_READS));
  for (const event of unmatched.slice(0, MAX_IDENTITY_RECOVERY_READS)) {
    let thread: ReviewThreadSnapshot;
    try {
      thread = await input.options.adapter.getReviewThread(input.reviewIdentity, event.threadId!);
    } catch (error) {
      console.warn(`tgd-review-agent: could not load a thread to recover a finding identity (${redactedMessage(error)})`);
      recoveryDeferred.push(event);
      continue;
    }
    // The same gate the command path applies: the thread must be the bot's OWN
    // and its root must carry an authenticated finding marker naming a ledger
    // record in THIS repository and review. A thread failing either is not
    // ours to recover, and falls out consumed, as before.
    const resolution = resolveMarkedFindingThread({
      event,
      thread,
      findings,
      repository: input.options.store.repositoryBinding,
      markerRepositoryDigest: computeRepositoryDigest(
        input.options.config.repository.provider,
        input.options.config.repository.canonicalUrl,
      ),
    });
    if (resolution.status !== "marked" || resolution.ledger.identity !== undefined) continue;
    // The marker's ledger record is PREPARED but UNBOUND — the crash gap. Bind
    // the identity the thread itself proves: the bot's root comment in the
    // thread the human replied to, the same fields a successful publication
    // write would have recorded.
    const boundEntry = bindFindingLedgerIdentity(resolution.ledger, {
      provider: event.provider,
      commentId: thread.rootCommentId,
      threadId: event.threadId!,
      url: resolution.root.url,
    });
    if (!input.options.dryRun) {
      await input.options.store.transact((tx) => { tx.appendFinding(boundEntry); });
    }
    findings = findings.map((entry) => entry.id === boundEntry.id ? boundEntry : entry);
    bound.add(event.threadId!);
    waiting.push(event);
    recoveredThreads.set(event.threadId!, thread);
  }

  // Nothing may run, but everything waiting must still be NAMED. Enumerating
  // through the full path spent a thread read per review on a poll that could
  // not afford to verify anything (PR #74 review).
  //
  // Recovered events are in `waiting` now: their binding is repaired, so they
  // are held here and reached through the ordinary bound path once model
  // budget returns — never re-read, never re-recovered. Unmatched events that
  // did NOT recover (no marker, not the bot's thread) are not held: there is
  // no way to ever match them, and holding unmatchable events pins the cursor
  // forever. Read failures and the unread past-the-cap tail ARE held — both
  // may still resolve on a later poll.
  const holdAll = { items: [], deferred: true, deferredEvents: [...waiting, ...recoveryDeferred], boundThreads: bound };
  if (input.budget <= 0) return holdAll;

  const outcomes = await input.options.store.readFindingOutcomes();
  const currentHead = await loadReviewHead(input.reviewNumber, input.options);
  if (currentHead === undefined) return holdAll;

  const alreadyScanned = input.headChangeScanSha !== undefined
    && input.headChangeScanSha.toLowerCase() === currentHead.toLowerCase();
  const verifiedAtHead = new Set(
    outcomes.filter((outcome) => outcome.headSha.toLowerCase() === currentHead.toLowerCase()).map((outcome) => outcome.findingId),
  );
  const staleOrigins = [...new Set(findings
    .filter((entry) =>
      entry.headSha.toLowerCase() !== currentHead.toLowerCase()
      && entry.placement !== null
      && entry.placement.line !== undefined
      && entry.identity?.threadId !== undefined
      && !verifiedAtHead.has(entry.id))
    .map((entry) => entry.headSha))];
  const needsCompare = staleOrigins.length > 0 && !alreadyScanned;
  let scannedHeadSha: string | undefined = alreadyScanned ? currentHead : undefined;
  let touchedLinesByOriginHead: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>> = new Map();
  let insertAfterByOriginHead: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>> = new Map();

  if (waiting.length === 0 && recoveryDeferred.length === 0 && !needsCompare) {
    return { items: [], deferred: false, deferredEvents: [], boundThreads: bound, scannedHeadSha: currentHead };
  }

  if (needsCompare) {
    const origins = [...staleOrigins]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, MAX_VERIFICATION_CANDIDATES);
    const loaded = await loadTouchedLinesByOriginHead({
      reviewNumber: input.reviewNumber,
      currentHead,
      origins,
      findings,
      options: input.options,
    });
    touchedLinesByOriginHead = loaded.lines;
    insertAfterByOriginHead = loaded.insertAfter;
    if (loaded.complete && origins.length === staleOrigins.length) scannedHeadSha = currentHead;
  }

  const queue = pendingVerifications({
    headSha: currentHead,
    findings: findings.map((entry) => ({
      id: entry.id,
      headSha: entry.headSha,
      finding: { severity: entry.finding.severity },
      placement: entry.placement === null || entry.placement.line === undefined
        ? null
        : {
            path: entry.placement.file,
            line: entry.placement.line,
            ...(entry.placement.startLine === undefined ? {} : { startLine: entry.placement.startLine }),
          },
      ...(entry.identity?.threadId === undefined ? {} : { identity: { threadId: entry.identity.threadId } }),
    })),
    events: input.events.map((item) => ({
      kind: item.event.kind,
      threadId: item.event.kind === "general-comment" ? undefined : item.event.threadId,
      authorIsBot: item.event.authorIsBot,
      resolved: item.event.kind === "thread-resolution" ? item.event.resolved : undefined,
    })),
    outcomes,
    resolvedThreads: input.resolvedThreads,
    changedLines: new Map(),
    touchedLinesByOriginHead,
    insertAfterByOriginHead,
    ceiling: MAX_VERIFICATION_CANDIDATES,
  });
  if (queue.length === 0) {
    // A recovery read outage defers its event even when no candidate emerged:
    // the event is off the page either way, and the reply it carries must not
    // be spent on a transport failure.
    return {
      items: [],
      deferred: recoveryDeferred.length > 0,
      deferredEvents: recoveryDeferred,
      boundThreads: bound,
      ...(scannedHeadSha === undefined ? {} : { scannedHeadSha }),
    };
  }

  const metadata = await loadReviewMetadata(input.reviewNumber, input.options);
  if (metadata === undefined) return holdAll;

  const needsRules = queue.some((pending) => {
    const ledger = findings.find((entry) => entry.id === pending.findingId);
    return ledger !== undefined && !(ledger.reviewOptions.codexScanResults === true &&
      ledger.finding.ruleName === "codex-security");
  });
  const rules = needsRules
    ? await loadActiveRules(input.reviewNumber, metadata, input.options)
    : { rules: [] as readonly RuleDefinition[] };
  if (rules.error !== undefined) {
    // Preserve the error in the queue context. Imported scan findings do not
    // need this rule set and must still settle; ordinary findings inspect the
    // error in verifyQueued and remain retryable rather than becoming inactive.
    console.warn(`tgd-review-agent: verification rule loading failed (${rules.error.message})`);
  }

  // Resolved WITHOUT touching the provider: which finding, which event. This is
  // the full set the page must not consume, so it is computed before anything
  // is spent and independently of what this poll can afford.
  const candidates = queue.flatMap((pending) => {
    const ledger = findings.find((entry) => entry.id === pending.findingId);
    const threadId = ledger?.identity?.threadId;
    if (ledger === undefined || threadId === undefined) return [];
    // The event that prompted it, so the reply lands in the right thread and
    // the action carries a real provenance.
    const trigger = input.events.find((item) =>
      item.event.kind !== "general-comment" && item.event.threadId === threadId);
    if (trigger !== undefined) return [{ pending, ledger, threadId, event: trigger.event }];
    if (pending.trigger !== "head-change") return [];
    return [{ pending, ledger, threadId, event: headChangeActivity({
      ledger,
      threadId,
      headSha: metadata.headSha,
      reviewNumber: input.reviewNumber,
      binding: input.options.store.repositoryBinding,
      at: input.options.now(),
    }) }];
  });

  // The DURABLE idempotency check, on the action ledger rather than the outcome
  // checkpoint. The checkpoint keeps only the most recent
  // `MAX_OUTCOME_CHECKPOINT` records, so once a repository passes that count an
  // older outcome falls out of it while the finding sits at the same head — and
  // the queue would answer a second time (PR #74 review). The action identity
  // already encodes exactly (finding, head), and the ledger is unbounded.
  //
  // I removed this check in an earlier round because the outcome record covered
  // it and no test failed without it. The record covers it only up to the
  // checkpoint bound; this is the case that survives past it.
  const identityFor = (candidate: { ledger: FindingLedgerEntry; event: ReviewActivityEvent }) =>
    conversationActionIdentity({
      provider: candidate.event.provider,
      repositoryDigest: candidate.event.repositoryDigest,
      reviewNumber: input.reviewNumber,
      eventId: candidate.ledger.id,
      commandKey: `verify:${metadata.headSha}`,
    });
  const answered = candidates.length === 0
    ? new Map()
    : await input.options.store.findTerminalActions(candidates.map(identityFor));
  const unanswered = candidates.filter((candidate) =>
    answered.get(identityFor(candidate).actionId)?.state !== "completed");

  const items: QueuedVerification[] = [];
  // Everything past the budget, named so the caller can hold it back.
  const deferredEvents: ReviewActivityEvent[] = unanswered.slice(input.budget)
    .map((candidate) => candidate.event);
  let deferred = deferredEvents.length > 0;
  for (const { pending, ledger, threadId, event } of unanswered.slice(0, input.budget)) {
    let thread: ReviewThreadSnapshot | undefined;
    const recoveredThread = recoveredThreads.get(threadId);
    if (recoveredThread !== undefined) {
      thread = recoveredThread;
    } else {
      try {
        thread = await input.options.adapter.getReviewThread(input.reviewIdentity, threadId);
      } catch (error) {
        // A READ OUTAGE, not an answer. Deferring retries it next poll; dropping
        // it let the page consume the reply for good (PR #74 review).
        console.warn(`tgd-review-agent: could not load a thread to verify (${redactedMessage(error)})`);
        deferredEvents.push(event);
        deferred = true;
        continue;
      }
    }

    // The thread must be the bot's OWN. A published finding's identity is bound
    // from the bot's successful inline write, so a thread carrying that id is
    // normally the bot's — but the command path already refuses to act in a
    // thread it did not root, and verification needs no command to be parsed
    // before it acts. Answering inside a thread rooted by someone else is the
    // same spoof with the parser removed from the path.
    const root = thread?.events.find((event) => event.commentId === thread?.rootCommentId);
    if (root === undefined || root.authorIsBot !== true) continue;

    items.push({
      pending,
      ledger,
      thread,
      event,
      identity: conversationActionIdentity({
        provider: event.provider,
        repositoryDigest: event.repositoryDigest,
        reviewNumber: input.reviewNumber,
        // Keyed on the FINDING and the HEAD, not the event: three replies in
        // one thread must produce one verification, and a resumed poll must not
        // repeat one it already published.
        eventId: ledger.id,
        commandKey: `verify:${metadata.headSha}`,
      }),
    });
  }
  return {
    items,
    deferred,
    boundThreads: bound,
    deferredEvents: [...deferredEvents, ...recoveryDeferred],
    context: { metadata, rules },
  };
}

/**
 * Turns one queued verification into a verdict, a reply and a record.
 *
 * This is the only step that costs a model call, which is why it is the only
 * step a dry run skips.
 */
async function verifyQueued(input: {
  readonly item: QueuedVerification;
  readonly context: NonNullable<VerificationQueue["context"]>;
  readonly reviewNumber: number;
  readonly options: {
    readonly adapter: ConversationAdapter;
    readonly store: ConversationStateStore;
    readonly now: () => string;
    readonly config: ResolvedPollConfig;
    readonly deps: PollDependencies;
  };
}): Promise<
  | { readonly kind: "planned"; readonly event: ReviewActivityEvent;
      readonly identity: { actionId: string; identityDigest: string }; readonly plan: ReplyPlan;
      readonly parentCommentId?: string }
  /** Try again next poll: the event stays owed and the cursor holds. */
  | { readonly kind: "transient" }
  /**
   * Nothing more to do for this event, ever.
   *
   * Held open, these LIVELOCK: the cursor never advances, and the same
   * candidate spends verification budget on every poll while later candidates
   * starve behind it (PR #74 review). Verification is unsolicited, so an
   * answer that can never be produced is dropped rather than allowed to block
   * a review's ordinary event processing.
   */
  | { readonly kind: "settled"; readonly reason: string }
> {
  const { item } = input;
  const metadata = input.context.metadata;
  if (metadata === undefined) return { kind: "transient" };
  const ledger = item.ledger;

  // There is no rule prompt to re-run for an imported scan finding. Settling
  // the queue is explicit and terminal; treating the synthetic policy as a
  // reviewer rule would manufacture a verification the scanner never made.
  if (ledger.reviewOptions.codexScanResults === true && ledger.finding.ruleName === "codex-security") {
    return { kind: "settled", reason: "Codex Security findings require a new external scan" };
  }

  if (input.context.rules.error !== undefined) return { kind: "transient" };

  // The same fallback the command path uses, and the same refusal: a review
  // records the model it ran under, so a finding raised by a configured run
  // stays verifiable after the operator drops the flag. Unresolvable means not
  // verified, never verified against a default nobody chose.
  const model = input.options.config.model ?? ledger.reviewOptions.model;
  if (model === undefined) {
    console.warn("tgd-review-agent: conversation model is not configured");
    return { kind: "settled", reason: "no model is configured" };
  }

  const result = await verifyFinding({
    pending: item.pending,
    ledger,
    currentRule: input.context.rules.rules.find((rule) => rule.name === ledger.finding.ruleName),
    currentCodeHunk: extractFileHunk(metadata.diff, ledger.finding.file),
    addressedThread: formatAddressedThread(item.thread),
    headSha: metadata.headSha,
    repository: input.options.store.repositoryBinding,
    outcomeId: `outcome_${createHash("sha256")
      .update(`${ledger.id}\0${metadata.headSha}`, "utf8").digest("hex").slice(0, 32)}`,
    at: input.options.now(),
    anchorChanged: item.pending.trigger === "head-change",
    model,
    ...(input.options.deps.createSession === undefined
      ? {}
      : { createSession: input.options.deps.createSession }),
  });

  if ("skip" in result) {
    console.warn(
      `tgd-review-agent: could not verify a finding (${result.skip.kind}) on review #${input.reviewNumber}`,
    );
    // A rule that no longer exists and a history the tool cannot read are
    // answers, not outages. Only `transient` earns a retry.
    return result.skip.kind === "transient"
      ? { kind: "transient" }
      : { kind: "settled", reason: result.skip.kind };
  }

  return {
    kind: "planned",
    event: item.event,
    identity: item.identity,
    // A resolution is not a comment, so it cannot be replied UNDER. The thread's
    // root is the bot's own finding comment, which is where the reply belongs.
    ...(item.event.commentId === undefined && item.thread?.rootCommentId !== undefined
      ? { parentCommentId: item.thread.rootCommentId }
      : {}),
    plan: {
      kind: "verification",
      verdict: result.plan.verdict,
      trigger: result.plan.reply.trigger,
      rationale: result.plan.reply.rationale,
      outcome: result.plan.outcome,
      headSha: metadata.headSha,
      resolveOwnThread: result.plan.resolveOwnThread,
    },
  };
}

function formatAddressedThread(thread: ReviewThreadSnapshot | undefined): string {
  if (thread === undefined) return "";
  return thread.events
    .filter((event) => event.kind === "thread-comment" || event.kind === "comment-edit" || event.kind === "general-comment")
    .map((event) => `${event.authorLogin ?? "unknown"}: ${event.body}`)
    .join("\n");
}
