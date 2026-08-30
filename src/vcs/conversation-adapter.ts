import type {
  BotIdentity,
  ChildMarkerKind,
  ConversationItemIdentity,
  ConversationAnchor,
  RepositoryBinding,
  ReviewBinding,
  ReviewIdentity,
  Sha256Digest,
  StableConversationId,
} from "../conversation/types.js";
import type { RepositoryRef, ReviewProvider } from "../target/types.js";

export const MAX_CURSOR_BYTES = 4_096;
export const MAX_CURSOR_ORDER_KEY_BYTES = 512;
export const MAX_PAGE_TOKEN_BYTES = 4_096;
export const MAX_CURSOR_ENVELOPE_BYTES = MAX_CURSOR_BYTES + 256;
export const MAX_PAGE_TOKEN_ENVELOPE_BYTES = MAX_PAGE_TOKEN_BYTES + 256;

const DIGEST_RE = /^[0-9a-f]{64}$/u;
const HEAD_SHA_RE = /^[0-9a-f]{40,64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export interface ReviewDiscoveryCursor extends RepositoryBinding {
  readonly scope: "open-review-discovery";
  readonly opaque: string;
  readonly orderKey: string;
}

/**
 * Provider-neutral envelope for a provider-owned high-water mark. `opaque` is
 * serializable and bounded by MAX_CURSOR_BYTES. It must never be compared by a
 * caller. `orderKey` is adapter-produced and may be compared lexically only
 * against keys from the same provider and review stream.
 */
export interface ReviewEventCursor extends ReviewBinding {
  readonly scope: "review-events";
  readonly opaque: string;
  readonly orderKey: string;
}

function validateProvider(provider: unknown): asserts provider is ReviewProvider {
  if (provider !== "github" && provider !== "gitlab") throw new Error("invalid cursor provider");
}

function validateRepositoryDigest(digest: unknown): asserts digest is string {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) throw new Error("invalid cursor repository digest");
}

function validateCursorString(value: unknown, name: "opaque" | "orderKey", maximumBytes: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_RE.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`invalid cursor ${name}`);
  }
  // Explicitly exercise JSON serialization: cursor persistence must never
  // depend on provider-specific objects or non-serializable values.
  JSON.stringify(value);
}

function snapshotExactDataProperties(
  value: object,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an invalid prototype`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== "string" || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has unknown or missing own keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} fields must be enumerable data properties, not accessors`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function canonicalJsonBytes(value: unknown, label: string, maximumBytes: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(`${label} JSON envelope exceeds byte limit`);
  }
}

function validateCursorBase(
  cursor: unknown,
  scope: "review-events" | "open-review-discovery",
): Record<string, unknown> {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) throw new Error("invalid cursor envelope");
  const candidate = snapshotExactDataProperties(
    cursor,
    scope === "review-events"
      ? ["scope", "provider", "repositoryDigest", "reviewNumber", "opaque", "orderKey"]
      : ["scope", "provider", "repositoryDigest", "opaque", "orderKey"],
    "cursor envelope",
  );
  if (candidate.scope !== scope) throw new Error(`invalid cursor scope: expected ${scope}`);
  validateProvider(candidate.provider);
  validateRepositoryDigest(candidate.repositoryDigest);
  validateCursorString(candidate.opaque, "opaque", MAX_CURSOR_BYTES);
  validateCursorString(candidate.orderKey, "orderKey", MAX_CURSOR_ORDER_KEY_BYTES);
  canonicalJsonBytes(candidate, "cursor", MAX_CURSOR_ENVELOPE_BYTES);
  return candidate;
}

