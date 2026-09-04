import type { PendingRunMetrics, RunMetrics } from "./types.js";
import { createHash } from "node:crypto";
import {
  bindFindingLedgerIdentity,
  prepareFindingLedgerEntry,
  type FindingLedgerEntry,
  type FindingReviewOptions,
  type FindingSnapshot,
} from "../conversation/state-schema.js";
import {
  buildReviewPublicationGraph,
  executePublication,
  loadPublicationAction,
  type PublicationAction,
  type PublicationChild,
  type PublicationExecutorHooks,
  type PublicationWriteResult,
  type PublicationWriter,
} from "../conversation/publication-manifest.js";
import { computeContentDigest, computeRepositoryDigest, formatChildMarker, parseChildMarker } from "../conversation/markers.js";
import { publicationBody, renderFocusReply } from "../conversation/render.js";
import type { ConversationStateStore } from "../conversation/state-store.js";
import type { RepositoryBinding, ReviewIdentity } from "../conversation/types.js";
import type { ConversationAdapter } from "../vcs/conversation-adapter.js";
import {
  AmbiguousInlinePublishError,
  validateInlinePublishOutcomes,
  type BotComment,
  type InlinePublishOutcome,
  type PullRequestInfo,
  type ReviewLocator,
  type VcsAdapter,
} from "../vcs/adapter.js";
import {
  deriveInlineChildId,
  formatInlineRecoveryMarker,
  formatPendingMarker,
  type InlineRecoveryState,
  type TerminalReviewResult,
} from "./comment-marker.js";
import {
  BOT_SIGNATURE_BLOCK_RE,
  botSignatureBlock,
  exceedsAtomicPayload,
  renderReviewDigest,
} from "./comment-format.js";
import { formatMarker } from "./dedup.js";
import { orchestrate, type OrchestrationResult } from "./orchestrate.js";
import type { Finding } from "./types.js";
import type { RuleDefinition } from "../rules/types.js";

const EXIT_OK = 0;
const EXIT_PARTIAL = 2;

export interface ReviewPublicationStatusLog {
  status: "skipped" | "posted" | "partial";
  findingsCount: number;
  rulesRun: string[];
  rulesFailed: string[];
  reason?: string;
  loadErrors?: string[];
  /** Issue #109: per-run cost/size telemetry; present on runs that dispatched. */
  metrics?: RunMetrics;
  /**
   * Issue #115: rules not dispatched because no changed path matched their
   * declared `applies_to`. Omitted when empty, so an unscoped run keeps its
   * exact pre-existing line shape.
   */
  rulesSkipped?: string[];
}

/**
 * Issue #109 / Codex review of PR #117: freezes the run duration AT the
 * terminal emitter, not where the metrics object was first built. Publication
 * (provider writes, retries, summary updates) is part of what a prompt change
 * can move — more findings mean more inline writes — so a duration frozen
 * before it would corrupt exactly the comparisons the metrics exist for.
 */
export function finalizeRunMetrics(pending: PendingRunMetrics): RunMetrics {
  const { startedAtMs, ...rest } = pending;
  return { ...rest, durationMs: Date.now() - startedAtMs };
}

export interface ReviewPublicationContext {
  readonly vcsAdapter: VcsAdapter;
  readonly locator: ReviewLocator;
  readonly provider: "github" | "gitlab";
  readonly repository: { readonly canonicalUrl: string };
}

export interface PrepareReviewFindingPublicationInput {
  readonly publicationIdentity: { readonly actionId: string; readonly identityDigest: string };
  readonly orchestration: OrchestrationResult;
  readonly storeBinding: RepositoryBinding;
  readonly reviewNumber: number;
  readonly reviewId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly rules: readonly Pick<RuleDefinition, "name" | "body">[];
  readonly reviewOptions: FindingReviewOptions;
  readonly now: string;
  readonly publicRepositoryDigest: string;
  readonly configHash: string;
  readonly summaryBody: string;
  readonly terminalResult?: TerminalReviewResult;
  readonly inlineRecovery?: InlineRecoveryState;
  readonly root?: { readonly kind: "group-reply"; readonly threadId?: string };
}

export function selectedFallbackIds(action: PublicationAction): Set<string> {
  const ids = new Set<string>();
  for (const child of action.children) {
    if (child.kind !== "fallback" || child.status !== "fallback-selected") continue;
    const inline = child.replacesId === undefined
      ? undefined
      : action.children.find((entry) => entry.id === child.replacesId);
    ids.add(inline === undefined ? child.replacesId ?? child.id : clientIdOf(inline));
  }
  return ids;
}

export function clientIdOf(child: PublicationChild): string {
  return child.placement.kind === "inline" && child.placement.clientId !== undefined
    ? child.placement.clientId
    : child.id;
}

export function composeFrozenSummary(
  action: PublicationAction,
  fallbackIds: ReadonlySet<string>,
  marker: string,
  /** Resolved `provider/model` specs, named in the signature this composes. */
  models?: readonly string[],
): string {
  const summary = action.children.find((child) => child.kind === "summary");
  if (summary === undefined) throw new Error("publication manifest is missing the summary child");
  const extras = action.children
    .filter((child) => {
      if (child.kind !== "fallback") return false;
      if (child.status === "fallback-selected") return true;
      const inline = child.replacesId === undefined
        ? undefined
        : action.children.find((entry) => entry.id === child.replacesId);
      const key = inline === undefined ? child.replacesId : clientIdOf(inline);
      return key !== undefined && fallbackIds.has(key);
    })
    .map((child) => child.body);
  // Every piece composed here arrives already signed — the frozen summary body
  // (buildBody signs it) and each relocated finding (a fallback child's body is
  // the rendered INLINE comment, footer included). Left alone, a replayed
  // manifest would show one apparent footer per relocated finding, mid-comment,
  // plus the real one (Codex review). Strip them all and sign once at the end:
  // the signature marks the end of the COMMENT, whatever this path assembled,
  // and the dedup marker stays last.
  const base = stripSignature(summary.body);
  const signature = botSignatureBlock(models);
  const signed = marker.length === 0
    ? signature
    : `${signature}\n\n${marker}`;
  return [base, ...extras.map(stripSignature), signed].join("\n\n");
}

/**
 * Removes the visible signature block — anywhere in the body, not only at the
 * end — so a body can be composed into a larger comment that signs itself once.
 * Machine markers are untouched: a relocated inline body keeps the marker that
 * stale-thread cleanup and recovery read.
 *
 * Only the EXACT block is removed. Finding text cannot contain it: sanitizeText
 * defangs lookalikes into a code span and drops their italics, so the exact byte
 * sequence appears only where a renderer put it. Tolerates a body with none — an
 * older manifest, or a renderer that did not sign.
 */
