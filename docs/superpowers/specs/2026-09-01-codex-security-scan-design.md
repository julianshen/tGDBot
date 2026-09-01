# Codex Security Findings: Ingest, Don't Execute

## Summary

Add an opt-in finding source that **reads a Codex Security scan result produced
by a separate job** and publishes its findings through the existing review
surface.

tGDBot does not run the scanner. That is the whole design, and it is the result
of a feasibility study that first tried the other way. An earlier revision of
this document specified running the scan as a child process of the review, and
nine review rounds found twenty-plus defects in it — essentially all of them
consequences of executing an unrestrictable agent over attacker-controlled code
from inside the reviewing process. Not running it removes that entire class.

## What the feasibility study established

Kept in full, because it is the durable part and it is what justifies the shape:

| Question | Finding |
|---|---|
| Package exists? | Yes — `@openai/codex-security@0.1.24`, Apache-2.0, ESM. |
| Node engines | SDK `^22.13.0 \|\| ^24.0.0 \|\| ^26.0.0` vs project `>=22.19.0` — not a subset. |
| Python | 3.10+ required by the scan plugin. |
| Install cost | Transitive `@openai/codex` linux-x64 binary is ~332 MB unpacked, plus `react`, `ink`, `pdfjs-dist`, `@linear/sdk`, `@octokit/core`. |
| Tool access | "runs with your local operating-system permissions and never pauses for approval"; `codexOverrides` "can't restrict the scan's filesystem access or change its approval policy". |
| Timeout | `maxTimeHours` is a **deep-mode** setting, rejected in standard mode. |

### Why in-process execution was rejected

ADR-003's guarantee is that a dispatched reviewer *genuinely cannot* call
`bash`/`edit`/`write`. A Codex scan is an agent with full local filesystem and
command access that never pauses for approval, pointed at a tree containing the
PR's code. Running it from the review reintroduces exactly the risk ADR-003
closed.

The attempted mitigations did not converge. Across nine rounds the review found,
among others: the environment allowlist still handed the agent the API key;
`HOME` redirection did not stop it reading `~/.config/gh/hosts.yml`; a private
clone did not make the managed mirror unreachable; proxy variables smuggled
credentials in their values; POSIX process-group kill left the agent running on
Windows; and — the finding that settled it — **nothing in the design created the
sandbox it depended on**, because the worker inherits the parent's mounts and
namespaces and the parent must see the managed workspace to have made the clone.

The last one is structural rather than fixable by another patch. The scan needs
a boundary the reviewing process cannot construct from inside itself. Something
outside must build it. Once something outside is building it, that something may
as well run the scan.

### Why answering open question 1 finishes the argument

The old design needed the PR's head checked out, because `DiffTarget.refs`
resolves against the given worktree and a base-only scan reviews the code
*before* the change. That meant a head fetch (including fork refs), a
`headWorktreePath` with its own ownership marker, and a full per-scan clone.

Judged not worth its cost. And with it goes the ability for tGDBot to run any
scan of the change at all — which is the cut: **tGDBot ingests, it does not
execute.**

## Scope

**In:** reading a scan result file, mapping it to `Finding`, publishing it.

**Out, and no longer this project's problem:** the child process and its
environment, credential delivery, sandbox runners and egress policy, the
isolated clone, head and fork fetching, repository-lock interaction, process-tree
termination, Windows kill semantics, output-directory lifecycle, the optional
peer dependency and its 332 MB, Python, the Node-range conflict, worker
packaging, and scan cost. Each belongs to whoever runs the scanner, which is
where the sandbox already has to be.

## How it runs

The operator runs Codex Security as its own CI job — sandboxed and egress-limited
however that CI system does it — and points the review at the artifact:

```text
--codex-scan-results <path>    (absent = feature off; this is the only new flag)
```

The path names a scan output directory or its `findings.json`. Absent, nothing
changes: no resolution, no read, byte-identical dispatch.

`--dry-run` reports what it would ingest without publishing.

## Reading the artifact

The file is **untrusted input**, exactly like a diff. It was produced by an agent
that read attacker-controlled code, so being on local disk earns it nothing.

