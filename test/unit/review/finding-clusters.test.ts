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
import { clusterFindings, crossFileGroups } from "../../../src/review/finding-clusters.js";
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

// Issue #37: rule prompts push each rule into its OWN domain vocabulary, which
// works directly against prose similarity. On hmchangw/newchat#188 six findings
// described one revocation-propagation defect as a consistency problem, a
// security problem, an ordering problem and an idempotency problem — sharing
// almost no words, and so staying six separate entries.
//
// What they DO share is the code they name. Identifiers come from the source,
// not from the rule's vocabulary, so two rules describing the same defect name
// the same symbols however differently they phrase the claim.
describe("clusterFindings — shared identifiers", () => {
  it("groups same-file findings that share code identifiers but almost no prose", () => {
    const clusters = clusterFindings([
      finding({
        line: 120,
        ruleName: "distributed-system",
        message: "`readL2` returns before consulting `FetchFromMongo`, so a revocation is invisible.",
      }),
      finding({
        line: 205,
        ruleName: "cassandra",
        message: "Extending the entry keeps stale history access alive; `FetchFromMongo` never runs while `readL2` hits.",
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.rules).toEqual(["distributed-system", "cassandra"]);
  });

  // One shared symbol is co-occurrence, not corroboration: half the findings in
  // a file will name the function the file is about.
  it("keeps findings apart when they share only one identifier", () => {
    const clusters = clusterFindings([
      finding({ line: 120, message: "`readL2` returns a stale entry." }),
      finding({ line: 400, message: "`readL2` is called without a timeout budget." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  // Ubiquitous names appear in every Go file alive and say nothing about WHICH
  // defect is meant.
  it("ignores identifiers too common to identify a defect", () => {
    const clusters = clusterFindings([
      finding({ line: 120, message: "The `err` value is discarded before `ctx` is checked." }),
      finding({ line: 400, message: "A nil `ctx` reaches the retry loop while `err` is shadowed." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  // The cross-file gate is NOT relaxed by this signal. Only the cluster's
  // representative receives an inline comment, so merging across files would
  // move a finding's comment off the file it is about — see orchestrate.ts.
  it("still never merges across files, however many identifiers match", () => {
    const clusters = clusterFindings([
      finding({ file: "a.go", message: "`readL2` skips `FetchFromMongo` and `SetJSONWithTTL` entirely." }),
      finding({ file: "b.go", message: "`SetJSONWithTTL` races `FetchFromMongo` after `readL2` misses." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  // Identifiers corroborate; they do not license merging unrelated claims that
  // merely mention the same well-known symbol pair in passing.
  it("keeps every member when an identifier merge happens", () => {
    const clusters = clusterFindings([
      finding({ line: 120, severity: "warning", message: "`readL2` returns before `FetchFromMongo` runs." }),
      finding({ line: 205, severity: "blocking", message: "Sliding keeps `readL2` hitting, so `FetchFromMongo` never revalidates." }),
    ]);

    expect(clusters[0]?.members).toHaveLength(2);
    expect(clusters[0]?.representative.severity).toBe("blocking");
  });
});

// PR #42 review: the safeguard is "two independently named symbols", but a
// single quoted span can yield several tokens — `Cache.readL2` splits into two
// — so one shared symbol reference could satisfy it on its own.
describe("clusterFindings — one symbol is one signal", () => {
  it("does not merge two findings that share a single qualified symbol", () => {
    const clusters = clusterFindings([
      finding({ line: 120, message: "`Cache.readL2` returns a stale entry." }),
      finding({ line: 400, message: "`Cache.readL2` is called without a timeout budget." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("does not merge on a single shared compound key", () => {
    const clusters = clusterFindings([
      finding({ line: 120, message: "The `sub:{roomID}:{account}` entry is written unconditionally." }),
      finding({ line: 400, message: "Nothing bounds the size of `sub:{roomID}:{account}`." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  // Reviewers quote the same symbol at different qualifications, so matching
  // still has to work token-wise across `readL2` and `Cache.readL2` — it is the
  // COUNT that must be per-symbol, not the matching.
  it("still merges when two distinct symbols match at different qualifications", () => {
    const clusters = clusterFindings([
      finding({ line: 120, message: "`readL2` returns before `FetchFromMongo` runs." }),
      finding({ line: 400, message: "`Cache.readL2` hits, so `Store.FetchFromMongo` never revalidates." }),
    ]);

    expect(clusters).toHaveLength(1);
  });
});


// Issue #48: a defect spread across files stays several inline comments, one
// per file — deliberately, since only a cluster's representative gets an inline
// comment and merging across files would move a comment off the file it is
// about. The relationship is described in the SUMMARY instead, where nothing
// has to move.
describe("crossFileGroups", () => {
  const idFinding = (file: string, message: string, overrides: Partial<Finding> = {}) =>
    finding({ file, message, ...overrides });

  it("groups findings in different files that name the same code", () => {
    const groups = crossFileGroups([
      idFinding("cache.go", "`readL2` returns before `FetchFromMongo` runs."),
      idFinding("loader.go", "A secondary read repopulates via `FetchFromMongo` after `readL2` misses."),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
  });

  // Prose similarity is the signal that failed on #188 — different rules
  // describe one defect in different vocabularies. Only identifiers cross files.
  it("does not group on prose similarity alone", () => {
    const groups = crossFileGroups([
      idFinding("a.go", "Set followed by Get is not atomic."),
      idFinding("b.go", "Set followed by Get is not atomic."),
    ]);

    expect(groups).toEqual([]);
  });

  it("requires two independently named symbols, as same-file clustering does", () => {
    const groups = crossFileGroups([
      idFinding("a.go", "`readL2` is slow."),
      idFinding("b.go", "`readL2` is called twice."),
    ]);

    expect(groups).toEqual([]);
  });

  // A group entirely inside one file is already collapsed into a single inline
  // comment, so repeating it in the summary would be noise.
  it("ignores a group that does not span files", () => {
    const groups = crossFileGroups([
      idFinding("a.go", "`readL2` skips `FetchFromMongo`."),
      idFinding("a.go", "`FetchFromMongo` never runs while `readL2` hits."),
    ]);

    expect(groups).toEqual([]);
  });

  it("returns nothing when every finding stands alone", () => {
    expect(crossFileGroups([idFinding("a.go", "`readL2` skips `FetchFromMongo`.")])).toEqual([]);
  });

  it("promotes the highest-severity member as the group's headline", () => {
    const groups = crossFileGroups([
      idFinding("a.go", "`readL2` skips `FetchFromMongo`.", { severity: "warning" }),
      idFinding("b.go", "`FetchFromMongo` races `readL2`.", { severity: "blocking" }),
    ]);

    expect(groups[0]?.representative.severity).toBe("blocking");
    expect(groups[0]?.members).toHaveLength(2);
  });
});


// PR #53 review. The bar is "two independently named symbols", but signals were
// collected per OCCURRENCE — and a finding naturally names its symbol twice,
// once in the title and again in the message. Two such findings then cleared a
// two-symbol threshold on the strength of one shared symbol.
describe("clusterFindings — one symbol stays one signal however often it appears", () => {
  it("does not merge two findings that share a single symbol named twice each", () => {
    const clusters = clusterFindings([
      finding({
        line: 120,
        title: "`readL2` returns a stale entry.",
        message: "`readL2` returns before the loader runs.",
      }),
      finding({
        line: 400,
        title: "`readL2` lacks a timeout.",
        message: "`readL2` is called without a budget.",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  // The same symbol at two qualifications is still one symbol.
  it("treats a qualified and bare reference to one symbol as a single signal", () => {
    const clusters = clusterFindings([
      finding({ line: 120, title: "`Cache.readL2` is stale.", message: "`readL2` returns early." }),
      finding({ line: 400, title: "`readL2` is slow.", message: "`Cache.readL2` blocks." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  // Two genuinely distinct symbols still corroborate, however often each is named.
  it("still merges on two distinct symbols repeated across title and message", () => {
    const clusters = clusterFindings([
      finding({
        line: 120,
        title: "`readL2` skips `FetchFromMongo`.",
        message: "`readL2` returns before `FetchFromMongo` runs.",
      }),
      finding({
        line: 400,
        title: "`FetchFromMongo` never revalidates.",
        message: "Sliding keeps `readL2` hitting, so `FetchFromMongo` is skipped.",
      }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it("applies the same counting across files", () => {
    expect(crossFileGroups([
      finding({ file: "a.go", title: "`readL2` is stale.", message: "`readL2` returns early." }),
      finding({ file: "b.go", title: "`readL2` is slow.", message: "`readL2` blocks." }),
    ])).toEqual([]);
  });
});


// PR #53 review. Folding any two references that share a token was too eager:
// `Cache.readL2` and `Cache.writeL2` share only their RECEIVER and are two
// different methods. Collapsing them lost a genuine two-symbol match.
describe("clusterFindings — a receiver is not the symbol", () => {
  it("treats two methods on one receiver as two symbols", () => {
    const clusters = clusterFindings([
      finding({ line: 120, message: "`Cache.readL2` and `Cache.writeL2` disagree about staleness." }),
      finding({ line: 400, message: "`Cache.writeL2` races `Cache.readL2` during eviction." }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it("still folds a bare and a qualified mention of ONE method", () => {
    const clusters = clusterFindings([
      finding({ line: 120, title: "`Cache.readL2` is stale.", message: "`readL2` returns early." }),
      finding({ line: 400, title: "`readL2` is slow.", message: "`Cache.readL2` blocks." }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("groups across files on two sibling methods", () => {
    expect(crossFileGroups([
      finding({ file: "a.go", message: "`Cache.readL2` skips `Cache.writeL2`." }),
      finding({ file: "b.go", message: "`Cache.writeL2` runs before `Cache.readL2`." }),
    ])).toHaveLength(1);
  });
});


// PR #53 review, the mirror of the previous fix. Identifying a symbol by its
// terminal alone lost the receiver, so two methods with a common name on
// DIFFERENT receivers matched. Both corrections have to hold at once: a bare
// mention still folds into its qualified form, and two qualified references
// only match when their receivers agree.
describe("clusterFindings — receivers separate look-alike methods", () => {
  it("does not group look-alike methods on different receivers", () => {
    expect(crossFileGroups([
      finding({ file: "a.go", message: "`UserCache.loadEntry` races `UserCache.storeEntry`." }),
      finding({ file: "b.go", message: "`ConfigCache.loadEntry` races `ConfigCache.storeEntry`." }),
    ])).toEqual([]);
  });

  it("groups them when the receiver does agree", () => {
    expect(crossFileGroups([
      finding({ file: "a.go", message: "`UserCache.loadEntry` races `UserCache.storeEntry`." }),
      finding({ file: "b.go", message: "`UserCache.storeEntry` runs before `UserCache.loadEntry`." }),
    ])).toHaveLength(1);
  });

  // The earlier correction must survive: a bare mention is compatible with any
  // qualification of the same name, because the reviewer simply did not say.
  it("still lets a bare mention match its qualified form", () => {
    expect(crossFileGroups([
      finding({ file: "a.go", message: "`loadEntry` skips `storeEntry`." }),
      finding({ file: "b.go", message: "`UserCache.storeEntry` runs before `UserCache.loadEntry`." }),
    ])).toHaveLength(1);
  });

  // Two different receivers named in ONE finding are two symbols, not one.
  it("counts two receivers in one finding as two symbols", () => {
    expect(crossFileGroups([
      finding({ file: "a.go", message: "`UserCache.loadEntry` disagrees with `ConfigCache.loadEntry`." }),
      finding({ file: "b.go", message: "`ConfigCache.loadEntry` disagrees with `UserCache.loadEntry`." }),
    ])).toHaveLength(1);
  });
});

// Issue #75 (Codex review, round 2): byte-identical duplicates are collapsed by
// SEVERITY alone, so a finding the host had checked could be discarded in
// favour of a twin that carried no claim — taking a computed contradiction with
// it and republishing the assertion unqualified.
describe("clusterFindings — a host check survives duplicate collapsing", () => {
  const shared = {
    file: "src/retry.ts",
    line: 41,
    category: "correctness",
    message: "budget() is never called.",
  };
  const hostCheck = {
    status: "lexical-matches" as const,
    references: [{ file: "src/http.ts", line: 88 }],
    filesSearched: 40,
  };

  it("carries the check onto a more severe twin that had none", () => {
    const clusters = clusterFindings([
      // The checked one is LESS severe, so severity alone discards it.
      { ...shared, severity: "warning", ruleName: "rule-a", claim: { kind: "no-other-references", symbol: "budget" }, hostCheck },
      { ...shared, severity: "blocking", ruleName: "rule-b" },
    ]);

    expect(clusters).toHaveLength(1);
    const representative = clusters[0]?.representative;
    // The blocking finding is still the one published...
    expect(representative?.severity).toBe("blocking");
    expect(representative?.ruleName).toBe("rule-b");
    // ...but it no longer publishes the assertion without the host's answer.
    expect(representative?.hostCheck).toEqual(hostCheck);
  });

  // Codex review, round 11. Duplicates can now genuinely DISAGREE: a claim
  // budget can run out between them, and a failed check is deliberately not
  // shared with its retry. Carrying a result only onto a winner that had none
  // then kept `not-checked` on the winner and discarded a twin's real answer —
  // telling readers the check was not performed about a search that had found
  // matches, which is worse than either input on its own.
  it("prefers an established result over the winner's not-checked", () => {
    const clusters = clusterFindings([
      // The winner on severity is the one whose check failed or was skipped.
      {
        ...shared,
        severity: "blocking",
        ruleName: "rule-a",
        claim: { kind: "no-other-references", symbol: "budget" },
        hostCheck: { status: "not-checked" as const, reason: "the check failed" },
      },
      { ...shared, severity: "warning", ruleName: "rule-b", claim: { kind: "no-other-references", symbol: "budget" }, hostCheck },
    ]);

    expect(clusters).toHaveLength(1);
    const representative = clusters[0]?.representative;
    expect(representative?.severity).toBe("blocking");
    expect(representative?.hostCheck).toEqual(hostCheck);
  });

  // The reverse must NOT happen: a real answer is never downgraded to an
  // admission that the host did not look.
  it("never replaces an established result with not-checked", () => {
    const clusters = clusterFindings([
      { ...shared, severity: "blocking", ruleName: "rule-a", claim: { kind: "no-other-references", symbol: "budget" }, hostCheck },
      {
        ...shared,
        severity: "warning",
        ruleName: "rule-b",
        claim: { kind: "no-other-references", symbol: "budget" },
        hostCheck: { status: "not-checked" as const, reason: "the check failed" },
      },
    ]);

    expect(clusters[0]?.representative?.hostCheck).toEqual(hostCheck);
  });

  it("leaves a winner that already carries its own check alone", () => {
    const own = { ...hostCheck, filesSearched: 7 };
    const clusters = clusterFindings([
      { ...shared, severity: "blocking", ruleName: "rule-b", claim: { kind: "no-other-references", symbol: "budget" }, hostCheck: own },
      { ...shared, severity: "warning", ruleName: "rule-a", claim: { kind: "no-other-references", symbol: "budget" }, hostCheck },
    ]);

    expect(clusters[0]?.representative?.hostCheck).toEqual(own);
  });
});
