// Several rules reviewing the same diff find the SAME defect and describe it in
// their own words. Exact file+line+message dedup cannot see that, so one race
// condition was reported five times on PR #281 — the reader has to work out by
// hand that they are one issue.
//
// Clustering groups them by root-cause identity for PRESENTATION only: every
// member is retained on the cluster, so an over-eager merge nests a finding
// instead of dropping it. That safety property is what lets the similarity
// threshold be tuned for recall rather than precision.
import { describe, expect, it } from "vitest";
import { clusterFindings } from "../../../src/review/finding-clusters.js";
import type { Finding } from "../../../src/review/types.js";

function finding(overrides: Partial<Finding> & { message: string }): Finding {
  return {
    file: "pkg/store/commit.go",
    line: 49,
    severity: "blocking",
    category: "concurrency",
    ruleName: "tgd-review",
    ...overrides,
  };
}

describe("clusterFindings", () => {
  it("groups differently-worded reports of one defect on nearby lines", () => {
    const clusters = clusterFindings([
      finding({ line: 49, ruleName: "distributed-system", message: "Set followed by Get does not select one winner atomically." }),
      finding({ line: 49, ruleName: "mongodb", message: "Set followed by Get does not establish a stable winning key." }),
      finding({ line: 46, ruleName: "performance-and-concurrency", message: "Set-then-Get does not make the fallback atomic." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(3);
    expect(clusters[0]!.rules).toEqual([
      "distributed-system",
      "mongodb",
      "performance-and-concurrency",
    ]);
  });

  it("links a chain: A~B and B~C cluster together even when A and C do not match", () => {
    const clusters = clusterFindings([
      finding({ line: 49, ruleName: "a", message: "Set followed by Get does not select one winner atomically." }),
      finding({ line: 47, ruleName: "b", message: "Set-then-Get does not make the fallback atomic." }),
      finding({ line: 47, ruleName: "c", message: "The Set/Get fallback can still fan out losing bytes at v0." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rules).toEqual(["a", "b", "c"]);
  });

  it("keeps unrelated findings in the same file apart", () => {
    const clusters = clusterFindings([
      finding({ line: 49, message: "Set followed by Get does not select one winner atomically." }),
      finding({ line: 51, message: "Client clock skew can shorten retired-key retention." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("never merges across files, however similar the message", () => {
    const clusters = clusterFindings([
      finding({ file: "a.go", message: "Set followed by Get is not atomic." }),
      finding({ file: "b.go", message: "Set followed by Get is not atomic." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("keeps an identical claim together even when the lines are far apart", () => {
    const clusters = clusterFindings([
      finding({ line: 252, ruleName: "distributed-system", message: "A successful rotation can permanently lose its retired key." }),
      finding({ line: 336, ruleName: "mongodb", message: "A successful rotation can permanently lose its retired key." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.lines).toEqual([252, 336]);
  });

  it("promotes the highest-severity member to representative", () => {
    const clusters = clusterFindings([
      finding({ severity: "warning", ruleName: "w", message: "Set followed by Get is not atomic here." }),
      finding({ severity: "blocking", ruleName: "b", message: "Set followed by Get is not atomic at all." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.representative.severity).toBe("blocking");
    expect(clusters[0]!.representative.ruleName).toBe("b");
  });

  it("collapses exact duplicates into one member", () => {
    const clusters = clusterFindings([
      finding({ ruleName: "a", message: "Identical claim." }),
      finding({ ruleName: "a", message: "Identical claim." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(1);
  });

  // CodeRabbit review of PR #23: exact-duplicate collapsing runs BEFORE
  // clustering, so two rules emitting the very same sentence lost one of the
  // rule names — and corroboration by an independent rule is exactly what the
  // metadata exists to show.
  it("credits every rule that reported an exact duplicate", () => {
    const clusters = clusterFindings([
      finding({ ruleName: "mongodb", message: "Identical claim." }),
      finding({ ruleName: "nats", message: "Identical claim." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rules).toEqual(["mongodb", "nats"]);
  });

  // A Jaccard ratio over two- or three-token claims is noise: these two reduce
  // to the same token set once the single-letter distinguisher is dropped.
  it("keeps short claims apart when they share too little vocabulary", () => {
    const clusters = clusterFindings([
      finding({ line: 10, ruleName: "a", message: "Issue A" }),
      finding({ line: 11, ruleName: "b", message: "Issue B" }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("does not merge two-word messages that share one common word", () => {
    const clusters = clusterFindings([
      finding({ line: 10, ruleName: "a", message: "first finding" }),
      finding({ line: 10, ruleName: "b", message: "second finding" }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("returns one cluster per finding when nothing is similar", () => {
    const clusters = clusterFindings([
      finding({ file: "a.go", message: "Unbounded goroutine per rotation." }),
      finding({ file: "b.go", message: "Compose file hardcodes the retention TTL." }),
      finding({ file: "c.go", message: "Secondary reads can cache a retired key." }),
    ]);

    expect(clusters).toHaveLength(3);
  });

  it("preserves first-seen order of clusters", () => {
    const clusters = clusterFindings([
      finding({ file: "z.go", message: "Later file, first finding." }),
      finding({ file: "a.go", message: "Earlier file, second finding." }),
    ]);

    expect(clusters.map((c) => c.representative.file)).toEqual(["z.go", "a.go"]);
  });

  it("clusters findings that carry no line number", () => {
    const clusters = clusterFindings([
      finding({ line: undefined, ruleName: "a", message: "Set followed by Get is not atomic." }),
      finding({ line: undefined, ruleName: "b", message: "Set followed by Get is not atomic." }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.lines).toEqual([]);
  });

  it("prefers an authored title over the message when judging similarity", () => {
    const clusters = clusterFindings([
      finding({
        ruleName: "a",
        title: "Rotation loses its retired key",
        message: "Completely different prose about mongo write concerns and timeouts.",
      }),
      finding({
        ruleName: "b",
        title: "Rotation loses its retired key",
        message: "Unrelated wording concerning NATS delivery ordering guarantees.",
      }),
    ]);

    expect(clusters).toHaveLength(1);
  });
});