export function stripSignature(body: string): string {
  // The renderer's own footer is the LAST occurrence, and nothing but machine
  // markers follows it. Anchoring on that is what makes this safe to run over a
  // relocated finding: a `suggestion` is emitted verbatim by design (ADR-007),
  // so it can legitimately contain the exact block — a proposed edit to a
  // Markdown footer, say, including this repository's own README. Removing
  // every occurrence would silently delete that from the proposed fix (Codex
  // review). A body whose only copy sits inside a suggestion is left alone.
  // Matched by SHAPE, not by fixed bytes: the signature now names the model
  // that produced the review, so its length varies. The pattern is the same one
  // the renderer composes from, so the two cannot drift apart.
  let index = -1;
  let length = 0;
  for (const match of body.matchAll(BOT_SIGNATURE_BLOCK_RE)) {
    index = match.index;
    length = match[0].length;
  }
  if (index === -1) return body.trimEnd();
  const after = body.slice(index + length);
  if (!isOnlyWholeLineMarkers(after)) return body.trimEnd();
  // Newlines are normalized only where the block was, so nothing else in the
  // body — a fenced block's own blank lines, say — is reflowed.
  const before = body.slice(0, index).replace(/\n+$/u, "");
  const tail = after.replace(/^\n+/u, "");
  return (tail.length === 0 ? before : `${before}\n\n${tail}`).trimEnd();
}

/** Whitespace and whole-line HTML comments only — the tool's trailing markers.
 *
 * Checked LINE AT A TIME rather than with one regex over the whole region:
 * `/^\s*(?:<!--[^\n]*-->\s*)*$/u` nested a quantifier inside a loop and
 * backtracked exponentially on `--><!--` repetitions (CodeQL js/redos, issue
 * #128), and its `-->` missed HTML's error-tolerant `--!>` end spelling
 * (CodeQL js/bad-tag-filter). One comment per LINE — with several allowed on
 * the same line, as before — and `--!>` accepted, is the same language without
 * the backtracking: each scan is a single linear pass over the line.
 */
const COMMENT_END_RE = /--!?>/u;

/** Exported for the issue #128 linear-parsing regression tests. */
export function isOnlyWholeLineMarkers(region: string): boolean {
  for (const line of region.split("\n")) {
    if (line.trimEnd() === "") continue;
    let rest = line.trimStart();
    while (rest.length > 0) {
      if (!rest.startsWith("<!--")) return false;
      const end = COMMENT_END_RE.exec(rest);
      if (end === null) return false; // an unclosed comment is CONTENT, not a marker
      rest = rest.slice(end.index + end[0].length).trimStart();
    }
  }
  return true;
}

function sameTerminalResult(
  actual: TerminalReviewResult | undefined,
  expected: TerminalReviewResult,
): boolean {
  return actual?.status === expected.status &&
    actual.findingsCount === expected.findingsCount &&
    actual.exitCode === expected.exitCode &&
    actual.rulesRun.length === expected.rulesRun.length &&
    actual.rulesRun.every((rule, index) => rule === expected.rulesRun[index]) &&
    actual.rulesFailed.length === expected.rulesFailed.length &&
    actual.rulesFailed.every((rule, index) => rule === expected.rulesFailed[index]) &&
    (actual.loadErrors?.length ?? 0) === (expected.loadErrors?.length ?? 0) &&
    (actual.loadErrors ?? []).every(
      (error, index) => error === expected.loadErrors?.[index],
    );
}

export function toFindingSnapshot(finding: Finding): FindingSnapshot {
  return {
    file: finding.file,
    severity: finding.severity,
    category: finding.category,
    message: finding.message,
    ruleName: finding.ruleName,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
    ...(finding.decision === undefined ? {} : { decision: finding.decision }),
    ...(finding.question === undefined ? {} : { question: finding.question }),
    ...(finding.title === undefined ? {} : { title: finding.title }),
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    ...(finding.effort === undefined ? {} : { effort: finding.effort }),
    ...(finding.references === undefined ? {} : { references: [...finding.references] }),
  };
}

export function actionableClarificationFinding(finding: Finding): Finding {
  const rest = { ...finding };
  delete rest.question;
  if (rest.decision === "new" || rest.decision === "still-valid") return rest;
  return { ...rest, decision: "still-valid" };
}

export function prepareReviewFindingPublication(
  input: PrepareReviewFindingPublicationInput,
): { readonly preparedFindings: FindingLedgerEntry[]; readonly children: PublicationChild[] } {
  const parentId = `act_${input.publicationIdentity.actionId.slice("action_".length)}`;
  const preparedFindings: FindingLedgerEntry[] = [];
  const inlines = input.orchestration.inlineComments.map((comment, index) => {
    const recovered = input.inlineRecovery?.children[index];
    const contentDigest = recovered?.contentDigest ?? computeContentDigest(comment.body);
    const placementDigest = recovered?.placementDigest ?? createHash("sha256").update(JSON.stringify({
      path: comment.path, line: comment.line, startLine: comment.startLine ?? null,
    }), "utf8").digest("hex");
    const childId = recovered?.childId ?? deriveInlineChildId(parentId, comment.clientId, contentDigest, placementDigest);
    const recoveryMarker = recovered?.marker ?? formatInlineRecoveryMarker({
      kind: "finding",
      parentId,
      childId,
      repositoryDigest: input.publicationIdentity.identityDigest,
      reviewNumber: input.reviewNumber,
      contentDigest,
      headSha: input.headSha,
      placementDigest,
    });
    const findingMarker = formatChildMarker({
      kind: "finding",
      parentId,
      childId,
      repositoryDigest: input.publicRepositoryDigest,
      reviewNumber: input.reviewNumber,
      contentDigest,
    });
    const publishedBody = `${comment.body}${comment.body.endsWith("\n") ? "" : "\n"}${findingMarker}`;
    const finding = input.orchestration.findingByClientId?.get(comment.clientId);
    if (finding !== undefined) {
      const rule = input.rules.find((item) => item.name === finding.ruleName);
      preparedFindings.push(prepareFindingLedgerEntry({
        repository: input.storeBinding,
        id: childId,
        reviewNumber: input.reviewNumber,
        reviewId: input.reviewId,
        baseSha: input.baseSha,
        headSha: input.headSha,
        finding: toFindingSnapshot(finding),
        ruleSnapshot: rule?.body ?? finding.ruleName,
        reviewOptions: input.reviewOptions,
        placement: {
          file: comment.path,
          line: comment.line,
          // The range's first line, so a stored anchor is the whole anchor.
          // Keeping only the endpoint meant a commit touching the start or
          // middle never re-examined the finding (PR #73 review).
          ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
          side: "new",
          originalHeadSha: input.headSha,
          currentHeadSha: input.headSha,
          outdated: false,
        },
        body: comment.body,
        publishedBody,
        at: input.now,
      }));
    }
    return {
      clientId: comment.clientId,
      childId,
      body: publishedBody,
      marker: recoveryMarker,
      file: comment.path,
      line: comment.line,
      startLine: comment.startLine,
      position: comment.position,
    };
  });
  return {
    preparedFindings,
    children: buildReviewPublicationGraph({
      actionId: input.publicationIdentity.actionId,
      summaryBody: input.summaryBody,
      headSha: input.headSha,
      configHash: input.configHash,
      ...(input.root === undefined ? {} : { root: input.root }),
      ...(input.terminalResult === undefined ? {} : { terminalResult: input.terminalResult }),
      inlines,
      fallbacks: inlines.map((inline) => ({ replacesId: inline.childId, body: inline.body })),
    }),
  };
}

