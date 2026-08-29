import { createHash } from "node:crypto";
import {
  clarificationQuestionIdentity,
  createPreparedClarification,
  transitionClarification,
} from "./clarification.js";
import { computeContentDigest, formatChildMarker, parseChildMarker } from "./markers.js";
import { childMarkerSuffix, createConversationPublicationChild, renderClarificationQuestion } from "./render.js";
import type {
  ActionState,
  ConversationEventEntry,
  PendingClarification,
  PublicationChildKind,
  PublicationChildStatus,
  PublicationInlinePosition,
  PublicationManifestChild,
  PublicationPlacement,
  PublicationTerminalResult,
} from "./state-schema.js";
import {
  replacePendingClarification,
  type ConversationExclusiveSession,
  type ConversationStateStore,
  type ConversationStateTransaction,
} from "./state-store.js";
import type { ConversationItemIdentity, RepositoryBinding, ReviewIdentity } from "./types.js";
import type { ConversationAdapter } from "../vcs/conversation-adapter.js";

export { clarificationQuestionIdentity };

export type {
  PublicationChildKind,
  PublicationChildStatus,
  PublicationPlacement,
};

export type PublicationChild = PublicationManifestChild;

export interface PublicationAction {
  readonly actionId: string;
  readonly identityDigest: string;
  readonly reviewNumber: number;
  readonly repository: RepositoryBinding;
  readonly state: ActionState;
  readonly successorActionId: string | null;
  readonly children: readonly PublicationChild[];
}

export interface PublicationWriteResult {
  readonly status: "posted" | "failed" | "fallback-selected";
  readonly identity?: ConversationItemIdentity;
  /**
   * The provider's own words for WHY a write failed, carried through to the
   * summary comment. Without it the summary can only say that a finding is not
   * inline, leaving the reader to guess between a bad anchor, a permissions
   * problem, and an outage — the exact ambiguity that made PR #281's summary
   * blame the diff for a rejection.
   */
  readonly reason?: string;
}

export interface PublicationWriter {
  lookupChild(child: PublicationChild): Promise<ConversationItemIdentity | null>;
  writeChild(child: PublicationChild, action: PublicationAction): Promise<PublicationWriteResult>;
}

export interface PublicationExecutorHooks {
  beforePublication?: () => Promise<void>;
  beforeFreeze?: (session: ConversationExclusiveSession, action: PublicationAction) => Promise<void>;
  beforeChildWrite?: (child: PublicationChild) => Promise<void>;
  afterChildWrite?: (child: PublicationChild) => Promise<void>;
  afterPublication?: (action: PublicationAction) => Promise<void>;
  onModelWork?: () => void;
}

export type PublicationStrategy = "sequential" | "github-atomic" | "gitlab-selective";

const STATE_ORDER: readonly ActionState[] = [
  "observed", "prepared", "manifest-ready", "published", "completed",
];

function cloneAction(action: PublicationAction): PublicationAction {
  return {
    actionId: action.actionId,
    identityDigest: action.identityDigest,
    reviewNumber: action.reviewNumber,
    repository: action.repository,
    state: action.state,
    successorActionId: action.successorActionId,
    children: action.children.map((child) => ({ ...child })),
  };
}

function assertTransition(from: ActionState, to: ActionState, empty = false): void {
  if (to === "superseded") {
    if (from === "completed" || from === "superseded") {
      throw new Error(`Impossible action transition from ${from} to ${to}`);
    }
    return;
  }
  if (to === "completed" && from === "observed" && empty) return;
  if (STATE_ORDER.indexOf(to) !== STATE_ORDER.indexOf(from) + 1) {
    throw new Error(`Impossible action transition from ${from} to ${to}`);
  }
}

function assertUniqueChildren(children: readonly PublicationChild[]): void {
  if (new Set(children.map((child) => child.id)).size !== children.length) {
    throw new Error("manifest contains duplicate child IDs");
  }
  if (new Set(children.map((child) => child.marker)).size !== children.length) {
    throw new Error("manifest contains duplicate child markers");
  }
}

function assertChildShape(child: PublicationChild, repository: RepositoryBinding): void {
  if (child.bodyDigest !== computeContentDigest(child.body)) {
    throw new Error("publication child bodyDigest does not match body");
  }
  if (child.identity !== undefined && child.identity.provider !== repository.provider) {
    throw new Error("publication identity provider does not match repository");
  }
}

