# GitLab Support Design

## Summary

tGD Review Agent will support GitLab.com and self-managed GitLab with feature
parity to its GitHub review flow. Remote operations will run exclusively
through the `glab` CLI. The implementation will not own an HTTP client, token
store, API base URL, or authentication flow.

The selected architecture generalizes the existing review target and VCS
boundaries, then adds a `GitLabAdapter`. GitLab-specific concepts such as merge
request IIDs, nested namespaces, diff refs, discussions, and note IDs stay
inside target parsing and the adapter. Rule dispatch and finding orchestration
remain provider-neutral.

## Goals

- Support GitLab.com and arbitrary self-managed GitLab hostnames configured in
  `glab`.
- Accept both an explicit repository plus numeric MR IID and a canonical MR URL.
- Match the GitHub flow for metadata, diff retrieval, trusted base-branch
  rules, summary upsert, deduplication, inline suggestions, stale bot-thread
  cleanup, dry-run behavior, managed workspaces, and context caching.
- Use `glab` for every remote operation, including `glab api` where no stable
  high-level command exposes the required operation.
- Preserve all existing GitHub CLI behavior.
- Keep untrusted MR content out of trusted rules and command routing.

## Non-goals

- Implementing a GitLab HTTP client or managing GitLab access tokens.
- Supporting non-GitLab forges.
- Adding a GitLab CI component or pipeline template in this change.
- Relying on experimental `glab mr note` subcommands when stable `glab api`
  behavior is available.
- Making review dispatch, prompts, or finding schemas provider-specific.

## CLI and Target Resolution

### Accepted forms

The CLI will accept:

```text
tgd-review-agent review \
  --vcs gitlab \
  --repo gitlab.example.com/group/subgroup/project \
  --pr 42
```

and:

```text
tgd-review-agent review \
  --pr https://gitlab.example.com/group/subgroup/project/-/merge_requests/42
```

For backward compatibility, the existing GitHub numeric form remains valid.
GitLab numeric mode requires `--repo`; the adapter will not silently infer a
self-managed target from an unrelated current directory. Repository values may
be a namespace/project path, host/namespace/project path, full HTTPS URL, or Git
URL accepted by `glab --repo`. A path without a host uses `gitlab.com`.

### Conflict rules

A complete MR URL determines provider, host, namespace, project, and IID. If
`--vcs`, `--repo`, or another target component is also supplied, every supplied
value must normalize to the same target. A mismatch is a caller error and no
remote command runs.

Target URLs must:

- use HTTPS;
- contain no username, password, query, or fragment;
- contain a non-empty namespace and project;
- use the GitLab `/-/merge_requests/<positive IID>` path;
- contain no encoded separators, dot segments, backslashes, or control
  characters.

Self-managed HTTPS URLs may contain an explicit port. The normalized repository
identity and canonical URL retain that port, so `gitlab.example.com:8443` and
`gitlab.example.com` cannot share a cache or workspace. `glab --repo` receives
the full canonical project URL. `glab api --hostname` and auth checks receive
the hostname without the port; users whose API is exposed on a custom port must
configure that mapping with `glab auth login --hostname <host> --api-host
<host>:<port>`. HTTP-only GitLab installations are out of scope.

### Provider-neutral model

`RepositoryRef` and `ReviewTarget` become discriminated provider-neutral
types. A repository carries:

- `provider`: `github` or `gitlab`;
- `host`;
- namespace segments;
- repository/project name;
- a canonical HTTPS URL.

GitHub retains its owner/repository constraints. GitLab allows nested namespace
segments. Helpers produce provider-specific CLI locator values and canonical
URLs; callers do not concatenate repository paths themselves.

### Definitive review locator contract

The current ambient `VcsAdapter` and overloaded `RepositoryScopedVcsAdapter`
interfaces will be replaced by one locator-based contract:

```text
ReviewLocator =
  | { kind: "ambient"; provider: "github"; number: number }
  | { kind: "repository"; repo: RepositoryRef; number: number }
```

`ResolvedConfig` carries both a `ReviewLocator` and the selected `VcsAdapter`.
Every adapter method accepts the locator as its first argument. `review()` never
passes a bare PR/MR string and never performs provider-specific routing.

The ambient variant exists only for the existing GitHub numeric invocation
without `--repo`. GitLab numeric input always resolves to the repository
variant, and both GitHub and GitLab full URLs or explicit `--repo` values use
the repository variant. `GitHubAdapter` preserves its current ambient command
behavior for the ambient variant and uses explicit repository flags for the
repository variant. This removes the two competing adapter interfaces while
keeping the existing GitHub command usable.

## Adapter Architecture

`GitLabAdapter` implements the locator-based VCS boundary. It accepts an
injectable `ExecGlab`:

```text
ExecGlab(args: readonly string[], stdin?: string): Promise<string>
```

The production implementation uses `execFile` with an argument array and
bounded output. Multi-line Markdown and JSON payloads go over stdin rather than
the command line. Tests inject a fake executor and never contact GitLab.

