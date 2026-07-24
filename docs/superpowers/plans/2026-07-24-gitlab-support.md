# GitLab Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full GitLab.com and self-managed GitLab review support through `glab`, while preserving existing GitHub behavior.

**Architecture:** Normalize every review invocation into one `ReviewLocator`, then route all provider operations through a locator-based `VcsAdapter`. Add a focused `GitLabAdapter` backed only by injected `glab` subprocess calls; extend provider-neutral anchors and inline publish outcomes so GitLab's per-discussion writes can fall back selectively without duplicating or losing findings.

**Tech Stack:** TypeScript 5.7, Node.js 22 `execFile`, `glab` CLI, existing `gh` CLI adapter, Vitest 3, ESLint, Node crypto/filesystem APIs.

---

## File Structure

### New files

- `src/vcs/gitlab-adapter.ts` — `glab` executor, GitLab MR metadata/diff, trusted rules, notes, discussions, and stale-thread operations.
- `test/unit/vcs/gitlab-adapter.test.ts` — offline command/payload/response tests with an injected fake executor.
- `test/fixtures/glab-mr.json` — representative GitLab MR metadata with `diff_refs`.
- `test/fixtures/glab-notes.json` — representative paginated note payloads.
- `test/fixtures/glab-discussions.json` — representative diff/general discussion payloads.

### Existing files with changed responsibilities

- `src/target/types.ts` — discriminated GitHub/GitLab repository and review-target types.
- `src/target/review-target.ts` — strict parsing and normalization of GitHub PR URLs, GitLab MR URLs, and explicit repository values.
- `src/cli.ts` — `--repo`, URL-capable `--pr`, normalized locator use, partial inline fallback.
- `src/config.ts` — adapter selection and `ReviewLocator` construction.
- `src/vcs/adapter.ts` — the single locator-based adapter contract and inline outcome types.
- `src/vcs/github-adapter.ts` — migrate overloads to `ReviewLocator` without changing observable GitHub commands.
- `src/review/diff-anchors.ts` — retain old/new path and line metadata for provider positioning.
- `src/review/comment-format.ts` — stable inline `clientId` and selective summary rendering inputs.
- `src/review/orchestrate.ts` — presentation record mapping `clientId` to normalized findings.
- `src/review/types.ts` — provider-neutral presentation/fallback types if they are not local to orchestration.
- `src/context/types.ts` and `src/context/cache.ts` — discriminated GitHub/GitLab cache keys while preserving GitHub canonical JSON.
- `src/context/context-pack.ts`, `src/context/business-reference.ts`, and `src/context/tgd-mapper.ts` — consume generalized repository identity.
- `src/workspace/types.ts`, `src/workspace/paths.ts`, and `src/workspace/manager.ts` — provider-neutral repository paths, markers, clone URLs, and origin validation.
- `README.md` and `test/unit/docs.test.ts` — supported GitLab workflows, authentication, examples, and documentation assertions.

## Chunk 1: Provider-Neutral Target and Contracts

### Task 0: Record the worktree baseline

**Files:**
- Modify: none.

- [ ] **Step 1: Record existing user-owned changes**

Run:

```bash
git status --porcelain=v1
```

Copy the exact output into the execution notes before editing. Do not stage,
delete, or alter any listed path. Final verification compares against this
baseline so pre-existing user work is preserved without assuming a particular
dirty path.

### Task 1: Normalize GitHub and GitLab review targets

**Files:**
- Modify: `src/target/types.ts`
- Modify: `src/target/review-target.ts`
- Modify: `test/unit/target/review-target.test.ts`
- Modify: `src/cli.ts`
- Modify: `test/unit/cli.test.ts`

- [ ] **Step 1: Write failing target and CLI tests**

Add table-driven tests covering:

```ts
expect(parseReviewTarget("https://gitlab.example.com/group/sub/project/-/merge_requests/42"))
  .toEqual({
    provider: "gitlab",
    repo: {
      provider: "gitlab",
      host: "gitlab.example.com",
      port: undefined,
      namespace: ["group", "sub"],
      repo: "project",
      canonicalUrl: "https://gitlab.example.com/group/sub/project",
    },
    number: 42,
    canonicalUrl:
      "https://gitlab.example.com/group/sub/project/-/merge_requests/42",
  });

expect(
  parseRepositoryRef("gitlab.example.com:8443/group/sub/project", "gitlab"),
).toMatchObject({
  provider: "gitlab",
  host: "gitlab.example.com",
  port: 8443,
  namespace: ["group", "sub"],
  repo: "project",
});
```

Add rejection cases for credentials, HTTP, query, fragment, zero IID, encoded
slash/dot segments, control characters, missing namespace/project, malformed
`/-/merge_requests/`, and mismatched provider. Update CLI tests so:

```ts
expect(parseArgs([
  "review",
  "--pr", "42",
  "--vcs", "gitlab",
  "--repo", "gitlab.example.com/group/project",
])).toMatchObject({
  pr: "42",
  vcs: "gitlab",
  repo: "gitlab.example.com/group/project",
});

expect(parseArgs([
  "review",
  "--pr", "https://gitlab.com/group/project/-/merge_requests/42",
])).toMatchObject({
  pr: "https://gitlab.com/group/project/-/merge_requests/42",
});
```

Add explicit normalization tests for every repository input promised by the
spec:

```ts
expect(parseRepositoryRef("group/sub/project", "gitlab"))
  .toMatchObject({ host: "gitlab.com", namespace: ["group", "sub"], repo: "project" });
expect(parseRepositoryRef(
  "https://gitlab.example.com/group/project.git",
  "gitlab",
)).toMatchObject({ host: "gitlab.example.com", repo: "project" });
expect(parseRepositoryRef(
  "git@gitlab.example.com:group/sub/project.git",
  "gitlab",
)).toMatchObject({ namespace: ["group", "sub"], repo: "project" });
expect(parseRepositoryRef(
  "ssh://git@gitlab.example.com/group/project.git",
  "gitlab",
)).toMatchObject({ host: "gitlab.example.com", repo: "project" });
```

