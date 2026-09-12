// Issue #139 stage 3's execution and its interaction with stages 4 and 5.
import { describe, expect, it, vi } from "vitest";
import {
  analyzeAttackPaths,
  eligibleCandidates,
  MAX_ANALYZED_CANDIDATES,
} from "../../../../src/review/security/analyze.js";
import type { Finding } from "../../../../src/review/types.js";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  file: "src/routes.ts",
  line: 3,
  severity: "warning",
  category: "security",
  ruleName: "sink-reachability",
  message: "User input reaches a SQL string.",
  ...overrides,
});

const EXPRESS = 'const app = express();\napp.get("/items/:id", handler);';

/** Six confident facts, as a well-behaved reviewer would answer. */
const answers = (overrides: Record<string, unknown> = {}) => ({
  vector: { value: "remote", evidence: "the reviewer thinks so" },
  attackerControl: { value: "yes", evidence: "req.params flows in unfiltered" },
  preconditions: { value: "none", evidence: "no setup needed" },
  authScope: { value: "public", evidence: "the reviewer thinks so" },
  crossesBoundary: { value: "yes", evidence: "reads another tenant's rows" },
  impactSurface: { value: "data", evidence: "returns records" },
  ...overrides,
});

const run = (findings: Finding[], opts: {
  analyze?: (f: Finding) => Promise<unknown>;
  head?: (file: string) => Promise<string | undefined>;
} = {}) =>
  analyzeAttackPaths({
    findings,
    analyze: opts.analyze ?? (async () => answers()),
    readHeadFile: opts.head ?? (async () => EXPRESS),
  });

describe("the host overwrites what it can establish", () => {
  // THE correction from spec review. An earlier draft kept the reviewer's
  // value when no pattern matched, which — since the supported list is short —
  // would have let model text drive severity on almost every review.
  it("replaces the reviewer's vector with the host's, unconditionally", async () => {
    const [rated] = await run([finding()]);

    expect(rated?.attackPath?.status).toBe("analyzed");
    if (rated?.attackPath?.status !== "analyzed") throw new Error("unreachable");
    expect(rated.attackPath.facts.vector.source).toBe("host");
    expect(rated.attackPath.facts.vector.evidence).toContain("src/routes.ts");
  });

  it("overwrites with UNKNOWN when no pattern matches, discarding the reviewer's guess", async () => {
    // The case that matters: the reviewer confidently said "remote", the host
    // has no pattern for Go, and the answer must be `unknown` rather than the
    // guess. Otherwise the supported-pattern list is decorative.
    const [rated] = await run([finding({ file: "internal/handler.go" })], {
      head: async () => "package main",
    });

    if (rated?.attackPath?.status !== "analyzed") throw new Error("unreachable");
    expect(rated.attackPath.facts.vector.value).toBe("unknown");
    expect(rated.attackPath.facts.vector.source).toBe("host");
  });

  it("leaves the four judgement fields with the reviewer", async () => {
    // No host check establishes whether an attacker controls a value in
    // general, so these are judgements and are labelled as such.
    const [rated] = await run([finding()]);

    if (rated?.attackPath?.status !== "analyzed") throw new Error("unreachable");
    for (const field of ["attackerControl", "preconditions", "crossesBoundary", "impactSurface"] as const) {
      expect(rated.attackPath.facts[field].source, field).toBe("reviewer");
    }
  });
});