export function childIsTerminal(
  child: PublicationChild,
  manifest: readonly PublicationChild[],
): boolean {
  if (child.status === "posted" || child.status === "fallback-selected") return true;
  if (child.status === "failed" && child.kind === "fallback") return true;
  if (child.status === "failed" && manifest.some((entry) =>
    entry.kind === "fallback" && entry.replacesId === child.id && entry.status === "fallback-selected")) {
    return true;
  }
  return child.kind === "fallback" &&
    manifest.some((entry) => entry.id === child.replacesId && entry.status === "posted");
}

export function observePublication(input: {
  readonly actionId: string;
  readonly identityDigest: string;
  readonly reviewNumber: number;
  readonly repository: RepositoryBinding;
}): PublicationAction {
  return {
    actionId: input.actionId,
    identityDigest: input.identityDigest,
    reviewNumber: input.reviewNumber,
    repository: input.repository,
    state: "observed",
    successorActionId: null,
    children: [],
  };
}

export function preparePublication(action: PublicationAction): PublicationAction {
  assertTransition(action.state, "prepared");
  if (action.children.length !== 0) throw new Error("prepared action cannot have a publication manifest");
  return { ...cloneAction(action), state: "prepared", children: [] };
}

export function freezePublication(
  action: PublicationAction,
  children: readonly PublicationChild[],
): PublicationAction {
  assertTransition(action.state, "manifest-ready");
  if (action.children.length !== 0) throw new Error("prepared action cannot have a publication manifest");
  assertUniqueChildren(children);
  const frozen = children.map((child) => {
    assertChildShape(child, action.repository);
    if (child.status !== "pending") throw new Error("frozen publication children must start pending");
    return { ...child, status: "pending" as const };
  });
  return { ...cloneAction(action), state: "manifest-ready", children: frozen };
}

export function startPublication(action: PublicationAction): PublicationAction {
  assertTransition(action.state, "published");
  if (action.children.some((child) => child.status !== "pending")) {
    throw new Error("publication manifest status is inconsistent with manifest-ready");
  }
  return { ...cloneAction(action), state: "published" };
}

export function updatePublicationChild(
  action: PublicationAction,
  childId: string,
  update: Partial<PublicationChild> & { readonly status: PublicationChildStatus },
): PublicationAction {
  if (action.state !== "published" && action.state !== "manifest-ready") {
    throw new Error(`Impossible action transition from ${action.state} to child update`);
  }
  const index = action.children.findIndex((child) => child.id === childId);
  if (index < 0) throw new Error("publication child does not exist");
  const current = action.children[index]!;
  const forbidden = (["id", "kind", "body", "bodyDigest", "marker", "placement", "replacesId"] as const)
    .filter((key) => key in update && update[key] !== undefined && update[key] !== current[key]);
  if (forbidden.length > 0) {
    throw new Error("Immutable publication manifest changed: body cannot change after freeze");
  }
  if (update.identity !== undefined && update.identity.provider !== action.repository.provider) {
    throw new Error("publication identity provider does not match repository");
  }
  const nextChildren = action.children.map((child, childIndex) => childIndex === index
    ? {
        ...child,
        status: update.status,
        ...(update.identity === undefined ? {} : { identity: update.identity }),
      }
    : child);
  return { ...cloneAction(action), state: "published", children: nextChildren };
}

export function completePublication(action: PublicationAction): PublicationAction {
  if (action.state !== "published") {
    throw new Error(`Impossible action transition from ${action.state} to completed`);
  }
  if (action.children.some((child) => child.bodyDigest !== computeContentDigest(child.body))) {
    throw new Error("Immutable publication manifest changed: body cannot change after freeze");
  }
  if (action.children.some((child) => !childIsTerminal(child, action.children))) {
    throw new Error("completed action has a child that lacks terminal posted/fallback state");
  }
  return { ...cloneAction(action), state: "completed" };
}

