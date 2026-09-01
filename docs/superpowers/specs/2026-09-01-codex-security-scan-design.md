# Codex Security Scan Design

## Summary

Add an **opt-in, off-by-default** finding source that runs an OpenAI Codex
Security scan over the reviewed change and merges its results into the review
as ordinary `Finding` records, alongside the findings produced by dispatched
rules.

The integration is feasible — the SDK's runtime requirements are compatible
with this project and its result shape maps cleanly onto `Finding` — but it
carries **one blocking design conflict** (below) that determines the entire
shape of the feature: a Codex scan is an agent with real tool access over a
tree containing attacker-controlled code, which is precisely the capability
ADR-003 removed from every other reviewing agent in this codebase.

Everything else in this document follows from resolving that conflict rather
than from the SDK's convenience surface.

## Feasibility findings

Established against the published package and this repository, not inferred:

| Question | Finding |
|---|---|
| Package exists? | Yes — `@openai/codex-security@0.1.24`, Apache-2.0. |
| Module system | ESM. This project is `"type": "module"`. Compatible. |
| Node engines | SDK: `^22.13.0 \|\| ^24.0.0 \|\| ^26.0.0`. Project: `>=22.19.0`. **Not a subset** — the project's range admits Node 23/25/27, the SDK's does not. |
| Python | Requires Python 3.10+ (3.10 also needs `tomli`). Precedent exists: the `graphify` context mapper already requires Python 3. |
| Install cost | Pulls `@openai/codex`, whose per-platform binary is **~332 MB unpacked** (linux-x64), plus `react`, `ink`, `pdfjs-dist`, `@linear/sdk`, `@octokit/core`. Current production dependency count: 6. |
| Tool access | "The SDK runs with your local operating-system permissions and never pauses for approval." `codexOverrides` "can't restrict the scan's filesystem access or change its approval policy." |
| Credentials | `OPENAI_API_KEY` / `CODEX_API_KEY`, or a file-backed sign-in. "Scan processes can inherit your environment, so remove unrelated credentials before you start." |

### The blocking conflict

ADR-003's guarantee is that a dispatched review subagent *genuinely cannot*
call `bash`/`edit`/`write` — not that it is instructed not to. The README
states the consequence plainly: an adversarial diff "can at most try to skew
its own analysis or output", because "it has no tool available that could take
a real destructive action".

A Codex Security scan inverts that. It is an agent with full local
filesystem and command access, it never pauses for approval, the SDK
explicitly declines to let the caller restrict either, and the tree it is
pointed at contains the PR's code. The diff is attacker-controlled by
necessity — that is the whole premise of the tool — so an unsandboxed scan
reintroduces exactly the RCE-class risk ADR-003 closed, and does so with the
CLI's environment in scope: provider API keys and `GH_TOKEN`/`GITHUB_TOKEN`
(which carries PR-comment write access) are both reachable.

This does not make the feature unbuildable. It makes it a feature that must
be **off by default, explicitly opted into, environment-scrubbed, and
documented as requiring a disposable environment** — the same posture
`dependencyFacts` already takes for a far smaller risk (one outbound request),
scaled to a much larger one.

## Goals

- Run a Codex Security scan over the reviewed change and publish its findings
  through the existing review surface, with no new publication path.
- Keep the default behaviour of the CLI **byte-identical** to today: nothing
  resolves, installs, spawns, or authenticates unless the flag is on.
- Subject scan output to the same trust boundary as reviewer output — it is
  model output over an attacker-controlled tree, and is treated as such.
- Never let a scan failure, timeout, cost limit, or missing runtime fail the
  review.
- Report coverage honestly: a partial scan must not read as a clean bill of
  health.

## Non-goals

- Deep mode (`mode: "deep"`, workers, subagents, `maxDiscoveryRuns`). v1 runs
  a standard scan only; deep mode's hour-scale budgets do not fit a per-PR
  review.
- Knowledge-base documents (`knowledgeBasePaths`), `scanPrompt`,
  `postScanPrompt`.
- Publishing SARIF, or surfacing `repositoryFindings` scan history.
- Carrying the narrative finding fields (`codeEvidence`, `rootCause`,
  `attackPath`, `validation`, `remediationTests`, `preventiveControls`).
- Interactive sign-in (`loginChatGPT`, `loginChatGPTDeviceCode`). The CLI has
  no interactive surface, and a browser flow is wrong for CI.
- Enabling the scan in `poll` mode by default.

## Architecture

### Process shape: a scrubbed child process, not an in-process call

