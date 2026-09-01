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

Environment rule, **allowlist rather than denylist** — and stricter than
graphify's for a reason graphify does not face.

graphify can afford a denylist: it is a deterministic AST indexer, so an
unrecognized variable reaching it is inert. This child runs an agent with
command and network access over attacker-controlled code, where every
variable that is not refused is a variable that can be exfiltrated. A
denylist enumerating `ANTHROPIC|OPENAI|AWS|…` plus the VCS tokens silently
passes `NPM_TOKEN`, `DATABASE_URL`, `SENTRY_DSN`, `SSH_AUTH_SOCK` and
whatever the next CI system invents. The default must be *refuse*.

So the child's environment is **built up from empty**:

- **Allowed:** `PATH`, `LANG`/`LC_*`, `TZ`, the proxy variables
  (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`), and `OPENAI_API_KEY` **or** `CODEX_API_KEY` —
  exactly one, chosen by the operator.
- **Everything else is dropped**, including anything the review's own process
  needs. A variable is added to the allowlist only with a stated reason.

`HOME` is **not** inherited, which is the half a denylist cannot fix at all.
Removing `GH_TOKEN` from the environment accomplishes nothing while the agent
can read `~/.config/gh/hosts.yml`, which stores the same token — and beside it
`~/.ssh`, `~/.npmrc`, `~/.aws/credentials`, and `~/.pi/auth.json`. An
environment boundary that a filesystem read walks around is not a boundary.

The child therefore gets a **fresh, empty `HOME`**: a `mkdtemp` directory
created per scan and removed with the scan output. `session-hermetics.ts`
already establishes this pattern for dispatch (`createIsolatedAgentDir`,
pointed at via `PI_CODING_AGENT_DIR`) — the difference is that dispatch
symlinks credentials in deliberately, and this one links nothing.

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

`review()` gains one step, after the diff and base SHA are pinned and before
rule dispatch:

```
withPreparedWorkspace( prepare → [codex scan] ) → dispatch rules → merge → dedup → publish
```

**The scan runs INSIDE the repository lock, via `withPreparedWorkspace`** —
not after a `prepareWorkspace` call. This is not a refinement; a scan outside
the lock is incorrect. `prepareWorkspace` releases the lock before it returns,
so two reviews on the same repository and base can have one running
`reset --hard` / `clean -ffdx` over the shared worktree while the other reads
it. Issue #78 already worked this out for structural checks, and its reasoning
transfers exactly: an unlocked race was tolerable while readers produced
*context*, which is framed as untrusted and which a reader weighs, but a
structural check derives a host-authored fact — "the one line a reader is
invited to trust without re-deriving" — and a scan finding anchored to
`file:line` is the same kind of claim. A scan racing another job's `clean`
can report a vulnerability at a line that only ever existed in that job's
scratch tree.

The request must pass **`rejectPreviouslySharedRoot: true`**. It defaults to
false, and every existing consumer that runs tooling out of a prepared tree
sets it — `cli.ts:1647` for structural checks, `prepare.ts:540` for context
mapping, `poll.ts:2058`. Without it, a workspace root that was once writable
by another user lets an attacker pre-create an expected-origin mirror whose
`hooks/post-checkout` runs during `git worktree add` — in the **parent**
process, before the scan child exists, and therefore under the parent's full
environment rather than the allowlisted one. `manager.ts:129` documents that
vector directly. Every managed-workspace request this feature makes sets the
flag.

What the scan is pointed at is **an isolated clone, not the managed
worktree**: `git clone --no-hardlinks --no-local`-equivalent into the
per-scan temp directory, carrying base and head, with no shared object store
and no inherited hooks. The managed mirror is never exposed to the scan,
because a scan that can write `repository.git/hooks/post-checkout` has left
something behind that a **later parent-side** `git worktree add` executes —
persistence that outlives the scan, its temp directory and its environment.
Managed git invocations additionally set `core.hooksPath` to an empty
directory, so a hook planted by any other means is inert.

That changes the locking answer for the better. The clone is made **under**
`withPreparedWorkspace`, and the lock is released before the scan itself runs.
The clone is a private, immutable copy, so #78's hazard — a host-authored fact
derived from a tree another job can `reset --hard` underneath — is closed by
construction rather than by serialising every other job on that repository for
the scan's whole duration. `--codex-scan-timeout` no longer has to sit below
`SCOPED_LOCK_TIMEOUT_MS`. The cost moves from contention to disk: one full
checkout per scan, removed with the scan output.

Scan findings are merged into `DispatchResult.findings` carrying
`ruleName: "codex-security"`. Clustering, inline anchoring, re-review
suppression, the conversation state store and the published marker then work
unchanged, because they are ordinary findings by the time they reach it.

**Coverage is the exception, and needs new plumbing.** `DispatchResult` and
the renderer's input (`comment-format.ts:1579`) carry findings and rule
accounting only — there is no field a completeness value could live in, so
"the summary renders an incomplete-coverage line" is not something the
existing pipeline can do. AC-6 is unimplementable without it. The design
therefore adds a typed optional field:

```ts
readonly scanCoverage?: {
  readonly completeness: "complete" | "partial" | "unknown";
  readonly deferred: readonly { readonly id: string; readonly reason: string }[];
};
```

carried on `DispatchResult`, threaded into the renderer input, and rendered by
a dedicated section. Optional, so every existing engine and test double that
never sets it is unaffected. `deferred` is structured (an id and a reason), so
no scanner prose reaches the comment — the same rule the finding mapping
follows.

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
--codex-scan-sandboxed         (required assertion; see Security bounds item 2)
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

**A reason alone is not enough: `"codex-security"` must also be pushed onto
`rulesFailed`.** The renderer looks up `ruleFailureReasons` only while
iterating `rulesFailed` (`comment-format.ts:1488-1495`), and the terminal
status line derives from the same array — so a failure recorded only as a
reason renders nothing at all, and the review publishes an all-clear that
silently omits a scan that never ran. That is precisely the "clean bill of
health manufactured out of a rejection" failure this design refuses elsewhere,
and it would defeat AC-5. Symmetrically, a completed scan appends
`"codex-security"` to `rulesRun`, so the two arrays keep accounting for every
dispatched source.

A scan that completes with `coverage.completeness: "partial"` is **not** a
failure and does not enter `rulesFailed`; it renders through the
incomplete-coverage path below. The two must not be conflated — a partial
scan produced findings worth reading, and a failed one produced nothing.

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
2. **An OS-level boundary is a precondition, not a recommendation.** This is
   the item everything else depends on, and it must not be overstated: the
   process-level measures below are defense-in-depth, **not** a sandbox.

   The scan keeps ordinary operating-system permissions. Giving it a fresh
   `HOME` does not remove its read access to the operator's real home — it can
   open `/home/<user>/.config/gh/hosts.yml`, `~/.ssh` or `~/.pi/auth.json` by
   absolute path — and nothing at the process level stops it writing anywhere
   the invoking user can write. An earlier draft of this document claimed the
   scan "cannot read a token off disk"; that was wrong, and the correction is
   the reason this item is now first among the concrete bounds.

   The only real boundary is external: a container, VM, or dedicated
   unprivileged user that exposes the scan inputs and nothing else. The CLI
   therefore **refuses to scan unless the operator explicitly asserts that
   boundary** (`--codex-scan-sandboxed`, or the equivalent environment
   assertion for CI). Refusing by default is deliberate: an unsandboxed scan
   is the dangerous case, so it must not be reachable by forgetting a flag.
   The CLI cannot verify the assertion, and says so rather than implying it
   checked.
3. **Environment allowlisted and `HOME` isolated** as specified above. This
   narrows what is trivially reachable — it does not make the operator's
   credentials unreadable, per item 2. Its real value is that the scan cannot
   accidentally *inherit* a token it never needed, and that a leak now
   requires the agent to go looking rather than to read what it was handed.
4. **The managed mirror is never exposed to the scan**, and every workspace
   request passes `rejectPreviouslySharedRoot: true`. The scan reads an
   isolated clone; managed git runs with `core.hooksPath` pointed at an empty
   directory. Together these close the persistence vector: a hook written
   into shared state and executed later by the parent, outside every bound
   above.
5. **Output outside the worktree**, `0o700`, removed by default.
6. **No new publication surface.** Scan findings reach the reader through the
   same renderer, with the same ADR-006 defanging and the same ADR-007
   suggestion restriction.
7. **No committable suggestions from scan output**, ever. A published finding
   names the isolated clone's tree, which no other job can rewrite.
8. The `--codex-scan` flag is recorded in the published marker's config hash,
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
- **Environment allowlist test** — the child's env is asserted by *equality*
  against the expected allowlisted set, not by absence of known-bad names: an
  absence test passes for every secret nobody thought to enumerate, which is
  the failure mode that made this an allowlist. Includes an unrecognized
  `NPM_TOKEN`-style variable that must not survive, and asserts `HOME` points
  at the per-scan temp directory.
- **Failure classification tests** — one per error class, asserting the
  published phrase and that the raw message does not appear in it.
- **Coverage honesty test** — `completeness: "partial"` renders the
  incomplete-coverage line; `complete` with zero findings does not claim more
  than it found.
- **Default-path test** — with the flag off, nothing resolves the SDK, spawns
  a child, or reads a Codex key. Asserted by a resolver double that fails the
  test if called.
- **Dedup test** — flipping `--codex-scan` changes `computeReviewConfigHash`.
- **Clone-isolation tests** — the workspace request carries
  `rejectPreviouslySharedRoot: true`; the path handed to the scan is not the
  managed worktree and does not reach the managed mirror; the clone is created
  inside `withPreparedWorkspace`'s callback.
- **Coverage plumbing test** — a `partial` scan with zero findings renders the
  incomplete-coverage section, asserted end to end through
  `DispatchResult.scanCoverage` rather than at the mapper.

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
  still publishes, `"codex-security"` appears in `rulesFailed`, and the reason
  renders as a classified phrase with the raw error only on stderr.
- **AC-5b** Given a scan that completes with `completeness: "partial"`, when
  the review publishes, then `"codex-security"` appears in `rulesRun` and not
  in `rulesFailed`.
- **AC-6** Given `coverage.completeness` of `partial` or `unknown` and zero
  findings, when the summary renders, then it states that coverage was
  incomplete — carried through `DispatchResult.scanCoverage`, not inferred.
- **AC-7** Given `--codex-scan on` and an ambient environment carrying
  `GH_TOKEN`, `NPM_TOKEN`, `DATABASE_URL` and a provider key, when the child is
  spawned, then its environment contains only the allowlisted names and the one
  Codex key, and its `HOME` is a fresh empty directory rather than the
  operator's.
- **AC-10** Given a scan in progress, when a second review on the same
  repository and base runs `reset --hard` / `clean -ffdx`, then the scan's
  findings are unaffected, because it reads a private clone made under the
  lock rather than the shared worktree.
- **AC-11** Given a managed-workspace request made for a scan, when it is
  built, then `rejectPreviouslySharedRoot` is `true`.
- **AC-12** Given a scan that writes to `hooks/post-checkout` in the tree it
  was given, when the next managed `git worktree add` runs, then no scan-written
  hook executes.
- **AC-13** Given `--codex-scan on` without the sandbox assertion, when the
  review runs, then the scan refuses to start and says why, and the review
  still publishes its rule findings.
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
5. **Clone cost.** One full checkout per scan, on top of the managed base
   worktree. Acceptable for a flag that is off by default and already requires
   a disposable environment, but it should be measured on a large repository
   before this is called settled.
6. **Asserting the sandbox.** `--codex-scan-sandboxed` is an unverifiable
   claim by the operator. Worth investigating whether a cheap positive signal
   (a container marker, a namespace check, an unprivileged-user check) can
   turn some of it into something the CLI actually verifies.