async function bindPublishedFindingIdentities(
  store: ConversationStateStore,
  published: PublicationAction,
  preparedFindings?: readonly FindingLedgerEntry[],
): Promise<void> {
  const existing = (await store.readContextSnapshot()).findings;
  const prepared = preparedFindings ?? existing;
  const bound: FindingLedgerEntry[] = [];
  for (const child of published.children) {
    if (child.kind !== "inline" || child.identity === undefined) continue;
    const source = prepared.find((entry) => entry.id === child.id) ?? existing.find((entry) => entry.id === child.id);
    if (source === undefined || source.identity !== undefined) continue;
    if (existing.find((entry) => entry.id === source.id)?.identity !== undefined) continue;
    bound.push(bindFindingLedgerIdentity(source, child.identity));
  }
  if (bound.length === 0) return;
  await store.transact((tx) => {
    for (const entry of bound) tx.appendFinding(entry);
  });
}

export async function persistPreparedFindings(
  store: ConversationStateStore,
  preparedFindings: readonly FindingLedgerEntry[],
): Promise<void> {
  if (preparedFindings.length === 0) return;
  await store.transact((tx) => {
    tx.initializeIfAbsent();
    for (const entry of preparedFindings) {
      if (!tx.snapshot.findings.some((item) => item.id === entry.id)) tx.appendFinding(entry);
    }
  });
}

