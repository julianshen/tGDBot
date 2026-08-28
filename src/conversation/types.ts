import type { ReviewProvider } from "../target/types.js";

/** Lowercase hexadecimal SHA-256 digest (exactly 64 characters). */
export type Sha256Digest = string;

/**
 * Stable IDs emitted by tGD use one of these prefixes followed by exactly 32
 * lowercase hexadecimal characters. They are opaque: consumers must not infer
 * ordering or provider identity from them.
 */
export type StableConversationId = string;
export type ActionId = StableConversationId;
export type OutputId = StableConversationId;
export type FindingId = StableConversationId;
export type ClarificationId = StableConversationId;

export interface ConversationItemIdentity {
  readonly provider: ReviewProvider;
  readonly commentId: string;
  readonly threadId?: string;
  readonly url: string;
}

/** Provider-authenticated identity used to distinguish trusted bot commands. */
export interface BotIdentity {
  readonly provider: ReviewProvider;
  /** Validated provider login/username, without a leading @. */
  readonly login: string;
  /** Provider-normalized mention form, including the leading @. */
  readonly mention: string;
}

export type ConversationCommand =
  | { readonly kind: "explain" }
  | { readonly kind: "check-latest" }
  | { readonly kind: "memories" }
  | { readonly kind: "reconsider"; readonly reason: string }
  | { readonly kind: "review-focus"; readonly direction: string }
  | { readonly kind: "remember"; readonly lesson: string }
  | { readonly kind: "forget"; readonly memoryId: string }
  | { readonly kind: "answer"; readonly pendingId: string; readonly answer: string };

export type CommandParseResult =
  | { readonly kind: "irrelevant" }
  | { readonly kind: "invalid"; readonly reason: "unknown" | "multiple" | "malformed" | "oversized" }
  | { readonly kind: "command"; readonly command: ConversationCommand; readonly normalized: string };

export interface RepositoryBinding {
  readonly provider: ReviewProvider;
  readonly repositoryDigest: Sha256Digest;
}

export interface ReviewBinding extends RepositoryBinding {
  readonly reviewNumber: number;
}

export interface ReviewIdentity extends ReviewBinding {
  /** Provider-native stable pull/merge request ID, not its mutable title. */
  readonly reviewId: string;
  readonly url: string;
}

export type DiffSide = "old" | "new";

/**
 * A current anchor may omit heads, or carry equal original/current heads. An
 * original/current heads may differ even while a thread remains current: a
 * later review head does not itself make GitHub's GraphQL thread outdated.
 * An outdated anchor carries both distinct heads.
 */
export interface ConversationAnchor {
  readonly file: string;
  readonly side?: DiffSide;
  /** The LAST line of the anchor, which is what a provider anchors a comment to. */
  readonly line?: number;
  /**
   * The FIRST line, when the finding spans a range.
   *
   * Without it a stored anchor keeps only its endpoint, so a later commit that
   * changes the start or middle of the range leaves the finding unexamined —
   * an addressed finding never re-checked (PR #73 review).
   */
  readonly startLine?: number;
  readonly originalHeadSha?: string;
  readonly currentHeadSha?: string;
  readonly outdated: boolean;
}

export type ConversationPlacement = ConversationAnchor;

export type ChildMarkerKind = "action" | "finding" | "clarification";

export interface ChildMarkerPayload {
  readonly version: 1;
  readonly kind: ChildMarkerKind;
  readonly parentId: StableConversationId;
  readonly childId: StableConversationId;
  readonly repositoryDigest: Sha256Digest;
  readonly reviewNumber: number;
  readonly contentDigest: Sha256Digest;
}

export type ChildMarkerInput = Omit<ChildMarkerPayload, "version"> & {
  readonly version?: 1;
};
