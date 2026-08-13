import { lstat } from "node:fs/promises";
import { computeRepositoryDigest } from "../conversation/markers.js";
import type { ConversationCursorSnapshot, ReviewCursorRecord } from "../conversation/state-schema.js";
import { deriveConversationStatePaths } from "../conversation/state-paths.js";
import type { ConversationStateStore } from "../conversation/state-store.js";
import type { RepositoryBinding, ReviewIdentity } from "../conversation/types.js";
import type { RepositoryRef } from "../target/types.js";
import type {
  ConversationAdapter,
  OpenReviewPageToken,
  ReviewEventCursor,
  ReviewEventPageToken,
} from "../vcs/conversation-adapter.js";

export const MAX_POLL_EVENTS = 200;

export interface StoredReviewProgress {
  readonly reviewId: string;
  readonly url: string;
  readonly eventOpaque: string | null;
  readonly eventOrderKey: string | null;
  readonly lastSeenEpoch: number;
}

export interface OpenReviewScanState {
  readonly epoch: number;
  readonly pageOpaque: string | null;
}

export interface StagedBootstrapReview {
  readonly identity: ReviewIdentity;
  readonly eventCursor: ReviewEventCursor;
}

export function adapterRepositoryBinding(repository: RepositoryRef): RepositoryBinding {
  return {
    provider: repository.provider,
    repositoryDigest: computeRepositoryDigest(repository.provider, repository.canonicalUrl),
  };
}

