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

- **Allowed:** `PATH`, `LANG`/`LC_*`, `TZ`, and the proxy variables
  (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`).
- **Everything else is dropped**, including anything the review's own process
  needs. A variable is added to the allowlist only with a stated reason.
- **The Codex credential is not on that list**, and is not an environment
  variable at all — see below.

#### The one credential the allowlist cannot simply keep

An allowlist that ends with "…and the API key" hands the agent the single
secret it still has. The scan needs outbound network by definition, so no
filesystem boundary contains a stolen key, and `maxCostUsd` bounds this run's
spend, not what someone else does with the credential afterwards. An
attacker-controlled diff that talks the agent into printing its own
environment gets a working key — which is the exact outcome the rest of this
section exists to prevent, reintroduced by the one exception.

So the key is **delivered out of band and kept out of the environment the
agent's tool subprocesses inherit**:

1. The parent passes it to the worker over a pipe (an inherited fd or stdin),
   never as a variable in the child's environment.
2. The worker authenticates the runtime with it — `loginApiKey(apiKey)` exists
   precisely to take a key programmatically — and holds it in a local, so no
   command the agent runs inherits it.
3. If a future SDK version can only read the key from the environment, the
   worker sets it, lets the runtime consume it, and **deletes it from
   `process.env` before the scan starts**, so it is absent from every tool
   subprocess spawned thereafter.

The residual is stated rather than papered over: a key the worker holds
in-process is still reachable by anything executing in that process, and step 3
is a race the SDK's internals could reopen. Tool subprocesses are the exposure
that actually matters here and they are closed; a per-run brokered or
short-lived credential is the real answer, and is open question 7.

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

A path-scoped scan of the base worktree (`target: [...changed paths]`) is
explicitly rejected as the cheap alternative: it scans the code *before* the
change, which answers a question nobody asked.

#### The head and fork contract

The SDK resolves a `refs` target against the checkout it is given and rejects
the scan when that checkout's `HEAD` is not the requested head. So the tree
handed to the scan must be **checked out at `pr.headSha`**, and the host must
verify `git rev-parse HEAD === pr.headSha` before starting rather than
discovering it as an `InvalidTargetError` afterwards.

That is more than a checkout argument, because of where the head comes from:

- The managed mirror fetches `origin` only. For a same-repository PR the head
  arrives with an ordinary fetch. **For a fork PR it does not exist in the
  mirror at all** and must be fetched explicitly — `refs/pull/<n>/head` on
  GitHub, the equivalent MR ref on GitLab.
- Fork PRs are not an edge case here. They are the *main* case: the whole
  premise of this feature is reviewing contributions from people who cannot
  push to the repository. A design that only works for same-repo branches
  would work for exactly the population that needs it least.
- The head fetch brings attacker-authored objects into the shared mirror. That
  is already true of any diff this tool reads, but it is one more reason the
  scan reads an isolated clone rather than anything mirror-backed.

So the workspace manager gains an explicit head contract: fetch the head from
the correct provider ref (including forks), record it with its own ownership
marker, and expose a `headWorktreePath` derived under the same `assertInside`
invariants as every other managed path. Same-repo and fork PRs each need a
test, covering cleanup and reuse.

### Output directory

`outputDir` must sit outside the scanned worktree or the SDK raises
`OutputInsideProtectedRootError`. It is placed under a new `scans/` sibling of
`worktrees/` inside the managed repository root.

**One exclusive directory per scan run**, keyed by scan id and `headSha`, and
created exclusively (`mkdir` that fails if it exists) rather than reused. A
single shared `scans/` directory would let two concurrent reviews — or a retry
overlapping its predecessor — read each other's artifacts, and would make
cleanup delete a directory another run is still writing. Removal targets that
one run-specific directory and nothing else. A concurrent-run test pins it.

**The ancestry checks do not extend themselves.** `manager.ts` passes
*hard-coded* candidate lists to `assertNoSymlinkedAncestors`, so adding
`scans`, the per-run output path, or `headWorktreePath` to
`deriveWorkspacePaths` does not put them under that protection — the earlier
draft of this document asserted it would, which was the same
assume-the-machinery-carries-it error as the `rulesFailed` and coverage
findings. Every new managed path is added to every relevant candidate list, at
create, read, preserve and delete, with a test that plants a pre-existing
symlinked `scans` parent.

Scan results contain source excerpts and vulnerability detail. The directory
is created `0o700`, and is removed after the findings are read unless
`--codex-scan-keep-output` is passed.

### Pipeline placement

`review()` gains one step, after the diff and base SHA are pinned and before
rule dispatch:

```text
withPreparedWorkspace( prepare + isolated clone ) → [codex scan] → dispatch rules → merge → dedup → publish
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
and no inherited hooks. The clone's `origin` remote is removed, so the mirror's
path is not recorded in the tree the scan reads.

**This does not make the mirror unreachable, and an earlier draft of this
document said it did.** `--no-local`/`--no-hardlinks` stop object *sharing*;
they revoke nothing. The scan child runs as the same UID as the parent with the
same filesystem view, and the managed layout is predictable, so a scan that
goes looking can still find and write `repository.git` — its config, its hooks
— and affect a later parent-side git operation. Dropping the remote raises the
cost of finding it; it is obfuscation, not a boundary.

What the clone genuinely buys is narrower and still worth having: the scan no
longer *needs* the mirror, nothing it writes in its own tree is observed by a
later consumer, and findings derive from a private copy no other job rewrites.
The mirror-write vector is closed by the boundary in Security bounds item 2 —
which is why that item now specifies what the boundary must expose, rather than
leaving "isolated environment" to interpretation. `core.hooksPath` pointed at
an empty directory for managed git invocations is the defense-in-depth layer
underneath it, not the primary control.

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
  /** Scanner-supplied ids that matched DEFERRED_ID_RE. Nothing else survives. */
  readonly deferred: readonly string[];
  /** How many deferred entries were reported in total, including unrenderable ones. */
  readonly deferredCount: number;
};
```

carried on `DispatchResult`, threaded into the renderer input, and rendered by
a dedicated section. Optional, so every existing engine and test double that
never sets it is unaffected.

**The `reason` field is deliberately gone, and calling the earlier
`{ id, reason }` shape "structured" was wrong.** A `reason` is
scanner-authored prose over an attacker-controlled tree. Putting it inside an
object does not sanitize it, and because it is not a `Finding` it reaches the
renderer without `normalizeUnknownFinding` or ADR-006 defanging — so a crafted
reason could carry a ` ```suggestion ` fence, mimic the bot's own signature or
HTML marker, or simply be long enough to blow the comment size limit. That is
precisely the rule `dependency-advisories.ts` already settled and this
document cites two sections earlier: prose is **excluded rather than escaped**.

