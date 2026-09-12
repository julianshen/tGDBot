// Issue #139 stages 3 and 5: the attack-path facts a security finding rests
// on, and the severity policy that reads them.
//
// The whole point of separating these from `message` is that "SQL built by
// concatenation" and "SQL built by concatenation, reachable from an
// unauthenticated handler, with no parameterisation between" are different
// claims, and only the second earns a blocking label. A severity asserted in
// prose cannot be disputed field by field; one derived from stated facts can.
//
// Two properties govern everything below.
//
// **`source` is never parsed.** The parser stamps every incoming fact
// `reviewer`, unconditionally; only the host reachability stage may construct
// one with `source: "host"`. Reviewer output is model text produced over an
// attacker-controlled diff, and a contract that let it select its own
// provenance would let a mistaken or injected response render as
// host-established evidence — with nothing downstream to catch it. Same
// guarantee `hostCheck` holds, for the reason its own comment gives: a forged
// verification is the most damaging thing a finding can carry, being the one
// part a reader is meant to trust without re-deriving.
//
// **Unknown lowers confidence, never severity.** On a Go or Rust repository
// most reachability fields will legitimately be `unknown`, and that must read
// as "we could not establish the path", never as "there is no path" — the
// failure `dependency-facts.ts` and `hostCheck: not-checked` were both written
// to avoid.
import type { Finding } from "../types.js";

/** Where a fact came from. Rendered differently; never interchangeable. */
export type FactSource = "host" | "reviewer";

export interface Fact<T> {
  readonly value: T | "unknown";
  /**
   * Why the value is what it is — or, when `value` is "unknown", why nothing
   * could be established.
   *
   * Required in both cases. A non-unknown value with no evidence drives
   * severity on nothing, and an `unknown` with no reason is indistinguishable
   * from a field the reviewer forgot.
   */
  readonly evidence: string;
  /** Set by the HOST, never parsed from reviewer output. */
  readonly source: FactSource;
}

export type Vector = "remote" | "local-network" | "localhost" | "none";
export type AttackerControl = "yes" | "plausible" | "no";
export type Preconditions = "none" | "plausible" | "unlikely" | "unachievable";
export type AuthScope = "public" | "user" | "internal" | "admin";
export type CrossesBoundary = "yes" | "no";
export type ImpactSurface = "data" | "identity" | "runtime" | "build" | "network";

export interface AttackPathFacts {
  /** Host-establishable (stage 4). Drives severity, so a reviewer guess never substitutes. */
  readonly vector: Fact<Vector>;
  readonly attackerControl: Fact<AttackerControl>;
  readonly preconditions: Fact<Preconditions>;
  /**
   * `user` is an ordinary signed-in non-admin caller — the commonest shape in
   * a product codebase. Absent from the first draft, which forced every such
   * path to `unknown` while the severity policy distinguished it.
   *
   * Host-establishable (stage 4), for the same reason as `vector`.
   */
  readonly authScope: Fact<AuthScope>;
  readonly crossesBoundary: Fact<CrossesBoundary>;
  readonly impactSurface: Fact<ImpactSurface>;
}

/**
 * Mirrors `StructuralCheck`: a RESULT, never a presence.
 *
 * Without `not-analyzed`, a finding whose analysis timed out, failed to parse,
 * or fell outside the candidate budget renders exactly like a finding from a
 * review with the pass off — and a reader cannot tell "we looked and could not
 * say" from "we never looked". That distinction is the whole of
 * `hostCheck: not-checked`.
 */
export type AttackPathResult =
  | { readonly status: "analyzed"; readonly facts: AttackPathFacts }
  | { readonly status: "not-analyzed"; readonly reason: string };

/** Bounded on the same terms as `message` (#110): this reaches a public comment. */
export const MAX_EVIDENCE_CHARS = 300;