export async function publishReviewFromManifest(options: {
  readonly action: PublicationAction;
  readonly store: ConversationStateStore;
  readonly context: ReviewPublicationContext;
  readonly pr: PullRequestInfo;
  readonly configHash: string;
  readonly botComment: BotComment | null;
  readonly hooks?: PublicationExecutorHooks;
  readonly now: () => string;
  readonly orchestration?: OrchestrationResult;
  /** Issue #109: per-run cost/size telemetry for the terminal status line. */
  readonly metrics?: PendingRunMetrics;
  /** Issue #115: rules the changed paths did not call for; see the status log. */
  readonly rulesSkipped?: readonly string[];
  readonly loadErrors?: readonly { readonly sourcePath: string; readonly message: string }[];
  readonly buildBody?: (
    o: OrchestrationResult,
    failedIds: ReadonlySet<string>,
    marker?: string,
    providerLimit?: boolean,
    publishFailureReason?: string | ReadonlyMap<string, string>,
  ) => string;
  readonly terminalResult?: TerminalReviewResult;
  readonly inlineRecovery?: InlineRecoveryState;
  readonly preparedFindings?: readonly FindingLedgerEntry[];
  readonly identity?: ReviewIdentity;
  readonly cleanStale?: boolean;
  readonly logStatus?: (log: ReviewPublicationStatusLog) => void;
}): Promise<number> {
  const {
    store, context, pr, configHash, hooks, now, orchestration, buildBody,
  } = options;
  const { vcsAdapter, locator, provider } = context;
  const reviewIdentity = options.identity ?? {
    provider,
    repositoryDigest: computeRepositoryDigest(provider, context.repository.canonicalUrl),
    reviewNumber: Number(pr.id),
    reviewId: pr.reviewId ?? String(pr.id),
    url: `${context.repository.canonicalUrl}${provider === "gitlab" ? "/-/merge_requests/" : "/pull/"}${Number(pr.id)}`,
  };
  let botComment = options.botComment;
  const summaryPlacement = options.action.children.find((child) => child.kind === "summary")?.placement;
  const terminalResult = options.terminalResult ??
    (summaryPlacement?.kind === "summary" ? summaryPlacement.terminalResult : undefined) ??
    botComment?.pendingState?.terminalResult ?? {
      status: "posted" as const,
      findingsCount: options.action.children.filter((child) => child.kind === "inline").length,
      rulesRun: [],
      rulesFailed: [],
      exitCode: 0 as const,
    };
  const inlineRecovery = options.inlineRecovery ?? botComment?.pendingState?.inlineRecovery;
  // Named for what it holds, not for one provider: GitLab results are recorded
  // here too, so the summary can report a GitLab failure reason as readily as a
  // GitHub one. Only the GitHub path READS it for batching — GitLab publishes
  // one child at a time and keeps its existing per-child semantics.
  const inlineResults = new Map<string, PublicationWriteResult>();
  let staleCleaned = options.cleanStale === false;

  const emitStatus = (log: ReviewPublicationStatusLog): void => {
    options.logStatus?.(log);
  };

  // One reason per rejected finding, keyed by the client ID the summary uses.
  // Bisection isolates comments that can fail with different statuses at
  // different paths, and GitLab rejects discussions independently, so a single
  // batch-wide reason would misdescribe most of them. `inlineResults` is keyed
  // by child id, which is not the client id — hence the translation.
  const failureReasons = (action: PublicationAction): Map<string, string> | undefined => {
    const reasons = new Map<string, string>();
    for (const child of action.children) {
      const result = inlineResults.get(child.id);
      if (result?.status === "failed" && result.reason !== undefined) {
        reasons.set(clientIdOf(child), result.reason);
      }
    }
    return reasons.size > 0 ? reasons : undefined;
  };

  const bodyFor = (action: PublicationAction, failedIds: ReadonlySet<string>, marker: string): string => {
    if (orchestration !== undefined && buildBody !== undefined) {
      return buildBody(orchestration, failedIds, marker, undefined, failureReasons(action));
    }
    return composeFrozenSummary(action, failedIds, marker, orchestration?.modelsUsed);
  };

  const summaryIdentityOf = (comment: BotComment) => ({
    provider,
    commentId: comment.id,
    url: provider === "github"
      ? `${context.repository.canonicalUrl}/pull/${Number(pr.id)}#issuecomment-${comment.id}`
      : `${context.repository.canonicalUrl}/-/merge_requests/${Number(pr.id)}#note_${comment.id}`,
  });

  async function cleanStaleThreads(): Promise<void> {
    if (staleCleaned) return;
    staleCleaned = true;
    try {
      const resolved = await vcsAdapter.resolveStaleReviewThreads(locator);
      if (resolved > 0) {
        console.log(`tgd-review-agent: resolved ${resolved} stale inline comment thread(s) from previous runs`);
      }
    } catch (err) {
      console.warn(
        `tgd-review-agent: could not resolve stale inline comment threads (${(err as Error).message}); ` +
          `continuing — old threads stay expanded but this run is unaffected`,
      );
    }
  }

  /**
   * The review body, composed ONCE per run.
   *
   * `payloadFor` runs for every attempt, including each subset the bisect
   * tries, and an accepted subset creates its own review. The digest describes
   * the RUN, so the same bytes stay true on all of them — and memoizing here is
   * what guarantees they ARE the same bytes, with no timestamp or re-sorted set
   * to make two attempts differ (issue #55).
   */
  /**
   * The account the tips must name.
   *
   * The command parser requires the AUTHENTICATED account's exact mention, so a
   * placeholder renders every command in the digest inert on any installation
   * not called `tgdbot` — which is the bring-your-own-token case (PR #72
   * review). Resolved once; a failure drops the tips rather than publishing
   * commands that cannot work.
   */
  let botLogin: string | undefined;
  let botLoginResolved = false;
  async function resolveBotLogin(): Promise<string | undefined> {
    if (botLoginResolved) return botLogin;
    botLoginResolved = true;
    try {
      // Present on the conversation-capable adapters, which is every adapter
      // the CLI constructs; typed narrowly here so a bare VcsAdapter still
      // satisfies the contract.
      const identity = (vcsAdapter as Partial<{
        getAuthenticatedBotIdentity: () => Promise<{ login: string }>;
      }>).getAuthenticatedBotIdentity;
      botLogin = identity === undefined
        ? undefined
        : (await identity.call(vcsAdapter)).login;
    } catch {
      botLogin = undefined;
    }
    return botLogin;
  }

  let reviewDigest: string | undefined;
  function reviewBody(): string | undefined {
    const summary = orchestration?.summaryInput;
    if (summary === undefined) return undefined;
    try {
      reviewDigest ??= composeDigest(summary);
    } catch (error) {
      // The digest is a nicety. It must never be the reason a review fails to
      // post, so a composition failure degrades to the provider's default body
      // rather than propagating into the publication path.
      console.warn(
        `tgd-review-agent: could not compose the review digest (${error instanceof Error ? error.message : String(error)})`,
      );
      return undefined;
    }
    return reviewDigest;
  }

  function composeDigest(summary: OrchestrationResult["summaryInput"]): string {
    return renderReviewDigest({
      headSha: pr.headSha,
      allFindings: summary.allFindings,
      inlineCount: summary.inlineCount,
      unanchored: summary.unanchored,
      ...(summary.publishFailed === undefined ? {} : { publishFailed: summary.publishFailed }),
      filesReviewed: summary.filesReviewed,
      rulesRun: summary.rulesRun,
      rulesFailed: summary.rulesFailed,
      // The summary is upserted before any inline write, so its provider-
      // confirmed identity is available by the time this composes.
      ...(botComment === null ? {} : { summaryUrl: summaryIdentityOf(botComment).url }),
      ...(orchestration?.modelsUsed === undefined ? {} : { models: orchestration.modelsUsed }),
      ...(botLogin === undefined ? {} : { botLogin }),
      // The legend describes the INLINE comments, so it is driven by the
      // findings that become them rather than by every finding.
      inlineFindings: orchestration?.inlineComments
        .map((comment) => orchestration.findingByClientId?.get(comment.clientId))
        .filter((finding): finding is Finding => finding !== undefined) ?? [],
    });
  }

  async function publishInlines(
    action: PublicationAction,
    children: readonly PublicationChild[],
  ): Promise<Map<string, PublicationWriteResult>> {
    const comments = children.map((entry) => toInlineComment(entry, provider));
    // Before the first compose, so the login is part of the memoized bytes.
    await resolveBotLogin();
    const results = new Map<string, PublicationWriteResult>();
    try {
      const outcomes = await vcsAdapter.createInlineReview(
        locator,
        pr.headSha,
        comments,
        inlineRecovery,
        reviewBody(),
      );
      try {
        const shapesValid = (outcomes as readonly unknown[]).every((outcome) => {
          if (typeof outcome !== "object" || outcome === null) return false;
          const candidate = outcome as Record<string, unknown>;
          return typeof candidate.clientId === "string" &&
            (candidate.status === "posted" || candidate.status === "failed") &&
            (candidate.reason === undefined || typeof candidate.reason === "string");
        });
        if (!shapesValid) throw new Error("malformed inline publish outcome");
        const validated = validateInlinePublishOutcomes(
          comments,
          outcomes,
          locator.kind === "repository"
            ? { repo: locator.repo, reviewNumber: locator.number }
            : undefined,
        );
        for (const child of children) {
          const outcome = validated.find((entry) => entry.clientId === clientIdOf(child));
          results.set(child.id, outcome?.status === "posted"
            ? { status: "posted", identity: outcome.identity }
            : { status: "failed", ...(outcome?.reason === undefined ? {} : { reason: outcome.reason }) });
        }
      } catch (err) {
        console.warn(
          `tgd-review-agent: inline review returned invalid outcomes (${(err as Error).message}); ` +
            `rewriting the summary comment to carry every inline finding instead`,
        );
        for (const child of children) results.set(child.id, { status: "failed" });
      }
    } catch (err) {
      if (err instanceof AmbiguousInlinePublishError && inlineRecovery !== undefined) {
        console.warn(
          `tgd-review-agent: GitHub may have accepted the inline review (${err.message}); ` +
            `not duplicating those findings into the summary; a later run will reconcile markers`,
        );
        if (botComment === null) throw new Error("Review publication is missing the summary identity");
        const ambiguousCheckpoint = await vcsAdapter.upsertComment(
          locator,
          bodyFor(action, new Set(children.map((child) => clientIdOf(child))), formatPendingMarker({
            phase: "ambiguous",
            headSha: pr.headSha,
            configHash,
            noteId: botComment.id,
            terminalResult,
            inlineRecovery,
          })),
          botComment,
        );
        if (ambiguousCheckpoint.id !== botComment.id || ambiguousCheckpoint.pendingState?.phase !== "ambiguous") {
          throw new Error("Could not persist ambiguous inline recovery checkpoint");
        }
        throw Object.assign(err, { publicationHalt: true });
      }
      console.warn(
        `tgd-review-agent: could not post inline review comments (${(err as Error).message}); ` +
          `rewriting the summary comment to carry every finding instead`,
      );
      throw err;
    }
    return results;
  }

  const writer: PublicationWriter = {
    async lookupChild(child) {
      if (vcsAdapter.findPublishedMarker !== undefined) {
        const found = await vcsAdapter.findPublishedMarker(locator, child.marker);
        if (found !== null) return found;
      }
      // Bound: the adapters implement this as a CLASS METHOD that reaches for
      // `this.repositoryForReview(...)`. Detaching it made `this` undefined, so
      // every inline lookup threw a TypeError that the executor swallowed into
      // "inline publication failed" — without ever calling the provider.
      const findBotChildMarker = (vcsAdapter as VcsAdapter & Partial<ConversationAdapter>).findBotChildMarker?.bind(vcsAdapter);
      const parsed = parseChildMarker(child.marker)
        ?? parseChildMarker((child.body.split(/\r?\n/u).at(-1) ?? "").trim());
      if (typeof findBotChildMarker === "function" && parsed !== null) {
        const found = await findBotChildMarker(reviewIdentity, {
          provider: reviewIdentity.provider,
          repositoryDigest: parsed.repositoryDigest,
          reviewNumber: parsed.reviewNumber,
          kind: parsed.kind,
          parentId: parsed.parentId,
          childId: parsed.childId,
          contentDigest: parsed.contentDigest,
        });
        if (found !== null) return found;
      }
      if (
        child.kind === "summary" &&
        botComment !== null &&
        botComment.pendingState?.headSha === pr.headSha &&
        botComment.pendingState.configHash === configHash
      ) {
        return summaryIdentityOf(botComment);
      }
      return null;
    },
    async writeChild(child, action) {
      if (child.kind === "summary") {
        const inlineChildren = action.children.filter((entry) => entry.kind === "inline");
        const noFallbackIds = new Set<string>();
        const allInlineIds = new Set(inlineChildren.map((entry) => clientIdOf(entry)));
        if (inlineChildren.length > 0 && provider === "github") {
          if (inlineChildren.length > 100) throw new Error("GitHub inline review exceeds the safe atomic comment count");
          if (exceedsAtomicPayload(inlineChildren.map((entry, index) => ({
            bodyChars: entry.body.length,
            markerChars: inlineRecovery?.children[index]?.marker.length ?? entry.marker.length,
          })))) {
            throw new Error("GitHub inline review exceeds the safe atomic payload size");
          }
        }
        const writtenSummary = await vcsAdapter.upsertComment(
          locator,
          bodyFor(action, noFallbackIds, formatPendingMarker({ phase: "publishing", headSha: pr.headSha, configHash })),
          botComment,
        );
        if (
          !writtenSummary ||
          typeof writtenSummary.id !== "string" ||
          writtenSummary.id.length === 0 ||
          writtenSummary.lastReviewedSha !== "" ||
          writtenSummary.reviewedConfig !== "" ||
          writtenSummary.pendingState?.phase !== "publishing" ||
          writtenSummary.pendingState.headSha !== pr.headSha ||
          writtenSummary.pendingState.configHash !== configHash
        ) {
          throw new Error("The VCS adapter did not return the exact identity of the pending summary note");
        }
        let summaryIdentity = writtenSummary;
        botComment = writtenSummary;
        if (inlineChildren.length > 0) {
          const checkpoint = await vcsAdapter.upsertComment(
            locator,
            bodyFor(action, allInlineIds, formatPendingMarker({
              phase: "ready",
              headSha: pr.headSha,
              configHash,
              noteId: writtenSummary.id,
              terminalResult,
              inlineRecovery,
            })),
            writtenSummary,
          );
          if (
            checkpoint.id !== writtenSummary.id ||
            checkpoint.lastReviewedSha !== "" ||
            checkpoint.reviewedConfig !== "" ||
            checkpoint.pendingState?.phase !== "ready" ||
            checkpoint.pendingState.headSha !== pr.headSha ||
            checkpoint.pendingState.configHash !== configHash ||
            checkpoint.pendingState.noteId !== writtenSummary.id ||
            !sameTerminalResult(checkpoint.pendingState.terminalResult, terminalResult)
          ) {
            throw new Error("The VCS adapter could not confirm the exact ready recovery checkpoint");
          }
          summaryIdentity = checkpoint;
          botComment = checkpoint;
        }
        await cleanStaleThreads();
        return { status: "posted", identity: summaryIdentityOf(summaryIdentity) };
      }
      if (child.kind === "inline") {
        await cleanStaleThreads();
        if (provider === "github") {
          const cached = inlineResults.get(child.id);
          if (cached !== undefined) return cached;
          const pending = action.children.filter((entry) =>
            entry.kind === "inline" && entry.status === "pending" && !inlineResults.has(entry.id));
          const posted = await publishInlines(action, pending);
          for (const [id, result] of posted) inlineResults.set(id, result);
          return inlineResults.get(child.id) ?? { status: "failed" };
        }
        const posted = await publishInlines(action, [child]);
        for (const [id, result] of posted) inlineResults.set(id, result);
        return posted.get(child.id) ?? { status: "failed" };
      }
      return { status: "failed" };
    },
  };

  const finalizePublishedSummary = async (action: PublicationAction): Promise<void> => {
    const finalFallbackIds = selectedFallbackIds(action);
    if (botComment === null) {
      const postedSummary = action.children.find((child) => child.kind === "summary" && child.identity !== undefined);
      if (postedSummary?.identity !== undefined) {
        botComment = {
          id: postedSummary.identity.commentId,
          body: postedSummary.body,
          lastReviewedSha: "",
          reviewedConfig: "",
        };
      }
    }
    if (botComment === null) {
      if (action.state === "completed" || action.state === "superseded") return;
      throw new Error("Review publication is missing the summary identity");
    }
    if (action.children.some((child) => child.kind === "inline")) {
      const selectiveCheckpoint = await vcsAdapter.upsertComment(
        locator,
        bodyFor(action, finalFallbackIds, formatPendingMarker({
          phase: "ready",
          headSha: pr.headSha,
          configHash,
          noteId: botComment.id,
          terminalResult,
        })),
        botComment,
      );
      if (
        selectiveCheckpoint.id !== botComment.id ||
        selectiveCheckpoint.lastReviewedSha !== "" ||
        selectiveCheckpoint.reviewedConfig !== "" ||
        selectiveCheckpoint.pendingState?.phase !== "ready" ||
        selectiveCheckpoint.pendingState.headSha !== pr.headSha ||
        selectiveCheckpoint.pendingState.configHash !== configHash ||
        selectiveCheckpoint.pendingState.noteId !== botComment.id ||
        !sameTerminalResult(selectiveCheckpoint.pendingState.terminalResult, terminalResult)
      ) {
        throw new Error("The VCS adapter could not confirm the exact selective recovery checkpoint");
      }
      botComment = selectiveCheckpoint;
    }
    const finalizedSummary = await vcsAdapter.upsertComment(
      locator,
      bodyFor(action, finalFallbackIds, formatMarker(pr.headSha, configHash)),
      botComment,
    );
    if (
      !finalizedSummary ||
      finalizedSummary.id !== botComment.id ||
      finalizedSummary.lastReviewedSha !== pr.headSha ||
      finalizedSummary.reviewedConfig !== configHash
    ) {
      throw new Error("The VCS adapter could not confirm finalization of the exact completed summary note");
    }
    botComment = finalizedSummary;
  };

  let published: PublicationAction;
  try {
    published = await executePublication({
      store,
      action: options.action,
      writer,
      hooks,
      now,
      strategy: provider === "github" ? "github-atomic" : "gitlab-selective",
      finalize: finalizePublishedSummary,
    });
  } catch (error) {
    if (error instanceof AmbiguousInlinePublishError) {
      emitStatus({
        status: "partial",
        findingsCount: terminalResult.findingsCount,
        rulesRun: [...terminalResult.rulesRun],
        rulesFailed: [...terminalResult.rulesFailed],
        reason: "inline-publication-ambiguous",
        // The run dispatched and paid its full prompt cost, so the ambiguous
        // partial still owes the terminal telemetry (Codex review of PR #117).
        ...(options.metrics === undefined ? {} : { metrics: finalizeRunMetrics(options.metrics) }),
        ...(options.rulesSkipped === undefined || options.rulesSkipped.length === 0
          ? {}
          : { rulesSkipped: [...options.rulesSkipped] }),
      });
      return EXIT_PARTIAL;
    }
    throw error;
  }

  await bindPublishedFindingIdentities(store, published, options.preparedFindings);

  if ((published.state === "completed" || published.state === "superseded") &&
    published.children.length === 0) {
    if (
      botComment !== null &&
      botComment.lastReviewedSha === pr.headSha &&
      botComment.reviewedConfig === configHash
    ) {
      emitStatus({
        status: terminalResult.status,
        findingsCount: terminalResult.findingsCount,
        rulesRun: [...terminalResult.rulesRun],
        rulesFailed: [...terminalResult.rulesFailed],
        loadErrors: terminalResult.loadErrors === undefined ? undefined : [...terminalResult.loadErrors],
        ...(options.metrics === undefined ? {} : { metrics: finalizeRunMetrics(options.metrics) }),
        ...(options.rulesSkipped === undefined || options.rulesSkipped.length === 0
          ? {}
          : { rulesSkipped: [...options.rulesSkipped] }),
        ...(options.orchestration === undefined ? { reason: "recovered-pending-review" } : {}),
      });
      return terminalResult.exitCode;
    }
    throw new Error("completed publication is missing its frozen manifest; refusing to finalize a conservative ready summary");
  }

  const completed = published.state === "completed" ||
    published.children.every((child) => child.status === "posted" || child.status === "failed" ||
      child.status === "fallback-selected");
  if (!completed) return EXIT_PARTIAL;
  emitStatus({
    status: terminalResult.status,
    findingsCount: terminalResult.findingsCount,
    rulesRun: [...terminalResult.rulesRun],
    rulesFailed: [...terminalResult.rulesFailed],
    loadErrors: terminalResult.loadErrors === undefined ? undefined : [...terminalResult.loadErrors],
    ...(options.metrics === undefined ? {} : { metrics: finalizeRunMetrics(options.metrics) }),
        ...(options.rulesSkipped === undefined || options.rulesSkipped.length === 0
          ? {}
          : { rulesSkipped: [...options.rulesSkipped] }),
    ...(options.orchestration === undefined ? { reason: "recovered-pending-review" } : {}),
  });
  return terminalResult.exitCode === 0 ? EXIT_OK : terminalResult.exitCode;
}

