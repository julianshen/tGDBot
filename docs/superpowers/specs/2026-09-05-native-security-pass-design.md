# Native Security Pass: Establish the Attack Path, Then Rate It

## Summary

Add a security review that tGDBot performs itself, at review time, on the diff —
replacing the position where `--codex-scan-results` is currently the only way to
get security coverage.

The design has one load-bearing idea, taken from
[openai/codex-security](https://github.com/openai/codex-security) (Apache-2.0)
and nothing else: **severity is decided after reachability is established, from
structured facts that each carry evidence or an explicit `unknown`.** Everything
downstream of that is arrangement of machinery this repository already has.

Issue: #139. **Revised after review** — see "Corrections from review", which
records the parts that did not survive.

## Corrections from review

The first draft of this document was reviewed before any code was written, and
twelve findings came back, ten of them serious. Recorded rather than quietly
folded in, because several invalidate claims the draft made confidently:

| Claim in the draft | What was wrong |
|---|---|
| reachability from the **base** worktree | a pull request that *adds* a handler creates a path the base does not contain, so base-only analysis misses precisely the new attack surface it exists to rate |
| `--security-pass off` "pays nothing" | the hook sat after dispatch; the rule pack would still have been loaded, dispatched and billed |
| eligibility from `Finding.category` | that field is model-authored free text — a rule emitting `injection` would be skipped, and any rule emitting `security` could opt into re-rating |
| one free-text `evidence` per finding | a reviewer can return six confident enums with prose supporting one, and the parser still sees a valid object |
| severity as a pure `facts -> severity` function | not **total**: an all-`unknown` input has no baseline to preserve, and a known `localhost` + cross-boundary path matched no row at all |
| host-established `vector`/`authScope` for all of TS/JS | resolving a call chain proves neither; middleware, decorators and generated routing decide both, so this would have given guesses a trusted label |
| `attackPath` present-or-absent | an enabled-but-unchecked finding would render identically to one from a review with the pass off |

Two of those — the tree, and the trusted label — were the specific things the
draft claimed as its strongest evidence.

A second round, after the revision, found four more:

| Claim in the revision | What was wrong |
|---|---|
| `Fact.source` parsed from reviewer output | the model could select `source: "host"` and have its guess rendered as host-established evidence; stage 4 leaves reviewer facts alone where no pattern matches, so nothing downstream would catch it |
| the rewritten severity table is total | it was not: an all-known `attackerControl: plausible` + remote + `crossesBoundary: yes` + `public` path matched no row, so an implementation returns `undefined` |
| the localhost row | matched on vector and boundary alone, rating a path with `attackerControl: no` as `warning` before the non-exploitable branch could reduce it |
| host checks for secrets and supply chain | they had **no way to reach a reader**: `structural-check.ts` annotates existing findings, and a PR whose only defect is a committed credential produces none to annotate |

The last is the one I had flagged as unexamined when the decision was made, and
it was a real hole rather than a theoretical one: two of the four advertised
security surfaces would have reported nothing, silently.

A third round found four more:

| Claim | What was wrong |
|---|---|
| unmatched routing keeps the reviewer's `vector`/`authScope` | contradicted the paragraph directly below it, and with the pattern list starting empty would have let model text drive severity on every review |
| `unlikely` preconditions mean not exploitable | `unlikely` still describes a **reachable** path; grouping it with the non-exploitable cases sent a remote, public, cross-boundary failure to `suggestion`, a level this project reserves for code that is correct as written |
| synthesized findings are "addressable in conversation" | `poll.ts` resolves a rule by `ruleName` among active rules and reports `inactive` otherwise; `codex-security` works only because #120 defined a host-owned policy object, and these two names had none |
| "two model calls per review" | stage 3 runs **per candidate**, so the real figure is `2 + N` — an understatement of the cost of the feature the document asks operators to enable |

Across three rounds, twenty findings. Most were the document asserting a
property it did not deliver.

## Why this is not the thing that was rejected

`2026-09-01-codex-security-scan-design.md` records a feasibility study that
tried running a security scanner as a child process of the review, and was
abandoned after nine review rounds and twenty-plus defects. Every one traced to
the same cause: **executing an unrestrictable foreign agent, with full local
filesystem and command access, over attacker-controlled code.**

This design does not do that, and the distinction is structural rather than a
matter of better sandboxing:

| | Rejected in-process scan | This design |
|---|---|---|
| What runs | `@openai/codex-security`, an agent that "never pauses for approval" | our own rules |
| Tools available to it | full OS permissions, not restrictable by the caller | `read`, `grep`, `find`, `ls` (ADR-003) |
| Who orchestrates | the foreign agent | the host, as with every other rule |
| Where findings come from | a foreign process's JSON | the same dispatch path as every other finding |

The security pass is a **rule pack plus one extra host stage**. It introduces no
new execution model. If it did, this document would be the wrong shape and the
answer would again be no.

## Constraints

1. **No new runtime dependency, and no Python.** Must work on a default
   `npm ci`, and inside the single-file binary (#137).
2. **No new tool grant.** Reviewer sessions keep exactly `read, grep, find, ls`.
3. **Off by default**, like `--structural-checks`. A review that does not ask
   for this pays nothing — not a model call, not a worktree, not a byte of
   prompt.
4. **Degrades, never blocks.** Every stage that cannot run says so beside the
   finding, as `hostCheck: not-checked` already does.

## Pipeline

Five stages. Three exist; two are new.

```
1. inventory      EXISTS  changedFilesWithRenameSources(diff)
2. discovery      EXISTS  per-rule dispatch of a security rule pack
3. attack path    NEW     one bounded pass per eligible candidate
4. reachability   NEW     host-established only under supported patterns
5. severity       NEW     host policy over the discovery severity and the facts
```

### Gating happens BEFORE dispatch

Constraint 3 says an off review pays nothing, and stages 3–5 running late does
not deliver that: the rule pack would be loaded, dispatched and billed anyway.

So `--security-pass off` **excludes the pack at rule loading**, before
`dispatchRulesFn` is reached. The mechanism exists — #115 already partitions
rules before dispatch and reports what it did not run — and the pack is reported
the same way, so an off review says it skipped the security rules rather than
implying it found nothing.

### Eligibility is host-known, not model-declared

Stages 3–5 select candidates by **membership in the builtin security pack**,
which the host knows because the host loaded those rules. `Finding.category` is
model-authored free text: a rule emitting `injection` would be skipped, and any
rule at all emitting `security` could opt itself into host re-rating. A
model-authored field must not gate a host stage — the same reasoning that keeps
`hostCheck` unforgeable and made #115 route scoping through `applies_to` rather
than through anything a reviewer writes.

Findings that never reach a reader — `addressed`, suppressed duplicates — are
excluded before stage 3, as #80 gates the structural clone, because stage 3 is
a model call.

## Stage 3: attack-path facts

Each fact carries its own value, its own evidence, and where it came from. A
single free-text `evidence` per finding cannot support the claim the design
rests on: a reviewer can return six confident enums with prose supporting one,
and a parser checking only shape would accept it.

```ts
/** Where a fact came from. Rendered differently; never interchangeable. */
export type FactSource = "host" | "reviewer";

export interface Fact<T> {
  readonly value: T | "unknown";
  /**
   * Absent ONLY when `value` is "unknown", where it instead records why
   * nothing could be established. A non-unknown value with no evidence is
   * rejected at parse: an unevidenced fact drives severity on nothing.
   */
  readonly evidence: string;
  /** Set by the HOST, never parsed. See below. */
  readonly source: FactSource;
}

export interface AttackPathFacts {
  readonly vector: Fact<"remote" | "local-network" | "localhost" | "none">;
  readonly attackerControl: Fact<"yes" | "plausible" | "no">;
  readonly preconditions: Fact<"none" | "plausible" | "unlikely" | "unachievable">;
  /**
   * `user` is an ordinary signed-in non-admin caller — the commonest shape in
   * a product codebase, and absent from the first draft, which forced every
   * such path to `unknown` while the severity table distinguished it.
   */
  readonly authScope: Fact<"public" | "user" | "internal" | "admin">;
  readonly crossesBoundary: Fact<"yes" | "no">;
  readonly impactSurface: Fact<"data" | "identity" | "runtime" | "build" | "network">;
}

/** Mirrors `StructuralCheck`: a result, never a presence. */
export type AttackPathResult =
  | { readonly status: "analyzed"; readonly facts: AttackPathFacts }
  | { readonly status: "not-analyzed"; readonly reason: string };
```

**`source` is not a parsed field.** Stage 3's parser stamps every incoming fact
`reviewer`, unconditionally; only stage 4 may construct one with `source:
"host"`. Reviewer output is model text produced over an attacker-controlled
diff, and if the contract let it select its own provenance, a mistaken or
injected response would render as host-established evidence — with nothing
downstream to catch it, because stage 4 leaves reviewer facts in place wherever
no supported pattern matches.

This is the guarantee `hostCheck` already holds, for the reason its own comment
gives: a forged verification is the most damaging thing a finding can carry,
being the one part a reader is meant to trust without re-deriving. Unforgeable
by construction, not by the model behaving.

`not-analyzed` is not optional decoration. Without it, a finding whose analysis
timed out, failed to parse, or fell outside the candidate budget renders exactly
like a finding from a review with the pass off — and the reader cannot tell
"we looked and could not say" from "we never looked". That distinction is the
whole of `hostCheck: not-checked`, and the reason is host-authored for the same
reason: it reaches a world-readable comment.

Still deliberately narrower than the reference, which also models service
identity, ports, ingress and load-balancer type. Those are deployment facts a
repository rarely establishes, and a field that reads `unknown` on every review
teaches readers to skip the section.

Evidence strings are bounded (#110) and sanitized on the same terms as
`message`.

## Stage 4: reachability, and its much narrower limit

The first draft claimed host-established `vector` and `authScope` across the
whole TS/JS family. That is wrong twice over, and the corrections matter more
than the capability.

**Resolving a call chain proves neither.** The same handler is
public or authenticated depending on Express or Fastify middleware, a decorator,
generated routing, or a project's own wrapper — none of which a caller-edge walk
observes.

**And the TS/JS limit was the package's, not the design's.** `@ast-grep/napi`'s
built-in `Lang` enum is `Html, JavaScript, Tsx, Css, TypeScript`; Java, Go, Rust
and Python are reachable through `registerDynamicLanguage` and a per-language
grammar. That is tier 2, and "The rule pack" states what it costs — this section
should not be read as saying those languages are out of reach.

So a host fact is produced **only under an explicitly supported pattern with
positive evidence**, and `unknown` otherwise:

| Situation | `source` | Value |
|---|---|---|
| a supported router registration resolves to the finding's symbol, with the mounting evidence read | `host` | established |
| the language parses (tier 1 or 2) but no supported pattern matches | — | `unknown` |
| no grammar for the language, or no ast-grep binding | — | `unknown` |

An earlier draft of this table said an unmatched pattern retained *whatever the
reviewer asserted*, which contradicted the paragraph below it and — because the
supported-pattern list starts empty — would have let model text drive severity
on every review until the first framework landed. Unmatched is `unknown`.

That splits the schema in two, which is worth stating plainly:

| Field | Who can establish it |
|---|---|
| `vector`, `authScope` | the **host**, under a supported pattern. Unmatched is `unknown`; a reviewer assertion never substitutes, because these two drive severity. |
| `attackerControl`, `preconditions`, `crossesBoundary`, `impactSurface` | the **reviewer**. No host check establishes whether an attacker controls a value in general, so these are judgements, labelled as such, and always `source: "reviewer"`. |

Both halves still carry evidence and can be `unknown`. The difference is that a
`vector` the host could not establish is `unknown` rather than a guess wearing
the reviewer's name — the reviewer's prose about it is still rendered as
context, it simply does not reach `rateSeverity`.

Tiers are defined under "The rule pack". **Discovery is not tiered** — every
language is reviewed. Only the evidence behind a fact is, and a language without
a grammar reaches `unknown`, never "no attack path".

The supported-pattern list starts empty and grows one framework at a time, each
with fixtures. An unrecognised routing style yields `unknown` — a coverage gap
that says so, not a guess wearing a host label.

### Which tree

**HEAD, not base.** A pull request that adds a handler creates a path the base
worktree does not contain, so a base-only analysis misses exactly the attack
surface it exists to rate — it would answer questions about the code *before*
the change.

This is a **blocking prerequisite**: `withPreparedWorkspace` (#78) prepares a
base worktree only (`baseWorktreePath`, marker keyed on `baseSha`). A head
worktree, under the same repository lock and the same rejection of a previously
shared root, has to exist before stage 4 can be honest. It is its own piece of
work and should be its own issue rather than a detail inside this one.

The base worktree remains useful for the opposite question — whether a caller
existed *before* — which is what `structural-check.ts` already reads it for.

**Graphify stays opt-in.** Where its edges exist they may raise confidence; they
may never be required, because that backend needs Python and the default `tgd`
mapper emits no edges at all.

`@ast-grep/napi` ships no prebuilt binary for some platforms, and
`structural-check.ts` already avoids evaluating the binding at module load for
that reason. This stage degrades the same way, and so must every grammar added
for tier 2: no binding, no grammar, no host fact — `unknown`, review continues.
**A missing grammar must never read as an absent attack path.**

## Stage 5: severity policy

Not a pure function of the facts. It takes **the severity discovery assigned**
and the facts, and it is **total** — every combination of inputs, including all
`unknown`, produces a result.

```ts
export function rateSeverity(
  discovered: Finding["severity"],
  facts: AttackPathFacts,
): Finding["severity"];
```

Expressed as control flow rather than a table, because two rounds of review
found combinations a table did not cover. Every branch returns, so the function
is total by construction rather than by enumeration:

```ts
function rateSeverity(discovered, facts) {
  // 1. Any field the decision needs is unknown -> preserve what discovery said.
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
  //     for code that is correct as written (builtin-agents/reviewer.md). Low
  //     confidence caps the result; it does not deny the path.
  const lowConfidence = facts.preconditions.value === "unlikely";

  // 3. Reachable but bounded to one user or tenant. Capped, never raised: a
  //    self-only issue the reviewer called `suggestion` stays there.
  if (facts.crossesBoundary.value === "no") return min(discovered, "warning");

  // 4. Crosses a boundary, from a network surface, on a caller anyone can be.
  if (
    (facts.vector.value === "remote" || facts.vector.value === "local-network") &&
    (facts.authScope.value === "public" || facts.authScope.value === "user")
  ) return lowConfidence ? "warning" : "blocking";

  // 5. Crosses a boundary, but from localhost, or behind internal/admin auth.
  return "warning";
}
```

The counterexample that forced this shape: `attackerControl: plausible`,
`vector: remote`, `preconditions: plausible`, `crossesBoundary: yes`,
`authScope: public` — all known, and matching **no row** of the previous table,
so an implementation following it returned `undefined` against a declared
`Finding["severity"]`. Here it reaches branch 4 and returns `blocking`.

`min` compares on the published ordering `blocking > warning > suggestion`.

`suggestion` is reached only by branch 2 — a path that is genuinely not
reachable: the attacker controls nothing, the preconditions are unachievable,
or there is no vector. That matters because this project's own reviewer
contract reserves `suggestion` for code that is **correct as written**, so
sending a reachable vulnerability there would state something false about it.

### Unknown lowers confidence, never severity

An `unknown` in a required field leaves severity at what discovery said and
renders the unknowns explicitly. On a Go or Rust repository most reachability
fields will legitimately be `unknown`, and that must read as *"we could not
establish the path"*, never as *"there is no path"* — the failure
`dependency-facts.ts` and `hostCheck: not-checked` were both written to avoid.

## The rule pack

### Discovery is language-agnostic; only host verification is not

Worth separating, because the first draft conflated them. A rule is a prompt: a
reviewer reads Java, Go, Rust or Python as readily as TypeScript, and discovery
works in all of them **today, with no new dependency**. What is language-limited
is the *host-verified* tier — the evidence the host establishes rather than
accepts.

| Tier | How | Languages | Cost |
|---|---|---|---|
| 1 — resolved | ast-grep + the in-process TypeScript compiler (#77) | TS/JS family | none; already installed |
| 2 — structural | ast-grep with a registered grammar | Java, Go, Rust, Python, … | a native `@ast-grep/lang-*` per language |
| 3 — asserted | the reviewer says so, labelled as such | everything | none |

Tier 2 is what makes the scan real for Java/Go/Rust/Python, and it is not free:

- `@ast-grep/napi`'s built-in `Lang` is only `Html, JavaScript, Tsx, Css,
  TypeScript`. Anything else needs `registerDynamicLanguage`, which takes **a
  path to a compiled tree-sitter library**.
- Those ship as `@ast-grep/lang-python`, `-java`, `-go`, `-rust` — roughly 6 MB
  unpacked each, all at `0.0.x`.
- They are loaded **by library path**, which is exactly what broke the pi
  extensions inside the single-file binary (#137): a `.dylib` cannot be read
  from `/$bunfs`. Supporting them there means extracting grammars to a temp
  directory at startup, per platform.

Tier 2 is therefore **its own decision**, not a detail of this one. The pass
should ship with tiers 1 and 3 — full discovery everywhere, host verification
where it is free — and tier 2 added per language, each with fixtures, once the
dependency and binary questions are answered.

What must not happen is tier 2's absence being read as an answer. A Go finding
without a grammar is `unknown` reachability, not safe.

### One reachability rule, not four

Injection, deserialization, path handling and the web sinks are the same
question — *does an attacker-controlled value reach a dangerous sink* — and
splitting them into four rules buys four model calls for one analysis. They
collapse into a single rule carrying a **sink table**, with the family recorded
on the finding so the summary can still group by class.

### Deterministic checks are not rules

Secrets, crypto misuse, and the supply-chain and CI checks are largely decidable
from the text. A committed `sk_live_…`, a workflow with `pull_request_target`
plus a mutable action ref, a dependency pinned to a branch — none of these needs
a model to have an opinion, and a model asked for one will sometimes disagree
with the evidence in front of it.

They become **host checks**, in the shape `structural-check.ts` already
establishes: computed by the host, rendered as host facts, unforgeable by
reviewer output, and free. That also removes them from the per-review model
budget entirely.

The pack is therefore:

| | What | Kind | Cost |
|---|---|---|---|
| `sink-reachability` | attacker-controlled value reaching a dangerous sink: SQL/NoSQL/command/LDAP/XPath/template injection, deserialization and unsafe parsing, path traversal and file handling, XSS, SSRF, open redirect | **rule** | one model call, then the attack-path stage |
| `authz-boundary` | missing or incorrect authorization, IDOR, tenant-boundary breaks, privilege escalation, auth bypass | **rule** | one model call, then the attack-path stage |
| `secrets-and-crypto` | committed credentials, weak or misused primitives, unverified signatures and tokens, unsafe randomness | **host check** | none |
| `supply-chain-and-ci` | mutable action refs, `pull_request_target` misuse, over-broad workflow permissions, unpinned or substituted dependencies | **host check** | none |

**Two discovery calls, plus one attack-path call per eligible candidate.** An
earlier draft said "two model calls per review", which understated the cost of
the feature it was asking operators to enable: stage 3 runs per candidate, so a
review with `N` eligible candidates costs `2 + N` calls, bounded by the
candidate budget.

The two host checks add none, which is most of the argument for making them host
checks. `applies_to` (#115) scopes the two rules, so a manifest-only change pays
for neither discovery call and reaches stage 3 only through the host detectors,
which do not use it.

### Host detectors must synthesize findings, not annotate them

A gap the second review found, and the one I had flagged as unexamined: making
secrets and supply-chain **host checks** left them with no way to reach a
reader at all. `structural-check.ts` is the wrong precedent for this half —
it *annotates* findings that already exist. A pull request whose only defect is
a committed credential produces no reviewer finding to annotate, so two of the
four advertised surfaces would have reported nothing, silently.

So host detectors **create** findings, before orchestration:

- they run after dispatch and before `orchestrateFn`, appending to
  `dispatchResult.findings`
- each carries a **host-owned `ruleName`** — `security:secrets`,
  `security:supply-chain` — reserved the way `codex-security` already is, so a
  user rule cannot claim the name and reviewer output cannot forge one
- those names are pushed to `rulesRun`, exactly as the Codex ingest pushes
  `codex-security`, so the summary's "Rules run" reflects what actually ran
- their findings then flow through dedup, clustering, anchoring and publication
  like any other, which is what makes them addressable in conversation and
  countable in `metrics` (#109)
- a detector that fails pushes its name to `rulesFailed` with a reason, rather
  than being absent

Each name also needs a **host-owned policy object**, or the conversation
commands do not work on its findings. `poll.ts` resolves a finding's rule by
looking up `ruleName` among the active rules and reports `inactive` when none
matches; `codex-security` works only because #120 defined
`CODEX_SECURITY_POLICY` — a `RuleDefinition` the host owns and never dispatches.
`security:secrets` and `security:supply-chain` need the same, or `explain` and
`reconsider` return "the trusted rule is no longer active" on a finding the host
produced moments earlier.

Their policy text differs from a rule's in an instructive way: it describes what
the host computed and forbids inventing evidence, exactly as
`CODEX_SECURITY_POLICY` does, because there is no reviewer reasoning to recover
— the finding is a computation, and an explanation must not imply otherwise.

Because these findings never pass through a model, their `hostCheck`-equivalent
provenance is inherent: the host computed the whole finding, so there is nothing
for a reviewer to have asserted. That is a stronger position than the reachability
facts are in, and worth keeping distinct in the rendering.

### Deliberately excluded

- **DoS and resource exhaustion** — every unbounded loop looks like one at diff
  scope, and the false-positive surface would swamp the rest.
- **Memory corruption** — meaningful only where we have the least evidence.
- **Known-CVE dependency matching** — that is #50's dependency facts and the
  advisory endpoint, already built. A rule duplicating it would publish two
  findings for one fact.
- **Secrets in git history** — the diff is the wrong input; that is a different
  tool with a different scope.

### Sequencing this suggests

The two host checks need neither a head worktree nor a supported-pattern table
nor a grammar. They could ship first and be useful while the reachability work
lands — which is worth stating, because the alternative is a feature that does
nothing until three prerequisites are done.

## Where it hooks in

Two hooks, not one — the gate has to precede dispatch:

```
loadRules(...)                              existing
  └─ security pack excluded when off        NEW, before dispatch (as #115)
dispatchRulesFn(...)                        existing
  └─ structural checks            (#75)     existing, --structural-checks on
  └─ security pass                (#139)    NEW,      --security-pass on
       ├─ candidates by PACK MEMBERSHIP     host-known, not category text
       ├─ eligibility gate                  as #80
       ├─ attack-path pass                  one bounded model call
       ├─ reachability                      host, supported patterns only
       └─ severity re-rating                host policy, total function
orchestrateFn(...)                          existing
```

New modules, mirroring the structural checker's layout:

- `src/review/security/attack-path.ts` — the stage-3 contract and parser
- `src/review/security/reachability.ts` — the host check and its pattern table
- `src/review/security/severity-policy.ts` — `rateSeverity`, a **pure, total
  function**, so the rubric is table-testable without a model
- `src/rules/builtin/security/*.md` — the rule pack, vendored like the builtin
  rule and therefore embedded for the binary (#137's `vendored-assets.ts`)

`Finding` gains one optional field, `attackPath?: AttackPathResult`, following
`claim`/`hostCheck`: parsed from reviewer output only where the contract allows,
never persisted in `FindingSnapshot` (a verification computed against one tree
must not be reattached to a finding regenerated against another — #79), and
rendered with its source and evidence when present.

## Cost

- gated on `--security-pass on`, and gated **before dispatch**, so an off review
  makes no security model call and carries no security prompt bytes
- gated on there being eligible candidates, as #80 gates the structural clone
- bounded per review by a candidate budget, as `structural-check.ts` bounds
  claims; overflow becomes `not-analyzed` with a budget reason, never silence
- the total is `2 + min(candidates, budget)` model calls, not two: the two
  discovery rules, plus one attack-path pass per eligible candidate. That
  number is what #113's benchmark should record, and what an operator deciding
  whether to enable this is entitled to see before they do
- `metrics` (#109) gains the counts, so #113's benchmark can measure the cost
  before anyone is asked to turn it on

## Coverage, when both sources are on

`--codex-scan-results` and `--security-pass on` are a supported combination, and
`DispatchResult` carries **one** `scanCoverage`. Having the native pass populate
the same shape would overwrite the ingest's incompleteness, deferred ids and
dropped counts, and publish a coverage story that is not true of either source.

Merge policy, host-computed:

| Field | Rule |
|---|---|
| `completeness` | the **worst** of the two: `unknown` ⊐ `partial` ⊐ `complete` |
| `deferred` | union, bounded, each id prefixed with its source |
| `deferredCount` | sum, before the display bound |
| `droppedFindings` | sum |

A merge that cannot be computed — an ingest whose coverage failed to parse —
degrades to `completeness: "unknown"` rather than to the native pass's own
answer, because the honest statement about two sources when one is unreadable is
that the total is unknown.

## Testing

- **`rateSeverity` is pure and total**, so the rubric is table-driven unit
  tests. Required cases, each from a defect a review round found:
  - every field `unknown` returns `discovered` exactly — the case that had no
    baseline before
  - a known `localhost` + `crossesBoundary: yes` path returns a defined result —
    the combination that matched no row
  - a remote, no-precondition, **self-only** finding does **not** reach
    `blocking` — the overlap between rows 2 and 4
  - `attackerControl: plausible` + remote + plausible preconditions +
    `crossesBoundary: yes` + `authScope: public` returns `blocking` — the
    all-known combination that matched no row in either earlier table
  - a known `localhost` path with `attackerControl: no` returns `suggestion`,
    not `warning` — exploitability is decided before the localhost branch
  - an **exhaustive** test over the full enum cross-product asserting every
    input returns one of the three severities. The function is small enough
    that totality can be proven by enumeration rather than asserted
- **Parsing** rejects a non-`unknown` fact with no evidence, and drops enum
  values outside the contract rather than coercing them, through
  `normalizeUnknownFinding`'s allowlist discipline.
- **Provenance** renders differently: a test asserting a `host` fact and a
  `reviewer` fact with identical values do not produce identical text — and a
  test that reviewer output claiming `source: "host"` is stamped `reviewer`
  anyway, because that field is not parsed.
- **Host detectors produce findings**: a fixture whose only defect is a
  committed credential yields a finding, with its host-owned rule name in
  `rulesRun`, reaching the summary — the case where annotating rather than
  creating would have reported nothing.
- **`not-analyzed`** renders a reason, and a test pins that a budget-deferred
  finding is distinguishable from a finding reviewed with the pass off.
- **Gating**: a `--security-pass off` review dispatches no security rule and
  reports the pack as skipped — asserted on `dispatchRules`' input, as #115's
  scoping tests do.
- **Reachability** against fixture worktrees: a supported router pattern, an
  unrecognised one returning `unknown`, a non-TS file, and a missing ast-grep
  binding.
- **Coverage merge**: two sources, worst-completeness wins, counts sum, an
  unreadable ingest degrades the total to `unknown`.
- **Benchmark fixtures** (#113): a genuinely reachable defect and an
  unreachable look-alike, so the pass can be shown to separate them rather than
  flagging both.

## Explicitly out of scope

- Running any external scanner, in-process or otherwise. See the rejection above.
- SARIF output, a findings service, a dashboard, embedding-based dedupe,
  multi-hour deep scans. Those serve a standalone scanner with durable state.
- Porting their Python helpers. `generate_in_scope_files.py`,
  `normalize_candidates.py` and `finalize_scan_contract.py` each have a
  TypeScript equivalent here already.
- Removing `--codex-scan-results`. It stays as an optional ingestion path for
  teams already running that scanner. It stops being the only way to get
  security coverage, which is the point.

## Open questions for review

Two from the first draft are now settled by review and recorded above: the
attack-path pass stays a **host stage** (it must be gated, budgeted and measured,
and a rule cannot be), and `evidence` becomes **per-fact and required** rather
than one free-text blob.

What remains genuinely open:

1. **Is the three-level collapse right?** The reference distinguishes `critical`
   from `high`; we have `blocking`. Mapping both there may flatten a
   distinction worth keeping — but a fourth severity changes every renderer and
   reopens #36's calibration argument.
2. **Should the head worktree be this issue's work or its own?** Stage 4 cannot
   be honest without it, and `withPreparedWorkspace` prepares only a base. My
   assumption is a separate issue, blocking this one.
3. **Is tier 2 worth four native dependencies?** Java, Go, Rust and Python need
   `@ast-grep/lang-*` grammars — roughly 6 MB each, all `0.0.x`, loaded by
   library path and therefore needing extraction inside the single-file binary.
   Discovery in those languages works without them; only host-verified evidence
   does not. That trade should be decided deliberately, per language.
4. **Should the rule pack ship enabled?** Off by default is safe and means most
   users never see it. There is a case that a security rule pack nobody enables
   is a security rule pack that does nothing — and it is a stronger case now
   that the off path is gated before dispatch and genuinely free.
5. **Is the supported-pattern list a trap?** Starting empty and growing one
   framework at a time is honest, but it means the feature ships with every
   reachability answer `unknown` until someone adds Express. Whether that is a
   principled floor or a feature that does nothing on day one is worth arguing.