Every GitLab invocation receives an explicit repository or hostname derived
from the normalized target. Ambient git remotes are not used when a target was
provided. `glab` owns authentication, host configuration, TLS behavior, and API
transport.

`resolveConfig` constructs `GitLabAdapter` for GitLab targets and removes the
current Phase 2 error.

## GitLab Data Flow

### Merge request metadata

The adapter retrieves MR metadata as JSON through `glab`. The normalized result
contains:

- MR IID;
- head, base, and start SHAs from the latest diff refs;
- source and target branch names;
- title and description;
- canonical web URL.

All required fields are shape-validated. Missing or malformed diff refs fail
before review dispatch because inline positions cannot be safely constructed
without them.

When the versions endpoint returns multiple entries, the adapter uses the first
entry in the API's newest-first response and verifies that its head SHA equals
both MR metadata `diff_refs.head_sha` and the head SHA reviewed by the caller.
An empty list or mismatch is a stale/incomplete snapshot error before the first
inline write.

### Diff

The adapter obtains the unified MR diff through `glab mr diff` with an explicit
repository. Existing diff-size limits remain unchanged. Anchor parsing is
extended to retain the old/new path and line metadata required for GitLab
positions while preserving its current GitHub eligibility decisions.

### Trusted base-branch rules

`getRuleFilesFromBase` uses `glab api` against the repository tree and file
endpoints at the exact base SHA. It:

- lists only direct `*.md` children of the configured rules directory;
- treats a missing directory as zero user rules;
- skips directories, symlinks, and other non-file entries;
- retrieves and decodes each selected file;
- rejects auth, network, permission, pagination, and malformed-response errors.

This preserves the existing trust boundary: an MR cannot change the rules used
to review itself.

### Bot identity and summary upsert

The adapter resolves the current authenticated GitLab username through
`glab api user` and caches it per host.

To find a prior summary, it paginates MR notes and accepts a note only when:

- its author matches the authenticated username; and
- its body contains the tGD summary marker prefix.

A malformed marker still identifies the existing bot note but forces a review
instead of a dedup skip. The adapter updates that exact note ID, or creates one
new note when none exists. Another user's copied marker cannot suppress review.

### Inline discussions

GitLab creates one positioned discussion per inline finding. Before posting,
the adapter obtains the latest MR diff version and uses its exact:

- `base_commit_sha`;
- `start_commit_sha`;
- `head_commit_sha`.

The diff-anchor parser will retain provider-neutral per-line position metadata,
not only the new-side line number:

- old and new paths from the unified diff headers, including renames;
- old and new line numbers when present;
- whether a line is added or context;
- start and end endpoints for an accepted range.

Every inline candidate remains anchored to the new file. For an added line, the
GitLab position sends `new_line` only and uses range endpoint type `new`. For a
context line, it sends both `old_line` and `new_line` and uses endpoint type
`old`, as required by GitLab. Removed-line findings remain summary-only because
the current finding contract identifies new-side lines.

A single-line discussion sends `old_path`, `new_path`, `new_line`, and
`old_line` when it exists. A multi-line discussion sends
`position[line_range][start]` and `[end]`; each endpoint contains its type,
available old/new line numbers, and a line code of
`<sha1(path)>_<old-or-empty>_<new-or-empty>`. The path used for a new-side
endpoint is the normalized new path. A range is eligible only when both
endpoints are in the same file and diff hunk and every replaced line is
new-side addressable. Otherwise the candidate is not posted inline: its
finding, including any suggestion, falls back to the summary as a plain
non-committable code block.

The reviewed head SHA must equal the latest diff version head SHA; otherwise
the adapter fails before posting any comment so the caller can retry against a
fresh MR snapshot.

Suggestion Markdown remains generated by the existing formatter. GitLab
supports suggestion fences in diff discussions; adapter positioning determines
the replacement range.

### Partial inline results

GitHub can submit inline comments atomically in one review. GitLab discussions
are separate writes, so the current all-or-nothing `createInlineReview`
contract is insufficient.

Each orchestrated inline comment receives a unique, stable `clientId`.
`createInlineReview` returns exactly one outcome for every input:

- `{ clientId, status: "posted" }`;
- `{ clientId, status: "failed", reason }`.

GitHub reports all posted after its atomic request succeeds. If GitHub rejects
that atomic write, the adapter converts the rejection into a failed outcome for
every input because the provider guarantees that none were posted. GitLab posts
sequentially in input order and records each result. Missing, duplicate, or
unknown IDs in an adapter result are treated as a batch contract failure.

Orchestration retains a provider-neutral presentation record mapping every
`clientId` to its normalized finding. A pure rendering helper accepts the set
of failed IDs and re-renders the summary from that existing record; it does not
redispatch rules or rerun an LLM. The first summary contains normal non-inline
findings. After a partial publish, only failed inline findings are added.
Already-posted findings are not duplicated, and no finding is lost.

Only batch preflight and adapter-contract failures reject: invalid input,
metadata/diff-version mismatch, or an invalid outcome set. A provider write
rejection is represented as outcome data. GitHub converts its atomic rejection
to all failed; GitLab records the failed discussion and continues. A
process-level failure that makes remaining GitLab writes impossible marks each
unattempted input failed before returning. Thus every provider write attempt
has one CLI path: validate first, then return a complete outcome set.