export function supersedePublication(action: PublicationAction, successorActionId: string): PublicationAction {
  const frozenButUnwritten = (action.state === "manifest-ready" || action.state === "published") &&
    action.children.every((child) => child.status === "pending" && child.identity === undefined);
  if (action.state !== "prepared" && !frozenButUnwritten) {
    throw new Error(`Impossible action transition from ${action.state} to superseded`);
  }
  if (successorActionId === action.actionId) {
    throw new Error("superseded action cannot link to itself as successor");
  }
  return {
    ...cloneAction(action),
    state: "superseded",
    successorActionId,
    children: action.state === "prepared" ? [] : action.children.map((child) => ({ ...child })),
  };
}

export function supersedeWithSuccessor(
  action: PublicationAction,
  successor: { readonly actionId: string; readonly identityDigest: string },
): { readonly superseded: PublicationAction; readonly successor: PublicationAction } {
  const next = observePublication({
    actionId: successor.actionId,
    identityDigest: successor.identityDigest,
    reviewNumber: action.reviewNumber,
    repository: action.repository,
  });
  return {
    superseded: supersedePublication(action, successor.actionId),
    successor: preparePublication(next),
  };
}

export function latestPublication(
  events: readonly ConversationEventEntry[],
  actionId: string,
): ConversationEventEntry | undefined {
  let latest: ConversationEventEntry | undefined;
  for (const entry of events) {
    if (entry.actionId === actionId) latest = entry;
  }
  return latest;
}

export function actionFromEvent(entry: ConversationEventEntry): PublicationAction {
  return {
    actionId: entry.actionId,
    identityDigest: entry.identityDigest,
    reviewNumber: entry.reviewNumber,
    repository: entry.repository,
    state: entry.state,
    successorActionId: entry.successorActionId,
    children: entry.manifest,
  };
}

export function eventFromAction(action: PublicationAction, at: string): ConversationEventEntry {
  return {
    version: 1,
    repository: action.repository,
    actionId: action.actionId,
    identityDigest: action.identityDigest,
    reviewNumber: action.reviewNumber,
    state: action.state,
    at,
    successorActionId: action.successorActionId,
    manifest: action.children,
  };
}

export function reviewPublicationIdentity(input: {
  readonly repository: RepositoryBinding;
  readonly reviewNumber: number;
  readonly headSha: string;
  readonly configHash: string;
  readonly commandActionId?: string;
}): { readonly actionId: string; readonly identityDigest: string } {
  const material = [
    input.repository.provider, input.repository.repositoryDigest, String(input.reviewNumber),
    input.headSha.toLowerCase(), input.configHash,
    ...(input.commandActionId === undefined ? [] : [input.commandActionId]),
  ].join("\0");
  const identityDigest = createHash("sha256").update(`tgd:review-publication:v1\0${material}`, "utf8").digest("hex");
  return { actionId: `action_${identityDigest.slice(0, 32)}`, identityDigest };
}

export function clarificationFindingPublicationIdentity(input: {
  readonly repository: RepositoryBinding;
  readonly reviewNumber: number;
  readonly clarificationId: string;
  readonly answerEventId: string;
  readonly headSha: string;
}): { readonly actionId: string; readonly identityDigest: string } {
  const material = [
    input.repository.provider, input.repository.repositoryDigest, String(input.reviewNumber),
    input.clarificationId, input.answerEventId, input.headSha.toLowerCase(),
  ].join("\0");
  const identityDigest = createHash("sha256")
    .update(`tgd:clarification-finding-publication:v1\0${material}`, "utf8")
    .digest("hex");
  return { actionId: `action_${identityDigest.slice(0, 32)}`, identityDigest };
}

function withRepository(action: PublicationAction, repository: RepositoryBinding): PublicationAction {
  return { ...action, repository };
}

