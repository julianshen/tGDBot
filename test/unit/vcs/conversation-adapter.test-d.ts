import { expectTypeOf } from "vitest";
import type {
  ConversationAdapter,
  OpenReviewPage,
  OpenReviewPageToken,
  ReviewEventPageToken,
  ReviewThreadPageToken,
  ReviewDiscoveryCursor,
} from "../../../src/vcs/conversation-adapter.js";
import type { RepositoryBinding } from "../../../src/conversation/types.js";

expectTypeOf<Parameters<ConversationAdapter["listOpenReviews"]>>().toEqualTypeOf<[
  repository: RepositoryBinding,
  after?: ReviewDiscoveryCursor,
  pageToken?: OpenReviewPageToken,
]>();

expectTypeOf<OpenReviewPage["nextCursor"]>().toEqualTypeOf<ReviewDiscoveryCursor | undefined>();
expectTypeOf<Parameters<ConversationAdapter["listReviewEvents"]>[2]>().toEqualTypeOf<ReviewEventPageToken | undefined>();
expectTypeOf<Parameters<ConversationAdapter["listReviewThreads"]>[1]>().toEqualTypeOf<ReviewThreadPageToken | undefined>();