// Reduces a POSTED summary back to its content, dropping both trailing tails:
// the marker and, under it, the signature. Callers append content after the
// result, so leaving the signature on would strand it mid-comment and produce a
// second one at the end (Codex review).
export function stripReviewMarker(body: string): string {
  return stripSignature(body
    .replace(/\n*<!-- tgd-review-agent:(?:sha=|pending)[\s\S]*?-->\s*$/u, "")
    .trimEnd());
}

export async function publishConfirmedClarificationFinding(options: {
  readonly store: ConversationStateStore;
  readonly finding: Finding;
  readonly rules: readonly Pick<RuleDefinition, "name" | "body">[];
  readonly reviewOptions: FindingReviewOptions;
  readonly publicationIdentity: { readonly actionId: string; readonly identityDigest: string };
  readonly reviewIdentity: ReviewIdentity;
  readonly context: ReviewPublicationContext;
  readonly pr: PullRequestInfo;
  readonly diff: string;
  readonly now: () => string;
  readonly hooks?: PublicationExecutorHooks;
  /**
   * Issue #79: the host's structural check on the finding about to be
   * published, run against the base as it is NOW.
   *
   * A clarification reassessment returns a freshly generated finding under the
   * same contract the review dispatcher uses, so it may carry a `claim` nobody
   * has checked. The CLI review path checks its claims after dispatch; this
   * path had no equivalent, and a claim with no check simply renders nothing —
   * a missing verification rather than a false one, but still the whole point
   * of the feature going unserved.
   *
   * INJECTED rather than performed here for two reasons. A check needs a base
   * worktree, a repository lock and a filesystem, none of which belong in a
   * module that otherwise only composes and posts comments. And the call sits
   * BELOW the replay-from-manifest return above, so a publication that already
   * exists is re-posted without paying for a clone — the feature's largest
   * single cost (#80) — to recompute a check whose result the manifest already
   * froze.
   *
   * Never throws: the caller degrades a failure to `not-checked` with a reason.
   */
  readonly checkClaim?: (finding: Finding) => Promise<Finding>;
}): Promise<number> {
  const existing = loadPublicationAction(
    (await options.store.readContextSnapshot()).events,
    options.publicationIdentity,
  );
  if (existing !== undefined && (existing.state === "manifest-ready" || existing.state === "published" ||
    existing.state === "completed" || existing.state === "superseded")) {
    const botComment = await options.context.vcsAdapter.findBotComment(options.context.locator);
    const configHash = existing.children.find((child) => child.kind === "summary" && child.placement.kind === "summary")
      ?.placement.kind === "summary"
      ? (existing.children.find((child) => child.kind === "summary")!.placement as { configHash: string }).configHash
      : botComment?.reviewedConfig || options.publicationIdentity.identityDigest.slice(0, 12);
    return publishReviewFromManifest({
      action: existing,
      store: options.store,
      context: options.context,
      pr: options.pr,
      configHash,
      botComment,
      hooks: options.hooks,
      now: options.now,
      identity: options.reviewIdentity,
      cleanStale: false,
    });
  }

  const actionable = actionableClarificationFinding(options.finding);
  // AFTER `actionableClarificationFinding`, so the check sees the finding as it
  // will be published — its decision settled and its question dropped — rather
  // than the reassessment's intermediate form.
  const finding = options.checkClaim === undefined ? actionable : await options.checkClaim(actionable);
  const orchestration = orchestrate({
    findings: [finding],
    rulesRun: [finding.ruleName],
    rulesFailed: [],
  }, options.diff, {
    inline: true,
    suggestions: options.reviewOptions.suggestions !== "off",
    reviewBinding: {
      repositoryDigest: computeRepositoryDigest(options.context.provider, options.context.repository.canonicalUrl),
      reviewNumber: Number(options.pr.id),
      headSha: options.pr.headSha,
    },
  });
  const botComment = await options.context.vcsAdapter.findBotComment(options.context.locator);
  const existingBody = botComment === null ? "" : stripReviewMarker(botComment.body);
  const summaryBody = existingBody.length > 0
    ? (orchestration.summaryInput.unanchored.length > 0
      ? `${existingBody}\n\n${orchestration.commentBody}`
      : existingBody)
    : orchestration.commentBody;
  const configHash = botComment !== null &&
    botComment.lastReviewedSha.toLowerCase() === options.pr.headSha.toLowerCase() &&
    botComment.reviewedConfig.length > 0
    ? botComment.reviewedConfig
    : options.publicationIdentity.identityDigest.slice(0, 12);
  const terminalResult: TerminalReviewResult = {
    status: "posted",
    findingsCount: orchestration.findingsCount,
    rulesRun: orchestration.rulesRun,
    rulesFailed: orchestration.rulesFailed,
    exitCode: 0,
  };
  const prepared = prepareReviewFindingPublication({
    publicationIdentity: options.publicationIdentity,
    orchestration,
    storeBinding: options.store.repositoryBinding,
    reviewNumber: Number(options.pr.id),
    reviewId: options.reviewIdentity.reviewId,
    baseSha: options.pr.baseSha,
    headSha: options.pr.headSha,
    rules: options.rules,
    reviewOptions: options.reviewOptions,
    now: options.now(),
    publicRepositoryDigest: computeRepositoryDigest(
      options.context.provider,
      options.context.repository.canonicalUrl,
    ),
    configHash,
    summaryBody,
    terminalResult,
  });
  await persistPreparedFindings(options.store, prepared.preparedFindings);
  return publishReviewFromManifest({
    action: {
      ...options.publicationIdentity,
      reviewNumber: Number(options.pr.id),
      repository: options.store.repositoryBinding,
      state: existing?.state === "prepared" ? "prepared" : "manifest-ready",
      successorActionId: null,
      children: prepared.children,
    },
    store: options.store,
    context: options.context,
    pr: options.pr,
    configHash,
    botComment,
    hooks: options.hooks,
    now: options.now,
    orchestration,
    terminalResult,
    preparedFindings: prepared.preparedFindings,
    identity: options.reviewIdentity,
    cleanStale: false,
  });
}