export function validateReviewDiscoveryCursor(
  cursor: unknown,
  expected?: RepositoryBinding,
): ReviewDiscoveryCursor {
  const candidate = validateCursorBase(cursor, "open-review-discovery");
  if (expected) {
    validateProvider(expected.provider);
    validateRepositoryDigest(expected.repositoryDigest);
    if (candidate.provider !== expected.provider) throw new Error("cursor provider binding mismatch");
    if (candidate.repositoryDigest !== expected.repositoryDigest) throw new Error("cursor repository binding mismatch");
  }
  return {
    scope: "open-review-discovery",
    provider: candidate.provider as ReviewProvider,
    repositoryDigest: candidate.repositoryDigest as string,
    opaque: candidate.opaque as string,
    orderKey: candidate.orderKey as string,
  };
}

export function validateReviewEventCursor(
  cursor: unknown,
  expected?: ReviewBinding,
): ReviewEventCursor {
  const candidate = validateCursorBase(cursor, "review-events") as Partial<ReviewEventCursor>;
  if (!Number.isSafeInteger(candidate.reviewNumber) || (candidate.reviewNumber as number) <= 0) throw new Error("invalid cursor review number");
  if (expected) {
    if (candidate.provider !== expected.provider) throw new Error("cursor provider binding mismatch");
    if (candidate.repositoryDigest !== expected.repositoryDigest) throw new Error("cursor repository binding mismatch");
    if (candidate.reviewNumber !== expected.reviewNumber) throw new Error("cursor review binding mismatch");
  }
  return {
    scope: "review-events",
    provider: candidate.provider!,
    repositoryDigest: candidate.repositoryDigest!,
    reviewNumber: candidate.reviewNumber!,
    opaque: candidate.opaque!,
    orderKey: candidate.orderKey!,
  };
}

export function validateConversationAnchor(anchor: ConversationAnchor): ConversationAnchor {
  if (typeof anchor.file !== "string" || anchor.file.length === 0 || CONTROL_RE.test(anchor.file)) throw new Error("invalid anchor file");
  if (anchor.line !== undefined && (!Number.isSafeInteger(anchor.line) || anchor.line <= 0)) throw new Error("invalid anchor line");
  if (anchor.side !== undefined && anchor.side !== "old" && anchor.side !== "new") throw new Error("invalid anchor side");
  for (const [name, sha] of [["originalHeadSha", anchor.originalHeadSha], ["currentHeadSha", anchor.currentHeadSha]] as const) {
    if (sha !== undefined && !HEAD_SHA_RE.test(sha)) throw new Error(`invalid anchor ${name}`);
  }
  if (anchor.outdated) {
    if (anchor.originalHeadSha === undefined) throw new Error("outdated anchor requires originalHeadSha");
    if (anchor.currentHeadSha === undefined) throw new Error("outdated anchor requires currentHeadSha");
    if (anchor.originalHeadSha === anchor.currentHeadSha) throw new Error("outdated anchor heads must differ");
  }
  return anchor;
}

/** Opaque, bounded continuation token; only the issuing adapter may interpret it. */
export interface OpenReviewPageToken extends RepositoryBinding {
  readonly scope: "open-review-page";
  readonly opaque: string;
}
export interface ReviewEventPageToken extends ReviewBinding {
  readonly scope: "review-event-page";
  readonly opaque: string;
}
export interface ReviewThreadPageToken extends ReviewBinding {
  readonly scope: "review-thread-page";
  readonly opaque: string;
}
export type PageToken = OpenReviewPageToken | ReviewEventPageToken | ReviewThreadPageToken;

