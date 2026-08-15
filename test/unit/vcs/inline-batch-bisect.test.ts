// GitHub's review endpoint is atomic: one comment it dislikes rejects the whole
// review. On PR #281 that cost all 14 inline comments — every finding was
// relocated to the summary because of (at most) one bad anchor.
//
// Bisecting turns "all or nothing" into "everything except the offender".
import { describe, expect, it, vi } from "vitest";
import { bisectRejected } from "../../../src/vcs/inline-batch-bisect.js";

describe("bisectRejected", () => {
  it("posts everything in one request when the batch is accepted", async () => {
    const attempt = vi.fn(async () => "accepted" as const);

    expect(await bisectRejected(4, attempt)).toEqual(new Set());
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith([0, 1, 2, 3]);
  });

  it("isolates the single offender and posts the rest", async () => {
    const attempt = vi.fn(async (indices: readonly number[]) =>
      indices.includes(2) ? ("rejected" as const) : ("accepted" as const),
    );

    expect(await bisectRejected(4, attempt)).toEqual(new Set([2]));

    // Everything except index 2 must have been accepted by some attempt.
    const acceptedIndices = new Set(
      attempt.mock.calls
        .filter(([indices]) => !indices.includes(2))
        .flatMap(([indices]) => [...indices]),
    );
    expect(acceptedIndices).toEqual(new Set([0, 1, 3]));
  });

  it("reports every offender when several are bad", async () => {
    const bad = new Set([1, 5]);
    const attempt = async (indices: readonly number[]) =>
      indices.some((i) => bad.has(i)) ? ("rejected" as const) : ("accepted" as const);

    expect(await bisectRejected(6, attempt)).toEqual(new Set([1, 5]));
  });

  it("reports all of them when every comment is bad", async () => {
    const attempt = async () => "rejected" as const;

    expect(await bisectRejected(3, attempt)).toEqual(new Set([0, 1, 2]));
  });

  it("never re-attempts an index that a previous attempt already posted", async () => {
    const calls: number[][] = [];
    const attempt = async (indices: readonly number[]) => {
      calls.push([...indices]);
      return indices.includes(3) ? ("rejected" as const) : ("accepted" as const);
    };

    await bisectRejected(8, attempt);

    const posted = new Set<number>();
    for (const indices of calls) {
      if (indices.includes(3)) continue;
      for (const index of indices) {
        expect(posted.has(index)).toBe(false);
        posted.add(index);
      }
    }
  });

  it("makes a single attempt for a single rejected comment", async () => {
    const attempt = vi.fn(async () => "rejected" as const);

    expect(await bisectRejected(1, attempt)).toEqual(new Set([0]));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty batch", async () => {
    const attempt = vi.fn(async () => "accepted" as const);

    expect(await bisectRejected(0, attempt)).toEqual(new Set());
    expect(attempt).not.toHaveBeenCalled();
  });

  it("propagates an inconclusive attempt instead of guessing", async () => {
    // A network loss is NOT a rejection: the write may have landed. Guessing
    // "rejected" would duplicate the comment on the retry.
    const attempt = async () => {
      throw new Error("connection reset");
    };

    await expect(bisectRejected(4, attempt)).rejects.toThrow("connection reset");
  });

  it("stays within a bounded number of requests", async () => {
    const attempt = vi.fn(async (indices: readonly number[]) =>
      indices.includes(9) ? ("rejected" as const) : ("accepted" as const),
    );

    await bisectRejected(16, attempt);

    // 1 failed whole-batch attempt, then a binary descent: comfortably under
    // 2 * ceil(log2(n)) + 1. The point is that it cannot degrade to one request
    // per comment for a single offender.
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(11);
  });
});
