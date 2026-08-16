// The scans sort candidate windows by orderKey and then compare those same keys
// against a page cutoff with `<` / `>`. If the two orders differ, a paginated
// scan emits one set and accounts for another — which is exactly how the
// review-event traversal broke its cutoffRank === emittedRank invariant.
import { describe, expect, it } from "vitest";
import { compareOrderKeys } from "../../../src/vcs/adapter.js";

const codepoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

describe("compareOrderKeys", () => {
  // Every pair below is one localeCompare disagrees with — the characters that
  // appear in GitHub's base64url node ids.
  it.each([
    ["underscore vs hyphen", "x_a", "x-a"],
    ["underscore vs letter", "x_a", "xAa"],
    ["case", "A|b", "a|b"],
    ["node-id shape", "PRRT_kwDOTX0Oys6YebU3", "PRRTZkwDOTX0Oys6YebU3"],
    ["digit boundary", "0_9", "0-9"],
  ])("agrees with the cutoff operators for %s", (_name, left, right) => {
    expect(Math.sign(compareOrderKeys(left, right))).toBe(codepoint(left, right));
  });

  it("disagrees with localeCompare, which is why it exists", () => {
    const differing = [["x_a", "x-a"], ["A|b", "a|b"]] as const;
    for (const [left, right] of differing) {
      expect(Math.sign(left.localeCompare(right))).not.toBe(compareOrderKeys(left, right));
    }
  });

  it("sorts a window consistently with a cutoff taken from it", () => {
    const keys = [
      "2026-08-15T14:26:38.000Z|thread-resolution|PRRT_kwDOa|r1",
      "2026-08-15T14:26:38.000Z|thread-resolution|PRRT-kwDOb|r2",
      "2026-08-15T14:26:38.000Z|thread-resolution|PRRTZkwDOc|r3",
      "2026-08-12T06:42:24.000Z|review-comment|00000000000000000000003764157431|r4",
    ];
    const sorted = [...keys].sort(compareOrderKeys);
    const cutoff = sorted[1]!;
    // The count at-or-before the cutoff must equal its position in the sort —
    // the invariant the paginated scans rely on.
    expect(sorted.filter((key) => key <= cutoff)).toHaveLength(2);
  });

  it("is a total order: reflexive, antisymmetric, transitive on a sample", () => {
    const keys = ["a_b", "a-b", "aAb", "azb", "a|b", "a0b"];
    for (const key of keys) expect(compareOrderKeys(key, key)).toBe(0);
    for (const left of keys) {
      for (const right of keys) {
        // Summing avoids Object.is treating -0 and +0 as different.
        expect(compareOrderKeys(left, right) + compareOrderKeys(right, left)).toBe(0);
      }
    }
    const sorted = [...keys].sort(compareOrderKeys);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i - 1]! < sorted[i]!).toBe(true);
  });
});