async function persistPrefix(
  session: ConversationExclusiveSession,
  action: PublicationAction,
  at: string,
): Promise<PublicationAction> {
  const existing = latestPublication(session.snapshot().events, action.actionId);
  if (existing === undefined) {
    const terminal = await session.findTerminalAction({
      actionId: action.actionId,
      identityDigest: action.identityDigest,
    });
    if (terminal !== undefined) {
      return {
        ...action,
        state: terminal.state,
        successorActionId: terminal.successorActionId,
      };
    }
    const observed = withRepository(observePublication(action), action.repository);
    const prepared = preparePublication(observed);
    const frozen = freezePublication(prepared, action.children);
    await session.commit((tx) => {
      tx.initializeIfAbsent();
      tx.appendEvent(eventFromAction(observed, at));
      tx.appendEvent(eventFromAction(prepared, at));
      tx.appendEvent(eventFromAction(frozen, at));
    });
    return frozen;
  }
  const current = withRepository(actionFromEvent(existing), action.repository);
  if (current.state === "observed") {
    const prepared = preparePublication(current);
    const frozen = freezePublication(prepared, action.children);
    await session.commit((tx) => {
      tx.appendEvent(eventFromAction(prepared, at));
      tx.appendEvent(eventFromAction(frozen, at));
    });
    return frozen;
  }
  if (current.state === "prepared") {
    const frozen = freezePublication(current, action.children);
    await session.commit((tx) => tx.appendEvent(eventFromAction(frozen, at)));
    return frozen;
  }
  return current;
}

async function persistAction(
  session: ConversationExclusiveSession,
  action: PublicationAction,
  at: string,
  extras?: (tx: ConversationStateTransaction) => void,
): Promise<void> {
  const existing = latestPublication(session.snapshot().events, action.actionId);
  if (existing?.state === action.state &&
    JSON.stringify(existing.manifest) === JSON.stringify(action.children) &&
    existing.successorActionId === action.successorActionId) {
    return;
  }
  await session.commit((tx) => {
    tx.appendEvent(eventFromAction(action, at));
    extras?.(tx);
  });
}

async function markPosted(
  action: PublicationAction,
  child: PublicationChild,
  identity: ConversationItemIdentity | undefined,
): Promise<PublicationAction> {
  return updatePublicationChild(action, child.id, {
    status: "posted",
    ...(identity === undefined ? {} : { identity }),
  });
}

async function writeOne(
  action: PublicationAction,
  child: PublicationChild,
  writer: PublicationWriter,
  hooks: PublicationExecutorHooks | undefined,
): Promise<PublicationAction> {
  const recovered = await writer.lookupChild(child);
  if (recovered !== null) {
    return markPosted(action, child, recovered);
  }
  await hooks?.beforeChildWrite?.(child);
  let next: PublicationAction;
  try {
    const result = await writer.writeChild(child, action);
    next = updatePublicationChild(action, child.id, {
      status: result.status,
      ...(result.identity === undefined ? {} : { identity: result.identity }),
    });
  } catch (error) {
    if ((error as { publicationHalt?: unknown } | undefined)?.publicationHalt === true) throw error;
    if (child.kind === "inline" || child.kind === "fallback") {
      const failed = updatePublicationChild(action, child.id, { status: "failed" });
      await hooks?.afterChildWrite?.(child);
      if (child.kind === "fallback") return failed;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { publicationAction: failed });
    }
    throw error;
  }
  await hooks?.afterChildWrite?.(child);
  return next;
}

function isPublicationHalt(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { publicationHalt?: unknown }).publicationHalt === true;
}

function failInlinesSelectFallbacks(action: PublicationAction): PublicationAction {
  let current = action;
  for (const child of action.children) {
    if (child.kind === "inline" && child.status === "pending") {
      current = updatePublicationChild(current, child.id, { status: "failed" });
    }
  }
  for (const child of current.children) {
    if (child.kind === "fallback" && child.status === "pending") {
      current = updatePublicationChild(current, child.id, { status: "fallback-selected" });
    }
  }
  return current;
}

function resolveSelectiveFallbacks(action: PublicationAction): PublicationAction {
  let current = action;
  const failedInlines = new Set(
    current.children.filter((child) => child.kind === "inline" && child.status === "failed").map((child) => child.id),
  );
  for (const child of current.children) {
    if (child.kind !== "fallback" || child.status !== "pending") continue;
    current = updatePublicationChild(current, child.id, {
      status: child.replacesId !== undefined && failedInlines.has(child.replacesId)
        ? "fallback-selected"
        : "failed",
    });
  }
  return current;
}