const VECTORS = new Set<string>(["remote", "local-network", "localhost", "none"]);
const ATTACKER_CONTROL = new Set<string>(["yes", "plausible", "no"]);
const PRECONDITIONS = new Set<string>(["none", "plausible", "unlikely", "unachievable"]);
const AUTH_SCOPES = new Set<string>(["public", "user", "internal", "admin"]);
const CROSSES = new Set<string>(["yes", "no"]);
const IMPACT_SURFACES = new Set<string>(["data", "identity", "runtime", "build", "network"]);

const FIELD_VALUES: Readonly<Record<keyof AttackPathFacts, ReadonlySet<string>>> = {
  vector: VECTORS,
  attackerControl: ATTACKER_CONTROL,
  preconditions: PRECONDITIONS,
  authScope: AUTH_SCOPES,
  crossesBoundary: CROSSES,
  impactSurface: IMPACT_SURFACES,
};

/** The field order the parser and every renderer walk. Stable output, stable tests. */
export const ATTACK_PATH_FIELDS = Object.freeze(
  Object.keys(FIELD_VALUES) as (keyof AttackPathFacts)[],
);

/** An `unknown` fact carrying the host's own reason. Never a parsed value. */
export function unknownFact<T>(reason: string, source: FactSource = "reviewer"): Fact<T> {
  return { value: "unknown", evidence: boundedEvidence(reason), source };
}

