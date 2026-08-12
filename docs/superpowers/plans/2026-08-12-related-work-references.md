# Related Work References Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `Related work` section to GitHub and GitLab review summaries for explicitly referenced issues, PRs, and MRs.

**Architecture:** A pure provider-aware extractor turns references in the current title/body into normalized, bounded records. Each VCS adapter resolves those records through `gh` or `glab` on the active host, while the CLI treats resolution as best-effort and passes display-only results through orchestration to the shared summary formatter.

**Tech Stack:** TypeScript, Node.js 22, Vitest, `gh` CLI, `glab` CLI

---

## Chunk 1: Domain extraction and provider resolution

### File structure

- Create `src/review/related-work.ts`: provider-neutral types, title/body reference extraction, canonicalization, sanitization, state normalization, and safe unresolved fallback construction.
- Create `test/unit/review/related-work.test.ts`: exhaustive parser, deduplication, limit, host, fallback, and metadata-safety tests.
- Modify `src/vcs/adapter.ts`: add the resolver operation and related-work types to the adapter contract.
- Create `src/vcs/github-related-work.ts`: focused GitHub issue/PR CLI lookup, timeout, classification, and recovery logic.
- Create `test/unit/vcs/github-related-work.test.ts`: GitHub classification, argument construction, timeout, normalization, partial failures, and hostile metadata tests.
- Modify `src/vcs/github-adapter.ts`: delegate the adapter contract to the focused GitHub resolver and add optional CLI timeout options.
- Create `src/vcs/gitlab-related-work.ts`: focused GitLab issue/MR CLI lookup, timeout, kind selection, and recovery logic.
- Create `test/unit/vcs/gitlab-related-work.test.ts`: GitLab kind selection, nested projects, argument construction, timeout, states, partial failures, and hostile metadata tests.
- Modify `src/vcs/gitlab-adapter.ts`: delegate the adapter contract to the focused GitLab resolver and add optional CLI timeout options.
- Modify `test/unit/cli-review.test.ts`: migrate the sole structurally typed `VcsAdapter` test double when the required contract method is introduced.

### Task 1: Extract and normalize explicit references

**Files:**
- Create: `src/review/related-work.ts`
- Create: `test/unit/review/related-work.test.ts`

- [ ] **Step 1: Write failing tests for supported GitHub references**

Cover current-repository `#42`, `owner/repo#42`, issue URLs, PR URLs, Markdown links, trailing punctuation, first-seen ordering, and deduplication of `#42` with a same-project `/pull/42` URL.

```ts
const result = extractRelatedWork({
  provider: "github",
  reviewUrl: "https://github.com/acme/widget/pull/9",
  title: "Fixes #42 and acme/api#7",
  description: "See [the prior PR](https://github.com/acme/widget/pull/42).",
});

expect(result.references.map((item) => [item.projectPath, item.number])).toEqual([
  ["acme/widget", 42],
  ["acme/api", 7],
]);
```

- [ ] **Step 2: Write failing tests for supported GitLab references**

Cover `#42`, `!19`, `group/subgroup/project#42`, `group/subgroup/project!19`, full issue/MR URLs, nested groups, and the fact that `#19` and `!19` are distinct.

```ts
const result = extractRelatedWork({
  provider: "gitlab",
  reviewUrl: "https://gitlab.example.com/group/app/-/merge_requests/8",
  title: "Closes #42; follows group/platform!19",
  description: "",
});

expect(result.references.map((item) => [item.kindHint, item.number])).toEqual([
  ["issue", 42],
  ["merge_request", 19],
]);
```

- [ ] **Step 3: Write failing boundary and safety tests**

Test fenced code, inline code, an unclosed fence, self-references, duplicates, 11+ unique references, duplicate occurrences not consuming the limit, omitted unique count, email/version lookalikes, invalid numbers, similar domains, cross-host URLs, cross-provider URLs, non-HTTPS URLs, ports, and title-before-description ordering.

```ts
expect(extractRelatedWork({
  provider: "github",
  reviewUrl: "https://github.example.com/acme/app/pull/5",
  title: "#5 `#6`",
  description: "```text\n#7\n```\nhttps://evil.example/acme/app/issues/8",
}).references).toEqual([]);
```

- [ ] **Step 4: Run the extractor tests and verify they fail**

Run: `npx vitest run test/unit/review/related-work.test.ts`

Expected: FAIL because `src/review/related-work.ts` does not exist.

- [ ] **Step 5: Implement the domain types and pure extractor**

Implement focused exported types and functions along these lines:

```ts
export type RelatedWorkKind = "issue" | "pull_request" | "merge_request";
export type RelatedWorkState = "open" | "closed" | "merged";