Dry-run performs no note or discussion writes.

### Stale bot-thread cleanup

The adapter paginates unresolved MR discussions. It resolves only discussions
whose first note:

- was authored by the currently authenticated user; and
- contains the tGD inline marker.

Manual discussions by the same account and marker copies from another account
remain untouched. Resolution uses `glab api` for each matching discussion.
Failures are isolated per discussion, logged without sensitive response data,
and do not prevent the new review.

## Workspace and Cache Generalization

Managed workspace paths and context-cache keys include provider, normalized
hostname, namespace segments, and repository name. This prevents collisions
between GitHub, GitLab.com, and self-managed projects with similar names.

Workspace origin validation accepts only clone URLs that normalize to the
requested repository:

- canonical HTTPS;
- scp-style SSH;
- `ssh://` Git URLs.

Credentials embedded in URLs, HTTP origins, unexpected ports, mismatched hosts,
and mismatched namespace/project paths are rejected. Filesystem path components
are derived only from validated normalized segments.

Existing GitHub cache keys and workspace paths remain byte-for-byte unchanged;
there is no migration. `ContextCacheKey` becomes a discriminated union whose
GitHub member retains the current exact fields and canonical JSON, so its
hashed entry path is identical. The GitLab member uses `provider: "gitlab"`, a
normalized host authority, and namespace segments, producing a different hash.

Workspace derivation likewise preserves the current
`repos/github.com/<owner>/<repo>` layout. GitLab uses
`repos/<normalized-host-authority>/<namespace...>/<project>`. A filesystem-safe
reversible encoding represents an explicit port in the host component.
Ownership markers include provider and the normalized canonical repository
identity. If an existing path or marker identifies a different provider,
authority, namespace, or project, preparation fails as a conflict; it is never
adopted or overwritten.

## Error Handling

- Missing `glab` produces an actionable message naming installation and
  `glab auth login --hostname <host>`.
- Authentication, permission, and host-configuration failures retain the
  relevant host/project context but do not expose tokens or raw sensitive
  payloads.
- Caller errors such as conflicting target options fail before `glab` runs.
- MR metadata or diff-ref shape failures stop before dispatch or posting.
- A missing trusted-rules directory is the only repository-file 404 treated as
  empty.
- Summary upsert failure remains fatal because it is the durable review result.
- Stale-thread cleanup remains best-effort.
- Individual inline failures fall back to summary; a stale-head mismatch fails
  the entire inline batch before its first write.
- Pagination is mandatory for notes, discussions, and repository listings.
- All subprocesses use bounded buffers and surface overflow as a named error.

## Compatibility

- Existing `--pr <number> --vcs github` behavior remains unchanged.
- GitHub adapter command construction and marker semantics stay intact.
- The review engine receives the same normalized metadata, diff, rules, and
  findings regardless of provider.
- Provider-specific wording in public types, comments, README, and prompts will
  be generalized where it describes shared behavior. Provider-specific
  constraints remain documented next to their adapter.

## Testing Strategy

All automated tests are offline.

### Target and CLI tests

- GitLab.com and self-managed MR URLs;
- nested namespaces;
- numeric IID plus every accepted `--repo` form;
- inferred `gitlab.com` for hostless repository paths;
- conflicting URL, `--repo`, and `--vcs`;
- credentials, query, fragment, encoded separators, dot segments, control
  characters, custom-port policy, and invalid IID rejection;
- unchanged GitHub argument behavior.

### GitLab adapter tests

- command argv and stdin construction without shell interpolation;
- metadata and diff-ref shape validation;
- explicit repository/hostname routing;
- note pagination, identity verification, spoofed markers, malformed markers,
  exact-note updates, and new-note creation;
- base-SHA rule listing, file decoding, missing-directory handling, pagination,
  and genuine failure propagation;
- inline single-line, multi-line, and suggestion positions;
- renamed-file context-line and mixed added/context range positions;
- stale-head preflight;
- partial inline success/failure accounting;
- stale discussion filtering, pagination, per-thread failure isolation, and
  accurate resolved counts;
- malformed JSON, missing `glab`, auth failures, and output overflow.

### Integration tests

- config selects the correct adapter;
- review dedup and dry-run work for GitLab;
- only failed inline findings return to summary;
- trusted rules still come from the base SHA;
- context cache and managed workspace isolate provider/host/project;
- all existing GitHub tests continue to pass.

An optional documented smoke procedure may run against a user-provided
GitLab.com or self-managed test project. It is never part of the default test
suite.

## Delivery

Implementation will be one pull request organized into reviewable commits:

1. provider-neutral targets, CLI repository input, workspace, and cache;
2. `GitLabAdapter` metadata, diff, rules, notes, and dedup;
3. provider-neutral partial inline results, GitLab discussions, and cleanup;
4. integration wiring, documentation, and smoke instructions.

Each commit must keep the relevant unit tests green. The final gate is the full
unit suite, type tests, lint, and build.