export async function executePublication(options: {
  readonly store: ConversationStateStore;
  readonly action: PublicationAction;
  readonly writer: PublicationWriter;
  readonly hooks?: PublicationExecutorHooks;
  readonly strategy?: PublicationStrategy;
  readonly now?: () => string;
  readonly finalize?: (action: PublicationAction) => Promise<void>;
  /**
   * Runs inside the transaction that records `completed`. Used so a
   * verification outcome cannot exist without the reply, or vice versa (#89).
   */
  readonly onComplete?: (tx: ConversationStateTransaction) => void;
}): Promise<PublicationAction> {
  const now = options.now ?? (() => new Date().toISOString());
  const strategy = options.strategy ?? "sequential";
  await options.hooks?.beforePublication?.();
  return options.store.withExclusiveLock(async (session) => {
    const repository = session.snapshot().cursor.repository.repositoryDigest.length === 64
      ? session.snapshot().cursor.repository
      : options.action.repository;
    let action = withRepository(options.action, repository);
    if (session.snapshot().cursor.initialized !== true) {
      await session.commit((tx) => { tx.initializeIfAbsent(); });
    }
    const binding = session.snapshot().cursor.repository;
    action = withRepository(action, binding);
    const existing = latestPublication(session.snapshot().events, action.actionId);
    if (existing !== undefined && (actionFromEvent(existing).state === "prepared") && options.hooks?.beforeFreeze) {
      const incomingChildren = action.children;
      await options.hooks.beforeFreeze(session, withRepository(actionFromEvent(existing), binding));
      const after = latestPublication(session.snapshot().events, action.actionId);
      if (after !== undefined && after.state !== "prepared") {
        action = withRepository(actionFromEvent(after), binding);
      } else {
        action = { ...action, children: incomingChildren.length > 0 ? incomingChildren : action.children };
      }
    }
    action = await persistPrefix(session, action.state === "observed" || action.state === "prepared" ||
      action.state === "manifest-ready" || action.state === "published" || action.state === "completed" ||
      action.state === "superseded"
      ? { ...action, children: action.children.length > 0 ? action.children :
        latestPublication(session.snapshot().events, action.actionId)?.manifest ?? action.children }
      : action, now());
    if (action.state === "completed" || action.state === "superseded") return action;
    if (action.state === "manifest-ready") {
      action = startPublication(action);
      await persistAction(session, action, now());
    }
    const pending = () => action.children.filter((child) => child.status === "pending");

    if (strategy === "github-atomic") {
      for (const child of pending().filter((entry) => entry.kind === "summary" || entry.kind === "group-reply" ||
        entry.kind === "general-question")) {
        action = await writeOne(action, child, options.writer, options.hooks);
        await persistAction(session, action, now());
      }
      const inlines = pending().filter((child) => child.kind === "inline");
      if (inlines.length > 0) {
        const first = inlines[0]!;
        await options.hooks?.beforeChildWrite?.(first);
        try {
          for (const child of inlines) {
            const recovered = await options.writer.lookupChild(child);
            if (recovered !== null) {
              action = await markPosted(action, child, recovered);
              continue;
            }
            const result = await options.writer.writeChild(child, action);
            action = updatePublicationChild(action, child.id, {
              status: result.status,
              ...(result.identity === undefined ? {} : { identity: result.identity }),
            });
          }
        } catch (error) {
          if (isPublicationHalt(error)) throw error;
          action = failInlinesSelectFallbacks(action);
        }
        await persistAction(session, action, now());
        await options.hooks?.afterChildWrite?.(first);
      }
      if (action.children.some((child) => child.kind === "fallback" && child.status === "pending")) {
        action = resolveSelectiveFallbacks(action);
        await persistAction(session, action, now());
      }
    } else if (strategy === "gitlab-selective") {
      for (const child of pending().filter((entry) => entry.kind !== "fallback")) {
        try {
          action = await writeOne(action, child, options.writer, options.hooks);
        } catch (error) {
          if (isPublicationHalt(error)) throw error;
          const failed = (error as { publicationAction?: PublicationAction }).publicationAction;
          if (failed === undefined) throw error;
          action = failed;
        }
        await persistAction(session, action, now());
      }
      action = resolveSelectiveFallbacks(action);
      await persistAction(session, action, now());
    } else {
      for (const child of pending().filter((entry) => entry.kind !== "fallback")) {
        action = await writeOne(action, child, options.writer, options.hooks);
        await persistAction(session, action, now());
      }
      action = resolveSelectiveFallbacks(action);
      if (action.children.some((child) => child.kind === "fallback")) {
        await persistAction(session, action, now());
      }
    }

    if (action.state !== "completed") {
      await options.hooks?.afterPublication?.(action);
      await options.finalize?.(action);
      action = completePublication(action);
      await persistAction(session, action, now(), options.onComplete);
    }
    return action;
  });
}

