// Issue #139 stages 3 and 5. Ordered by how much the property matters.
import { describe, expect, it } from "vitest";
import {
  ATTACK_PATH_FIELDS,
  explainSeverity,
  MAX_EVIDENCE_CHARS,
  parseAttackPathFacts,
  rateSeverity,
  type AttackPathFacts,
  type Fact,
  type ImpactSurface,
} from "../../../../src/review/security/attack-path.js";
import type { Finding } from "../../../../src/review/types.js";

const fact = <T>(value: T | "unknown", evidence = "because the code says so"): Fact<T> => ({
  value,
  evidence,
  source: "reviewer",
});

/** A fully-known, maximally-exploitable path. Tests vary one field at a time. */
const exploitable = (overrides: Partial<AttackPathFacts> = {}): AttackPathFacts => ({
  vector: fact("remote"),
  attackerControl: fact("yes"),
  preconditions: fact("none"),
  authScope: fact("public"),
  crossesBoundary: fact("yes"),
  impactSurface: fact("data"),
  ...overrides,
});

describe("a reviewer cannot forge host provenance", () => {
  // THE property of stage 3. A forged verification is the most damaging thing
  // a finding can carry, being the one part a reader is meant to trust
  // without re-deriving.
  it("stamps every parsed fact as reviewer, even one claiming to be host", () => {
    const facts = parseAttackPathFacts({
      vector: { value: "remote", evidence: "an Express route", source: "host" },
    });

    expect(facts.vector.value).toBe("remote");
    expect(facts.vector.source).toBe("reviewer");
  });

  it("stamps reviewer on every field, not just the ones that were answered", () => {
    const facts = parseAttackPathFacts({});

    for (const field of ATTACK_PATH_FIELDS) {
      expect(facts[field].source, `${field} carries a forgeable source`).toBe("reviewer");
    }
  });
});

