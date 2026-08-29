// Issue #57, stage 1: which findings are worth re-examining, decided BEFORE any
// model is called.
//
// Verification is a model call per finding, so an unbounded loop over every open
// finding on a busy repository is a cost incident rather than a feature. This
// module is where that is bounded, and where "one verdict per finding per head"
// is guaranteed — both are properties of the QUEUE, not of the verifier, so they
// hold however the verifier is later changed.
//
// Pure and synchronous: no I/O, no model, no provider. That is what lets the
// triggers, the ceiling and the priority order be tested exhaustively.
import type { FindingVerificationTrigger } from "./state-schema.js";
import type { Finding } from "../review/types.js";

/** The subset of a ledger entry this decision needs. */
export interface VerificationCandidate {
  readonly id: string;
  readonly headSha: string;
  readonly finding: { readonly severity: Finding["severity"] };
  /**
   * `line` is the LAST line of the anchor; `startLine` the first, when the
   * finding spans a range. Checking only the endpoint missed a commit that
   * changed the start or middle of the range, so an addressed finding was
   * never re-examined (PR #73 review).
   */
  readonly placement: {
    readonly path: string;
    readonly line: number;
    readonly startLine?: number;
  } | null;
  readonly identity?: { readonly threadId?: string } | undefined;
}

/** The subset of an activity event this decision needs. */
export interface VerificationEvent {
  readonly kind: string;
  readonly threadId?: string | undefined;
  readonly authorIsBot?: boolean | undefined;
  readonly resolved?: boolean | undefined;
}

/** The subset of an outcome record this decision needs. */
export interface VerificationOutcome {
  readonly findingId: string;
  readonly headSha: string;
  /** What prompted the recorded verdict, for the resolution rule below. */
  readonly trigger?: FindingVerificationTrigger;
}

export interface PendingVerification {
  readonly findingId: string;
  readonly trigger: FindingVerificationTrigger;
  readonly severity: Finding["severity"];
}

export interface VerificationQueueInput {
  /** The head verification would run against. */
  readonly headSha: string;
  readonly findings: readonly VerificationCandidate[];
  readonly events: readonly VerificationEvent[];
  /** Outcomes already recorded, which is what makes this idempotent. */
  readonly outcomes: readonly VerificationOutcome[];
  /** Lines the new head touched, by path. Empty when the head did not move. */
  readonly changedLines: ReadonlyMap<string, ReadonlySet<number>>;
  /**
   * Threads the caller last observed RESOLVED, from durable state.
   *
   * A resolution is a state both adapters re-emit, not an event, so acting on
   * it requires knowing whether it changed. With this, the trigger is the
   * TRANSITION `not resolved -> resolved`, which suppresses re-emissions at any
   * head and lets a genuine reopen-then-resolve trigger again even when the two
   * land in different polls (#90, and the #73 residual).
   */
  readonly resolvedThreads: ReadonlySet<string>;
  /** The most verifications one poll may perform. */
  readonly ceiling: number;
}

/** Blocking first: a cost ceiling that dropped blockers would be worse than none. */
const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

/**
 * A human who replied is waiting for an answer; an inferred code change is not.
 *
 * So at equal severity a direct reply outranks a push that happened to touch the
 * line. `reaction` is in the vocabulary but nothing emits it yet — the adapters
 * expose reactions on a thread SNAPSHOT rather than as an activity event, so
 * detecting "a reaction landed since last poll" would need prior reaction state
 * that poll does not keep.
 */
const TRIGGER_RANK: Record<FindingVerificationTrigger, number> = {
  "thread-comment": 0,
  "thread-resolution": 1,
  reaction: 2,
  "head-change": 3,
};

/**
 * The findings this poll should verify, in the order they should be taken.
 *
 * A finding qualifies when a human acted in its thread, or when the new head
 * touched the lines it is anchored to. An unrelated push must not re-verify
 * every open finding, which is why the head trigger is anchor-scoped rather
 * than "the head moved".
 */
/**
 * Folds this page's resolution events over what was last observed.
 *
 * ONE definition, used both to decide what to verify and to persist what was
 * seen. Computing the same rule separately in the poll loop would let the two
 * drift, and a disagreement here means either a lost verification or a repeated
 * one.
 */