The SDK is an in-process library, but `process.env` is process-global: there
is no way to hand the scan a reduced environment from inside our own process
without mutating the environment the rest of the review runs in. The SDK's
own guidance ("remove unrelated credentials before you start") is therefore
not satisfiable in-process.

`graphify-mapper.ts` already solved this shape for this codebase: `execFile`
with a fixed argument list and an environment scrubbed of provider
credentials, because "handing it one anyway would turn a code-indexing tool
into a key-exfiltration surface keyed on whatever its Python dependency tree
does". The same reasoning applies with more force here, since this child
*does* execute an agent.

So: a small bundled worker (`dist/review/codex-scan-worker.js`) that imports
the SDK, is spawned by `codex-scan.ts` with a **denylist-scrubbed environment
carrying exactly the keys the scan needs**, and writes one JSON document to
stdout. This keeps the SDK's typed results while regaining the env control
the in-process path cannot offer.

Environment rule, stricter than graphify's:

- **Removed:** every provider credential pattern graphify already strips,
  plus `GH_TOKEN`, `GITHUB_TOKEN`, `GH_REPO`, `GITHUB_REPOSITORY`,
  `GLAB_TOKEN`, and the `GIT_*` path overrides `workspace/manager.ts` already
  enumerates.
- **Kept:** `OPENAI_API_KEY` **or** `CODEX_API_KEY` (exactly one, chosen by
  the operator), proxy variables, `PATH`, `HOME`.

The scan is `auth: "api-key"`, always. A file-backed sign-in is deliberately
not used: it would make the scan's identity depend on ambient state the CLI
cannot see.

### Dependency shape: optional, lazily resolved

`@openai/codex-security` is an **optional `peerDependency`**, never a
`dependencies` entry. A ~332 MB platform binary and a React/ink/pdfjs tree
must not land in every install of a CLI that today ships six production
dependencies and is expected to run in ephemeral CI containers.

Resolution reuses `extensions.ts`'s established pattern — `createRequire` +
`require.resolve`, with the `ERR_PACKAGE_PATH_NOT_EXPORTED` walk-up already
implemented there. Absent package, or a Node major outside the SDK's range,
produces a classified failure reason with an install hint; it never throws
into the review.

### Scan target

`DiffTarget.refs({ base: pr.baseSha, head: pr.headSha })`, run against the
managed worktree.

Two facts make this the only correct option, and both cost work:

1. The managed workspace checks out **only the base**, at `baseSha`
   (`deriveWorkspacePaths` derives exactly one `baseWorktreePath` per SHA, and
   `prepareWorkspace` hard-resets and cleans it). The PR's head is never
   checked out anywhere.
2. The diff itself is fetched from the provider API (`gh pr diff`, or the
   file-by-file reconstruction for >20,000-line diffs), never applied to a
   tree.

So the workspace manager needs to additionally fetch `headSha` into the mirror
and expose it to the worktree — a bounded, well-scoped change, but a real one,
with its own owner-marker and path-derivation work under the existing
`assertInside` invariants.

A path-scoped scan of the base worktree (`target: [...changed paths]`) is
explicitly rejected as the cheap alternative: it scans the code *before* the
change, which answers a question nobody asked.

### Output directory

`outputDir` must sit outside the scanned worktree or the SDK raises
`OutputInsideProtectedRootError`. It is placed under a new `scans/` sibling of
`worktrees/` inside the managed repository root, derived through
`deriveWorkspacePaths` so `assertInside` and `assertNoSymlinkedAncestors`
cover it like every other managed path.

Scan results contain source excerpts and vulnerability detail. The directory
is created `0o700`, and is removed after the findings are read unless
`--codex-scan-keep-output` is passed.

### Pipeline placement

`review()` gains one step, after the diff and base SHA are pinned and the
workspace is prepared, and before rule dispatch:

```
prepare workspace → [codex scan] → dispatch rules → merge → dedup → publish
```

Scan findings are merged into `DispatchResult.findings` carrying
`ruleName: "codex-security"`. Everything downstream — clustering, inline
anchoring, re-review suppression, the conversation state store, the published
marker — then works unchanged, because they are ordinary findings by the time
they reach it.

`"codex-security"` is a reserved rule name: `loadRulesForReview` rejects a
user rule that claims it, the same way `planReviewWorkflow` already rejects
duplicate rule names.

### Trust boundary

Codex findings are model output over an attacker-controlled tree. They pass
through `normalizeUnknownFinding`'s existing allowlist gateway, which builds a
finding field by field and drops unknown keys — no separate parser.

