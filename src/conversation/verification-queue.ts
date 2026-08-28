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
export function pendingVerifications(input: VerificationQueueInput): PendingVerification[] {
  // Already answered at this head. Three replies in one thread in one poll is
  // still one verification, and a resumed poll re-verifies nothing.
  const verified = new Set(
    input.outcomes
      .filter((outcome) => outcome.headSha === input.headSha)
      .map((outcome) => outcome.findingId),
  );

  // A resolution is an EVENT, not a standing state. Both adapters timestamp
  // each resolution snapshot with the pull request's update time, so an
  // already-resolved thread emits `resolved: true` again on every later push.
  // Acting on each of those would re-queue every previously resolved finding at
  // every new head, bypassing the anchor filter entirely (PR #73 review). Once
  // a resolution has been acted on for a finding, a repeat says nothing new.
  const resolutionActedOn = new Set(
    input.outcomes
      .filter((outcome) => outcome.trigger === "thread-resolution")
      .map((outcome) => outcome.findingId),
  );

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
    const humanTrigger = signalled === "thread-resolution" && resolutionActedOn.has(candidate.id)
      ? undefined
      : signalled;
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