function validateOperationPageToken(
  token: unknown,
  scope: PageToken["scope"],
  expected: RepositoryBinding | ReviewBinding,
): PageToken {
  if (typeof token !== "object" || token === null || Array.isArray(token)) throw new Error("invalid page token envelope");
  const reviewScoped = scope !== "open-review-page";
  const candidate = snapshotExactDataProperties(
    token,
    reviewScoped
      ? ["scope", "provider", "repositoryDigest", "reviewNumber", "opaque"]
      : ["scope", "provider", "repositoryDigest", "opaque"],
    "page token envelope",
  ) as Partial<PageToken>;
  if (candidate.scope !== scope) throw new Error(`invalid page token scope: expected ${scope}`);
  validateProvider(candidate.provider);
  validateRepositoryDigest(candidate.repositoryDigest);
  if (
    typeof candidate.opaque !== "string" ||
    candidate.opaque.length === 0 ||
    CONTROL_RE.test(candidate.opaque) ||
    Buffer.byteLength(candidate.opaque, "utf8") > MAX_PAGE_TOKEN_BYTES
  ) {
    throw new Error("invalid page token opaque value");
  }
  canonicalJsonBytes(candidate, "page token", MAX_PAGE_TOKEN_ENVELOPE_BYTES);
  if (candidate.provider !== expected.provider) throw new Error("page token provider binding mismatch");
  if (candidate.repositoryDigest !== expected.repositoryDigest) throw new Error("page token repository binding mismatch");
  if (reviewScoped) {
    const reviewNumber = (candidate as Partial<ReviewEventPageToken>).reviewNumber;
    if (!Number.isSafeInteger(reviewNumber) || (reviewNumber as number) <= 0) throw new Error("invalid page token review number");
    if (!("reviewNumber" in expected) || reviewNumber !== expected.reviewNumber) throw new Error("page token review binding mismatch");
    return { scope, provider: candidate.provider!, repositoryDigest: candidate.repositoryDigest!, reviewNumber: reviewNumber!, opaque: candidate.opaque! } as ReviewEventPageToken | ReviewThreadPageToken;
  }
  return { scope, provider: candidate.provider!, repositoryDigest: candidate.repositoryDigest!, opaque: candidate.opaque! } as OpenReviewPageToken;
}

export const validateOpenReviewPageToken = (token: unknown, expected: RepositoryBinding): OpenReviewPageToken =>
  validateOperationPageToken(token, "open-review-page", expected) as OpenReviewPageToken;
export const validateReviewEventPageToken = (token: unknown, expected: ReviewBinding): ReviewEventPageToken =>
  validateOperationPageToken(token, "review-event-page", expected) as ReviewEventPageToken;
export const validateReviewThreadPageToken = (token: unknown, expected: ReviewBinding): ReviewThreadPageToken =>
  validateOperationPageToken(token, "review-thread-page", expected) as ReviewThreadPageToken;

export interface OpenReviewSummary {
  readonly identity: ReviewIdentity;
  readonly title: string;
  readonly headSha: string;
  readonly updatedAt: string;
  /** Stable adapter ordering key, unique within this listing traversal. */
  readonly orderKey: string;
}

export interface OpenReviewPage {
  readonly reviews: readonly OpenReviewSummary[];
  readonly nextPageToken?: OpenReviewPageToken;
  /** High-water cursor for later listing traversal, if supported by the provider. */
  readonly nextCursor?: ReviewDiscoveryCursor;
}

interface ReviewActivityEventBase extends ReviewBinding {
  readonly eventId: string;
  readonly revisionId: string;
  /** Deterministic adapter key; compare only inside this review's event stream. */
  readonly orderKey: string;
  readonly authorLogin?: string;
  readonly authorIsBot?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
  readonly url: string;
  readonly commentId?: string;
  readonly threadId?: string;
  readonly parentCommentId?: string;
  readonly resolved?: boolean;
  readonly outdated?: boolean;
  readonly placement?: ConversationAnchor;
  /** Provider-authenticated reactions, normalized for review feedback. */
  readonly reactions?: readonly ReviewReaction[];
}

export interface ReviewReaction {
  readonly id: string;
  readonly content: "thumbs-up";
  readonly authorLogin: string;
  readonly authorIsBot: boolean;
  readonly createdAt: string;
}

export type ReviewActivityEvent =
  | (ReviewActivityEventBase & { readonly kind: "general-comment"; readonly commentId: string; readonly authorLogin: string; readonly authorIsBot: boolean })
  | (ReviewActivityEventBase & { readonly kind: "thread-comment"; readonly commentId: string; readonly threadId: string; readonly authorLogin: string; readonly authorIsBot: boolean })
  | (ReviewActivityEventBase & { readonly kind: "thread-resolution"; readonly threadId: string; readonly resolved: boolean; readonly authorLogin?: never; readonly authorIsBot?: never })
  | (ReviewActivityEventBase & { readonly kind: "comment-edit"; readonly commentId: string; readonly editedRevisionId: string; readonly authorLogin: string; readonly authorIsBot: boolean });