Field mapping, and what is deliberately refused:

| SDK field | Treatment |
|---|---|
| `severity.level` | Mapped into the closed `blocking \| warning \| suggestion` set. An unrecognized level **drops the severity mapping and the finding**, rather than defaulting — a mis-tiered security finding is worse than an absent one. |
| `locations[0].path`, `startLine` | `file` / `line`, re-anchored through `diff-anchors.ts`. A finding that cannot anchor inside the diff still posts, in the summary comment. |
| `title` | `title`, subject to the existing ≤80-char one-line contract (ADR-008). |
| finding body | `message`, subject to ADR-006 defanging in full: the `suggestion` info-string is neutralized like any other finding-derived text. |
| `references` / citations | **Always dropped.** `allowedReferences` is derived from a rule file's own text; there is no rule text here, so the fail-closed branch applies unchanged. |
| remediation text | **Never becomes `suggestion`.** ADR-007 permits a committable suggestion only from a validated field authorized by rule text. Codex remediation prose is not that, and a one-click commit button is the highest-consequence surface in the renderer. |
| `claim` / `hostCheck` | Never accepted. `hostCheck` is host-computed by construction; accepting one from a scanner would forge the one part a reader is meant to trust without re-deriving. |
| `codeEvidence`, `rootCause`, `attackPath`, … | Not carried in v1. `dependency-advisories.ts`'s rule stands: structured fields only, prose excluded rather than escaped. |

### Coverage honesty

`coverage.completeness` is `complete`, `partial`, or `unknown`. A `partial` or
`unknown` scan renders an explicit line in the published summary naming what
was not covered (`coverage.deferred` ids and reasons, which are structured).

This is the `dependency-advisories.ts` lesson applied directly: a scan that
was cut short by `maxTimeHours`, a cost limit, or an interruption must not
render as "no security findings". A clean bill of health manufactured out of
an incomplete run is the worst output this feature could produce.

### Cost and telemetry

`maxCostUsd` is set from `--codex-scan-max-cost` (default: a conservative
non-zero ceiling), and `onCost` feeds new `RunMetrics` fields, per issue #109's
rule that every field is a committed, greppable measurement:

- `codexScanUsd` — estimated spend for the scan.
- `codexFindings` — findings published from the scan.
- `codexCompleteness` — `complete` / `partial` / `unknown`.
- `codexDurationMs` — measured at the terminal emitter, like `durationMs`.

The SDK notes the limit is an estimate, not a hard cap, so the flag is
documented as such.

### Dedup

`computeReviewConfigHash` must include the codex-scan flags. Otherwise
enabling the scan on an already-reviewed head is suppressed by the marker and
silently does nothing — the failure mode config-aware dedup exists to prevent.

## CLI surface

```
--codex-scan on|off            (default: off)
--codex-scan-max-cost <usd>
--codex-scan-timeout <hours>   → maxTimeHours
--codex-scan-keep-output       (retain the scan directory)
```

`--codex-scan on` in `poll` mode requires the flag to be set explicitly per
invocation; it is never inherited from a repository default.

Under `--dry-run`, the SDK's `preflight()` runs and its plan is printed, but no
scan starts. `preflight` "leaves the Codex runtime and credentials untouched",
which makes it exactly the right zero-cost gate for both dry-run and as the
pre-check before every real scan.

## Failure handling

Never fatal. Every failure lands in
`ruleFailureReasons["codex-security"]` as a **short classified phrase safe to
publish** — the raw error goes to stderr, per the existing rule that published
failure reasons must not echo provider request detail into a world-readable
comment.

| SDK error | Published phrase |
|---|---|
| `AuthenticationRequiredError` | no API key for the Codex Security scan |
| `PluginPythonUnavailableError` | Python 3.10+ unavailable for the scan |
| `PluginBootstrapError` | the scan runtime could not start |
| `ConfigurationError`, `InvalidTargetError` | the scan target or configuration was rejected |
| `OutputDirectoryError`, `OutputInsideProtectedRootError` | the scan output location was rejected |
| `ScanCostLimitExceededError` | the scan stopped at its cost limit |
| `IncompleteScanError`, `ContractValidationError` | the scan did not produce a usable result |
| `ScanInterruptedError` | the scan was interrupted |

`ScanInterruptedError` carries `scanDir`; that path is logged to stderr and
the directory preserved regardless of `--codex-scan-keep-output`.