So what crosses is bounded and inert:

- **`id`** must match a `DEFERRED_ID_RE` in the spirit of
  `dependency-advisories.ts`'s `ADVISORY_ID_RE` — short, identifier-shaped,
  incapable of forming a sentence. An id that does not match is dropped.
- **`deferredCount`** is host-computed from what the scan reported, so
  dropping unrenderable ids never manufactures a cleaner picture: the section
  says how many were deferred even when it can name none of them.
- **Reasons go to stderr**, with the rest of the raw scan output, where an
  operator can read them and no reader is asked to trust them.

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
`unknown` scan renders an explicit line in the published summary reporting
`deferredCount` and the validated `deferred` ids — **never a reason**, per the
sanitation rule below. This sentence previously said "ids and reasons, which
are structured", which survived the edit that removed `reason` from the type
and would have re-authorized the exact prose that rule exists to keep out. A
requirement stated in two places is a requirement that can disagree with
itself, so the rendering rule now lives only with the type that carries it.

This is the `dependency-advisories.ts` lesson applied directly: a scan that
was cut short by the host deadline, a cost limit, or an interruption must not
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

`computeReviewConfigHash` must include the codex-scan settings that change
what a review produces — enabled state, cost limit, timeout, **and the
`--codex-scan-sandboxed` assertion** — or enabling the scan on an
already-reviewed head is suppressed by the marker and silently does nothing,
the failure mode config-aware dedup exists to prevent.

The assertion belongs in that list precisely because AC-13 makes its absence
*publish*: a first run with `--codex-scan on` and no assertion posts a review
whose scan failed, marker and all. Adding the assertion and re-running changes
whether the scan happens at all — but if the hash cannot see it, dedup
suppresses the corrected run on the same head, and the operator who did exactly
what the error told them to gets silence. A retry test covers
absent-then-present on one head.

**But only when the scan is on.** An unconditional field — even one hashing
`"codex-scan: off"` — changes the hash of every existing default review, so
upgrading the CLI would invalidate every published marker and re-review every
open PR across every repository at once. The disabled default must hash
**byte-identically to a pre-feature run**. Tested both ways: a pre-feature
marker still matches after the upgrade, and each result-affecting setting
changes the hash when the scan is on.