/**
 * Publishes a focused review as a reply of its own.
 *
 * A focused run answers the person who asked a narrow question. It must not
 * touch the managed summary or resolve the previous head's threads — doing
 * either would let a narrow question silently rewrite the whole review — so
 * this deliberately does NOT go through publishReviewFromManifest, which is
 * built around upserting that summary and requires one to exist.
 *
 * The reply is a single frozen child, so a crash after an accepted-but-
 * unconfirmed write is reconciled by its marker instead of posting twice.
 */
function toInlineComment(child: PublicationChild, provider: "github" | "gitlab") {
  const markerSuffix = provider === "gitlab" ? `\n${child.marker}` : "";
  return {
    clientId: clientIdOf(child),
    path: child.placement.kind === "inline" ? child.placement.file : "",
    line: child.placement.kind === "inline" ? child.placement.line : 1,
    ...(child.placement.kind === "inline" && child.placement.startLine !== undefined
      ? { startLine: child.placement.startLine }
      : {}),
    position: child.placement.kind === "inline" && child.placement.position !== undefined
      ? child.placement.position
      : {
          oldPath: child.placement.kind === "inline" ? child.placement.file : "",
          newPath: child.placement.kind === "inline" ? child.placement.file : "",
          start: { type: "new" as const, newLine: child.placement.kind === "inline" ? child.placement.line : 1 },
          end: { type: "new" as const, newLine: child.placement.kind === "inline" ? child.placement.line : 1 },
          sameHunk: true as const,
        },
    body: `${child.body}${markerSuffix}`,
  };
}