export interface RelatedWorkReference {
  readonly provider: "github" | "gitlab";
  readonly host: string;
  readonly port?: string;
  readonly projectPath: string;
  readonly number: number;
  readonly kindHint?: RelatedWorkKind;
  readonly sourceText: string;
  readonly identifier: string;
  readonly fallbackUrl?: string;
}

export interface RelatedWorkItem extends RelatedWorkReference {
  readonly kind?: RelatedWorkKind;
  readonly title?: string;
  readonly state?: RelatedWorkState;
  readonly url?: string;
}

export interface ExtractRelatedWorkResult {
  readonly references: readonly RelatedWorkReference[];
  readonly omittedCount: number;
}
```

Implementation requirements:

- Parse and validate `reviewUrl` first; return no references when it is absent, malformed, non-HTTPS, or not a canonical URL for the active provider.
- Remove fenced and inline code with a small state-machine scanner before matching; an unclosed fence hides the remainder of the description.
- Parse title first, then description, while retaining source offsets for stable order.
- Accept full URLs only on the exact active hostname and normalized port.
- Normalize host casing and project identity; preserve case only for display if needed.
- Preserve the exact matched token in `sourceText` for traceability, but never log or render it directly.
- Construct `identifier` only from validated fields: GitHub uses `#N` locally or `owner/repo#N` across repositories; GitLab uses `#N`/`!N` locally or `group/project#N`/`group/project!N` across projects. Reject percent-encoded `/` or `\\` before decoding, then implement named segment validators using `^[A-Za-z0-9_.-]+$` on each decoded segment; require non-empty segments and reject `.`/`..`, control characters, whitespace, Markdown delimiters, and traversal segments. GitHub requires exactly owner/repository; GitLab permits two or more group/project segments. Add tests proving hostile matched text cannot enter `identifier`.
- For GitHub, key deduplication by provider/host/port/project/number and treat kind as metadata.
- For GitLab, include the syntax-derived kind in the key.
- Remove the current PR/MR identity.
- Apply the 10-unique-reference cap after deduplication and return the count of additional unique references.
- Construct GitHub unresolved links as `/issues/{number}` and GitLab links as `/-/issues/{number}` or `/-/merge_requests/{number}`.

- [ ] **Step 6: Add sanitization and validation helpers**

Keep metadata helpers in the same focused module so both adapters and the formatter share one policy:

```ts
export function normalizeRelatedWorkState(
  kind: RelatedWorkKind,
  value: unknown,
): RelatedWorkState | undefined;

export function sanitizeRelatedWorkTitle(value: unknown): string | undefined;

export function validateResolvedRelatedWork(
  reference: RelatedWorkReference,
  candidate: unknown,
): RelatedWorkItem;
```

Flatten line breaks, remove control characters, trim, then cap titles to 200 Unicode code points (199 code points plus `…` when truncated). Normalize open/opened/closed/merged states, and accept a returned URL only when its HTTPS host, port, project, number, and kind match the request. On invalid metadata, return the original unresolved reference rather than throwing.

- [ ] **Step 7: Run the extractor tests and verify they pass**