## CLI surface

```text
--codex-scan on|off            (default: off)
--codex-scan-sandboxed         (required assertion; see Security bounds item 2)
--codex-scan-max-cost <usd>
--codex-scan-timeout <hours>   (enforced by the parent; NOT maxTimeHours)
--codex-scan-keep-output       (retain the scan directory)
```

**`--codex-scan-timeout` is enforced in the parent process, not passed to the
SDK.** An earlier draft mapped it to `maxTimeHours`, which is wrong and would
have failed every scan: `maxTimeHours` is one of the deep-mode settings
(alongside `workers`, `subagents`, `stopAfterNoNew`, `maxDiscoveryRuns`) and
requires `mode: "deep"`, which v1 does not use. Passing it with a standard
scan is rejected outright — a flag that breaks the feature whenever anyone
sets it.

So the deadline lives where the host already controls it: a timer that fires
the `AbortSignal` already threaded into the scan, followed by terminating the
child. `maxTimeHours` is passed only if deep mode is ever added.

**Termination must target the process group.** `subprocess.kill()` signals the
immediate child only, and the worker is not the leaf — it starts the Codex
runtime, which starts its own plugin and Python processes. Killing the worker
alone leaves an agent running against attacker-controlled code with no
supervisor and no deadline, which is worse than the timeout the kill was
enforcing. On POSIX the child is spawned `detached` and the group is signalled
(`process.kill(-pid, …)`), escalating `SIGTERM` → `SIGKILL`, with the same
teardown on the abort path.

**On Windows that call cannot work.** `process.kill(-pid, …)` has no meaning
there, and `detached` makes the worker independent rather than reachable — so
a timeout or abort would report the scan stopped while the agent kept running,
the precise failure this whole mechanism exists to prevent. The repository does
carry Windows paths (`state-paths.ts` branches on `win32`; `protect.ts:88`
returns early there). So Windows terminates the tree with
`taskkill /T /F /PID <pid>`, and **if that is not implemented, the scan refuses
to start on Windows** rather than running without an enforceable deadline.
`protect.ts` sets the precedent for saying this out loud: it names its Windows
gap as a product decision "stated here rather than silently chosen".

Cleanup runs in a `finally` and is **not uniform**, because two rules in this
document require retention:

- The isolated clone and the temp `HOME` are **always** removed. Nothing needs
  them afterwards and both may hold attacker-controlled content.
- The run's output directory is removed **only** when neither
  `--codex-scan-keep-output` nor a preserved `ScanInterruptedError` `scanDir`
  applies. An unconditional removal here would have quietly broken both
  promises — the retention flag and the interrupted-scan evidence — from a
  sentence in a different section.

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
| unsupported Node major | the scan needs Node 22, 24 or 26 |
| scan deadline reached | the scan stopped at its time limit |
| anything else | the scan failed to run |

The last row is not decoration. Open question 2 promises a classified phrase
for an unsupported Node version and the table had none, and any unanticipated
SDK or worker error — a bug, a version skew, a malformed worker response —
must still resolve to *some* publishable phrase. Without a catch-all, an
unclassified failure either publishes nothing (an all-clear after a failed
scan, the AC-5 failure again) or leaks a raw error into a world-readable
comment. The raw text stays on stderr in every case, including this one.

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

   The only real boundary is external, and the assertion names something
   specific rather than a vibe. `--codex-scan-sandboxed` asserts that the
   scan child runs in a container, VM, or dedicated unprivileged account
   **that exposes only the isolated clone and the run's output directory** —
   and in particular not the managed workspace root, not the operator's home,
   and not the credentials of the account running the CLI. That precision
   matters because the process-level measures do not deliver it: same UID,
   same filesystem view, predictable managed layout.

   The CLI **refuses to scan unless the operator makes that assertion**.
   Refusing by default is deliberate: an unsandboxed scan is the dangerous
   case, so it must not be reachable by forgetting a flag. The CLI cannot
   verify the assertion, and says so rather than implying it checked.
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

## What this design does not claim

Three review rounds each caught the same class of error in this document: a
property asserted about machinery that does not provide it — `rulesFailed`
carrying a reason nobody put in the array, coverage rendering from a field that
did not exist, ancestry checks extending to paths their hard-coded lists never
mention, `HOME` redirection described as making credentials unreadable, a
private clone described as making the mirror unreachable, and prose called
"structured" because it sat inside an object.

