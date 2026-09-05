// Pure selection, association, and lifecycle of the single active
// clarification for a review/head snapshot.
import { createHash } from "node:crypto";
import { COMMAND_ID_BASE32_ALPHABET } from "./command-parser.js";
import type {
  ClarificationLifecycleState,
  ClarificationTerminalOutcome,
  FindingSnapshot,
  PendingClarification,
} from "./state-schema.js";
import type { ConversationItemIdentity, RepositoryBinding } from "./types.js";
import type { Finding } from "../review/types.js";
import type { ReviewActivityEvent, ReviewThreadSnapshot } from "../vcs/conversation-adapter.js";

export const CLARIFICATION_PUBLIC_ID_LENGTH = 26;
export const CLARIFICATION_PUBLIC_ID_RE = new RegExp(
  `^clar_[${COMMAND_ID_BASE32_ALPHABET}]{12,32}$`,
  "u",
);

const LIFECYCLE_ORDER: readonly ClarificationLifecycleState[] = [
  "prepared", "published", "answer-observed", "terminal",
];

export interface ClarificationSelectionInput {
  readonly repositoryDigest: string;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly findings: readonly Finding[];
  readonly ruleOrder?: readonly string[];
  readonly excludeIds?: readonly string[];
}

export interface SelectedClarification {
  readonly id: string;
  readonly question: string;
  readonly finding: Finding;
}

export interface ClarificationSelection {
  readonly selected?: SelectedClarification;
  readonly deferredCount: number;
}

export interface PreparedClarificationInput {
  readonly id: string;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly question: string;
  readonly createdAt: string;
  readonly finding: Finding | FindingSnapshot;
  readonly ruleName?: string;
  readonly ruleSnapshot?: string;
  readonly actionId?: string;
  readonly identityDigest?: string;
}

export type ClarificationAssociation =
  | { readonly kind: "ignore" }
  | {
      readonly kind: "answer";
      readonly pending: PendingClarification;
      readonly answerText: string;
      readonly answerIdentity: ConversationItemIdentity;
    }
  | {
      readonly kind: "stale";
      readonly pending: PendingClarification;
      readonly answerText: string;
      readonly answerIdentity: ConversationItemIdentity;
    };

function isClarificationCandidate(
  finding: Finding,
): finding is Finding & { question: string } {
  return finding.decision === "needs-clarification" && typeof finding.question === "string";
}