Run: `npx vitest run test/unit/review/related-work.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the extractor**

```bash
git add src/review/related-work.ts test/unit/review/related-work.test.ts
git commit -m "feat: extract explicit related work references"
```

### Task 2: Add GitHub metadata resolution

**Files:**
- Modify: `src/vcs/adapter.ts`
- Create: `src/vcs/github-related-work.ts`
- Create: `test/unit/vcs/github-related-work.test.ts`
- Modify: `src/vcs/github-adapter.ts`
- Modify: `test/unit/vcs/github-adapter.test.ts`
- Modify: `test/unit/cli-review.test.ts`

- [ ] **Step 1: Write failing adapter-contract and GitHub resolution tests**

Add this operation to all adapter test doubles as part of the compilation change:

```ts
resolveRelatedWork(
  references: readonly RelatedWorkReference[],
): Promise<readonly RelatedWorkItem[]>;
```

Test that GitHub resolution:

- Calls `gh api -X GET repos/{owner}/{repo}/issues/{number} --hostname {host}`.
- Uses the response `pull_request` marker to classify PRs.
- Calls `gh pr view {number} --repo {host}/{owner}/{repo} --json title,state,url` only for PRs.
- Never falls back to issue classification when either command fails.
- Normalizes issue open/closed and PR open/closed/merged states.
- Preserves input order under bounded concurrency.
- Returns an unresolved item for individual auth, not-found, timeout, malformed output, or metadata-validation failures.
- Passes `{ timeoutMs: 5_000 }` to each related-work CLI invocation; the real executor maps this to `execFile`'s `timeout` option so Node terminates the child process. Separate tests verify (a) the real-executor seam forwards `timeout: 5_000` to `execFile`, and (b) an injected executor rejection representing timeout becomes one unresolved item while sibling lookups still complete; do not claim fake timers prove OS process termination.
- Logs only `github` and the canonical `identifier` for a failure, never `sourceText`, PR body content, credentials, stderr, or raw CLI output.

- [ ] **Step 2: Run GitHub adapter and type tests and verify they fail**

Run: `npx vitest run test/unit/vcs/github-related-work.test.ts test/unit/vcs/github-adapter.test.ts test/unit/cli-review.test.ts && npm run test:type`

Expected: FAIL because `resolveRelatedWork` is missing from the contract and adapter.

- [ ] **Step 3: Extend the VCS adapter contract**

Import the related-work types with `import type` and add the method to `VcsAdapter`. Document that it must return exactly one item per input, in the same order, and must convert per-item failures into unresolved items. In the same step, add an identity resolver to the `VcsAdapter` double in `test/unit/cli-review.test.ts`; `GitHubAdapter` and `GitLabAdapter` are the only production implementations found by `rg -n "implements VcsAdapter|VcsAdapter" src test`.

- [ ] **Step 4: Implement GitHub resolution**

Implement a focused resolver module that accepts the injected `ExecGh`; keep `GitHubAdapter.resolveRelatedWork` as a thin delegate. Extend `ExecGh` with an optional third `ExecOptions` argument containing `timeoutMs`, and have `realExecGh` pass it to `execFile({ timeout })`, which terminates the child on expiry. Parse command JSON as `unknown`, check required shapes explicitly, then call `validateResolvedRelatedWork` before accepting fields.

```ts
async resolveRelatedWork(
  references: readonly RelatedWorkReference[],
): Promise<readonly RelatedWorkItem[]> {
  return mapWithConcurrency(references, 3, async (reference) => {
    try {
      return await this.resolveOneRelatedWork(reference);
    } catch (error) {
      console.warn(`tgd-review-agent: could not resolve github ${reference.identifier}`);
      return reference;
    }
  });
}
```

Use the existing injected `execGh` seam and argument-array style. Do not accept non-GitHub references, interpolate shell strings, or fetch descriptions/comments/diffs.

- [ ] **Step 5: Run focused GitHub tests and verify they pass**

Run: `npx vitest run test/unit/vcs/github-related-work.test.ts test/unit/vcs/github-adapter.test.ts test/unit/review/related-work.test.ts test/unit/cli-review.test.ts && npm run test:type`

Expected: PASS.

- [ ] **Step 6: Commit GitHub resolution**

```bash
git add src/vcs/adapter.ts src/vcs/github-related-work.ts src/vcs/github-adapter.ts test/unit/vcs/github-related-work.test.ts test/unit/vcs/github-adapter.test.ts test/unit/cli-review.test.ts
git commit -m "feat: resolve GitHub related work metadata"
```

### Task 3: Add GitLab metadata resolution

**Files:**
- Create: `src/vcs/gitlab-related-work.ts`
- Create: `test/unit/vcs/gitlab-related-work.test.ts`
- Modify: `src/vcs/gitlab-adapter.ts`
- Modify: `test/unit/vcs/gitlab-adapter.test.ts`

- [ ] **Step 1: Write failing GitLab resolution tests**

Test issues and MRs in current and nested cross-project paths. Assert the exact invocation below, JSON parsing, open/closed/merged normalization, stable input order, and unresolved fallback for per-item failures. Include malicious or mismatched URLs/titles. Extend `ExecGlab` with the same optional `{ timeoutMs }` argument and assert `{ timeoutMs: 5_000 }`.

```ts
expect(execGlab).toHaveBeenCalledWith([
  "mr", "view", "19",
  "--repo", "https://gitlab.example.com:8443/group/subgroup/project",
  "--output", "json",
], undefined, { timeoutMs: 5_000 });
```

Add a second assertion for `https://gitlab.example.com/group/project`: its `--repo` value omits `:443`. As with GitHub, separately test real-executor timeout option forwarding and resolver recovery from an injected timeout rejection.