The child process is bounded by `--codex-scan-timeout` and killed on the
review's own abort path, with `AbortSignal` passed through to `run()`.

## Security and resource bounds

1. **Off by default**, and documented in the README's "⚠️ Security
   Considerations" section as requiring an ephemeral, isolated environment —
   not as a recommendation but as the condition under which it is supported.
2. **Environment scrubbed** as specified above. The scan never receives a VCS
   token; it has no reason to talk to `gh`/`glab`, and that token is the
   write path to the PR.
3. **Output outside the worktree**, `0o700`, removed by default.
4. **No new publication surface.** Scan findings reach the reader through the
   same renderer, with the same ADR-006 defanging and the same ADR-007
   suggestion restriction.
5. **No committable suggestions from scan output**, ever.
6. The `--codex-scan` flag is recorded in the published marker's config hash,
   so a reader can tell whether a given review included a scan.

## Testing strategy

Following the project rule that the automated suite makes no live LLM or
network calls, the scan boundary is **injected**, exactly as `FetchJson` is in
`dependency-facts.ts`.

- **Mapping unit tests** — SDK-shaped result fixtures in, `Finding[]` out.
  Cover: severity mapping, unknown severity dropped, anchoring inside and
  outside the diff, `title` length contract.
- **Refusal tests** (the important half) — a fixture whose findings carry
  `references`, a remediation string, a `claim`, and a `hostCheck` produces a
  finding with none of them. A fixture whose message contains a
  ` ```suggestion ` fence renders defanged, asserted in
  `comment-format.test.ts` alongside the existing ADR-006 cases.
- **Environment scrubbing test** — the child's env contains no
  `GH_TOKEN`/`GITHUB_TOKEN`/`ANTHROPIC_API_KEY`, and contains the one Codex
  key. Mirrors the existing graphify scrubbing test.
- **Failure classification tests** — one per error class, asserting the
  published phrase and that the raw message does not appear in it.
- **Coverage honesty test** — `completeness: "partial"` renders the
  incomplete-coverage line; `complete` with zero findings does not claim more
  than it found.
- **Default-path test** — with the flag off, nothing resolves the SDK, spawns
  a child, or reads a Codex key. Asserted by a resolver double that fails the
  test if called.
- **Dedup test** — flipping `--codex-scan` changes `computeReviewConfigHash`.

## Acceptance criteria

- **AC-1** Given `--codex-scan off` (the default), when a review runs, then no
  SDK resolution, child process, or credential read occurs, and the dispatched
  task text is byte-identical to today's.
- **AC-2** Given `--codex-scan on` and a completed scan, when the review
  publishes, then scan findings appear as ordinary findings with
  `ruleName: "codex-security"`, anchored inline where they anchor.
- **AC-3** Given a scan finding carrying remediation text, references, a
  claim, or a host check, when it is normalized, then none of those fields
  survives onto the published finding.
- **AC-4** Given a scan whose finding message contains a `suggestion` fence,
  when it is rendered, then the fence is defanged and no committable
  suggestion is produced.
- **AC-5** Given any scan failure, when the review completes, then the review
  still publishes, and the reason appears as a classified phrase with the raw
  error only on stderr.
- **AC-6** Given `coverage.completeness` of `partial` or `unknown`, when the
  summary renders, then it states that coverage was incomplete.
- **AC-7** Given `--codex-scan on`, when the child is spawned, then its
  environment contains no VCS token and no provider key other than the Codex
  key.
- **AC-8** Given `--dry-run --codex-scan on`, when the review runs, then
  `preflight` runs and its plan prints, and no scan starts.
- **AC-9** Given two runs on the same head differing only in `--codex-scan`,
  when dedup is evaluated, then the second is not suppressed.

## Open questions

1. **Does the head worktree earn its cost?** Fetching and checking out
   `headSha` is new workspace-manager surface and a second worktree per
   review. If the answer is no, the feature does not ship — a base-only scan
   reviews the wrong code.
2. **Node range.** Keeping the project at `>=22.19.0` while the scan needs
   `^22.13 || ^24 || ^26` means the flag is unavailable on Node 23/25/27.
   Runtime check and a classified failure phrase, or tighten `engines`?
3. **Trusted Access.** The SDK reports `granted` / `not_granted` / `unknown`
   and warns when access is missing. Should `not_granted` be a hard refusal
   rather than a warning, given a degraded scan's findings still publish?
4. **Bundling the worker.** `dist/review/codex-scan-worker.js` is a new build
   output; the `build` script currently only compiles and copies two `.md`
   files.