export interface ReviewEventPage {
  /** Stable ascending order with no duplicate (eventId, revisionId) pairs. */
  readonly events: readonly ReviewActivityEvent[];
  readonly nextCursor: ReviewEventCursor;
  readonly nextPageToken?: ReviewEventPageToken;
}

export interface ReviewThreadSummary extends ReviewBinding {
  readonly threadId: string;
  readonly rootCommentId: string;
  readonly url: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly updatedAt: string;
  readonly orderKey: string;
  readonly placement?: ConversationAnchor;
}

export interface ReviewThreadPage {
  readonly threads: readonly ReviewThreadSummary[];
  readonly nextPageToken?: ReviewThreadPageToken;
}

export interface ReviewThreadSnapshot extends ReviewThreadSummary {
  /** Complete stable-order history, including edits represented as revisions. */
  readonly events: readonly ReviewActivityEvent[];
}

export interface ChildMarkerLookup extends ReviewBinding {
  readonly kind: ChildMarkerKind;
  readonly parentId: StableConversationId;
  readonly childId: StableConversationId;
  readonly contentDigest: Sha256Digest;
}

export interface GeneralReplyInput extends ReviewBinding {
  readonly body: string;
}

export interface ThreadReplyInput extends GeneralReplyInput {
  readonly threadId: string;
  readonly parentCommentId?: string;
}

/**
 * Conversation APIs compose with VcsAdapter at the application boundary.
 *
 * Trust: identities, bot flags and marker matches are provider-authenticated;
 * raw author names or marker text alone are never sufficient. Pagination:
 * tokens are single-use provider/repository query state, bounded as documented,
 * and pages must neither reorder nor duplicate stable identities. Ordering:
 * callers only compare adapter order keys within the exact stream that issued
 * them; cursors are never timestamps and have no cross-provider ordering.
 */
export interface ConversationAdapter {
  getAuthenticatedBotIdentity(): Promise<BotIdentity>;
  /**
   * Resolve the provider-native review identity (GraphQL node ID / GitLab
   * database ID) for conversation reads. `reviewId` must not be the PR/MR number.
   */
  resolveReviewIdentity(repository: RepositoryRef, reviewNumber: number): Promise<ReviewIdentity>;
  /** Implementations must validate `after` and `pageToken` against `repository`. */
  listOpenReviews(repository: RepositoryBinding, after?: ReviewDiscoveryCursor, pageToken?: OpenReviewPageToken): Promise<OpenReviewPage>;
  /** Implementations must validate `after` against `review` before provider I/O. */
  listReviewEvents(review: ReviewIdentity, after?: ReviewEventCursor, pageToken?: ReviewEventPageToken): Promise<ReviewEventPage>;
  listReviewThreads(review: ReviewIdentity, pageToken?: ReviewThreadPageToken): Promise<ReviewThreadPage>;
  getReviewThread(review: ReviewIdentity, threadId: string): Promise<ReviewThreadSnapshot>;
  postGeneralReply(review: ReviewIdentity, input: GeneralReplyInput): Promise<ConversationItemIdentity>;
  postThreadReply(review: ReviewIdentity, input: ThreadReplyInput): Promise<ConversationItemIdentity>;
  findBotChildMarker(review: ReviewIdentity, marker: ChildMarkerLookup): Promise<ConversationItemIdentity | null>;
  /**
   * Resolve one review thread. Callers must only pass a thread this tool
   * rooted; implementations perform the provider write and do not re-decide
   * that policy.
   */
  resolveReviewThread(review: ReviewIdentity, threadId: string): Promise<void>;
}