describe("severity comes out of the facts", () => {
  // With `authScope` always `unknown` today (see reachability.ts: a
  // registration line shows a route exists, not who may reach it), every
  // rating PRESERVES what discovery assigned. That is the conservative
  // direction and the honest one — but it means the policy is dormant
  // end-to-end until a pattern that positively resolves auth composition
  // lands. `rateSeverity` itself is exercised directly in attack-path.test.ts.
  it("keeps a warning at warning when the path cannot be fully established", async () => {
    const [rated] = await run([finding({ severity: "warning" })]);
    expect(rated?.severity).toBe("warning");
  });

  it("keeps a blocking finding blocking rather than lowering it on partial facts", async () => {
    // The direction that matters. A finding must never be DOWNGRADED because
    // the host could not establish a field — that is a coverage gap read as a
    // clean bill of health.
    const [rated] = await run([finding({ severity: "blocking" })], {
      analyze: async () => answers({ attackerControl: { value: "no", evidence: "constant input" } }),
    });
    expect(rated?.severity).toBe("blocking");
  });

  it("keeps discovery's severity when the host cannot establish the path at all", async () => {
    // A Go repository today. Unknown must lower CONFIDENCE, never severity.
    const [rated] = await run([finding({ file: "internal/handler.go", severity: "warning" })], {
      head: async () => "package main",
    });
    expect(rated?.severity).toBe("warning");
  });

  it("still records every fact, so the reader sees what was and was not established", async () => {
    // The facts are the deliverable even while the rating is dormant: a reader
    // who disputes a severity has specific rows to dispute.
    const [rated] = await run([finding()]);

    if (rated?.attackPath?.status !== "analyzed") throw new Error("unreachable");
    expect(rated.attackPath.facts.vector.value).toBe("remote");
    expect(rated.attackPath.facts.authScope.value).toBe("unknown");
    expect(rated.attackPath.facts.attackerControl.value).toBe("yes");
  });
});

describe("the pass is bounded", () => {
  it("does not run at all when there are no security findings", async () => {
    const analyze = vi.fn();
    const out = await run([finding({ category: "correctness" })], { analyze: analyze as never });

    expect(analyze).not.toHaveBeenCalled();
    expect(out[0]?.attackPath).toBeUndefined();
  });

  it("ignores non-security findings even alongside security ones", async () => {
    const analyze = vi.fn(async () => answers());
    const out = await run([finding({ category: "style" }), finding()], { analyze });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(out[0]?.attackPath).toBeUndefined();
    expect(out[1]?.attackPath).toBeDefined();
  });

  it("spends the budget on the most severe candidates", async () => {
    const analyze = vi.fn(async () => answers());
    const many = [
      ...Array.from({ length: MAX_ANALYZED_CANDIDATES }, () => finding({ severity: "suggestion" })),
      finding({ severity: "blocking", message: "the worst one" }),
    ];
    const out = await run(many, { analyze });

    expect(analyze).toHaveBeenCalledTimes(MAX_ANALYZED_CANDIDATES);
    // The blocking finding was last in the input and still got analyzed.
    const worst = out.find((f) => f.message === "the worst one");
    expect(worst?.attackPath?.status).toBe("analyzed");
  });

  it("marks what it could not afford as not-analyzed, with the reason", async () => {
    // "We looked and could not say", "we never looked", and "there were more
    // than we rate" are three different facts, and a reader needs the third.
    const many = Array.from({ length: MAX_ANALYZED_CANDIDATES + 2 }, (_, index) =>
      finding({ severity: "suggestion", message: `finding ${index}` }));
    const out = await run(many);

    const skipped = out.filter((f) => f.attackPath?.status === "not-analyzed");
    expect(skipped).toHaveLength(2);
    expect(skipped[0]?.attackPath).toMatchObject({ status: "not-analyzed" });
    if (skipped[0]?.attackPath?.status !== "not-analyzed") throw new Error("unreachable");
    expect(skipped[0].attackPath.reason).toMatch(/budget/u);
  });

  it("does not re-rate a finding it could not afford to analyze", async () => {
    // Rating on absent facts would be exactly the guess this stage replaces.
    // Asserted on the UNANALYZED ones only: the budgeted ones are legitimately
    // re-rated, and an earlier version of this test conflated "not analyzed"
    // with "not re-rated" and failed for the right reason.
    const many = Array.from({ length: MAX_ANALYZED_CANDIDATES + 2 }, () =>
      finding({ severity: "suggestion" }));
    const out = await run(many);
    const unanalyzed = out.filter((f) => f.attackPath?.status === "not-analyzed");

    expect(unanalyzed).toHaveLength(2);
    expect(unanalyzed.every((f) => f.severity === "suggestion")).toBe(true);
  });

  it("attaches the analysis to a budgeted finding, whatever the rating comes out as", async () => {
    // The budgeted/unbudgeted distinction is about whether the pass RAN, not
    // about what it concluded. An earlier version asserted a rating here and
    // conflated the two.
    const [rated] = await run([finding({ severity: "suggestion" })]);

    expect(rated?.attackPath?.status).toBe("analyzed");
  });
});