export async function conversationStateInitialized(
  stateRoot: string,
  repository: RepositoryRef,
): Promise<boolean> {
  const paths = deriveConversationStatePaths(stateRoot, repository);
  try {
    await lstat(paths.cursorPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  return true;
}

export function encodeReviewProgress(progress: StoredReviewProgress): string {
  return JSON.stringify({
    id: progress.reviewId,
    url: progress.url,
    o: progress.eventOpaque,
    k: progress.eventOrderKey,
    e: progress.lastSeenEpoch,
  });
}

export function decodeReviewProgress(cursor: string | null): StoredReviewProgress | null {
  if (cursor === null) return null;
  const value = JSON.parse(cursor) as Partial<{
    id: string;
    url: string;
    o: string | null;
    k: string | null;
    e: number;
  }>;
  if (typeof value.id !== "string" || value.id.length === 0 || typeof value.url !== "string" ||
    value.url.length === 0 || (value.o !== null && typeof value.o !== "string") ||
    (value.k !== null && typeof value.k !== "string") || !Number.isSafeInteger(value.e) ||
    (value.e as number) < 1) {
    throw new Error("Stored review cursor progress is invalid");
  }
  return {
    reviewId: value.id,
    url: value.url,
    eventOpaque: value.o ?? null,
    eventOrderKey: value.k ?? null,
    lastSeenEpoch: value.e as number,
  };
}

export function encodeScanPosition(position: OpenReviewScanState): string {
  return JSON.stringify({ e: position.epoch, p: position.pageOpaque });
}

export function decodeScanPosition(value: string | null): OpenReviewScanState | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as Partial<{ e: number; p: string | null }>;
  if (!Number.isSafeInteger(parsed.e) || (parsed.e as number) < 1 ||
    (parsed.p !== null && typeof parsed.p !== "string")) {
    throw new Error("Stored open-review scan position is invalid");
  }
  return { epoch: parsed.e as number, pageOpaque: parsed.p ?? null };
}

export function reviewIdentityFrom(
  binding: RepositoryBinding,
  reviewNumber: number,
  progress: StoredReviewProgress,
): ReviewIdentity {
  return {
    provider: binding.provider,
    repositoryDigest: binding.repositoryDigest,
    reviewNumber,
    reviewId: progress.reviewId,
    url: progress.url,
  };
}

export function eventCursorFrom(
  binding: RepositoryBinding,
  reviewNumber: number,
  progress: StoredReviewProgress,
): ReviewEventCursor | undefined {
  if (progress.eventOpaque === null || progress.eventOrderKey === null) return undefined;
  return {
    scope: "review-events",
    provider: binding.provider,
    repositoryDigest: binding.repositoryDigest,
    reviewNumber,
    opaque: progress.eventOpaque,
    orderKey: progress.eventOrderKey,
  };
}

export function eventPageTokenFrom(
  binding: RepositoryBinding,
  reviewNumber: number,
  opaque: string | undefined,
): ReviewEventPageToken | undefined {
  if (opaque === undefined) return undefined;
  return {
    scope: "review-event-page",
    provider: binding.provider,
    repositoryDigest: binding.repositoryDigest,
    reviewNumber,
    opaque,
  };
}

export function nextRoundRobinIndex(
  reviews: readonly ReviewCursorRecord[],
  nextRoundRobinKey: string | null,
): number {
  const active = activeReviews(reviews);
  if (active.length === 0) return 0;
  if (nextRoundRobinKey === null) return 0;
  const found = active.findIndex((review) => String(review.reviewNumber) >= nextRoundRobinKey);
  return found === -1 ? 0 : found;
}

export function activeReviews(reviews: readonly ReviewCursorRecord[]): ReviewCursorRecord[] {
  return [...reviews].filter((review) => !review.retired).sort((left, right) =>
    left.reviewNumber - right.reviewNumber);
}

export async function fetchBootstrapStaging(
  adapter: ConversationAdapter,
  binding: RepositoryBinding,
): Promise<readonly StagedBootstrapReview[]> {
  const discovered = new Map<number, ReviewIdentity>();
  let pageToken: OpenReviewPageToken | undefined;
  do {
    const page = await adapter.listOpenReviews(binding, undefined, pageToken);
    for (const item of page.reviews) discovered.set(item.identity.reviewNumber, item.identity);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);

  const staged: StagedBootstrapReview[] = [];
  for (const identity of [...discovered.values()].sort((left, right) =>
    left.reviewNumber - right.reviewNumber)) {
    staged.push({ identity, eventCursor: await currentEventHighWater(adapter, identity) });
  }
  return staged;
}

export async function currentEventHighWater(
  adapter: ConversationAdapter,
  identity: ReviewIdentity,
): Promise<ReviewEventCursor> {
  const after: ReviewEventCursor | undefined = undefined;
  let pageToken: ReviewEventPageToken | undefined;
  let terminal: ReviewEventCursor | undefined;
  do {
    const page = await adapter.listReviewEvents(identity, after, pageToken);
    pageToken = page.nextPageToken;
    if (pageToken === undefined) terminal = page.nextCursor;
  } while (pageToken !== undefined);
  if (terminal === undefined) throw new Error("Review event listing did not return a high-water cursor");
  return terminal;
}

export async function commitBootstrapIfAbsent(
  store: ConversationStateStore,
  staged: readonly StagedBootstrapReview[],
): Promise<"initialized" | "already-initialized"> {
  return store.transact((tx) => {
    if (tx.snapshot.cursor.initialized) return "already-initialized";
    tx.initializeIfAbsent();
    tx.replaceCursor(bootstrapCursor(tx.snapshot.cursor, staged));
    return "initialized";
  });
}

export function bootstrapCursor(
  current: ConversationCursorSnapshot,
  staged: readonly StagedBootstrapReview[],
): ConversationCursorSnapshot {
  return {
    version: 1,
    repository: current.repository,
    initialized: true,
    initializedEpoch: 1,
    openReviewScanPosition: null,
    nextRoundRobinKey: null,
    reviews: staged.map((item) => ({
      reviewNumber: item.identity.reviewNumber,
      cursor: encodeReviewProgress({
        reviewId: item.identity.reviewId,
        url: item.identity.url,
        eventOpaque: item.eventCursor.opaque,
        eventOrderKey: item.eventCursor.orderKey,
        lastSeenEpoch: 1,
      }),
      retired: false,
    })),
  };
}

export async function synchronizeOpenReviews(options: {
  readonly adapter: ConversationAdapter;
  readonly binding: RepositoryBinding;
  readonly store: ConversationStateStore;
  readonly now: () => string;
  readonly dryRun: boolean;
}): Promise<ConversationCursorSnapshot> {
  const initial = await options.store.readContextSnapshot();
  const resume = decodeScanPosition(initial.cursor.openReviewScanPosition);
  const epoch = resume?.epoch ?? nextScanEpoch(initial.cursor);
  let pageToken = resume?.pageOpaque === undefined || resume.pageOpaque === null
    ? undefined
    : openPageToken(options.binding, resume.pageOpaque);
  let working = initial.cursor.reviews.map((review) => ({ ...review }));

  while (true) {
    const page = await options.adapter.listOpenReviews(options.binding, undefined, pageToken);
    working = applyDiscoveredReviews(working, page.reviews, epoch);
    if (page.nextPageToken !== undefined) {
      pageToken = page.nextPageToken;
      if (!options.dryRun) {
        await options.store.transact((tx) => {
          tx.replaceCursor({
            ...tx.snapshot.cursor,
            reviews: mergeReviewRecords(tx.snapshot.cursor.reviews, working),
            openReviewScanPosition: encodeScanPosition({ epoch, pageOpaque: page.nextPageToken!.opaque }),
          });
        });
      }
      continue;
    }
    const retiredAt = options.now();
    working = retireUnseen(working, epoch, retiredAt);
    if (!options.dryRun) {
      await options.store.transact((tx) => {
        tx.replaceCursor({
          ...tx.snapshot.cursor,
          reviews: retireUnseen(mergeReviewRecords(tx.snapshot.cursor.reviews, working), epoch, retiredAt),
          openReviewScanPosition: null,
        });
      });
    }
    break;
  }
  return options.dryRun ? { ...initial.cursor, reviews: working, openReviewScanPosition: null }
    : (await options.store.readContextSnapshot()).cursor;
}

function nextScanEpoch(cursor: ConversationCursorSnapshot): number {
  let maximum = cursor.initializedEpoch;
  for (const review of cursor.reviews) {
    const progress = decodeReviewProgress(review.cursor);
    if (progress !== null && progress.lastSeenEpoch > maximum) maximum = progress.lastSeenEpoch;
  }
  return maximum + 1;
}

function applyDiscoveredReviews(
  reviews: readonly ReviewCursorRecord[],
  discovered: readonly { identity: ReviewIdentity }[],
  epoch: number,
): ReviewCursorRecord[] {
  const byNumber = new Map(reviews.map((review) => [review.reviewNumber, review]));
  for (const item of discovered) {
    const existing = byNumber.get(item.identity.reviewNumber);
    const previous = decodeReviewProgress(existing?.cursor ?? null);
    byNumber.set(item.identity.reviewNumber, {
      reviewNumber: item.identity.reviewNumber,
      cursor: encodeReviewProgress({
        reviewId: item.identity.reviewId,
        url: item.identity.url,
        eventOpaque: previous?.eventOpaque ?? null,
        eventOrderKey: previous?.eventOrderKey ?? null,
        lastSeenEpoch: epoch,
      }),
      retired: false,
      ...(existing?.eventPageToken === undefined ? {} : { eventPageToken: existing.eventPageToken }),
    });
  }
  return [...byNumber.values()].sort((left, right) => left.reviewNumber - right.reviewNumber);
}

function mergeReviewRecords(
  base: readonly ReviewCursorRecord[],
  updates: readonly ReviewCursorRecord[],
): ReviewCursorRecord[] {
  const byNumber = new Map(base.map((review) => [review.reviewNumber, review]));
  for (const update of updates) byNumber.set(update.reviewNumber, update);
  return [...byNumber.values()].sort((left, right) => left.reviewNumber - right.reviewNumber);
}

function retireUnseen(
  reviews: readonly ReviewCursorRecord[],
  epoch: number,
  retiredAt: string,
): ReviewCursorRecord[] {
  return reviews.map((review) => {
    const progress = decodeReviewProgress(review.cursor);
    if (review.retired || (progress?.lastSeenEpoch ?? 0) >= epoch) return review.retired
      ? review
      : {
          reviewNumber: review.reviewNumber,
          cursor: review.cursor,
          retired: false,
          ...(review.eventPageToken === undefined ? {} : { eventPageToken: review.eventPageToken }),
        };
    return { reviewNumber: review.reviewNumber, cursor: review.cursor, retired: true, retiredAt };
  });
}

function openPageToken(binding: RepositoryBinding, opaque: string): OpenReviewPageToken {
  return { scope: "open-review-page", provider: binding.provider, repositoryDigest: binding.repositoryDigest, opaque };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
