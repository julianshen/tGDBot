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

## Adapter Architecture

`GitLabAdapter` implements the same repository-scoped VCS boundary as
`GitHubAdapter`. It accepts an injectable `ExecGlab`:

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

### Diff

The adapter obtains the unified MR diff through `glab mr diff` with an explicit
repository. Existing diff-size limits and anchor parsing remain unchanged.

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

Each provider-neutral inline comment becomes a GitLab text position with old
and new paths, a new-side line, and a line range when supported by the finding.
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

The provider-neutral contract will return a result for each requested comment:

- posted;
- failed with a publish-safe reason.

GitHub reports all posted after its atomic request succeeds and all failed when
it rejects. GitLab posts sequentially or with conservative bounded concurrency
and records each result. The CLI moves only failed findings into the summary.
Already-posted findings are not duplicated, and no finding is lost.

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

Existing GitHub cache entries and workspace layout remain readable or are
migrated explicitly; the change must not silently reinterpret a GitHub cache as
GitLab data.

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