Each was fixed where it appeared. The pattern is worth stating once, as a
standing inventory, because the next reader of this document will otherwise
have to re-derive which of its reassurances are load-bearing:

| Not claimed | What is actually true |
|---|---|
| The scan cannot read the operator's credentials. | It runs as the same user with ordinary filesystem permissions. Only the external boundary prevents this. |
| The scan cannot reach or write the managed mirror. | The clone removes the *need* and the recorded path. Reachability ends at the external boundary, not here. |
| The environment allowlist contains the scan. | It stops inheritance of secrets the scan never needed. It is not a sandbox. |
| Structured-looking scanner output is safe to render. | Only bounded, pattern-validated fields are. Any free-text field is prose and is excluded, never escaped. |
| Existing machinery carries a new value automatically. | Each of `rulesFailed`, `scanCoverage`, the ancestry candidate lists and the config hash had to be extended by hand. |

The single control this feature's safety actually rests on is the external
boundary in Security bounds item 2. Everything else is defense-in-depth, and
should be read that way.

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
- **Deferred-id sanitation test** — a scan whose `deferred` entries carry a
  ` ```suggestion ` fence, a bot-signature lookalike, and a 100 KB reason
  renders none of that text, still reports the correct `deferredCount`, and
  keeps the reasons on stderr. Sits beside the existing ADR-006 cases in
  `comment-format.test.ts`.

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
- **AC-14** Given a review run with the scan off, when its marker is compared
  to one written before this feature existed, then the config hashes match.
- **AC-14b** Given a run with `--codex-scan on` and no sandbox assertion,
  followed by a run on the same head with the assertion, then the second run is
  not suppressed by dedup and the scan executes.
- **AC-20** Given a completed scan, when the worker's tool subprocesses are
  inspected, then no Codex API key appears in their environment.
- **AC-21** Given `--codex-scan-keep-output`, or an interrupted scan, when
  cleanup runs, then the clone and temp `HOME` are gone and the output
  directory remains.
- **AC-22** Given Windows, when the scan is requested, then either the process
  tree is terminated via `taskkill /T /F` on timeout and abort, or the scan
  refuses to start.
- **AC-19** Given a scan whose `coverage.deferred` entries carry fenced
  markup, marker lookalikes, or oversized text, when the summary renders, then
  no scanner-authored prose appears and `deferredCount` still reflects every
  reported entry.
- **AC-15** Given `--codex-scan-timeout`, when the scan is dispatched, then no
  deep-mode setting is passed, and when the deadline passes, the whole child
  process group is terminated and the clone, temp `HOME` and output directory
  are removed.
- **AC-16** Given a fork pull request, when the scan is prepared, then the head
  is fetched from the fork ref and the scanned checkout's `HEAD` equals
  `pr.headSha`.
- **AC-17** Given two scans running concurrently on the same repository, when
  each completes, then neither has read or deleted the other's output
  directory.
- **AC-18** Given a failure with no table entry, when the review publishes,
  then the catch-all phrase renders and the raw error appears only on stderr.
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
4. **Bundling the worker** is a requirement, not an open question — recorded
   here because it is the one part that cannot be deferred to implementation.
   `npm run build` compiles TypeScript and copies exactly two `.md` files, so
   `dist/review/codex-scan-worker.js` does not exist unless the build makes
   it, and `bin`/`files` must ship it. The acceptance test runs against the
   **packed** artifact with `@openai/codex-security` both absent and present.
   The worker may `import` the SDK statically: it is a separate process, so
   that import never enters the main process's graph and the default path
   still resolves nothing.
5. **Clone cost.** One full checkout per scan, on top of the managed base
   worktree. Acceptable for a flag that is off by default and already requires
   a disposable environment, but it should be measured on a large repository
   before this is called settled.
6. **Asserting the sandbox.** `--codex-scan-sandboxed` is an unverifiable
   claim by the operator. Worth investigating whether a cheap positive signal
   (a container marker, a namespace check, an unprivileged-user check) can
   turn some of it into something the CLI actually verifies.
7. **A brokered scan credential.** Steps 1-3 above keep the key out of tool
   subprocesses but not out of the worker process. A per-run, short-lived or
   scope-limited credential — minted for one scan and useless afterwards —
   would make a leak survivable instead of merely unlikely. Worth checking
   whether the provider supports one.