- [ ] **Step 2: Run the GitLab adapter tests and verify they fail**

Run: `npx vitest run test/unit/vcs/gitlab-related-work.test.ts test/unit/vcs/gitlab-adapter.test.ts`

Expected: FAIL because the GitLab resolver is not implemented.

- [ ] **Step 3: Implement GitLab resolution**

Use `glab issue view` for `issue` references and `glab mr view` for `merge_request` references, with the explicit canonical project URL (including a validated non-default port); `--repo` selects the GitLab host because these view commands do not support `--hostname`. Implement this in `src/vcs/gitlab-related-work.ts`; keep the adapter method a thin delegate. Extend `realExecGlab` to map the optional timeout to `execFile({ timeout })` and preserve its existing single-settlement/stdin cleanup behavior when the timed-out child reports an error. Keep the same bounded, order-preserving, per-item recovery behavior as GitHub. Validate all parsed JSON through the shared metadata policy, emit only provider plus canonical identifier in warnings, and never fetch descriptions, notes, or diffs.

- [ ] **Step 4: Run focused VCS tests and verify they pass**

Run: `npx vitest run test/unit/vcs/github-related-work.test.ts test/unit/vcs/gitlab-related-work.test.ts test/unit/vcs/github-adapter.test.ts test/unit/vcs/gitlab-adapter.test.ts test/unit/review/related-work.test.ts && npm run test:type`

Expected: PASS.

- [ ] **Step 5: Commit GitLab resolution**

```bash
git add src/vcs/gitlab-related-work.ts src/vcs/gitlab-adapter.ts test/unit/vcs/gitlab-related-work.test.ts test/unit/vcs/gitlab-adapter.test.ts
git commit -m "feat: resolve GitLab related work metadata"
```

## Chunk 2: Summary rendering and review-flow integration

### File structure

- Modify `src/review/comment-format.ts`: accept related-work entries and render the safe `Related work` section at the specified location.
- Modify `test/unit/review/comment-format.test.ts`: verify resolved/unresolved rendering, escaping, omission, and exact section order.
- Modify `src/review/orchestrate.ts`: carry related-work data in `SummaryInput` so fallback re-renders retain the section.
- Modify `test/unit/review/orchestrate.test.ts`: verify normal and failed-inline summary variants preserve related work.
- Modify `src/cli.ts`: extract and best-effort resolve references after dedup decisions and before orchestration; log omitted and lookup failures without aborting review.
- Modify `test/unit/cli-review.test.ts`: verify GitHub/GitLab integration, dry-run output, failure recovery, skipped-review behavior, and adapter invocation limits.
- Modify `test/unit/cli-review-default-wiring.test.ts`: add the resolver to typed/default adapter doubles if needed.

### Task 4: Render related work in every summary variant

**Files:**
- Modify: `src/review/comment-format.ts`
- Modify: `test/unit/review/comment-format.test.ts`
- Modify: `src/review/orchestrate.ts`
- Modify: `test/unit/review/orchestrate.test.ts`

- [ ] **Step 1: Write failing formatter tests**

Test resolved local and cross-project entries, unresolved fallback entries, absent title/state, Markdown-sensitive titles, unknown states, no-reference omission, mixed valid/invalid runtime entries, and an all-invalid runtime array. Assert exact ordering after findings/rule failures and before collapsed files/rules details. Mixed input renders only valid entries; all-invalid input omits both bullets and the `Related work` heading.

```ts
expect(renderRelatedWorkItem(localIssue)).toBe(
  "[Issue #42](https://github.com/acme/app/issues/42) — Fix login timeout (open)",
);
expect(renderRelatedWorkItem(crossRepoPr)).toBe(
  "[PR acme/api#51](https://github.com/acme/api/pull/51) — Refactor auth (merged)",
);
expect(renderRelatedWorkItem(crossProjectMr)).toBe(
  "[MR group/platform!19](https://gitlab.example.com/group/platform/-/merge_requests/19) — Rotate sessions (open)",
);
expect(renderRelatedWorkItem(unresolved)).toBe(
  "[#77](https://github.com/acme/app/issues/77)",
);
expect(body.indexOf("### Related work")).toBeGreaterThan(body.indexOf("Rules that failed"));
expect(body.indexOf("### Related work")).toBeLessThan(body.indexOf("<details>"));
```