export function loadPublicationAction(
  storeSnapshotEvents: readonly ConversationEventEntry[],
  identity: { readonly actionId: string; readonly identityDigest: string },
): PublicationAction | undefined {
  const latest = latestPublication(storeSnapshotEvents, identity.actionId);
  if (latest === undefined || latest.identityDigest !== identity.identityDigest) return undefined;
  return actionFromEvent(latest);
}

export function buildReviewPublicationGraph(input: {
  readonly actionId: string;
  readonly summaryBody: string;
  readonly headSha: string;
  readonly configHash: string;
  readonly terminalResult?: PublicationTerminalResult;
  readonly inlines: readonly {
    readonly clientId: string;
    readonly childId: string;
    readonly body: string;
    readonly marker: string;
    readonly file: string;
    readonly line: number;
    readonly startLine?: number;
    readonly position?: PublicationInlinePosition;
  }[];
  readonly fallbacks: readonly { readonly replacesId: string; readonly body: string }[];
  /**
   * Publishes the narrative as a reply instead of the managed summary. A
   * focused review needs the same inline and fallback graph as any other, but
   * must not upsert the summary, so only the root child differs.
   */
  readonly root?: { readonly kind: "group-reply"; readonly threadId?: string };
}): PublicationChild[] {
  const summaryId = `output_${createHash("sha256").update(`tgd:review-summary:v1\0${input.actionId}`, "utf8").digest("hex").slice(0, 32)}`;
  const children: PublicationChild[] = [input.root === undefined ? {
    id: summaryId,
    kind: "summary",
    status: "pending",
    body: input.summaryBody,
    bodyDigest: computeContentDigest(input.summaryBody),
    marker: `<!-- tgd-review-summary:${input.actionId} -->`,
    placement: {
      kind: "summary",
      headSha: input.headSha,
      configHash: input.configHash,
      ...(input.terminalResult === undefined ? {} : { terminalResult: input.terminalResult }),
    },
  } : {
    id: summaryId,
    kind: "group-reply",
    status: "pending",
    body: input.summaryBody,
    bodyDigest: computeContentDigest(input.summaryBody),
    marker: `<!-- tgd-review-reply:${input.actionId} -->`,
    placement: input.root.threadId === undefined
      ? { kind: "group-reply" }
      : { kind: "group-reply", threadId: input.root.threadId },
  }];
  for (const inline of input.inlines) {
    children.push({
      id: inline.childId,
      kind: "inline",
      status: "pending",
      body: inline.body,
      bodyDigest: computeContentDigest(inline.body),
      marker: inline.marker,
      placement: {
        kind: "inline",
        file: inline.file,
        line: inline.line,
        ...(inline.startLine === undefined ? {} : { startLine: inline.startLine }),
        clientId: inline.clientId,
        ...(inline.position === undefined ? {} : { position: inline.position }),
      },
    });
  }
  for (const [index, fallback] of input.fallbacks.entries()) {
    const id = `output_${createHash("sha256").update(`tgd:review-fallback:v1\0${input.actionId}\0${fallback.replacesId}`, "utf8").digest("hex").slice(0, 32)}`;
    children.push({
      id,
      kind: "fallback",
      status: "pending",
      body: fallback.body,
      bodyDigest: computeContentDigest(fallback.body),
      marker: `<!-- tgd-review-fallback:${input.actionId}:${index} -->`,
      placement: { kind: "fallback" },
      replacesId: fallback.replacesId,
    });
  }
  return children;
}