export async function publishFocusedReview(options: {
  readonly store: ConversationStateStore;
  readonly context: ReviewPublicationContext;
  readonly pr: PullRequestInfo;
  readonly identity: ReviewIdentity;
  readonly repository: RepositoryBinding;
  readonly publicationIdentity: { readonly actionId: string; readonly identityDigest: string };
  readonly direction: string;
  readonly summary: string;
  readonly orchestration: OrchestrationResult;
  readonly rules: readonly Pick<RuleDefinition, "name" | "body">[];
  readonly reviewOptions: FindingReviewOptions;
  readonly baseSha: string;
  readonly configHash: string;
  readonly threadId?: string;
  readonly now: () => string;
  readonly hooks?: PublicationExecutorHooks;
  /** Issue #109: focused commands dispatch every rule, so they emit the same terminal telemetry. */
  readonly metrics?: PendingRunMetrics;
  /** Issue #115: rules the changed paths did not call for; see the status log. */
  readonly rulesSkipped?: readonly string[];
  readonly logStatus?: (log: ReviewPublicationStatusLog) => void;
}): Promise<number> {
  const adapter = options.context.vcsAdapter as unknown as ConversationAdapter;
  const { vcsAdapter, locator, provider } = options.context;
  const publicDigest = computeRepositoryDigest(provider, options.context.repository.canonicalUrl);
  const timestamp = options.now();

  // The narrative becomes a reply rather than the managed summary; everything
  // below it — inline children, their fallbacks, the finding ledger — is the
  // ordinary review graph, so a focused finding is as actionable as any other.
  const prepared = prepareReviewFindingPublication({
    publicationIdentity: options.publicationIdentity,
    orchestration: options.orchestration,
    storeBinding: options.repository,
    reviewNumber: Number(options.pr.id),
    reviewId: options.identity.reviewId,
    baseSha: options.baseSha,
    headSha: options.pr.headSha,
    rules: options.rules,
    reviewOptions: options.reviewOptions,
    now: timestamp,
    publicRepositoryDigest: publicDigest,
    configHash: options.configHash,
    summaryBody: publicationBody(renderFocusReply(
      { direction: options.direction, summary: options.summary },
      focusedReplyMarker(options.publicationIdentity.actionId, publicDigest, Number(options.pr.id), options.summary),
    )),
    root: { kind: "group-reply", ...(options.threadId === undefined ? {} : { threadId: options.threadId }) },
  });
  await persistPreparedFindings(options.store, prepared.preparedFindings);

  const action: PublicationAction = {
    actionId: options.publicationIdentity.actionId,
    identityDigest: options.publicationIdentity.identityDigest,
    reviewNumber: Number(options.pr.id),
    repository: options.repository,
    state: "prepared",
    successorActionId: null,
    children: prepared.children,
  };

  let inlineOutcomes: readonly InlinePublishOutcome[] | undefined;

  /**
   * The review body for a FOCUSED run, composed once.
   *
   * A focused run looked where it was asked to look, so it must not present
   * itself as a whole-PR review (issue #55). It carries no finding counts for
   * the same reason: the reply already restates its findings, and the digest
   * describes rather than repeats.
   */
  let focusedDigest: string | undefined;
  function focusedReviewBody(): string {
    focusedDigest ??= renderReviewDigest({
      headSha: options.pr.headSha,
      allFindings: [],
      inlineCount: prepared.children.filter((entry) => entry.kind === "inline").length,
      unanchored: [],
      filesReviewed: [],
      rulesRun: [],
      rulesFailed: [],
      focusDirection: options.direction,
    });
    return focusedDigest;
  }

  const writer: PublicationWriter = {
    async lookupChild(pending) {
      const parsed = parseChildMarker((pending.body.split(/\r?\n/u).at(-1) ?? "").trim());
      if (parsed === null) return null;
      return adapter.findBotChildMarker(options.identity, {
        provider: options.identity.provider,
        repositoryDigest: parsed.repositoryDigest,
        reviewNumber: parsed.reviewNumber,
        kind: parsed.kind,
        parentId: parsed.parentId,
        childId: parsed.childId,
        contentDigest: parsed.contentDigest,
      });
    },
    async writeChild(pending, current): Promise<PublicationWriteResult> {
      if (pending.kind === "inline") {
        if (inlineOutcomes === undefined) {
          const siblings = current.children.filter((entry) => entry.kind === "inline");
          inlineOutcomes = await vcsAdapter.createInlineReview(
            locator,
            options.pr.headSha,
            siblings.map((entry) => toInlineComment(entry, provider)),
            undefined,
            focusedReviewBody(),
          );
        }
        const mine = inlineOutcomes.find((outcome) => outcome.clientId === clientIdOf(pending));
        if (mine === undefined || mine.status !== "posted") return { status: "failed" };
        return { status: "posted", identity: mine.identity };
      }
      if (pending.kind === "fallback") {
        // A focused run already restates its findings in the reply, so a
        // fallback needs no separate write — it exists so the manifest can
        // reach a terminal state when an inline could not be anchored.
        return { status: "fallback-selected" };
      }
      const input = {
        provider: options.identity.provider,
        repositoryDigest: options.identity.repositoryDigest,
        reviewNumber: options.identity.reviewNumber,
        body: pending.body,
      };
      const written = pending.placement.kind === "group-reply" && pending.placement.threadId !== undefined
        ? await adapter.postThreadReply(options.identity, { ...input, threadId: pending.placement.threadId })
        : await adapter.postGeneralReply(options.identity, input);
      // Take only the identity fields. Whatever else an adapter returns is its
      // own business and must not reach the stored manifest.
      return {
        status: "posted",
        identity: {
          provider: written.provider,
          commentId: written.commentId,
          ...(written.threadId === undefined ? {} : { threadId: written.threadId }),
          url: written.url,
        },
      };
    },
  };

  const published = await executePublication({
    store: options.store,
    action,
    writer,
    now: options.now,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  // Issue #109: a focused command dispatched every rule — its terminal line
  // owes the same telemetry, including the publication time just spent.
  const hasFailure = options.orchestration.rulesFailed.length > 0;
  options.logStatus?.({
    status: hasFailure ? "partial" : "posted",
    findingsCount: options.orchestration.findingsCount,
    rulesRun: [...options.orchestration.rulesRun],
    rulesFailed: [...options.orchestration.rulesFailed],
    ...(options.metrics === undefined ? {} : { metrics: finalizeRunMetrics(options.metrics) }),
        ...(options.rulesSkipped === undefined || options.rulesSkipped.length === 0
          ? {}
          : { rulesSkipped: [...options.rulesSkipped] }),
  });
  return published.state === "completed" ? 0 : 2;
}

/** Marker for the focused reply, bound to the digest of the body it carries. */
function focusedReplyMarker(
  actionId: string,
  publicDigest: string,
  reviewNumber: number,
  summary: string,
): string {
  const childHex = createHash("sha256")
    .update(`tgd:focused-review:v1\0${actionId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return formatChildMarker({
    kind: "action",
    // Ledger IDs and marker IDs use different prefixes for one identity.
    parentId: `act_${actionId.slice("action_".length)}`,
    childId: `out_${childHex}`,
    repositoryDigest: publicDigest,
    reviewNumber,
    contentDigest: computeContentDigest(summary),
  });
}