Formatting rules are fixed: labels are `Issue`, `PR`, and `MR`; same-project identifiers use `#N`/`!N`; cross-project identifiers use the canonical project path plus marker/number; the validated link wraps `Kind identifier` for resolved entries and just `identifier` for unresolved entries; an optional sanitized title follows ` — `; an optional normalized state follows as ` (state)` only when a title is present. Without a validated URL, render the same label as escaped plain text. The heading is exactly `### Related work`.

- [ ] **Step 2: Write failing orchestration retention tests**

Pass related-work items to `orchestrate`, then call `renderSummary` with failed inline IDs. Assert the same `Related work` section occurs exactly once in the initial, conservative all-inline fallback, and selective fallback summaries.

- [ ] **Step 3: Run formatter/orchestration tests and verify they fail**

Run: `npx vitest run test/unit/review/comment-format.test.ts test/unit/review/orchestrate.test.ts`

Expected: FAIL because `SummaryInput` and orchestration options do not accept related work.

- [ ] **Step 4: Implement the formatter**

Add `relatedWork?: readonly RelatedWorkItem[]` to `SummaryInput`. `renderRelatedWorkItem()` returns content without the list prefix; `renderRelatedWork()` is the sole owner of `- `. Render with the exact contract from Step 1 and introduce `normalizeRelatedWorkForRender(item: unknown)`, which shape-checks the identity fields, reconstructs the canonical reference, then calls Chunk 1's `validateResolvedRelatedWork(reference, item)`. Malformed runtime items that still contain a valid canonical identity fall back to its escaped identifier with no link/title/state; entries without a valid identity are omitted. Never use `sourceText` or raw provider fields.

```ts
function renderRelatedWork(items: readonly RelatedWorkItem[]): string {
  const lines = items
    .map(normalizeRelatedWorkForRender)
    .filter((item): item is RelatedWorkItem => item !== undefined)
    .map((item) => `- ${renderRelatedWorkItem(item)}`);
  if (lines.length === 0) return "";
  return `### Related work\n\n${lines.join("\n")}`;
}
```

Insert the section after full findings and rule failures, before building collapsed details. Normalize and filter before rendering; do not add the section when the input is empty or no valid entries remain.

- [ ] **Step 5: Thread items through orchestration**

Extend orchestration options with `relatedWork?: readonly RelatedWorkItem[]` and copy them into `summaryInput`. Because `renderSummary` spreads the original `summaryInput`, inline publishing fallbacks automatically retain the section.

- [ ] **Step 6: Run formatter/orchestration tests and verify they pass**

Run: `npx vitest run test/unit/review/comment-format.test.ts test/unit/review/orchestrate.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit summary rendering**

```bash
git add src/review/comment-format.ts src/review/orchestrate.ts test/unit/review/comment-format.test.ts test/unit/review/orchestrate.test.ts
git commit -m "feat: render related work in review summaries"
```

### Task 5: Integrate best-effort lookup into the CLI review flow

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/unit/cli-review.test.ts`
- Modify: `test/unit/cli-review-default-wiring.test.ts`

- [ ] **Step 1: Write failing CLI integration tests**

Test that:

- A non-skipped review extracts title/body references and calls the active adapter once with at most 10 unique items.
- Resolved items reach the summary in GitHub and GitLab flows.
- A whole-operation resolver rejection logs a warning and renders parsed unresolved references.
- Per-item unresolved results coexist with resolved entries.
- `--dry-run`, pending markers, conservative inline fallback, and selective inline fallback retain the section.
- A dedup-skipped review performs no related-work resolution.
- No supported references means the resolver is not called.
- Oversized/unfetchable diff, pending-review recovery, dispatch rejection, and total rule-load failure paths perform no related-work resolution because they produce no newly rendered summary.
- Reordered, duplicated, foreign-identity, and incomplete resolver results cannot reorder or replace extracted references.

- [ ] **Step 2: Run CLI tests and verify they fail**

Run: `npx vitest run test/unit/cli-review.test.ts test/unit/cli-review-default-wiring.test.ts`

Expected: FAIL because the CLI does not extract or resolve related work.

- [ ] **Step 3: Implement best-effort CLI integration**

Place extraction and lookup immediately after `dispatchRulesFn` resolves successfully and immediately before `orchestrateFn`. This is after every existing no-new-summary early return (dedup skip, current pending recovery, diff rejection/oversize, and total rule-load failure), so none of those paths performs related-work I/O. A thrown dispatch likewise performs no lookup.

```ts
const extracted = extractRelatedWork({
  provider: config.locator.kind === "repository"
    ? config.locator.repo.provider
    : config.locator.provider,
  reviewUrl: pr.url,
  title: pr.title,
  description: pr.description,
});

