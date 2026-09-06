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
whole TS/JS family. That is wrong, and the correction matters more than the
capability: **resolving a call chain proves neither.** The same handler is
public or authenticated depending on Express or Fastify middleware, a decorator,
generated routing, or a project's own wrapper — none of which a caller-edge walk
observes.

So a host fact is produced **only under an explicitly supported pattern with
positive evidence**, and `unknown` otherwise:

| Situation | `source` | Value |
|---|---|---|
| a supported router registration resolves to the finding's symbol, with the mounting evidence read | `host` | established |
| TS/JS resolves, no supported pattern matches | `reviewer` | whatever the reviewer asserted |
| non-TS/JS, or no ast-grep binding | `reviewer` | asserted, or `unknown` |

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
that reason. This stage degrades the same way: no binding, no host fact,
`unknown`, review continues.

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

The rules, applied in order, first match wins:

| # | Condition | Result |
|---|---|---|
| 1 | any field required by rules 2–5 is `unknown` | **`discovered`**, unchanged |
| 2 | `attackerControl: yes` ∧ `vector: remote\|local-network` ∧ `preconditions: none\|plausible` ∧ `crossesBoundary: yes` ∧ `authScope: public\|user` | `blocking` |
| 3 | as 2 but `authScope: internal\|admin`, **or** `vector: localhost` with `crossesBoundary: yes` | `warning` |
| 4 | reachable, but `crossesBoundary: no` — same-user, same-tenant, self-only | `warning`, capped: never above `discovered` |
| 5 | `attackerControl: no` ∨ `preconditions: unachievable` ∨ `vector: none` | `suggestion` |

Rule 1 is what makes "unknown lowers confidence, never severity" implementable.
The draft asserted that rule and could not deliver it: with no baseline, an
all-`unknown` input had nothing to preserve, and the function had to invent a
default. Passing `discovered` in gives it something to preserve.

Rule 3 exists because the draft had no row at all for a known `localhost` path
that crosses a boundary — another local tenant, or a browser reaching a local
service. The function was not total and would have thrown or silently defaulted
on a genuinely serious case.

Rule 2 requires `crossesBoundary: yes` explicitly. Without it the draft promoted
a bounded self-only defect to `blocking` on nothing more than "remote and no
prerequisites", and rows 2 and 4 both matched the same finding.

Rule 4 caps rather than sets: an authenticated same-user issue the reviewer
called `suggestion` should not be *raised* to `warning` by a policy whose job
here is to hold severity down.

### Unknown lowers confidence, never severity

An `unknown` in a required field leaves severity at what discovery said and
renders the unknowns explicitly. On a Go or Rust repository most reachability
fields will legitimately be `unknown`, and that must read as *"we could not
establish the path"*, never as *"there is no path"* — the failure
`dependency-facts.ts` and `hostCheck: not-checked` were both written to avoid.

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
  tests. Required cases, each from a defect the review found in the draft:
  - every field `unknown` returns `discovered` exactly — the case that had no
    baseline before
  - a known `localhost` + `crossesBoundary: yes` path returns a defined result —
    the combination that matched no row
  - a remote, no-precondition, **self-only** finding does **not** reach
    `blocking` — the overlap between rows 2 and 4
  - a property test that the function is total: no input throws or returns
    `undefined`
- **Parsing** rejects a non-`unknown` fact with no evidence, and drops enum
  values outside the contract rather than coercing them, through
  `normalizeUnknownFinding`'s allowlist discipline.
- **Provenance** renders differently: a test asserting a `host` fact and a
  `reviewer` fact with identical values do not produce identical text.
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
3. **Should the rule pack ship enabled?** Off by default is safe and means most
   users never see it. There is a case that a security rule pack nobody enables
   is a security rule pack that does nothing — and it is a stronger case now
   that the off path is gated before dispatch and genuinely free.
4. **Is the supported-pattern list a trap?** Starting empty and growing one
   framework at a time is honest, but it means the feature ships with every
   reachability answer `unknown` until someone adds Express. Whether that is a
   principled floor or a feature that does nothing on day one is worth arguing.