export async function executeReviewPublication(options: {
  readonly store: ConversationStateStore;
  readonly action: PublicationAction;
  readonly hooks?: PublicationExecutorHooks;
  readonly now?: () => string;
  readonly finalize?: (action: PublicationAction) => Promise<void>;
  readonly publish: (context: {
    readonly action: PublicationAction;
    readonly hooks?: PublicationExecutorHooks;
    persist(action: PublicationAction): Promise<PublicationAction>;
  }) => Promise<PublicationAction>;
}): Promise<PublicationAction> {
  const now = options.now ?? (() => new Date().toISOString());
  await options.hooks?.beforePublication?.();
  return options.store.withExclusiveLock(async (session) => {
    if (session.snapshot().cursor.initialized !== true) {
      await session.commit((tx) => { tx.initializeIfAbsent(); });
    }
    const binding = session.snapshot().cursor.repository;
    let action = withRepository(options.action, binding);
    action = await persistPrefix(session, action, now());
    if (action.state === "completed" || action.state === "superseded") return action;
    if (action.state === "manifest-ready") {
      action = startPublication(action);
      await persistAction(session, action, now());
    }
    action = await options.publish({
      action,
      hooks: options.hooks,
      persist: async (next) => {
        await persistAction(session, next, now());
        return next;
      },
    });
    if (action.state !== "completed" && action.state !== "superseded" &&
      action.children.every((child) => childIsTerminal(child, action.children))) {
      await options.hooks?.afterPublication?.(action);
      await options.finalize?.(action);
      action = completePublication(action);
      await persistAction(session, action, now());
    }
    return action;
  });
}

export function clarificationQuestionWriter(input: {
  readonly adapter: Pick<ConversationAdapter, "postGeneralReply" | "findBotChildMarker">;
  readonly reviewIdentity: ReviewIdentity;
  readonly writeInline?: (child: PublicationChild) => Promise<PublicationWriteResult | null>;
}): PublicationWriter {
  return {
    async lookupChild(child) {
      const parsed = parseChildMarker((child.body.split(/\r?\n/u).at(-1) ?? "").trim())
        ?? parseChildMarker(child.marker);
      if (parsed === null) return null;
      return input.adapter.findBotChildMarker(input.reviewIdentity, {
        provider: input.reviewIdentity.provider,
        repositoryDigest: parsed.repositoryDigest,
        reviewNumber: parsed.reviewNumber,
        kind: parsed.kind,
        parentId: parsed.parentId,
        childId: parsed.childId,
        contentDigest: parsed.contentDigest,
      });
    },
    async writeChild(child) {
      if (child.placement.kind === "general-question" && child.placement.file !== undefined &&
        child.placement.line !== undefined && input.writeInline !== undefined) {
        const inline = await input.writeInline(child);
        if (inline !== null) return inline;
      }
      const identity = await input.adapter.postGeneralReply(input.reviewIdentity, {
        provider: input.reviewIdentity.provider,
        repositoryDigest: input.reviewIdentity.repositoryDigest,
        reviewNumber: input.reviewIdentity.reviewNumber,
        body: child.body,
      });
      return { status: "posted", identity };
    },
  };
}