export function encodeClarificationPublicId(digest: Uint8Array | string): string {
  const bytes = typeof digest === "string" ? Buffer.from(digest, "hex") : digest;
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < CLARIFICATION_PUBLIC_ID_LENGTH) {
      output += COMMAND_ID_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (output.length < CLARIFICATION_PUBLIC_ID_LENGTH && bits > 0) {
    output += COMMAND_ID_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  while (output.length < 12) {
    output += COMMAND_ID_BASE32_ALPHABET[0];
  }
  return `clar_${output.slice(0, CLARIFICATION_PUBLIC_ID_LENGTH)}`;
}

function clarificationId(input: ClarificationSelectionInput, finding: Finding & { question: string }): string {
  const digest = createHash("sha256")
    .update("tgd:clarification:v1\0", "utf8")
    .update(input.repositoryDigest)
    .update("\0")
    .update(String(input.reviewNumber))
    .update("\0")
    .update(input.headSha)
    .update("\0")
    .update(finding.ruleName)
    .update("\0")
    .update(finding.file)
    .update("\0")
    .update(finding.line === undefined ? "" : String(finding.line))
    .update("\0")
    .update(finding.question)
    .digest();
  return encodeClarificationPublicId(digest);
}

/**
 * Picks the first needs-clarification finding by workflow/rule order, then
 * original finding order. One active question per review/head snapshot.
 */
export function selectClarification(input: ClarificationSelectionInput): ClarificationSelection {
  const excluded = new Set(input.excludeIds ?? []);
  const candidates = input.findings
    .map((finding, index) => ({ finding, index }))
    .filter((item): item is { finding: Finding & { question: string }; index: number } =>
      isClarificationCandidate(item.finding),
    )
    .filter((item) => !excluded.has(clarificationId(input, item.finding)));
  if (candidates.length === 0) return { deferredCount: 0 };

  const ruleRank = new Map((input.ruleOrder ?? []).map((name, index) => [name, index]));
  candidates.sort((left, right) => {
    const leftRank = ruleRank.get(left.finding.ruleName) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = ruleRank.get(right.finding.ruleName) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.index - right.index;
  });

  const first = candidates[0]!;
  return {
    selected: {
      id: clarificationId(input, first.finding),
      question: first.finding.question,
      finding: first.finding,
    },
    deferredCount: candidates.length - 1,
  };
}

export function toClarificationFindingSnapshot(finding: Finding | FindingSnapshot): FindingSnapshot {
  return {
    file: finding.file,
    severity: finding.severity,
    category: finding.category,
    message: finding.message,
    ruleName: finding.ruleName,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
    ...(finding.existingCode === undefined ? {} : { existingCode: finding.existingCode }),
    ...(finding.decision === undefined ? {} : { decision: finding.decision }),
    ...(finding.question === undefined ? {} : { question: finding.question }),
    ...(finding.title === undefined ? {} : { title: finding.title }),
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    ...(finding.effort === undefined ? {} : { effort: finding.effort }),
    ...(finding.references === undefined ? {} : { references: [...finding.references] }),
  };
}

export function createPreparedClarification(input: PreparedClarificationInput): PendingClarification {
  if (!CLARIFICATION_PUBLIC_ID_RE.test(input.id)) {
    throw new Error("clarification id is not a stable public ID");
  }
  return {
    id: input.id,
    reviewNumber: input.reviewNumber,
    headSha: input.headSha.toLowerCase(),
    question: input.question,
    createdAt: input.createdAt,
    state: "prepared",
    ruleName: input.ruleName ?? input.finding.ruleName,
    finding: toClarificationFindingSnapshot(input.finding),
    ...(input.ruleSnapshot === undefined ? {} : { ruleSnapshot: input.ruleSnapshot }),
    ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
    ...(input.identityDigest === undefined ? {} : { identityDigest: input.identityDigest }),
  };
}

export function clarificationLifecycleState(entry: PendingClarification): ClarificationLifecycleState {
  return entry.state ?? "prepared";
}

export function transitionClarification(
  current: PendingClarification,
  next: ClarificationLifecycleState,
  extras: {
    readonly identity?: ConversationItemIdentity;
    readonly answerIdentity?: ConversationItemIdentity;
    readonly answerText?: string;
    readonly answerEventId?: string;
    readonly terminalOutcome?: ClarificationTerminalOutcome;
    readonly actionId?: string;
    readonly identityDigest?: string;
  } = {},
): PendingClarification {
  const from = clarificationLifecycleState(current);
  if (LIFECYCLE_ORDER.indexOf(next) !== LIFECYCLE_ORDER.indexOf(from) + 1) {
    throw new Error(`Impossible clarification transition from ${from} to ${next}`);
  }
  if (next === "published" && extras.identity === undefined && current.identity === undefined) {
    throw new Error("published clarification requires a provider identity");
  }
  if (next === "answer-observed" && extras.answerText === undefined && current.answerText === undefined) {
    throw new Error("answer-observed clarification requires the first answer");
  }
  return {
    ...current,
    state: next,
    ...(extras.identity === undefined ? {} : { identity: extras.identity }),
    ...(extras.answerIdentity === undefined ? {} : { answerIdentity: extras.answerIdentity }),
    ...(extras.answerText === undefined ? {} : { answerText: extras.answerText }),
    ...(extras.answerEventId === undefined ? {} : { answerEventId: extras.answerEventId }),
    ...(extras.terminalOutcome === undefined ? {} : { terminalOutcome: extras.terminalOutcome }),
    ...(extras.actionId === undefined ? {} : { actionId: extras.actionId }),
    ...(extras.identityDigest === undefined ? {} : { identityDigest: extras.identityDigest }),
  };
}

const ANSWER_SYNTAX_RE = new RegExp(
  `(?:^|\\n)[ \\t]*(?:@[^\\s]+[ \\t]+)?answer[ \\t]+(clar_[${COMMAND_ID_BASE32_ALPHABET}]{12,32})[ \\t]*:[ \\t]*(\\S[\\s\\S]*)$`,
  "iu",
);

export function parseAnswerSyntax(body: string): { readonly pendingId: string; readonly answer: string } | undefined {
  const match = ANSWER_SYNTAX_RE.exec(body.normalize("NFC").replace(/\r\n?/gu, "\n"));
  if (!match) return undefined;
  const pendingId = match[1]!.toLowerCase();
  const answer = match[2]!.replace(/[ \t]+/gu, " ").trim();
  if (!CLARIFICATION_PUBLIC_ID_RE.test(pendingId) || answer.length === 0) return undefined;
  return { pendingId, answer };
}

function answerIdentityFrom(event: ReviewActivityEvent): ConversationItemIdentity {
  return {
    provider: event.provider,
    commentId: event.commentId ?? event.eventId,
    url: event.url,
    ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
  };
}

function matchingPending(
  pending: readonly PendingClarification[],
  reviewNumber: number,
  pendingId?: string,
): PendingClarification | undefined {
  return pending.find((entry) =>
    entry.reviewNumber === reviewNumber && (pendingId === undefined || entry.id === pendingId));
}

function firstHumanReply(thread: ReviewThreadSnapshot, event: ReviewActivityEvent): boolean {
  const comments = thread.events.filter((entry) =>
    entry.kind === "thread-comment" || entry.kind === "comment-edit" || entry.kind === "general-comment");
  const firstHuman = comments.find((entry) => entry.authorIsBot !== true);
  return firstHuman !== undefined && firstHuman.eventId === event.eventId;
}

function threadMatchesQuestion(thread: ReviewThreadSnapshot, pending: PendingClarification): boolean {
  if (pending.identity === undefined) return false;
  if (pending.identity.threadId !== undefined && pending.identity.threadId === thread.threadId) return true;
  return pending.identity.commentId === thread.rootCommentId;
}

export function mayBeClarificationAnswer(input: {
  readonly event: ReviewActivityEvent;
  readonly pending: readonly PendingClarification[];
}): boolean {
  if (input.event.authorIsBot === true) return false;
  const published = input.pending.filter((entry) =>
    entry.reviewNumber === input.event.reviewNumber &&
    clarificationLifecycleState(entry) !== "terminal");
  if (published.length === 0) return false;
  const parsed = parseAnswerSyntax(input.event.body);
  if (parsed !== undefined && published.some((entry) => entry.id === parsed.pendingId)) return true;
  if (input.event.threadId === undefined) return false;
  return published.some((entry) =>
    entry.identity?.threadId === input.event.threadId ||
    entry.identity?.commentId === input.event.parentCommentId);
}

export function associateClarificationEvent(input: {
  readonly event: ReviewActivityEvent;
  readonly pending: readonly PendingClarification[];
  readonly thread?: ReviewThreadSnapshot;
  readonly repositoryDigest: string;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly mentioned?: boolean;
}): ClarificationAssociation {
  if (
    input.event.repositoryDigest !== input.repositoryDigest ||
    input.event.reviewNumber !== input.reviewNumber
  ) {
    return { kind: "ignore" };
  }
  if (input.event.authorIsBot === true) return { kind: "ignore" };

  const parsed = parseAnswerSyntax(input.event.body);
  const threaded = input.event.threadId !== undefined && input.thread !== undefined
    ? input.pending.find((entry) =>
      entry.reviewNumber === input.reviewNumber && threadMatchesQuestion(input.thread!, entry))
    : undefined;
  const bySyntax = parsed === undefined
    ? undefined
    : matchingPending(input.pending, input.reviewNumber, parsed.pendingId);
  const pending = bySyntax ?? threaded;
  if (pending === undefined) return { kind: "ignore" };
  if (clarificationLifecycleState(pending) === "terminal") return { kind: "ignore" };
  if (clarificationLifecycleState(pending) === "answer-observed" && pending.answerEventId !== input.event.eventId) {
    return { kind: "ignore" };
  }

  let answerText: string | undefined;
  if (parsed !== undefined && parsed.pendingId === pending.id) {
    answerText = parsed.answer;
  } else if (
    input.mentioned !== true &&
    input.thread !== undefined &&
    threadMatchesQuestion(input.thread, pending) &&
    firstHumanReply(input.thread, input.event)
  ) {
    answerText = input.event.body.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  }
  if (answerText === undefined || answerText.length === 0) return { kind: "ignore" };

  const answerIdentity = answerIdentityFrom(input.event);
  if (pending.headSha.toLowerCase() !== input.headSha.toLowerCase()) {
    return { kind: "stale", pending, answerText, answerIdentity };
  }
  if (clarificationLifecycleState(pending) === "prepared") return { kind: "ignore" };
  return { kind: "answer", pending, answerText, answerIdentity };
}

export function clarificationQuestionIdentity(input: {
  readonly repository: RepositoryBinding;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly clarificationId: string;
}): { readonly actionId: string; readonly identityDigest: string } {
  const material = [
    input.repository.provider, input.repository.repositoryDigest, String(input.reviewNumber),
    input.headSha.toLowerCase(), input.clarificationId,
  ].join("\0");
  const identityDigest = createHash("sha256").update(`tgd:clarification-publication:v1\0${material}`, "utf8").digest("hex");
  return { actionId: `action_${identityDigest.slice(0, 32)}`, identityDigest };
}

export function clarificationAnswerIdentity(input: {
  readonly repository: RepositoryBinding;
  readonly reviewNumber: number;
  readonly eventId: string;
  readonly clarificationId: string;
}): { readonly actionId: string; readonly identityDigest: string } {
  const material = [
    input.repository.provider, input.repository.repositoryDigest, String(input.reviewNumber),
    input.eventId, input.clarificationId,
  ].join("\0");
  const identityDigest = createHash("sha256").update(`tgd:clarification-answer:v1\0${material}`, "utf8").digest("hex");
  return { actionId: `action_${identityDigest.slice(0, 32)}`, identityDigest };
}