function boundedEvidence(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length <= MAX_EVIDENCE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_EVIDENCE_CHARS - 1)}…`;
}

function parseFact(raw: unknown, allowed: ReadonlySet<string>): Fact<never> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unknownFact("the reviewer did not answer this field");
  }
  const record = raw as Record<string, unknown>;
  const evidence = typeof record.evidence === "string" ? boundedEvidence(record.evidence) : "";
  const value = record.value;

  if (typeof value !== "string" || !allowed.has(value)) {
    // Includes an explicit "unknown" from the reviewer, which is a legitimate
    // answer and keeps whatever reason it gave.
    return unknownFact(
      evidence.length > 0
        ? evidence
        : `the reviewer gave no recognised value (${typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : typeof value})`,
    );
  }
  if (evidence.length === 0) {
    // An unevidenced value is downgraded rather than rejected: the finding is
    // still worth publishing, and the fact simply does not reach the severity
    // policy. Dropping the whole analysis over one bare field would lose the
    // five that were answered properly.
    return unknownFact(`the reviewer answered "${value}" without evidence`);
  }
  // `source` is STAMPED, never read. A reviewer that emits `"source": "host"`
  // has it overwritten here, which is the only reason a reader can trust the
  // label at all.
  return { value, evidence, source: "reviewer" } as Fact<never>;
}

/**
 * Reads an attack-path analysis out of reviewer output.
 *
 * Never throws, and never returns a partially-populated object: a missing or
 * malformed field becomes `unknown` with a reason, so the result is always a
 * complete set of six facts. Callers therefore never have to handle absence,
 * and a reader always sees six rows — some of which say the reviewer did not
 * answer, which is information rather than a gap.
 */
export function parseAttackPathFacts(raw: unknown): AttackPathFacts {
  const record =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const facts: Record<string, Fact<never>> = {};
  for (const field of ATTACK_PATH_FIELDS) {
    facts[field] = parseFact(record[field], FIELD_VALUES[field]);
  }
  return facts as unknown as AttackPathFacts;
}

/** Every field `rateSeverity` reads. An unknown in any of them preserves discovery. */
const SEVERITY_INPUTS: readonly (keyof AttackPathFacts)[] = Object.freeze([
  "vector",
  "attackerControl",
  "preconditions",
  "authScope",
  "crossesBoundary",
]);

function anyRequiredUnknown(facts: AttackPathFacts): boolean {
  return SEVERITY_INPUTS.some((field) => facts[field].value === "unknown");
}

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

/** The LESS severe of the two, on the published ordering blocking > warning > suggestion. */
function min(a: Finding["severity"], b: Finding["severity"]): Finding["severity"] {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * The severity a finding should carry, given what discovery said and what the
 * attack-path stage established.
 *
 * TOTAL by construction: every branch returns, so no combination of inputs can
 * fall through. Expressed as control flow rather than a table because two
 * rounds of spec review found combinations a table did not cover — including
 * `attackerControl: plausible` + `vector: remote` + `preconditions: plausible`
 * + `crossesBoundary: yes` + `authScope: public`, which matched no row and
 * would have returned `undefined` against a declared return type.
 *
 * Not a pure function of the facts: it takes the severity DISCOVERY assigned
 * and can only refine it. That is what keeps the policy from inventing a
 * vulnerability the reviewer never claimed.
 */
export function rateSeverity(
  discovered: Finding["severity"],
  facts: AttackPathFacts,
): Finding["severity"] {
  // 1. Anything the decision needs is unknown -> preserve what discovery said.
  //    Unknown lowers CONFIDENCE, never severity.
  if (anyRequiredUnknown(facts)) return discovered;

  // 2. Exploitability first, so a non-exploitable path can never be raised by
  //    a later branch. This ordering is the fix for a localhost path with
  //    `attackerControl: no` being rated `warning` before it could be reduced.
  const reachable =
    (facts.attackerControl.value === "yes" || facts.attackerControl.value === "plausible") &&
    facts.preconditions.value !== "unachievable" &&
    facts.vector.value !== "none";
  if (!reachable) return "suggestion";

  // 2b. `unlikely` preconditions still describe a REACHABLE path. Grouping
  //     them with the non-exploitable cases sent a remote, public,
  //     cross-boundary failure to `suggestion` — a level this project reserves
  //     for code that is correct as written. Low confidence CAPS the result;
  //     it does not deny the path.
  const lowConfidence = facts.preconditions.value === "unlikely";

  // 3. Reachable but bounded to one user or tenant. Capped, never raised: a
  //    self-only issue the reviewer called `suggestion` stays there.
  if (facts.crossesBoundary.value === "no") return min(discovered, "warning");

  // 4. Crosses a boundary, from a network surface, on a caller anyone can be.
  if (
    (facts.vector.value === "remote" || facts.vector.value === "local-network") &&
    (facts.authScope.value === "public" || facts.authScope.value === "user")
  ) {
    return lowConfidence ? "warning" : "blocking";
  }

  // 5. Crosses a boundary, but from localhost, or behind internal/admin auth.
  return "warning";
}

/**
 * Why a rating came out as it did, for the published comment.
 *
 * Returned rather than logged because the point of deriving severity from
 * facts is that a reader who disputes the label has a specific fact to
 * dispute. A rating with no stated basis is the vibe this stage replaces.
 */
export function explainSeverity(
  discovered: Finding["severity"],
  facts: AttackPathFacts,
): string {
  const rated = rateSeverity(discovered, facts);
  if (anyRequiredUnknown(facts)) {
    const unresolved = SEVERITY_INPUTS.filter((field) => facts[field].value === "unknown");
    return (
      `Severity kept at \`${discovered}\` as the reviewer reported it: ` +
      `${unresolved.join(", ")} could not be established, and an unestablished ` +
      `attack path is not evidence of a safe one.`
    );
  }
  if (rated === "suggestion") {
    return (
      "Rated `suggestion`: the attack path is not reachable — " +
      `attacker control \`${facts.attackerControl.value}\`, ` +
      `preconditions \`${facts.preconditions.value}\`, vector \`${facts.vector.value}\`.`
    );
  }
  return (
    `Rated \`${rated}\` from the stated facts: vector \`${facts.vector.value}\`, ` +
    `auth scope \`${facts.authScope.value}\`, ` +
    `crosses a trust boundary \`${facts.crossesBoundary.value}\`, ` +
    `preconditions \`${facts.preconditions.value}\`.`
  );
}