- **Bounded before parsed.** A hard byte cap, enforced while reading; overflow is
  a classified failure, not data to salvage. The finding count and total
  scanner-authored text are capped before the document is built. Same ceiling
  discipline as `--max-diff-chars`, `--context-max-chars`,
  `MAX_ADVISORIES_PER_PACKAGE`.
- **Path is not attacker-controlled** — it comes from the operator's own
  invocation — but it is still resolved and checked like any managed path rather
  than trusted for being a CLI argument.

## Mapping to `Finding`

Through `normalizeUnknownFinding`'s existing allowlist, which builds a finding
field by field and drops unknown keys.

| Source | Treatment |
|---|---|
| *(host-owned)* | `category` is set to the constant `"security"`. The gateway rejects any object without a string `category` (`dispatch-results.ts:192`), so an unset one silently discards every finding. Host-owned rather than mapped: a scanner-supplied category is prose, and it renders inside a code span. |
| `severity.level` | Mapped into the closed `blocking \| warning \| suggestion` set. An unrecognized level drops the finding rather than defaulting — but never silently; see coverage below. |
| `locations[0].path`, `startLine` | `file` / `line`, re-anchored through `diff-anchors.ts`. A finding that cannot anchor still posts, in the summary. |
| `title` | `title`, under the ≤80-char one-line contract (ADR-008). |
| finding body | `message`, with ADR-006 defanging in full — the `suggestion` info-string is neutralized like any other finding-derived text. |
| `references` | **Always dropped.** `allowedReferences` derives from a rule file's text; there is none here, so the fail-closed branch applies. |
| remediation text | **Never becomes `suggestion`.** ADR-007 permits a committable suggestion only from a rule-authorized field, and a one-click commit button is the highest-consequence surface in the renderer. |
| `claim` / `hostCheck` | Never accepted. `hostCheck` is host-computed by construction; accepting one would forge the part a reader trusts without re-deriving. |
| `codeEvidence`, `rootCause`, `attackPath`, … | Not carried. `dependency-advisories.ts`'s rule: structured fields only, prose excluded rather than escaped. |

Findings carry `ruleName: "codex-security"`.

## Coverage honesty

`DispatchResult` gains one optional field, threaded to the renderer:

```ts
readonly scanCoverage?: {
  readonly completeness: "complete" | "partial" | "unknown";
  /** Scanner ids matching DEFERRED_ID_RE. Nothing else survives. */
  readonly deferred: readonly string[];
  readonly deferredCount: number;
  /** Findings the artifact reported that the host could not map. Forces `partial`. */
  readonly droppedFindings: number;
};
```

The existing pipeline has nowhere to carry completeness, so this is new plumbing
rather than something inherited.

`deferred` carries **ids only** — a `reason` is scanner-authored prose, and
wrapping prose in an object does not sanitize it. `deferredCount` and
`droppedFindings` are host-computed, so discarding what cannot be rendered never
manufactures a cleaner picture: `furtherAdvisories`' rule, reported and never
absorbed. Reasons go to stderr.

A `partial` or `unknown` result renders an explicit incomplete-coverage line. A
scan cut short must never read as "no security findings".

## Accounting and dedup

- On success `"codex-security"` joins `rulesRun`; on failure it joins
  **`rulesFailed`**, because the renderer surfaces `ruleFailureReasons` only
  while iterating that array (`comment-format.ts:1488-1495`). A reason without
  the array entry renders nothing, and the review publishes an all-clear after a
  failed ingest.
- A `partial` result is **not** a failure.
- Failure phrases are short and classified — `no scan results at that path`,
  `the scan results could not be read`, `the scan results were too large`, and a
  catch-all — with raw errors on stderr only, never in a world-readable comment.
- `computeReviewConfigHash` includes the results path **only when the flag is
  set**, so the feature-off default hashes byte-identically to a pre-feature run
  and upgrading does not re-review every open PR. It also covers a digest of the
  artifact, so re-running after replacing a stale or failed result is not
  suppressed by dedup.

## The reserved rule name

`"codex-security"` is reserved **only while the flag is set** — reserving it
unconditionally would skip an existing user rule of that name and report a load
error on the default path, changing a review for someone who never enabled this.

