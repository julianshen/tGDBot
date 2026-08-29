import { expectTypeOf } from "vitest";
import type {
  ConversationAdapter,
  OpenReviewPage,
  OpenReviewPageToken,
  ReviewEventPageToken,
  ReviewThreadPageToken,
  ReviewDiscoveryCursor,
} from "../../../src/vcs/conversation-adapter.js";
import type { RepositoryBinding, ReviewIdentity } from "../../../src/conversation/types.js";
import type { RepositoryRef } from "../../../src/target/types.js";

expectTypeOf<Parameters<ConversationAdapter["listOpenReviews"]>>().toEqualTypeOf<[
  repository: RepositoryBinding,
  after?: ReviewDiscoveryCursor,
  pageToken?: OpenReviewPageToken,
]>();

expectTypeOf<OpenReviewPage["nextCursor"]>().toEqualTypeOf<ReviewDiscoveryCursor | undefined>();
expectTypeOf<Parameters<ConversationAdapter["listReviewEvents"]>[2]>().toEqualTypeOf<ReviewEventPageToken | undefined>();
expectTypeOf<Parameters<ConversationAdapter["listReviewThreads"]>[1]>().toEqualTypeOf<ReviewThreadPageToken | undefined>();
expectTypeOf<ConversationAdapter["resolveReviewIdentity"]>().toEqualTypeOf<
  (repository: RepositoryRef, reviewNumber: number) => Promise<ReviewIdentity>
>();
expectTypeOf<ConversationAdapter["resolveReviewThread"]>().toEqualTypeOf<
  (review: ReviewIdentity, threadId: string) => Promise<void>
>();