- [ ] **Step 2: Run target and CLI tests to verify failure**

Run:

```bash
npx vitest run test/unit/target/review-target.test.ts test/unit/cli.test.ts
```

Expected: FAIL because GitLab targets and `--repo` are not implemented and
`--pr` currently accepts only digits.

- [ ] **Step 3: Implement discriminated repository and target types**

Define the public shape in `src/target/types.ts`:

```ts
export interface GitHubRepositoryRef {
  readonly provider: "github";
  readonly host: "github.com";
  readonly owner: string;
  readonly repo: string;
  readonly canonicalUrl: string;
}

export interface GitLabRepositoryRef {
  readonly provider: "gitlab";
  readonly host: string;
  readonly port?: number;
  readonly namespace: readonly string[];
  readonly repo: string;
  readonly canonicalUrl: string;
}

export type RepositoryRef = GitHubRepositoryRef | GitLabRepositoryRef;

export interface ReviewTarget {
  readonly provider: RepositoryRef["provider"];
  readonly repo: RepositoryRef;
  readonly number: number;
  readonly canonicalUrl: string;
}
```

Keep URL parsing in small provider-specific helpers. Decode only after rejecting
encoded separators and dot segments. Normalize hostnames to lowercase, preserve
case-sensitive namespace/project path segments, strip `.git`, and retain an
explicit HTTPS port in canonical identity.

- [ ] **Step 4: Implement CLI repository input and validation**

Add `repo?: string` to `CliArgs` and a `repo` string option to `parseArgs`.
Replace the digits-only `--pr` check with:

```ts
const pr = values.pr as string;
if (!/^\d+$/.test(pr)) {
  parseReviewTarget(pr); // validates a complete canonical PR/MR URL
}
```

Do not resolve conflicts in `parseArgs`; keep syntax parsing separate from
target/config resolution.

- [ ] **Step 5: Run target and CLI tests**

Run:

```bash
npx vitest run test/unit/target/review-target.test.ts test/unit/cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit target normalization**

```bash
git add src/target/types.ts src/target/review-target.ts src/cli.ts \
  test/unit/target/review-target.test.ts test/unit/cli.test.ts
git commit -m "feat: normalize GitLab review targets"
```

### Task 2: Replace dual VCS interfaces with `ReviewLocator`

**Files:**
- Modify: `src/vcs/adapter.ts`
- Modify: `src/vcs/github-adapter.ts`
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Modify: `test/unit/vcs/github-adapter.test.ts`
- Modify: `test/unit/cli-review.test.ts`
- Modify: `test/unit/cli-review-default-wiring.test.ts`

- [ ] **Step 1: Write failing locator/config tests**

Add these contract cases:

```ts
const ambient: ReviewLocator = {
  kind: "ambient",
  provider: "github",
  number: 42,
};
await adapter.getPullRequest(ambient);
expect(execGh).toHaveBeenCalledWith([
  "pr", "view", "42", "--json",
  "headRefOid,baseRefOid,title,body,url",
]);

const explicit: ReviewLocator = {
  kind: "repository",
  repo: githubRepo,
  number: 42,
};
await adapter.getDiff(explicit);
expect(execGh).toHaveBeenCalledWith([
  "pr", "diff", "42", "--repo", "github.com/octo/repo",
]);
```

Add locator-resolution tests for numeric ambient GitHub, explicit GitHub
repository, complete URLs, GitLab numeric without `--repo` rejection, and
URL/`--repo` mismatch. Adapter selection for GitLab belongs to Task 5, when the
real adapter exists.

- [ ] **Step 2: Run the locator tests to verify failure**

Run:

```bash
npx vitest run test/unit/vcs/github-adapter.test.ts \
  test/unit/cli-review.test.ts \
  test/unit/cli-review-default-wiring.test.ts
```

Expected: type/runtime failures because adapters still use bare IDs and
overloaded repository methods.

- [ ] **Step 3: Define the one adapter contract**

In `src/vcs/adapter.ts`, import the new `RepositoryRef` and define:

```ts
export type ReviewLocator =
  | {
      readonly kind: "ambient";
      readonly provider: "github";
      readonly number: number;
    }
  | {
      readonly kind: "repository";
      readonly repo: RepositoryRef;
      readonly number: number;
    };