describe("a published reason never carries the provider's own words", () => {
  it("publishes a classified phrase, not the raw error", async () => {
    // `renderAttackPath` puts this reason in the inline comment, which is
    // world-readable on a public repository. Provider errors echo request
    // identifiers, model names and prompt fragments (Codex review of PR #151).
    const out = await run([finding()], {
      analyze: async () => {
        throw new Error("429 from api.example.com req_id=abc123 key=sk_live_SECRET");
      },
    });

    if (out[0]?.attackPath?.status !== "not-analyzed") throw new Error("unreachable");
    const reason = out[0].attackPath.reason;
    expect(reason).not.toContain("req_id");
    expect(reason).not.toContain("api.example.com");
    expect(reason).not.toContain("sk_live");
    expect(reason).toMatch(/did not complete/u);
  });

  it("names a timeout, which the host itself worded", async () => {
    // Worth distinguishing: it tells a reader something actionable, and the
    // message came from this codebase rather than a provider.
    const out = await run([finding()], {
      analyze: async () => {
        throw new Error("the attack-path analysis timed out after 120000ms");
      },
    });

    if (out[0]?.attackPath?.status !== "not-analyzed") throw new Error("unreachable");
    expect(out[0].attackPath.reason).toMatch(/timed out/u);
  });
});

describe("failure never takes the review with it", () => {
  it("records a failed analysis as not-analyzed and keeps the finding", async () => {
    const out = await run([finding({ severity: "warning" })], {
      analyze: async () => {
        throw new Error("provider exploded");
      },
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("warning");
    if (out[0]?.attackPath?.status !== "not-analyzed") throw new Error("unreachable");
    // Classified, not the provider's words — see the block above.
    expect(out[0].attackPath.reason).toMatch(/did not complete/u);
  });

  it("survives a head read that throws", async () => {
    const out = await run([finding()], {
      head: async () => {
        throw new Error("worktree gone");
      },
    });

    if (out[0]?.attackPath?.status !== "analyzed") throw new Error("unreachable");
    // The host could not read the tree, so it establishes nothing — and says
    // so rather than trusting the reviewer's guess.
    expect(out[0].attackPath.facts.vector.value).toBe("unknown");
  });

  it("survives an analyzer that answers prose", async () => {
    const out = await run([finding()], { analyze: async () => "I think it is fine" });

    if (out[0]?.attackPath?.status !== "analyzed") throw new Error("unreachable");
    expect(out[0].attackPath.facts.attackerControl.value).toBe("unknown");
  });

  it("preserves every input finding, analyzed or not", async () => {
    const input = [finding({ category: "style" }), finding(), finding({ category: "perf" })];
    const out = await run(input);

    expect(out).toHaveLength(input.length);
    expect(out.map((f) => f.category)).toEqual(["style", "security", "perf"]);
  });
});

describe("candidate selection", () => {
  it("keeps only security findings, worst first", () => {
    const ordered = eligibleCandidates([
      finding({ severity: "suggestion", message: "c" }),
      finding({ category: "style", message: "ignored" }),
      finding({ severity: "blocking", message: "a" }),
      finding({ severity: "warning", message: "b" }),
    ]);

    expect(ordered.map((f) => f.message)).toEqual(["a", "b", "c"]);
  });

  it("excludes host-detector findings, whose severity is computed not judged", async () => {
    // A committed credential is `blocking` because the host matched a
    // provider's own format. Letting a model's reachability guess re-rate it
    // could send a live credential to `suggestion` — a level reserved for code
    // that is CORRECT — and would spend a model call to do it.
    const analyze = vi.fn(async () => answers({
      attackerControl: { value: "no", evidence: "the model guessed" },
    }));
    const out = await analyzeAttackPaths({
      findings: [finding({ ruleName: "security:secrets", severity: "blocking" })],
      analyze,
      readHeadFile: async () => EXPRESS,
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(out[0]?.severity).toBe("blocking");
    expect(out[0]?.attackPath).toBeUndefined();
  });

  it("excludes the supply-chain detector too", () => {
    expect(eligibleCandidates([finding({ ruleName: "security:supply-chain" })])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [finding({ severity: "suggestion" }), finding({ severity: "blocking" })];
    const before = input.map((f) => f.severity);
    eligibleCandidates(input);

    expect(input.map((f) => f.severity)).toEqual(before);
  });
});
