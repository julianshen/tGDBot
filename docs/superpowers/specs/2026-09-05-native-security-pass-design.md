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

Issue: #139.

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
1. inventory      EXISTS  changedFilesWithRenameSources(diff), base worktree (#78)
2. discovery      EXISTS  per-rule dispatch of a security rule pack
3. attack path    NEW     one bounded pass per security candidate
4. reachability   NEW     host-established for TS/JS; unknown elsewhere
5. severity       NEW     host policy over the facts from 3 and 4
```

Stages 3–5 run only over findings whose `category` marks them security, and only
when `--security-pass on`. Discovery output that never reaches a reader — an
`addressed` finding, a suppressed duplicate — is excluded before stage 3, using
the same `hasCheckableClaim`-shaped eligibility gate #80 established, because
stage 3 is a model call and must not be spent on a finding nobody sees.

## Stage 3: attack-path facts

The reviewer answers a fixed schema. Every field is evidenced or `unknown`;
there is no third option and no default.

```ts
/** Issue #139. What could be established about reaching this finding. */
export interface AttackPathFacts {
  /** Where an attacker's input enters, and how it reaches the finding. */
  readonly vector: "remote" | "local-network" | "localhost" | "none" | "unknown";
  /** Whether an attacker controls the input the finding depends on. */
  readonly attackerControl: "yes" | "plausible" | "no" | "unknown";
  /** What the path requires before it can be taken. */
  readonly preconditions: "none" | "plausible" | "unlikely" | "unachievable" | "unknown";
  /** Whether the reachable surface is authenticated. */
  readonly authScope: "public" | "internal" | "admin" | "unknown";
  /** Whether impact crosses a trust, tenant or user boundary. */
  readonly crossesBoundary: "yes" | "no" | "unknown";
  /** What is affected if the path is taken. */
  readonly impactSurface: "data" | "identity" | "runtime" | "build" | "network" | "unknown";
  /**
   * Free text, bounded, quoting repository evidence for the fields above.
   * Rendered under the finding; the fields drive policy, this explains them.
   */
  readonly evidence: string;
}
```

Deliberately **narrower than the reference**, which also models service
identity, ports, ingress and load-balancer type. Those are deployment facts a
repository usually cannot establish, and a field that is `unknown` on almost
every review is a field that teaches readers to skip the section.

`evidence` is bounded like every other model-authored string (#110) and
sanitized on the same terms as `message`.

## Stage 4: reachability, and its honest limit

Reachability is the one fact the host can sometimes establish rather than
accept. The Python-free tools already present are `@ast-grep/napi` and the
in-process TypeScript compiler (#77), reading the base worktree (#78).

`LANG_BY_EXTENSION` in `structural-check.ts` covers `.ts .mts .cts .tsx .js
.mjs .cjs .jsx` and nothing else, so:

| Repository | `vector`, `authScope` | Rendered as |
|---|---|---|
| TS/JS family | host-established where a caller chain resolves | a host fact, like `hostCheck` |
| anything else | model-asserted, or `unknown` | clearly attributed to the reviewer |

A model-asserted fact and a host-established one **must never render
identically**. `describeCheck`/`describeCheckCompact` already draw that line for
structural claims and set the precedent.

**Graphify stays opt-in.** Where `--context-mapper graphify` has produced edges,
they may raise confidence in a reachability answer. They may never be required
to produce one, because that backend needs Python and the default `tgd` mapper
emits no edges at all.

`@ast-grep/napi` ships no prebuilt binary for some platforms, and
`structural-check.ts` already avoids evaluating the binding at module load for
that reason. This stage degrades the same way: no binding, no host-established
reachability, `unknown`, review continues.

## Stage 5: severity policy

Severity becomes a host decision over the stage-3 facts. tGDBot publishes three
levels, so the reference's five-level rubric collapses:

| Facts | Severity |
|---|---|
| `attackerControl: yes` **and** `vector: remote` **and** `authScope: public` **and** `crossesBoundary: yes` | `blocking` |
| `attackerControl: yes\|plausible` **and** `vector: remote\|local-network` **and** `preconditions: none\|plausible` | `blocking` |
| reachable but same-user, same-tenant, or authenticated-only | `warning` |
| `attackerControl: no` **or** `preconditions: unachievable` | `suggestion` |
| anything containing `unknown` in a field the rules above required | **see below** |

### Unknown lowers confidence, never severity

The failure this rule exists to prevent: a rubric that reads "unknown
reachability" as "not reachable" converts a coverage gap into a clean bill of
health. That is precisely the failure `dependency-facts.ts` was written to
avoid — *"a review that could not check something must say so; implying it
checked and found nothing is the silent-degradation failure this project
rejects"* — and `hostCheck: not-checked` exists for the same reason.

So an `unknown` in a required field **does not** demote a finding. It produces
the severity the known fields support, and the finding renders its unknowns
explicitly. On a Go or Rust repository most reachability fields will be
`unknown`, and that must read as *"we could not establish the path"*, never as
*"there is no path"*.

## Where it hooks in

`src/cli.ts`, after dispatch and beside the structural check, which already has
the shape this needs — eligibility gate, lock-scoped worktree, degrade with a
host-authored reason:

```
dispatchRulesFn(...)                       existing
  └─ structural checks           (#75)     existing, --structural-checks on
  └─ security pass               (#139)    NEW,      --security-pass on
       ├─ eligible candidates only         (gate, as #80)
       ├─ attack-path pass                 one model call, bounded
       ├─ reachability                     host, TS/JS only
       └─ severity re-rating               host policy, pure function
orchestrateFn(...)                         existing
```

New modules, mirroring the structural checker's layout:

- `src/review/security/attack-path.ts` — the stage-3 contract and parser
- `src/review/security/reachability.ts` — the TS/JS host check
- `src/review/security/severity-policy.ts` — a **pure function**, facts to
  severity, so the rubric is unit-testable without a model
- `src/rules/builtin/security/*.md` — the rule pack, vendored like the builtin
  rule and therefore embedded for the binary (#137's `vendored-assets.ts`)

`Finding` gains one optional field, `attackPath?: AttackPathFacts`, following
`claim`/`hostCheck` exactly: parsed from reviewer output only where the contract
allows, never persisted in `FindingSnapshot` (a verification computed against
one base must not be reattached to a finding regenerated against another —
#79), and rendered only when present.

## Cost

A second model call per eligible security candidate is real spend, so:

- gated on `--security-pass on`, off by default
- gated on there being eligible candidates, as #80 gates the structural clone
- bounded per review by a candidate budget, as `structural-check.ts` bounds
  claims, with the overflow reported as `deferred` rather than dropped
- `metrics` (#109) gains the counts, so #113's benchmark can measure what it
  costs before anyone is asked to turn it on

## Coverage

`ScanCoverage` already exists — `completeness`, `deferred`, `deferredCount`,
`droppedFindings` — and is populated today only by the Codex ingest. The
security pass populates the same shape, so a reader sees one coverage story
whichever source produced the findings.

## Testing

- **`severity-policy.ts` is a pure function**: the whole rubric is table-driven
  unit tests, including one per `unknown`-in-a-required-field case asserting the
  severity did **not** drop.
- **Reachability** against fixture worktrees, as `structural-check` is tested:
  a resolvable caller chain, an unresolvable one, a non-TS file, and a missing
  ast-grep binding.
- **Parsing** the stage-3 contract through `normalizeUnknownFinding`'s
  allowlist discipline: a reviewer that emits `attackPath` fields outside the
  enum has them dropped, not coerced.
- **Benchmark fixtures** (#113): at least one security fixture with a genuine
  reachable defect and one with an unreachable look-alike, so the pass can be
  shown to separate them rather than flagging both.

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

1. **Is the three-level collapse right?** The reference distinguishes
   `critical` from `high`; we have `blocking`. Mapping both to `blocking` may
   flatten a distinction worth keeping — but adding a fourth severity is a
   change to every renderer and to #36's calibration argument.
2. **Should the attack-path pass be a rule, or host-orchestrated?** A rule is
   less machinery and inherits everything; a host stage can be gated, budgeted
   and measured precisely. This document assumes the second, following the
   structural checker, but the first is defensible and cheaper.
3. **Is `evidence` free text a mistake?** It is model-authored prose rendered
   into a world-readable comment. Bounded and sanitized, but every other
   host-adjacent string in this project is either host-authored or a validated
   field, and this is neither.
4. **Should the rule pack ship enabled?** Off by default is safe and means most
   users never see it. There is a case that a security rule pack nobody enables
   is a security rule pack that does nothing.