export interface VcsAdapter {
  getPullRequest(locator: ReviewLocator): Promise<PullRequestInfo>;
  getDiff(locator: ReviewLocator): Promise<string>;
  findBotComment(locator: ReviewLocator): Promise<BotComment | null>;
  upsertComment(
    locator: ReviewLocator,
    body: string,
    existing: BotComment | null,
  ): Promise<void>;
  createInlineReview(
    locator: ReviewLocator,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<void>;
  resolveStaleReviewThreads(locator: ReviewLocator): Promise<number>;
  getRuleFilesFromBase(
    locator: ReviewLocator,
    baseSha: string,
    rulesDir: string,
  ): Promise<RuleFileContent[]>;
}
```

Remove `RepositoryScopedVcsAdapter` and all overloads. Add locator narrowing
helpers that reject a provider mismatch before invoking a CLI.

- [ ] **Step 4: Migrate `GitHubAdapter` without changing commands**

Convert each method to accept one locator. The ambient branch must reproduce
current argument arrays exactly. The repository branch must require a GitHub
repo and use existing `--repo`, REST path, and GraphQL host helpers.

At this task, preserve the current `createInlineReview(): Promise<void>`
behavior. Task 8 will introduce `clientId` and publish outcomes atomically with
their tests and consumers.

- [ ] **Step 5: Resolve config to locator plus adapter**

Change `ResolvedConfig`:

```ts
export interface ResolvedConfig extends CliArgs {
  readonly locator: ReviewLocator;
  readonly vcsAdapter: VcsAdapter;
}
```

Extract and test a pure `resolveReviewLocator(args)` with these rules:

- full URL → explicit repository locator;
- numeric GitHub plus no `--repo` → ambient GitHub locator;
- numeric plus `--repo` → explicit repository locator;
- numeric GitLab without `--repo` → error;
- inferred URL provider and explicit `--vcs`/`--repo` must match.

At this intermediate commit, production `resolveConfig()` intentionally keeps
the existing Phase 2 error after successfully resolving a GitLab locator.
Task 5 removes that error and wires the real `GitLabAdapter` in the same commit
that creates it. Do not add a stub adapter or an unspecified factory.

- [ ] **Step 6: Migrate `review()` and test doubles**

Replace every `config.vcsAdapter.method(config.pr, ...)` with
`config.vcsAdapter.method(config.locator, ...)`. Update test doubles to assert
the locator, not a string ID. Do not change review ordering or error handling.

- [ ] **Step 7: Run locator/config regression tests**

Run:

```bash
npx vitest run test/unit/vcs/github-adapter.test.ts \
  test/unit/cli-review.test.ts \
  test/unit/cli-review-default-wiring.test.ts
npm run test:type
```

Expected: PASS with unchanged GitHub command snapshots.
GitLab locator tests pass, while the existing default-wiring test continues to
assert the temporary Phase 2 production error until Task 5.

- [ ] **Step 8: Commit the adapter contract migration**

```bash
git add src/vcs/adapter.ts src/vcs/github-adapter.ts src/config.ts src/cli.ts \
  test/unit/vcs/github-adapter.test.ts test/unit/cli-review.test.ts \
  test/unit/cli-review-default-wiring.test.ts
git commit -m "refactor: route reviews through normalized locators"
```

### Task 3: Generalize context cache identity

**Files:**
- Modify: `src/context/types.ts`
- Modify: `src/context/cache.ts`
- Modify: `src/context/mapper.ts`
- Modify: `src/context/context-pack.ts`
- Modify: `src/context/business-reference.ts`
- Modify: `src/context/tgd-mapper.ts`
- Modify: `test/unit/context/cache.test.ts`
- Modify: `test/unit/context/context-pack.test.ts`
- Modify: `test/unit/context/business-reference.test.ts`
- Modify: `test/unit/context/tgd-mapper.test.ts`

- [ ] **Step 1: Write failing cache and context-consumer tests**

Capture an existing GitHub key and path before changing validation:

```ts
const githubKey = {
  provider: "github" as const,
  host: "github.com",
  owner: "octo-org",
  repo: "octo-repo",
  baseSha: "a".repeat(40),
  schemaVersion: 1,
  tgdVersion: "1",
  policyVersion: "1",
};
expect(cache.entryPath(githubKey)).toBe(existingExpectedPath);
```

Add a GitLab key with raw normalized `host: "gitlab.example.com"`, `port: 8443`,
and `namespace: ["group", "subgroup"]`; assert it has a distinct deterministic
entry path. Encoding belongs only in filesystem path helpers, never in the key.
Test rejection of separators/control data inside individual segments.

Write tests against the intended `repository: RepositoryRef` field on
`ContextMapRequest` and `BusinessReferenceInput`. Identify every construction
that the implementation step must update with:

```bash
rg -n "ContextMapRequest|BusinessReferenceInput|\\.map\\(\\{" src test
```

In the context-pack, business-reference, and mapper suites, add one GitLab
repository case each:

```ts
const gitlabRepo: GitLabRepositoryRef = {
  provider: "gitlab",
  host: "gitlab.example.com",
  port: 8443,
  namespace: ["group", "sub"],
  repo: "project",
  canonicalUrl: "https://gitlab.example.com:8443/group/sub/project",
};
```

Assert context-pack output renders
`Repository: gitlab.example.com:8443/group/sub/project`; generated business
frontmatter contains `provider: gitlab` and the canonical repository identity;
and `TgdPiMapper` builds its validation cache key from the request repository
instead of the current synthetic GitHub-only owner/repo fields.

- [ ] **Step 2: Run every affected context test to verify failure**

Run:

```bash
npx vitest run test/unit/context/cache.test.ts \
  test/unit/context/context-pack.test.ts \
  test/unit/context/business-reference.test.ts \
  test/unit/context/tgd-mapper.test.ts
```

Expected: FAIL because cache validation and context consumers are GitHub-only.

- [ ] **Step 3: Implement discriminated cache keys and repository labels**

Keep the GitHub member's exact fields and canonicalization:

```ts
export type ContextCacheKey =
  | ExistingGitHubContextCacheKey
  | {
      provider: "gitlab";
      host: string;
      port?: number;
      namespace: readonly string[];
      repo: string;
      baseSha: string;
      schemaVersion: number;
      tgdVersion: string;
      policyVersion: string;
    };
```

Validate union members separately. Do not add, remove, or rename a GitHub key
field; its SHA-256 entry identity must remain unchanged. Add
`repository: RepositoryRef` to `ContextMapRequest` and
`BusinessReferenceInput`. Add a shared pure
repository-label/cache-key helper close to `src/context/types.ts` rather than
duplicating GitLab formatting. Update `ContextMapRequest`,
`BusinessReferenceInput`, `TgdPiMapper.validationKey`, generated business
frontmatter, and context-pack repository rendering to consume that identity.
Update all source/test callers so no default silently substitutes GitHub.

- [ ] **Step 4: Run all affected context tests**

Run:

```bash
npx vitest run test/unit/context/cache.test.ts \
  test/unit/context/context-pack.test.ts \
  test/unit/context/business-reference.test.ts \
  test/unit/context/tgd-mapper.test.ts
npm run test:type
```

Expected: PASS, including the fixed legacy GitHub entry-path assertion.

- [ ] **Step 5: Commit cache/context generalization**

```bash
git add src/context test/unit/context
git commit -m "feat: isolate GitLab context caches"
```

### Task 4: Generalize managed workspace identity

**Files:**
- Modify: `src/workspace/types.ts`
- Modify: `src/workspace/paths.ts`
- Modify: `src/workspace/manager.ts`
- Modify: `test/unit/workspace/manager.test.ts`

- [ ] **Step 1: Write failing workspace path, origin, and marker tests**

Use:

```ts
const repo: GitLabRepositoryRef = {
  provider: "gitlab",
  host: "gitlab.example.com",
  port: 8443,
  namespace: ["group", "sub"],
  repo: "project",
  canonicalUrl: "https://gitlab.example.com:8443/group/sub/project",
};
```

Assert the GitHub path remains exactly
`repos/github.com/octo-org/octo-repo`, GitLab uses a filesystem-safe encoded
authority plus nested namespace, and mismatched provider/host/namespace markers
or origins fail without overwrite. Cover exact HTTPS, scp SSH, and `ssh://` SSH
acceptance plus credentials, HTTP, wrong port, wrong host, and wrong path
rejection.

- [ ] **Step 2: Run workspace tests to verify failure**

Run:

```bash
npx vitest run test/unit/workspace/manager.test.ts
```

Expected: FAIL because workspace paths and origins require GitHub.

- [ ] **Step 3: Implement provider-neutral workspace paths and origins**

Preserve the existing GitHub branch byte-for-byte. For GitLab, encode raw
`host` plus optional `port` only inside a dedicated reversible filesystem
helper, append validated namespace segments/project, generate the canonical
HTTPS clone URL, and validate all accepted origin forms against normalized
repository identity. Ownership markers include provider and canonical identity.

Keep `git` responsible for clone/mirror/worktree operations; no `glab` call is
needed for local workspace construction.

- [ ] **Step 4: Run workspace and type tests**

Run:

```bash
npx vitest run test/unit/workspace/manager.test.ts
npm run test:type
```

Expected: PASS with unchanged GitHub path/origin behavior.

- [ ] **Step 5: Commit workspace generalization**

```bash
git add src/workspace test/unit/workspace
git commit -m "feat: isolate GitLab managed workspaces"
```

## Chunk 2: GitLab Core Adapter

### Task 5: Add the safe `glab` executor and MR snapshot operations

**Files:**
- Create: `src/vcs/gitlab-adapter.ts`
- Create: `test/unit/vcs/gitlab-adapter.test.ts`
- Create: `test/fixtures/glab-mr.json`
- Modify: `src/vcs/adapter.ts`
- Modify: `src/config.ts`
- Modify: `test/unit/cli-review-default-wiring.test.ts`

- [ ] **Step 1: Write failing executor, metadata, and diff tests**

Test an injected executor signature:

```ts
const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
const execGlab: ExecGlab = async (args, stdin) => {
  calls.push({ args, stdin });
  return fixture;
};
```

Cover GitLab.com, self-managed, and custom-port repositories. Assert:

- all MR commands receive `--repo <canonical project URL>`;
- API calls receive `--hostname <host-without-port>`;
- no shell command string is constructed;
- required MR fields and all three diff refs are shape-validated;
- `getDiff` returns `glab mr diff` output unchanged;
- malformed JSON and absent/malformed refs reject with named errors;
- missing executable and `maxBuffer` overflow become actionable errors.
Head/version consistency belongs to Task 9, where the caller head and latest
version are both available.

- [ ] **Step 2: Run the adapter tests to verify failure**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts
```

Expected: FAIL because `GitLabAdapter` does not exist.

- [ ] **Step 3: Implement `ExecGlab` and locator guards**

Implement the production executor with promisified `execFile` and a typed
failure:

```ts
export type ExecGlab = (
  args: readonly string[],
  stdin?: string,
) => Promise<string>;

export class GlabCommandError extends Error {
  readonly exitCode?: number;
  readonly httpStatus?: number;
  readonly stderr: string;
}
```

Use `glab` plus argv, set a 10 MiB buffer consistent with the GitHub adapter,
write optional stdin, disable interactive prompting in the child environment,
and never log stdin or environment values. Map `ENOENT` to the install/auth
guidance from the spec. For failed `glab api` commands, parse `httpStatus` only
from the CLI's known anchored `HTTP <three digits>` diagnostic form; retain
stderr for internal classification but sanitize it before user-facing output.

Add shared helpers in this file:

```ts
projectEndpoint(repo, suffix)
// projects/<encodeURIComponent(namespace/project)>/<suffix>

decodeNdjsonRecords<T>(stdout)
// one JSON record per non-empty line
```

`glab api --paginate --output ndjson` emits each array element as one line, not
one page array. Unit-test endpoint encoding, multiple records spanning
pagination, blank final lines, malformed records, `GlabCommandError.httpStatus`,
and non-API failures without a status.

- [ ] **Step 4: Implement MR metadata and diff**

Use:

```text
glab api --method GET --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>
glab mr diff <iid> --repo <canonical-project-url>
```

Validate object shapes with local type guards. Extend `PullRequestInfo` in
`src/vcs/adapter.ts` with optional `startSha`, `headRef`, and `baseRef` fields
so existing GitHub ambient responses and test doubles remain source-compatible.
`GitLabAdapter.getPullRequest` must always populate all three from
`diff_refs`/MR branch fields. Do not change `GitHubAdapter` in this task and do
not cache MR snapshots across review runs.

- [ ] **Step 5: Wire config to the real adapter**

Construct `GitLabAdapter` when `locator` identifies GitLab. Update the default
wiring test to mock this module and assert GitLab no longer throws the Phase 2
error.

- [ ] **Step 6: Run adapter/config tests**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts \
  test/unit/cli-review-default-wiring.test.ts
npm run test:type
```

Expected: PASS.

- [ ] **Step 7: Commit MR adapter foundations**

```bash
git add src/vcs/gitlab-adapter.ts src/vcs/adapter.ts src/config.ts \
  test/unit/vcs/gitlab-adapter.test.ts test/fixtures/glab-mr.json \
  test/unit/cli-review-default-wiring.test.ts
git commit -m "feat: fetch GitLab merge request snapshots"
```

### Task 6: Fetch trusted base-branch GitLab rules

**Files:**
- Modify: `src/vcs/gitlab-adapter.ts`
- Modify: `test/unit/vcs/gitlab-adapter.test.ts`
- Modify: `test/unit/cli-review.test.ts`

- [ ] **Step 1: Write failing repository-file tests**

Test:

- URL-encoded project path and rules directory;
- exact `ref=<baseSha>`;
- records emitted across multiple `--paginate --output ndjson` pages;
- direct `.md` blobs only;
- nested tree/symlink/submodule entries skipped;
- plain UTF-8 content from the repository-file raw endpoint;
- missing directory returns `[]`;
- missing individual listed file, auth, permission, and malformed data reject.

Add a review integration assertion:

```ts
expect(vcsAdapter.getRuleFilesFromBase).toHaveBeenCalledWith(
  config.locator,
  "base-sha",
  ".review/rules",
);
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts \
  test/unit/cli-review.test.ts
```

Expected: FAIL at the unimplemented GitLab rule fetch.

- [ ] **Step 3: Implement tree pagination and file retrieval**

List with this explicit command contract:

```text
glab api --method GET --paginate --output ndjson --hostname <host>
  projects/<encoded-project>/repository/tree
  --raw-field path=<rules-dir>
  --raw-field ref=<base-sha>
  --field per_page=100
```

Decode each NDJSON line as one tree-entry record with the Task 5 helper. Fetch
each selected file as plain UTF-8:

```text
glab api --method GET --hostname <host>
  projects/<encoded-project>/repository/files/<encoded-file-path>/raw
  --raw-field ref=<base-sha>
```

Explicit `--method GET` prevents query fields from switching the request to
POST. Treat only `GlabCommandError.httpStatus === 404` from the initial tree
listing as an empty rules directory. A 404 from a listed file and all other
statuses reject. Sort selected entries by repository path before fetching and
returning for deterministic rule order.

- [ ] **Step 4: Run rule-fetch and CLI tests**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts \
  test/unit/cli-review.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit trusted rule support**

```bash
git add src/vcs/gitlab-adapter.ts \
  test/unit/vcs/gitlab-adapter.test.ts test/unit/cli-review.test.ts
git commit -m "feat: load GitLab rules from the base revision"
```

### Task 7: Add GitLab summary deduplication and exact-note upsert

**Files:**
- Modify: `src/vcs/gitlab-adapter.ts`
- Create: `src/review/comment-marker.ts`
- Modify: `src/vcs/github-adapter.ts`
- Modify: `test/unit/vcs/gitlab-adapter.test.ts`
- Create: `test/unit/review/comment-marker.test.ts`
- Modify: `test/unit/vcs/github-adapter.test.ts`
- Create: `test/fixtures/glab-notes.json`
- Modify: `test/unit/cli-review.test.ts`

- [ ] **Step 1: Write failing note identity/upsert tests**

Cover:

- authenticated username cached once per hostname;
- all `--paginate --output ndjson` note pages inspected;
- another author's copied marker ignored;
- own valid marker parsed;
- own malformed marker returned with empty SHA/config;
- exact existing note updated by ID through stdin JSON;
- absent note creates one note;
- Markdown never appears in argv;
- GitLab dedup skips unchanged head/config and re-reviews changed config.

- [ ] **Step 2: Write failing shared marker tests**

Add:

```ts
expect(parseBotMarker("<!-- tgd-review-agent:sha=abc1234 cfg=deadbeef -->"))
  .toEqual({ lastReviewedSha: "abc1234", reviewedConfig: "deadbeef" });
expect(parseBotMarker("<!-- tgd-review-agent:sha=malformed -->"))
  .toEqual({ lastReviewedSha: "", reviewedConfig: "" });
expect(parseBotMarker("prefix <!-- tgd-review-agent:sha=abc1234 --> trailing"))
  .toEqual({ lastReviewedSha: "", reviewedConfig: "" });
expect(parseBotMarker("ordinary human note")).toBeNull();
```

The helper must distinguish no marker from an own malformed trailing marker so
both adapters update rather than duplicate the latter.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts \
  test/unit/review/comment-marker.test.ts \
  test/unit/vcs/github-adapter.test.ts \
  test/unit/cli-review.test.ts
```

Expected: FAIL because note methods are unimplemented.

- [ ] **Step 4: Extract marker parsing and implement identity/pagination**

Resolve `user.username` with `glab api user --hostname <host>`. Cache the
in-flight promise by normalized host authority. Fetch MR notes with explicit
pagination:

```text
glab api --method GET --paginate --output ndjson --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/notes
  --field per_page=100
```

Decode each line as one note with `decodeNdjsonRecords`. Extract the private
GitHub marker-prefix/trailing-marker logic into
`src/review/comment-marker.ts`, export one parser, and migrate
`GitHubAdapter.findBotComment` to it before using it in GitLab. Preserve all
existing GitHub spoofing, malformed-marker, and trailing-marker behavior.

Create:

```text
glab api --method POST --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/notes
  --input -
```

Update the exact note:

```text
glab api --method PUT --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/notes/<validated-note-id>
  --input -
```

For both writes, stdin is `JSON.stringify({ body })`. Validate numeric note IDs
from provider responses before endpoint construction. Validate response shape
but do not retain response bodies.

- [ ] **Step 5: Run adapter, marker, and dedup tests**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts \
  test/unit/review/comment-marker.test.ts \
  test/unit/vcs/github-adapter.test.ts \
  test/unit/cli-review.test.ts \
  test/unit/review/dedup.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit GitLab summary behavior**

```bash
git add src/review/comment-marker.ts src/vcs/github-adapter.ts \
  src/vcs/gitlab-adapter.ts test/fixtures/glab-notes.json \
  test/unit/review/comment-marker.test.ts \
  test/unit/vcs/github-adapter.test.ts \
  test/unit/vcs/gitlab-adapter.test.ts test/unit/cli-review.test.ts
git commit -m "feat: upsert GitLab review summaries"
```

## Chunk 3: Inline Positions, Partial Results, and Cleanup

### Task 8: Retain provider-neutral diff positions and stable inline IDs

**Files:**
- Modify: `src/review/diff-anchors.ts`
- Modify: `src/review/comment-format.ts`
- Modify: `src/review/orchestrate.ts`
- Modify: `src/review/types.ts`
- Modify: `src/vcs/adapter.ts`
- Modify: `src/vcs/github-adapter.ts`
- Modify: `test/unit/review/diff-anchors.test.ts`
- Modify: `test/unit/review/comment-format.test.ts`
- Modify: `test/unit/review/orchestrate.test.ts`
- Modify: `test/unit/vcs/github-adapter.test.ts`

- [ ] **Step 1: Write failing position metadata tests**

Add unified diff fixtures for added lines, context lines, renames, separated
hunks, and mixed added/context ranges in both endpoint orders. Assert an
eligible anchor includes:

```ts
{
  oldPath: "src/old-name.ts",
  newPath: "src/new-name.ts",
  start: { type: "new", oldLine: undefined, newLine: 10 },
  end: { type: "new", oldLine: undefined, newLine: 12 },
  sameHunk: true,
}
```

For context lines, assert both old/new numbers and `type: "old"`. A mixed
added/context range in one file/hunk remains eligible because every endpoint is
new-side addressable; retain each endpoint's own `new`/`old` type. Only
cross-hunk, cross-file, removed-side, or missing-endpoint ranges are ineligible.

- [ ] **Step 2: Write failing presentation/outcome tests**

Assert deterministic IDs such as `finding-0`, one presentation mapping per
inline candidate, and selective rendering:

```ts
const presentation = orchestrate(dispatchResult, diff, { inline: true });
const failedId = presentation.inlineComments[1].clientId;
const body = renderSummary(presentation, new Set([failedId]));
expect(body).toContain("second finding");
expect(body).not.toContain("first finding");
```

Add GitHub adapter tests for complete outcome sets on atomic success and
atomic rejection.

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
npx vitest run test/unit/review/diff-anchors.test.ts \
  test/unit/review/comment-format.test.ts \
  test/unit/review/orchestrate.test.ts \
  test/unit/vcs/github-adapter.test.ts
```

Expected: FAIL because position metadata, IDs, and outcomes are absent.

- [ ] **Step 4: Extend anchor parsing**

Represent each hunk's line map with old/new counters. Capture paths from
`---`/`+++` headers, including `/dev/null` and renames. Add a lookup that
returns exact endpoints and hunk identity. Preserve the current
`isInlineCommentable` behavior for GitHub single-line findings.

- [ ] **Step 5: Add stable presentation IDs and selective rendering**

Extend `InlineReviewComment`:

```ts
export interface InlineReviewComment {
  readonly clientId: string;
  readonly path: string;
  readonly line: number;
  readonly startLine?: number;
  readonly position: DiffPositionRange;
  readonly body: string;
}

export interface InlinePublishOutcome {
  readonly clientId: string;
  readonly status: "posted" | "failed";
  readonly reason?: string;
}
```

Keep a mapping from each ID to the already-normalized finding. Implement a pure
summary renderer that adds only requested failed IDs. Validate outcome
completeness and uniqueness in one shared helper.

- [ ] **Step 6: Adapt GitHub atomic posting**

On success, return all-posted outcomes. On a rejected `gh` atomic request,
return all-failed outcomes with one publish-safe reason rather than throwing.
Input/preflight/contract errors still throw.

- [ ] **Step 7: Run review/GitHub tests**

Run:

```bash
npx vitest run test/unit/review/diff-anchors.test.ts \
  test/unit/review/comment-format.test.ts \
  test/unit/review/orchestrate.test.ts \
  test/unit/vcs/github-adapter.test.ts
npm run test:type
```

Expected: PASS.

- [ ] **Step 8: Commit provider-neutral inline contracts**

```bash
git add src/review src/vcs/adapter.ts src/vcs/github-adapter.ts \
  test/unit/review test/unit/vcs/github-adapter.test.ts
git commit -m "refactor: track provider-neutral inline outcomes"
```

### Task 9: Post GitLab inline discussions with partial outcomes

**Files:**
- Modify: `src/vcs/gitlab-adapter.ts`
- Modify: `test/unit/vcs/gitlab-adapter.test.ts`
- Create: `test/fixtures/glab-discussions.json`

- [ ] **Step 1: Write failing diff-version preflight tests**

Cover empty versions, newest-first selection, malformed SHAs, metadata/version
head mismatch, and caller/version head mismatch. Assert no POST runs after any
preflight failure.

`GitLabAdapter.createInlineReview` must first call its own
`getPullRequest(locator)` to obtain a fresh metadata snapshot, then fetch
versions. Assert exact call order: metadata GET, versions GET, all comparison
checks, then zero or more discussion POSTs. The versions command is:

```text
glab api --method GET --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/versions
```

The JSON response must be a newest-first array; select element zero only.

- [ ] **Step 2: Write failing position payload tests**

Assert exact payloads for:

- added single line: `new_line`, no `old_line`;
- renamed context line: both paths and both line numbers;
- added multi-line range: start/end type `new`, line numbers, SHA-1 line codes;
- context multi-line range: endpoint type `old`;
- mixed added/context ranges in both orders with endpoint-specific types;
- unsupported cross-hunk/removed-side range: failed outcome and no POST;
- suggestion body preserved over stdin;
- custom-port project routed through configured hostname.

Compute expected line codes in tests independently with Node `createHash`:

```ts
const pathHash = createHash("sha1").update("src/new-name.ts").digest("hex");
expect(payload.position.line_range.start.line_code)
  .toBe(`${pathHash}__10`);
```

- [ ] **Step 3: Write failing partial failure tests**

Make the second of three POSTs reject. Assert input-order calls and outcomes:

```ts
expect(result.outcomes).toEqual([
  { clientId: "finding-0", status: "posted" },
  { clientId: "finding-1", status: "failed", reason: expect.any(String) },
  { clientId: "finding-2", status: "posted" },
]);
```

Also simulate an executor failure that prevents further calls and assert every
unattempted ID is returned failed.

Add a table for the shared write classifier:

```ts
[
  [400, "continue"],
  [409, "continue"],
  [422, "continue"],
  [401, "stop"],
  [403, "stop"],
  [404, "stop"],
  [408, "stop"],
  [429, "stop"],
  [500, "stop"],
]
```

A `GlabCommandError` without `httpStatus` is a process/transport failure and
stops. A plain programming error is rethrown as a contract failure.

- [ ] **Step 4: Run GitLab inline tests to verify failure**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts
```

Expected: FAIL at inline preflight/posting.

- [ ] **Step 5: Implement version preflight and position mapping**

Call `getPullRequest(locator)` for a fresh metadata snapshot, fetch MR versions,
select index zero, and validate all SHA fields. Require:

- metadata `headSha` equals the caller's reviewed `headSha`;
- metadata `headSha`/`baseSha`/`startSha` equal the selected version's
  head/base/start commit SHAs.

Complete every comparison before the first POST. Build one JSON discussion
payload per candidate, generate line codes from normalized new paths, and
return failed outcomes for unsupported ranges without posting them.

Post each supported candidate with:

```text
glab api --method POST --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/discussions
  --input -
```

stdin is:

```ts
JSON.stringify({
  body: comment.body,
  position: {
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
    position_type: "text",
    old_path: comment.position.oldPath,
    new_path: comment.position.newPath,
    ...(end.oldLine === undefined ? {} : { old_line: end.oldLine }),
    new_line: end.newLine,
    ...(isRange ? { line_range: { start, end } } : {}),
  },
})
```

`start` and `end` contain `line_code`, endpoint-specific `type`, and available
`old_line`/`new_line`.

- [ ] **Step 6: Implement sequential posting outcomes**

Post supported candidates sequentially in input order. Use one tested
`classifyGlabWriteFailure` helper: HTTP 400/409/422 are item-level failures and
continue; no HTTP status, 401/403/404/408/429, and 5xx stop and mark all
remaining IDs failed. Unexpected non-`GlabCommandError` values rethrow as
contract/programming errors. Sanitize failure reasons for publication; raw
errors go only to logs. Return exactly one outcome per input and validate it
with the shared contract helper.

- [ ] **Step 7: Run GitLab adapter tests**

Run:

```bash
npx vitest run test/unit/vcs/gitlab-adapter.test.ts
npm run test:type
```

Expected: PASS.

- [ ] **Step 8: Commit GitLab inline support**

```bash
git add src/vcs/gitlab-adapter.ts test/unit/vcs/gitlab-adapter.test.ts \
  test/fixtures/glab-discussions.json
git commit -m "feat: post GitLab inline review discussions"
```

### Task 10: Integrate selective fallback and stale-thread cleanup

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/vcs/gitlab-adapter.ts`
- Modify: `test/unit/cli-review.test.ts`
- Modify: `test/unit/vcs/gitlab-adapter.test.ts`
- Modify: `test/fixtures/glab-discussions.json`

- [ ] **Step 1: Write failing CLI partial fallback tests**

For three inline findings with one failed outcome, assert:

- the initial summary contains no successfully anchored finding;
- the final upsert adds only the failed finding;
- successful inline findings are not duplicated;
- invalid/missing/duplicate outcome IDs trigger all-inline summary fallback;
- dry-run performs neither summary nor inline writes;
- a preflight rejection falls back all inline candidates.

- [ ] **Step 2: Write failing stale cleanup tests**

Cover paginated discussions with:

- own marked unresolved thread → resolve;
- own manual unresolved thread → untouched;
- another user's marked thread → untouched;
- already resolved thread → untouched;
- one resolve failure → warn and continue;
- returned count equals successful resolutions.

Assert list/resolve commands exactly:

```text
glab api --method GET --paginate --output ndjson --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/discussions
  --field per_page=100

glab api --method PUT --hostname <host>
  projects/<encoded-project>/merge_requests/<iid>/discussions/<encoded-id>
  --input -
```

The resolve stdin is `JSON.stringify({ resolved: true })`. Each NDJSON line is
one discussion. Discussion IDs must match the documented opaque-ID character
allowlist and still pass through `encodeURIComponent`.

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
npx vitest run test/unit/cli-review.test.ts \
  test/unit/vcs/gitlab-adapter.test.ts
```

Expected: FAIL because partial fallback and GitLab cleanup are not integrated.

- [ ] **Step 4: Integrate complete outcome validation and rerendering**

In `review()`:

1. build the presentation once;
2. upsert the normal summary;
3. best-effort resolve stale bot discussions;
4. publish inline candidates;
5. validate outcomes;
6. if any failed, re-render with exactly those `clientId`s;
7. call `findBotComment(locator)` again to obtain the exact note ID created or
   updated in step 2;
8. update that exact summary note with the fallback body.

If publish/preflight rejects, use all inline IDs. Preserve the existing
summary-first durability guarantee. If the post-upsert refetch cannot find the
authenticated marker note, fail rather than create a second summary.

- [ ] **Step 5: Implement GitLab stale discussion cleanup**

List discussions with the exact GET/NDJSON command from Step 2, resolve only
first-note author+marker matches, and isolate each PUT failure. Use the same
write classifier but always continue cleanup because cleanup is best-effort.
Reuse cached identity and shared marker parsing. Resolve with the exact PUT
endpoint and `{ resolved: true }` stdin payload from Step 2; never interpolate a
discussion ID from unvalidated response data without encoding.

- [ ] **Step 6: Run CLI and adapter integration tests**

Run:

```bash
npx vitest run test/unit/cli-review.test.ts \
  test/unit/vcs/gitlab-adapter.test.ts \
  test/unit/review/orchestrate.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit partial fallback and cleanup**

```bash
git add src/cli.ts src/vcs/gitlab-adapter.ts \
  test/unit/cli-review.test.ts test/unit/vcs/gitlab-adapter.test.ts \
  test/fixtures/glab-discussions.json
git commit -m "feat: preserve partial GitLab review results"
```

## Chunk 4: Documentation and Release Verification

### Task 11: Document GitLab.com and self-managed usage

**Files:**
- Modify: `README.md`
- Modify: `test/unit/docs.test.ts`
- Modify: `src/config.ts`
- Modify: `src/vcs/adapter.ts`
- Modify comments only as required in: `src/review/diff-anchors.ts`
- Modify comments only as required in: `src/review/comment-format.ts`
- Modify comments only as required in: `src/review/orchestrate.ts`
- Modify comments only as required in: `src/review/types.ts`
- Modify comments only as required in: `src/context/types.ts`
- Modify comments only as required in: `src/context/cache.ts`
- Modify comments only as required in: `src/context/context-pack.ts`
- Modify comments only as required in: `src/context/mapper.ts`
- Modify comments only as required in: `src/context/tgd-mapper.ts`
- Modify comments only as required in: `src/context/business-reference.ts`
- Modify comments only as required in: `src/workspace/types.ts`
- Modify comments only as required in: `src/workspace/paths.ts`
- Modify comments only as required in: `src/workspace/manager.ts`

- [ ] **Step 1: Write failing documentation assertions**

Assert README contains:

- `glab` installation prerequisite;
- `glab auth login --hostname`;
- GitLab.com numeric `--repo` example;
- self-managed nested namespace/custom-port example;
- complete MR URL example;
- `glab api` disclosure;
- inline partial fallback behavior;
- minimum GitLab permissions for notes/discussions/rules;
- custom API-port `glab auth login --api-host` mapping;
- opt-in smoke procedure that is not part of the default test suite;
- GitHub remains the default.

- [ ] **Step 2: Run docs tests to verify failure**

Run:

```bash
npx vitest run test/unit/docs.test.ts
```

Expected: FAIL because README still says GitLab is Phase 2/unimplemented.

- [ ] **Step 3: Update README and shared API comments**

Replace Phase 2 statements with exact commands:

```bash
glab auth login --hostname gitlab.example.com

tgd-review-agent review \
  --vcs gitlab \
  --repo gitlab.example.com/group/subgroup/project \
  --pr 42

tgd-review-agent review \
  --pr https://gitlab.example.com/group/project/-/merge_requests/42
```

Document custom API port setup using `--api-host`, trusted base-branch rules,
summary/inline behavior, required permissions, dry-run, and an opt-in smoke
procedure. Generalize shared comments while retaining provider-specific
constraints inside adapters.

- [ ] **Step 4: Run docs tests**

Run:

```bash
npx vitest run test/unit/docs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md test/unit/docs.test.ts src/config.ts src/vcs/adapter.ts \
  src/review/diff-anchors.ts src/review/comment-format.ts \
  src/review/orchestrate.ts src/review/types.ts \
  src/context/types.ts src/context/cache.ts src/context/context-pack.ts \
  src/context/mapper.ts src/context/tgd-mapper.ts \
  src/context/business-reference.ts src/workspace/types.ts \
  src/workspace/paths.ts src/workspace/manager.ts
git commit -m "docs: explain GitLab review workflows"
```

### Task 12: Run full verification and inspect the final diff

**Files:**
- Modify only files needed to fix verification failures.

- [ ] **Step 1: Run the complete unit and type suite**

Run:

```bash
npm test
```

Expected: all unit tests and `tsconfig.type-tests.json` pass.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: zero ESLint errors.

- [ ] **Step 3: Run the production build**

Run:

```bash
npm run build
```

Expected: TypeScript compilation succeeds and required bundled rule/agent files
are copied.

- [ ] **Step 4: Run the full suite including smoke-safe tests**

Run:

```bash
npm run test:all
```

Expected: all repository tests pass without contacting GitHub, GitLab, or an
LLM unless an existing test is explicitly marked opt-in.

- [ ] **Step 5: Audit provider assumptions and diff hygiene**

Run:

```bash
rg -n \
  "GitLab support not yet implemented|GitLab.*Phase 2|gitlab adapter.*Phase 2|host must be github\\.com|RepositoryScopedVcsAdapter|vcsAdapter\\.[A-Za-z]+\\(config\\.pr" \
  src README.md test
rg -n "owner|github\\.com" src/context src/workspace src/target src/vcs/adapter.ts
git diff --check origin/main...HEAD
git status --short
```

Expected: no stale Phase 2/old-interface/bare-`config.pr` adapter hits and no
whitespace errors. Review every `owner`/`github.com` hit: it must be inside a
GitHub discriminant branch, GitHub-specific type/adapter, or explicit
backward-compatibility test. Compare `git status` with Task 0's recorded
baseline; there must be no new unexplained unstaged/untracked path, and every
pre-existing user-owned path remains untouched.

- [ ] **Step 6: Review the complete patch**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Expected: inspect every changed file for scope alignment, accidental generated
files, debugging output, unrelated refactors, incomplete migrations, and
security regressions. Any correction receives a focused test before editing.

- [ ] **Step 7: Review security-sensitive command construction**

Inspect every `ExecGlab` call and verify:

- no `shell: true`;
- no MR content, Markdown, token, or JSON body in a shell command;
- repository/API path components are normalized and encoded once;
- explicit host/repository routing on every GitLab call;
- pagination on every list operation;
- raw subprocess errors are not published in comments.

Expected: all checks satisfied or corrected with focused regression tests.

- [ ] **Step 8: Commit verification fixes if required**

If verification changed files:

```bash
git add <exact changed files>
git commit -m "fix: complete GitLab integration verification"
```

If no files changed, do not create an empty commit.

- [ ] **Step 9: Invoke completion review**

Use `@superpowers:verification-before-completion`, then
`@superpowers:requesting-code-review`. Address only technically valid findings,
rerun the relevant tests, and finish with the full verification commands above.