export function observeResolvedThreads(
  previous: ReadonlySet<string>,
  events: readonly VerificationEvent[],
  /**
   * Threads worth REMEMBERING — those a finding is bound to.
   *
   * A thread with no finding can never produce a verification, so its state is
   * dead weight, and the caller caps what it stores: letting those fill the cap
   * would evict the threads that can (PR #94 review). Absent, everything is
   * remembered, which is what a caller with no findings loaded wants.
   */
  remembered?: ReadonlySet<string>,
): { readonly resolved: ReadonlySet<string>; readonly transitioned: ReadonlySet<string> } {
  const keep = (threadId: string): boolean => remembered === undefined || remembered.has(threadId);
  const resolved = new Set([...previous].filter(keep));
  const transitioned = new Set<string>();
  for (const event of events) {
    if (event.kind !== "thread-resolution" || event.threadId === undefined) continue;
    // A reopen CLEARS the thread, so the next `true` reads as a real transition
    // even in a later poll.
    if (event.resolved === false) { resolved.delete(event.threadId); continue; }
    if (event.resolved !== true || !keep(event.threadId)) continue;
    const known = resolved.has(event.threadId);
    // DELETE then add, so re-observing moves the thread to the end. `Set.add`
    // is a no-op for a member already present, so insertion order was
    // first-observed rather than last — and a caller capping the tail would
    // evict threads it had just seen, re-read them as transitions, and cycle
    // (PR #94 review).
    resolved.delete(event.threadId);
    resolved.add(event.threadId);
    if (!known) transitioned.add(event.threadId);
  }
  return { resolved, transitioned };
}

export function pendingVerifications(input: VerificationQueueInput): PendingVerification[] {
  // Already answered at this head. Three replies in one thread in one poll is
  // still one verification, and a resumed poll re-verifies nothing.
  const verified = new Set(
    input.outcomes
      .filter((outcome) => outcome.headSha === input.headSha)
      .map((outcome) => outcome.findingId),
  );

  // A resolution is a STATE both adapters re-emit, not an event: an
  // already-resolved thread reports `resolved: true` again on every later push.
  // So the trigger is the transition into it, computed against what the caller
  // durably observed last. Reading "already acted on" from the outcome
  // checkpoint instead meant it was forgotten after
  // `MAX_OUTCOME_CHECKPOINT` newer records, and the same still-resolved thread
  // verified again at the next head (#90).
  //
  // A reopen is the same rule from the other side: observing `resolved: false`
  // clears the thread, so the next `true` is a real transition — and because
  // the record is durable, the reopen and the re-resolution no longer have to
  // arrive in the same poll (the #73 residual).
  const { transitioned } = observeResolvedThreads(input.resolvedThreads, input.events);

  const humanEventsByThread = new Map<string, FindingVerificationTrigger>();
  for (const event of input.events) {
    // The bot's own replies must not trigger verification, or a run answers
    // itself forever.
    if (event.authorIsBot === true) continue;
    if (event.threadId === undefined) continue;
    const trigger: FindingVerificationTrigger | undefined =
      event.kind === "thread-comment" ? "thread-comment"
        : event.kind === "thread-resolution" && event.resolved === true ? "thread-resolution"
          : undefined;
    if (trigger === undefined) continue;
    // Keep the strongest signal for a thread: a reply outranks a resolution.
    const existing = humanEventsByThread.get(event.threadId);
    if (existing === undefined || TRIGGER_RANK[trigger] < TRIGGER_RANK[existing]) {
      humanEventsByThread.set(event.threadId, trigger);
    }
  }

  // Keyed by finding ID: the same finding appearing twice in the input would
  // otherwise be verified twice on one head, which is precisely what the
  // idempotency rule exists to prevent (PR #73 review).
  const queued = new Map<string, PendingVerification>();
  for (const candidate of input.findings) {
    if (verified.has(candidate.id)) continue;

    const threadId = candidate.identity?.threadId;
    const signalled = threadId === undefined ? undefined : humanEventsByThread.get(threadId);
    const suppressedRepeat = signalled === "thread-resolution"
      && !(threadId !== undefined && transitioned.has(threadId));
    const humanTrigger = suppressedRepeat ? undefined : signalled;
    // An unanchored finding cannot be matched against a diff, so a push tells
    // us nothing about it — and neither does a finding RAISED at this head,
    // which is commonly anchored to a line this head changed because that is
    // what the review was reading. Verifying it against the commit that
    // produced it spends the ceiling and posts a reply nobody prompted
    // (PR #73 review).
    const touched = candidate.placement !== null
      && candidate.headSha.toLowerCase() !== input.headSha.toLowerCase()
      && anchorTouched(candidate.placement, input.changedLines);

    const trigger = humanTrigger ?? (touched ? "head-change" : undefined);
    if (trigger === undefined) continue;
    const existing = queued.get(candidate.id);
    // Keep the strongest signal, so a duplicate cannot demote a human reply to
    // an inferred code change.
    if (existing === undefined || TRIGGER_RANK[trigger] < TRIGGER_RANK[existing.trigger]) {
      queued.set(candidate.id, { findingId: candidate.id, trigger, severity: candidate.finding.severity });
    }
  }

  return [...queued.values()]
    .sort((left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      || TRIGGER_RANK[left.trigger] - TRIGGER_RANK[right.trigger])
    .slice(0, Math.max(0, input.ceiling));
}

/** Whether the new head changed ANY line of the anchor, not only its endpoint. */
function anchorTouched(
  placement: NonNullable<VerificationCandidate["placement"]>,
  changedLines: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const changed = changedLines.get(placement.path);
  if (changed === undefined) return false;
  const last = placement.line;
  const first = placement.startLine ?? last;
  for (let line = Math.min(first, last); line <= Math.max(first, last); line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}