if (extracted.omittedCount > 0) {
  console.warn(`tgd-review-agent: omitted ${extracted.omittedCount} additional related reference(s)`);
}

let relatedWork: readonly RelatedWorkItem[] = extracted.references;
if (extracted.references.length > 0) {
  try {
    const candidates = await config.vcsAdapter.resolveRelatedWork(extracted.references);
    relatedWork = reconcileRelatedWork(extracted.references, candidates);
  } catch (error) {
    for (const reference of extracted.references) {
      console.warn(
        `tgd-review-agent: related-work lookup failed for ${reference.provider} ${reference.identifier}; using unresolved reference`,
      );
    }
    relatedWork = extracted.references;
  }
}
```

Make canonical reconciliation the only adapter-result validation path; do not reject the whole array based on length. Treat the returned value as untrusted runtime data: verify it is an array, shape-check each entry before computing its key, and ignore malformed entries. Build a key from the same provider-specific dedupe identity used by extraction. Accept a resolved candidate only when its key equals an extracted key and that key occurs exactly once in the adapter output; ignore foreign and duplicate candidates. Finally map over `extracted.references` in extraction order, substituting the one accepted candidate or the original unresolved reference when the candidate is missing, duplicated, or mismatched. Add explicit tests for reordered valid output (restored to extraction order), duplicates (that identity falls back), foreign identities (ignored), malformed values (ignored), a non-array result (all unresolved), and incomplete output (missing identity falls back). Never log the caught error, `sourceText`, body content, stderr, raw metadata, or credentials.

- [ ] **Step 4: Update test doubles and dependency wiring**

The required adapter contract was migrated in Task 2. In this task, update the main CLI harness factory in `test/unit/cli-review.test.ts` and any default-wiring helper found by `rg -n "vcsAdapter:|VcsAdapter" test/unit/cli-review*.test.ts` so its resolver defaults to returning its inputs and can be overridden per integration test. Keep tests that intentionally omit `pr.url` working: extraction should safely produce no references rather than requiring unrelated fixtures to change.

- [ ] **Step 5: Run CLI integration tests and verify they pass**

Run: `npx vitest run test/unit/cli-review.test.ts test/unit/cli-review-default-wiring.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit CLI integration**

```bash
git add src/cli.ts test/unit/cli-review.test.ts test/unit/cli-review-default-wiring.test.ts
git commit -m "feat: add related work to review flow"
```

### Task 6: Full verification and documentation consistency

**Files:**
- Modify: `README.md` only if the existing review-output documentation enumerates summary sections.
- Modify: `test/unit/docs.test.ts` only if documentation assertions require the new section.

- [ ] **Step 1: Check whether user-facing output documentation needs an update**

Run: `rg -n "summary|comment|Files reviewed|Rules run|GitHub|GitLab" README.md docs`

Expected decision rule: update documentation only when it claims to enumerate every summary section or describes all title/body processing; otherwise record in the implementation notes that no README change is needed. Do not add unrelated documentation.

- [ ] **Step 2: Add the minimal documentation update and test, if required**

When Step 1 finds an exhaustive output description, document that only explicit title/body references are listed, metadata lookup uses `gh`/`glab`, and lookup failure does not fail review. Otherwise mark this step skipped in the plan checklist with the Step 1 evidence.

- [ ] **Step 3: Run the complete verification suite**

Run: `npm test`

Expected: all unit and type tests PASS.

Run: `npm run lint`

Expected: PASS with no lint errors.

Run: `npm run build`

Expected: PASS and produce the CLI build.

Run: `npm run test:smoke`

Expected: all smoke tests PASS.

- [ ] **Step 4: Inspect the final diff for scope and generated artifacts**

Run: `git status --short && git diff --check && git diff origin/main...HEAD --stat`

Expected: only related-work implementation, tests, and necessary documentation are changed; `git diff --check` prints nothing.

- [ ] **Step 5: Commit any final documentation-only change**

```bash
git add README.md test/unit/docs.test.ts
git commit -m "docs: explain related work references"
```

Skip this commit when Step 1 found no documentation change was needed.
