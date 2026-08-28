// Issue #57, stages 2 and 3: turning a queued finding into a verdict, a reply
// and a durable record.
//
// Verification IS the reconsider action reaching the same conclusion without
// being asked. It reuses that prompt builder, parser, session hermetics and
// model resolution deliberately — a separate "verification" prompt would be a
// second thing to keep calibrated with the first, and the two would drift.
//
// The model call is injected, so this is testable without a provider. What it
// returns is a PLAN: the caller owns posting, resolving and persisting, because
// those need poll's exactly-once machinery.
import { reconsiderFinding } from "./actions.js";
import type { ConversationSessionFactory } from "./session.js";
import { prepareFindingOutcome } from "./state-schema.js";
import type {
  FindingLedgerEntry,
  FindingOutcomeEntry,
  FindingVerdict,
  FindingVerificationTrigger,
} from "./state-schema.js";
import type { PendingVerification } from "./verification-queue.js";
import type { RepositoryBinding } from "./types.js";
import type { RuleDefinition } from "../rules/types.js";

/** What the caller should do about one verified finding. */
export interface VerificationPlan {
  readonly findingId: string;
  readonly verdict: FindingVerdict;
  /**
   * What the reply must say. NOT a rendered body: a conversation body carries a
   * private brand so it can only be produced by a renderer, and the caller owns
   * the marker anyway.
   */
  readonly reply: {
    readonly verdict: FindingVerdict;
    readonly trigger: FindingVerificationTrigger;
    readonly rationale: string;
  };
  /**
   * Whether the tool may resolve the thread it started.
   *
   * True only for `withdrawn`, and only ever for the bot's OWN thread —
   * resolving a human-started thread stays a documented non-goal.
   */
  readonly resolveOwnThread: boolean;
  readonly outcome: FindingOutcomeEntry;
}

/** Why a finding could not be verified. Never a silent skip. */
export type VerificationSkip =
  | { readonly kind: "transient"; readonly findingId: string }
  | { readonly kind: "inactive-rule"; readonly findingId: string; readonly ruleName: string }
  | { readonly kind: "unsupported-history"; readonly findingId: string };

export type VerificationResult = { readonly plan: VerificationPlan } | { readonly skip: VerificationSkip };

export interface VerificationInput {
  readonly pending: PendingVerification;
  readonly ledger: FindingLedgerEntry;
  readonly currentRule: RuleDefinition | undefined;
  readonly currentRuleDisabled?: boolean;
  readonly currentCodeHunk: string;
  readonly addressedThread: string;
  readonly headSha: string;
  readonly repository: RepositoryBinding;
  readonly outcomeId: string;
  readonly at: string;
  readonly anchorChanged: boolean;
  /**
   * REQUIRED, as the action contract requires it. It was optional here, and an
   * `as never` cast at the call site hid the mismatch: an unconfigured model
   * reached `reconsiderFinding` as `undefined` instead of being refused as
   * transient the way the command path refuses it (PR #74 review).
   */
  readonly model: string;
  readonly createSession?: ConversationSessionFactory;
}

/**
 * The reason handed to the reconsider prompt.
 *
 * HOST-authored. On the command path this is a human's own words; here nobody
 * asked, so the host says why it is looking. Interpolating anything from the
 * thread would put untrusted text into the prompt through a field the command
 * path treats as untrusted argument.
 */
function reasonFor(trigger: FindingVerificationTrigger): string {
  switch (trigger) {
    case "thread-comment":
      return "Automatic verification: a human replied in this thread. Re-read the finding against the current code and say whether it still holds.";
    case "thread-resolution":
      return "Automatic verification: this thread was marked resolved. Re-read the finding against the current code and say whether it still holds.";
    case "reaction":
      return "Automatic verification: this finding was acknowledged. Re-read it against the current code and say whether it still holds.";
    case "head-change":
      return "Automatic verification: a new commit changed the lines this finding was anchored to. Re-read it against the current code and say whether it still holds.";
  }
}

/**
 * Verifies one queued finding.
 *
 * A failure is reported, never swallowed: a transient provider error, a rule
 * that no longer exists, and history the tool cannot read are three different
 * situations and a caller may want to retry, report or drop each differently.
 */
export async function verifyFinding(input: VerificationInput): Promise<VerificationResult> {
  const result = await reconsiderFinding({
    ledger: input.ledger,
    currentRule: input.currentRule,
    ...(input.currentRuleDisabled === undefined ? {} : { currentRuleDisabled: input.currentRuleDisabled }),
    currentCodeHunk: input.currentCodeHunk,
    addressedThread: input.addressedThread,
    reason: reasonFor(input.pending.trigger),
    ...(input.model === undefined ? {} : { model: input.model }),
    createSession: input.createSession,
  } as never);

  if (result.status === "transient-error") return { skip: { kind: "transient", findingId: input.pending.findingId } };
  if (result.status === "unsupported-history") {
    return { skip: { kind: "unsupported-history", findingId: input.pending.findingId } };
  }
  if (result.status === "inactive-rule") {
    return { skip: { kind: "inactive-rule", findingId: input.pending.findingId, ruleName: result.ruleName } };
  }

  const verdict = result.result.outcome;
  return {
    plan: {
      findingId: input.pending.findingId,
      verdict,
      reply: { verdict, trigger: input.pending.trigger, rationale: result.result.rationale },
      // Only a concern the tool has DROPPED, and only its own thread.
      resolveOwnThread: verdict === "withdrawn",
      outcome: prepareFindingOutcome({
        repository: input.repository,
        id: input.outcomeId,
        findingId: input.ledger.id,
        reviewNumber: input.ledger.reviewNumber,
        headSha: input.headSha,
        ruleName: input.ledger.finding.ruleName,
        category: input.ledger.finding.category,
        severity: input.pending.severity,
        ...(input.ledger.finding.effort === undefined ? {} : { effort: input.ledger.finding.effort }),
        verdict,
        trigger: input.pending.trigger,
        anchorChanged: input.anchorChanged,
        at: input.at,
      }),
    },
  };
}