export function buildClarificationQuestionChild(input: {
  readonly actionId: string;
  readonly pendingId: string;
  readonly question: string;
  readonly repositoryDigest: string;
  readonly reviewNumber: number;
  readonly file?: string;
  readonly line?: number;
}): PublicationChild {
  const childHex = createHash("sha256")
    .update(`tgd:clarification-question:v1\0${input.actionId}\0${input.pendingId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const childId = `clarification_${childHex}`;
  const markerChildId = `clar_${childHex}`;
  const parentId = `act_${input.actionId.slice("action_".length)}`;
  const provisional = formatChildMarker({
    kind: "clarification",
    parentId,
    childId: markerChildId,
    repositoryDigest: input.repositoryDigest,
    reviewNumber: input.reviewNumber,
    contentDigest: "0".repeat(64),
  });
  const first = renderClarificationQuestion({ question: input.question, pendingId: input.pendingId }, provisional);
  const suffix = childMarkerSuffix(provisional);
  const visible = first.text.endsWith(suffix) ? first.text.slice(0, -suffix.length) : first.text;
  const marker = formatChildMarker({
    kind: "clarification",
    parentId,
    childId: markerChildId,
    repositoryDigest: input.repositoryDigest,
    reviewNumber: input.reviewNumber,
    contentDigest: computeContentDigest(visible),
  });
  return createConversationPublicationChild({
    id: childId,
    kind: "general-question",
    placement: input.file === undefined || input.line === undefined
      ? { kind: "general-question" }
      : { kind: "general-question", file: input.file, line: input.line },
    body: renderClarificationQuestion({ question: input.question, pendingId: input.pendingId }, marker),
    marker: `<!-- tgd-clarification:${input.actionId}:${childId} -->`,
  });
}

export async function publishClarificationQuestion(options: {
  readonly store: ConversationStateStore;
  readonly pending: PendingClarification;
  readonly repository: RepositoryBinding;
  readonly publicRepositoryDigest: string;
  readonly writer: PublicationWriter;
  readonly hooks?: PublicationExecutorHooks;
  readonly now?: () => string;
  readonly file?: string;
  readonly line?: number;
}): Promise<{ readonly action: PublicationAction; readonly pending: PendingClarification }> {
  const now = options.now ?? (() => new Date().toISOString());
  const identity = clarificationQuestionIdentity({
    repository: options.repository,
    reviewNumber: options.pending.reviewNumber,
    headSha: options.pending.headSha,
    clarificationId: options.pending.id,
  });
  const child = buildClarificationQuestionChild({
    actionId: identity.actionId,
    pendingId: options.pending.id,
    question: options.pending.question,
    repositoryDigest: options.publicRepositoryDigest,
    reviewNumber: options.pending.reviewNumber,
    file: options.file,
    line: options.line,
  });
  const prepared = options.pending.state === undefined
    ? createPreparedClarification({
        id: options.pending.id,
        reviewNumber: options.pending.reviewNumber,
        headSha: options.pending.headSha,
        question: options.pending.question,
        createdAt: options.pending.createdAt,
        finding: options.pending.finding ?? {
          file: "unknown",
          severity: "warning",
          category: "correctness",
          message: options.pending.question,
          ruleName: options.pending.ruleName ?? "clarification",
          decision: "needs-clarification",
          question: options.pending.question,
        },
        actionId: identity.actionId,
        identityDigest: identity.identityDigest,
      })
    : {
        ...options.pending,
        actionId: options.pending.actionId ?? identity.actionId,
        identityDigest: options.pending.identityDigest ?? identity.identityDigest,
      };

  await options.store.transact((tx) => {
    tx.initializeIfAbsent();
    const existing = tx.snapshot.pending.clarifications.find((entry) => entry.id === prepared.id);
    if (existing === undefined || existing.state === undefined) {
      tx.replacePending(replacePendingClarification(tx.snapshot.pending, prepared));
    }
  });

  const latest = latestPublication((await options.store.readContextSnapshot()).events, identity.actionId);
  const action: PublicationAction = {
    actionId: identity.actionId,
    identityDigest: identity.identityDigest,
    reviewNumber: options.pending.reviewNumber,
    repository: options.repository,
    state: latest?.state === "manifest-ready" || latest?.state === "published" || latest?.state === "completed"
      ? latest.state
      : "prepared",
    successorActionId: null,
    children: latest !== undefined && latest.manifest.length > 0 ? latest.manifest : [child],
  };
  const published = await executePublication({
    store: options.store,
    action,
    writer: options.writer,
    hooks: options.hooks,
    now,
  });
  const posted = published.children.find((entry) =>
    entry.kind === "general-question" && (entry.status === "posted" || entry.identity !== undefined));
  const current = (await options.store.readContextSnapshot()).pending.clarifications.find((entry) =>
    entry.id === prepared.id) ?? prepared;
  if (posted?.identity !== undefined && current.state !== "published" && current.state !== "answer-observed" &&
    current.state !== "terminal") {
    const next = current.state === "prepared" || current.state === undefined
      ? transitionClarification({ ...current, state: "prepared" }, "published", { identity: posted.identity })
      : current;
    await options.store.transact((tx) => {
      tx.replacePending(replacePendingClarification(tx.snapshot.pending, next));
    });
    return { action: published, pending: next };
  }
  if (posted?.identity !== undefined && current.state === "published" && current.identity === undefined) {
    const next = { ...current, identity: posted.identity };
    await options.store.transact((tx) => {
      tx.replacePending(replacePendingClarification(tx.snapshot.pending, next));
    });
    return { action: published, pending: next };
  }
  return { action: published, pending: current };
}
