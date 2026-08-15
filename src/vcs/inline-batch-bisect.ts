// Recovering an atomic inline-review batch that the provider refused.
//
// GitHub's `POST /pulls/{n}/reviews` is all-or-nothing: one comment it will not
// accept rejects the entire review. The adapter's comment on that endpoint has
// always acknowledged the cost ("GitHub 422s the entire request if any single
// anchor is off the diff") and paid it by relocating EVERY finding to the
// summary. On PR #281 that turned one unhappy comment into fourteen lost inline
// comments.
//
// Bisecting converts that into "post everything except the offender": split the
// batch, retry each half, and recurse only into halves that are still refused.
// A single bad comment out of sixteen costs ~9 requests instead of losing all
// sixteen.
//
// Pure control flow — the caller supplies `attempt`, so this module performs no
// I/O and the recursion is testable on its own.

/**
 * Ceiling on provider requests per bisection.
 *
 * Isolating ONE offender costs about 2·log2(n) attempts, so this is generous
 * for the case bisection exists to serve. It bounds the opposite case: when
 * every comment is refused for a global reason (a stale head SHA, a repo-wide
 * permission change), the recursion would otherwise walk the whole binary tree
 * — roughly 2n-1 requests, ~199 at the caller's 100-comment cap — learning
 * nothing it did not already know from the first rejection.
 */
const DEFAULT_ATTEMPT_BUDGET = 32;

/**
 * Posts the given batch. Resolves `"accepted"` when the provider took every
 * comment in it, `"rejected"` when it definitively refused the batch.
 *
 * MUST throw for anything inconclusive — a timeout, a dropped connection, a 5xx.
 * A lost response is not a rejection: the write may well have landed, and
 * treating it as a rejection would post the comment twice on the next attempt.
 */
export type BatchAttempt = (
  indices: readonly number[],
) => Promise<"accepted" | "rejected">;

/**
 * Posts `count` comments, isolating the ones the provider refuses.
 *
 * Returns the indices that were definitively rejected; every other index has
 * been accepted by exactly one attempt. An index is never submitted twice —
 * once a batch containing it is accepted, that batch is never revisited — so
 * this cannot duplicate a published comment.
 *
 * Inconclusive attempts propagate to the caller untouched. NOTE for callers:
 * by then an earlier batch may already be live, so the rejection thrown here
 * must NOT be turned into "the whole batch failed" — that would duplicate
 * posted comments into the summary. Run marker recovery and let it decide what
 * landed (see GitHubAdapter.createInlineReview).
 */
export async function bisectRejected(
  count: number,
  attempt: BatchAttempt,
  maxAttempts = DEFAULT_ATTEMPT_BUDGET,
): Promise<Set<number>> {
  const rejected = new Set<number>();
  if (count <= 0) return rejected;

  let attempts = 0;
  const publish = async (indices: readonly number[]): Promise<void> => {
    if (indices.length === 0) return;
    if (attempts >= maxAttempts) {
      // Budget spent. Report the remainder as rejected: those findings then
      // travel to the summary, which is the same place they were headed before
      // bisection existed. Cost is bounded; no finding is lost.
      for (const index of indices) rejected.add(index);
      return;
    }
    attempts += 1;
    if (await attempt(indices) === "accepted") return;

    // A rejected batch of one names its own offender; there is nothing left to
    // split, and the caller reports it as failed rather than losing its sibling.
    if (indices.length === 1) {
      rejected.add(indices[0]!);
      return;
    }

    const middle = Math.floor(indices.length / 2);
    await publish(indices.slice(0, middle));
    await publish(indices.slice(middle));
  };

  await publish(Array.from({ length: count }, (_, index) => index));
  return rejected;
}