Reserving it has a consequence the rest of the pipeline does not absorb:
conversation and verification resolve a finding's rule by name
(`poll.ts:1141`, `poll.ts:2916`), and `conversation/actions.ts:306` turns a miss
into `inactive-rule` — so every ingested finding would be reported as belonging
to a rule the maintainer removed. A host-owned synthetic policy record is
supplied to those lookups, and model-driven verification is disabled for these
findings with its own reason: verifying a rule finding re-runs that rule's
prompt, and there is no prompt here.

Clustering, inline anchoring, publication, the marker and re-review suppression
work unchanged — none of them resolve a rule by name.

## What this design does not claim

- **That the scan is safe.** It is exactly as dangerous as before; the danger
  now sits with the job that runs it, where a sandbox can actually be built.
  This project's README should say so where it points at the feature.
- **That the artifact is trustworthy.** It is agent output over hostile code,
  and is treated as untrusted throughout.
- **That existing machinery carries new values.** `rulesFailed`, `scanCoverage`,
  the config hash and the conversation lookups each needed extending by hand.

## Testing

Injected reader; no live scans, no network — the project rule.

- Mapping and refusal tests: severity mapping; unknown severity dropped *and*
  counted; `references`, remediation, `claim`, `hostCheck` all refused; a
  ` ```suggestion ` fence in a message rendered defanged (beside the existing
  ADR-006 cases).
- Sanitation: `deferred` entries carrying fenced markup, marker lookalikes and a
  100 KB reason render as nothing, with `deferredCount` still correct.
- Bounds: an oversized artifact is abandoned at the cap and reported.
- Accounting: failure lands in `rulesFailed` and renders; `partial` lands in
  `rulesRun`; a `partial` with zero findings still states incomplete coverage.
- Default path: with the flag absent, nothing resolves or reads, asserted by a
  reader double that fails the test if called.
- Dedup: flag-off hashes identically to pre-feature; replacing the artifact
  re-triggers.
- Conversation: an ingested finding is not reported as `inactive-rule`.

## Acceptance criteria

Where an AC and a rule above disagree, **the rule wins and the AC is the bug**.

- **AC-1** Flag absent → no read, no resolution, byte-identical dispatch.
- **AC-2** Valid artifact → findings publish as ordinary findings with
  `ruleName: "codex-security"`, anchored inline where they anchor.
- **AC-3** A finding carrying remediation text, references, a claim or a host
  check → none of those fields survives.
- **AC-4** A `suggestion` fence in a message → defanged, no committable
  suggestion.
- **AC-5** Any ingest failure → the review still publishes, `"codex-security"`
  is in `rulesFailed`, and the reason renders as a classified phrase with the
  raw error only on stderr.
- **AC-6** `partial`/`unknown` with zero findings → the summary states coverage
  was incomplete, via `scanCoverage`.
- **AC-7** One unmappable severity → `completeness` is not `"complete"` and
  `droppedFindings` is 1.
- **AC-8** Deferred entries with fenced markup, marker lookalikes or oversized
  text → no scanner prose renders; `deferredCount` counts every entry.
- **AC-9** Artifact over the byte cap → read abandoned at the cap, too-large
  phrase published, memory bounded.
- **AC-10** A user rule named `codex-security` with the flag absent → loads
  normally, no load error, AC-1 holds.
- **AC-11** A conversation command on an ingested finding → not reported as
  `inactive-rule`.
- **AC-12** Flag off → config hash matches a pre-feature marker. Artifact
  replaced → not suppressed by dedup.

## Open questions

1. **Is ingest worth building at all?** The operator can already read the
   scanner's own output. The value this adds is one review comment instead of
   two places to look, plus re-review suppression and inline anchoring. Real,
   but smaller than the original proposal, and worth confirming before
   implementation.
2. **Artifact format.** `findings.json` or SARIF. SARIF is more portable and
   would let other scanners use the same path; `findings.json` is closer to the
   SDK's own types. Deciding this decides how much of the mapping table is
   Codex-specific.
3. **Should the summary link the scan job?** Useful provenance, but a URL from
   an artifact is scanner-supplied and would need the same treatment as any
   other untrusted field.