describe("parsing never produces a partial analysis", () => {
  it("fills every field, so a reader always sees six rows", () => {
    const facts = parseAttackPathFacts({ vector: { value: "remote", evidence: "x" } });

    for (const field of ATTACK_PATH_FIELDS) {
      expect(facts[field], `${field} is missing`).toBeDefined();
      expect(typeof facts[field].evidence).toBe("string");
    }
  });

  it.each([undefined, null, "prose", 42, []])("survives %p as the whole analysis", (raw) => {
    const facts = parseAttackPathFacts(raw);
    expect(facts.vector.value).toBe("unknown");
  });

  it("rejects a value outside the enum", () => {
    // A model that invents "internet" must not have it reach the severity
    // policy as though it were a recognised vector.
    const facts = parseAttackPathFacts({ vector: { value: "internet", evidence: "x" } });
    expect(facts.vector.value).toBe("unknown");
  });

  it("downgrades a value that came with no evidence", () => {
    // Six confident enums with prose supporting one is exactly the failure the
    // per-fact evidence requirement exists to catch: an unevidenced fact
    // drives severity on nothing.
    const facts = parseAttackPathFacts({ vector: { value: "remote", evidence: "  " } });

    expect(facts.vector.value).toBe("unknown");
    expect(facts.vector.evidence).toMatch(/without evidence/u);
  });

  it("keeps the reviewer's reason when it answers unknown deliberately", () => {
    const facts = parseAttackPathFacts({
      vector: { value: "unknown", evidence: "routing is generated at build time" },
    });

    expect(facts.vector.value).toBe("unknown");
    expect(facts.vector.evidence).toBe("routing is generated at build time");
  });

  it("bounds evidence, which reaches a public comment", () => {
    const facts = parseAttackPathFacts({
      vector: { value: "remote", evidence: "e".repeat(MAX_EVIDENCE_CHARS * 3) },
    });

    expect(facts.vector.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  });
});

describe("severity is derived from the facts", () => {
  // The counterexample that forced control flow over a table: all six known,
  // matching no row of the previous table, so an implementation following it
  // returned undefined against a declared Finding["severity"].
  it("rates the combination that matched no row of the old table", () => {
    expect(rateSeverity("warning", exploitable({
      attackerControl: fact("plausible"),
      preconditions: fact("plausible"),
    }))).toBe("blocking");
  });

  it("raises a remote, public, cross-boundary path to blocking", () => {
    expect(rateSeverity("warning", exploitable())).toBe("blocking");
  });

  it("treats an ordinary signed-in caller as a reachable audience", () => {
    // `user` was absent from the first draft, which forced every ordinary
    // product path to `unknown` while the policy distinguished it.
    expect(rateSeverity("warning", exploitable({ authScope: fact("user") }))).toBe("blocking");
  });

  it("caps a low-confidence path at warning rather than denying it", () => {
    // `unlikely` preconditions still describe a REACHABLE path. Grouping them
    // with the non-exploitable cases sent a remote, public, cross-boundary
    // failure to `suggestion` — a level reserved for code that is CORRECT.
    expect(rateSeverity("blocking", exploitable({ preconditions: fact("unlikely") })))
      .toBe("warning");
  });

  it.each([
    ["the attacker controls nothing", { attackerControl: fact<"no">("no") }],
    ["the preconditions are unachievable", { preconditions: fact<"unachievable">("unachievable") }],
    ["there is no vector at all", { vector: fact<"none">("none") }],
  ])("sends a path to suggestion when %s", (_label, override) => {
    expect(rateSeverity("blocking", exploitable(override as Partial<AttackPathFacts>)))
      .toBe("suggestion");
  });

  it("reduces a localhost path the attacker cannot reach, rather than rating it warning", () => {
    // Exploitability is checked FIRST so a non-exploitable path can never be
    // raised by a later branch — the ordering fix from spec review.
    expect(rateSeverity("blocking", exploitable({
      vector: fact("localhost"),
      attackerControl: fact("no"),
    }))).toBe("suggestion");
  });

  it("caps a self-only issue at warning", () => {
    expect(rateSeverity("blocking", exploitable({ crossesBoundary: fact("no") }))).toBe("warning");
  });

  it("never RAISES a self-only issue discovery called a suggestion", () => {
    // Capped, never raised. The policy refines what discovery claimed; it does
    // not invent a vulnerability the reviewer never reported.
    expect(rateSeverity("suggestion", exploitable({ crossesBoundary: fact("no") })))
      .toBe("suggestion");
  });

  it("rates a cross-boundary path behind admin auth as warning", () => {
    expect(rateSeverity("blocking", exploitable({ authScope: fact("admin") }))).toBe("warning");
  });

  it("rates a cross-boundary path from localhost as warning", () => {
    expect(rateSeverity("blocking", exploitable({ vector: fact("localhost") }))).toBe("warning");
  });
});

describe("unknown lowers confidence, never severity", () => {
  // The trap the issue names explicitly: a rubric reading "unknown
  // reachability" as "not reachable" turns a coverage gap into a false clean
  // bill of health.
  it.each(["vector", "attackerControl", "preconditions", "authScope", "crossesBoundary"] as const)(
    "preserves the discovered severity when %s is unknown",
    (field) => {
      const facts = exploitable({ [field]: fact<never>("unknown", "no grammar for this language") });
      expect(rateSeverity("blocking", facts)).toBe("blocking");
    },
  );

  it("preserves discovery when NOTHING could be established", () => {
    // A Go or Rust repository today. This must read as "we could not
    // establish the path", never as "there is no path".
    const nothing = parseAttackPathFacts({});
    expect(rateSeverity("blocking", nothing)).toBe("blocking");
  });

  it("does not let an unknown impactSurface change the rating", () => {
    // Not a severity input. Listing it as one would make a descriptive field
    // suppress ratings on repositories that cannot establish it.
    expect(rateSeverity("warning", exploitable({ impactSurface: fact<ImpactSurface>("unknown") })))
      .toBe("blocking");
  });
});

describe("the rating explains itself", () => {
  it("names the fields it could not establish", () => {
    // A reader who disputes a severity needs a specific fact to dispute.
    const explanation = explainSeverity("blocking", exploitable({ vector: fact<never>("unknown") }));

    expect(explanation).toContain("vector");
    expect(explanation).toMatch(/not evidence of a safe one/u);
  });

  it("names the facts behind a blocking rating", () => {
    const explanation = explainSeverity("warning", exploitable());

    expect(explanation).toContain("remote");
    expect(explanation).toContain("public");
  });

  it("says plainly why a path was rated suggestion", () => {
    const explanation = explainSeverity("blocking", exploitable({ attackerControl: fact("no") }));

    expect(explanation).toMatch(/not reachable/u);
  });
});

describe("totality", () => {
  it("returns a valid severity for every combination of values", () => {
    // Total BY CONSTRUCTION, but asserted exhaustively because the defect this
    // replaces was an implementation that returned `undefined` for one
    // combination out of several hundred.
    const values: Record<keyof AttackPathFacts, readonly string[]> = {
      vector: ["remote", "local-network", "localhost", "none", "unknown"],
      attackerControl: ["yes", "plausible", "no", "unknown"],
      preconditions: ["none", "plausible", "unlikely", "unachievable", "unknown"],
      authScope: ["public", "user", "internal", "admin", "unknown"],
      crossesBoundary: ["yes", "no", "unknown"],
      impactSurface: ["data", "unknown"],
    };
    const severities: Finding["severity"][] = ["blocking", "warning", "suggestion"];
    let combinations = 0;

    for (const vector of values.vector) {
      for (const attackerControl of values.attackerControl) {
        for (const preconditions of values.preconditions) {
          for (const authScope of values.authScope) {
            for (const crossesBoundary of values.crossesBoundary) {
              for (const discovered of severities) {
                const facts = {
                  vector: fact(vector),
                  attackerControl: fact(attackerControl),
                  preconditions: fact(preconditions),
                  authScope: fact(authScope),
                  crossesBoundary: fact(crossesBoundary),
                  impactSurface: fact("data"),
                } as unknown as AttackPathFacts;
                expect(severities).toContain(rateSeverity(discovered, facts));
                combinations += 1;
              }
            }
          }
        }
      }
    }
    expect(combinations).toBeGreaterThan(1000);
  });
});
