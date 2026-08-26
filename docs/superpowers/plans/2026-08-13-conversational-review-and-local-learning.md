# Conversational Review and Local Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tGDBot conversation-aware, add a retry-safe one-shot `poll` command for review discussions, and retain explicitly commanded repository-local memories without modifying reviewed repositories.

**Architecture:** Add a provider-neutral conversation boundary above the existing GitHub/GitLab CLI adapters, a repository-isolated append-only state store, deterministic command/context builders, and immutable publication manifests. Keep `review` and `poll` as one-shot commands; both share review options, state-root resolution, trust boundaries, and marker-based crash recovery.

**Tech Stack:** Node.js 22, TypeScript 5.9, Vitest, `node:util.parseArgs`, `gh`/`glab` through existing `execFile` seams, pi AgentSession APIs already used by direct dispatch.

**Approved spec:** `docs/superpowers/specs/2026-08-13-conversational-review-and-local-learning-design.md`

---

## File structure

New focused modules:

- `src/cli-args.ts` — shared review flags plus command-specific `review`/`poll` parsing; no runtime execution.
- `src/vcs/conversation-adapter.ts` — provider-neutral activity, cursor, thread, identity, and reply contracts.
- `src/conversation/types.ts` — command, memory, clarification, finding-ledger, and context domain types.
- `src/conversation/markers.ts` — versioned action/finding/clarification child markers and strict parsers.
- `src/conversation/command-parser.ts` — pure exact grammar and untrusted Markdown masking.
- `src/conversation/state-paths.ts` — state-root selection and repository-isolated path derivation.
- `src/conversation/state-schema.ts` — unknown-to-typed validators and resource ceilings for state files.
- `src/conversation/state-store.ts` — lock-protected atomic snapshots and append-only audit ledgers.
- `src/conversation/context.ts` — deterministic discussion/memory selection, budgets, boundaries, and digest.
- `src/conversation/render.ts` — provider-neutral sanitizing, Markdown escaping, URL validation, fence defanging, and reply rendering.
- `src/conversation/publication-manifest.ts` — immutable multi-output manifests and child recovery state.
- `src/conversation/session.ts` — fresh read-only conversational AgentSession creation and structured parsing.
- `src/conversation/actions.ts` — explain, reconsider, answer, focused review, and forced review behavior.
- `src/conversation/clarification.ts` — one-active clarification selection and state transitions.
- `src/poll/discovery.ts` — resumable open-review discovery and per-review round-robin event traversal.
- `src/poll/poll.ts` — one-shot event classification/execution loop and exit result.
- `src/poll/config.ts` — canonical repository/adapter/state configuration for `poll`.

Existing integration points:

- `src/cli.ts` — thin command dispatch, existing review flow integration, force reason, context notices.
- `src/config.ts` — resolve review and poll configurations through the same adapter constructors.
- `src/vcs/adapter.ts` — enrich inline outcomes with validated provider identities.
- `src/vcs/github-adapter.ts` and `src/vcs/gitlab-adapter.ts` — implement activity/reply/marker APIs.
- `src/review/types.ts`, `dispatch-prompt.ts`, `direct-dispatch.ts`, and `dispatch.ts` — decision states and bounded conversation context.
- `src/review/orchestrate.ts`, `comment-format.ts`, `dedup.ts`, and `comment-marker.ts` — state-aware presentation, context fingerprinting, and publication metadata.
- `README.md` — commands, local storage, safety model, scheduling, recovery, and limits.

Do not combine the state store, provider translation, command parsing, and model actions into one module. Their failure and trust boundaries are intentionally independent.

---

### Task 1: Establish baseline and split command parsing from runtime

**Files:**
- Create: `src/cli-args.ts`
- Modify: `src/cli.ts`
- Modify: `src/config.ts`
- Test: `test/unit/cli.test.ts`
- Test: `test/unit/cli-review.test.ts`
- Create: `test/unit/poll/config.test.ts`

- [ ] **Step 1: Record the starting tree without overwriting unrelated work**

Run:

```bash
git status --short
npm test
```

Expected: record all pre-existing modified files; tests pass or any pre-existing failure is documented before feature edits. Never reset or stage unrelated changes.

- [ ] **Step 2: Write failing parser tests for two subcommands and shared flags**

Add cases proving:

```ts
expect(parseCommandArgs(["review", "--pr", "42", "--state-dir", "/tmp/tgd-state"]))
  .toMatchObject({ command: "review", stateDir: "/tmp/tgd-state" });

expect(parseCommandArgs([
  "poll", "--repo", "owner/repo", "--model", "openai/gpt-5",
  "--dispatch", "direct", "--advisor", "off", "--state-dir", "/tmp/tgd-state",
])).toMatchObject({
  command: "poll", repo: "owner/repo", model: "openai/gpt-5",
  dispatch: "direct", advisor: "off", stateDir: "/tmp/tgd-state",
});
```

Also test missing `--pr`, missing `--repo`, incompatible positionals, relative/empty `--state-dir`, and preservation of every current review default.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npx vitest run test/unit/cli.test.ts test/unit/poll/config.test.ts`

Expected: FAIL because `parseCommandArgs`, `PollArgs`, and `--state-dir` do not exist.

- [ ] **Step 4: Extract types/default validation into `src/cli-args.ts`**

Define the shared shape explicitly:

```ts
export interface SharedReviewOptions {
  vcs: "github" | "gitlab";
  vcsExplicit?: boolean;
  repo?: string;
  model?: string;
  rulesDir: string;
  disableBuiltinRule: boolean;
  advisor: "on" | "off";
  suggestions: "on" | "off";
  dryRun: boolean;
  trustLocalRules: boolean;
  dispatch: "direct" | "legacy";
  maxDiffChars?: number;
  stateDir?: string;
}

export interface ReviewArgs extends SharedReviewOptions {
  command: "review";
  pr: string;
}

export interface PollArgs extends SharedReviewOptions {
  command: "poll";
  repo: string;
}

export type CommandArgs = ReviewArgs | PollArgs;
export function parseCommandArgs(argv: string[]): CommandArgs;
```

Keep `parseArgs()` re-exported from `src/cli.ts` as a compatibility wrapper that returns `ReviewArgs` for existing tests/importers. Make `main()` switch on `command`; do not implement `poll()` yet—inject a temporary `runPoll` dependency in tests and fail with a named not-implemented error only when invoked.

- [ ] **Step 5: Run parser and existing CLI tests**

Run: `npx vitest run test/unit/cli.test.ts test/unit/cli-review.test.ts test/unit/poll/config.test.ts`

Expected: PASS, including all pre-existing review parsing behavior.

- [ ] **Step 6: Commit the parser boundary**

```bash
git add src/cli-args.ts src/cli.ts src/config.ts test/unit/cli.test.ts test/unit/cli-review.test.ts test/unit/poll/config.test.ts
git commit -m "refactor: split review and poll command parsing"
```

---

### Task 2: Define provider-neutral conversation and marker contracts

**Files:**
- Create: `src/vcs/conversation-adapter.ts`
- Create: `src/conversation/types.ts`
- Create: `src/conversation/markers.ts`
- Modify: `src/vcs/adapter.ts`
- Test: `test/unit/conversation/markers.test.ts`
- Test: `test/unit/vcs/adapter.test.ts`

- [ ] **Step 1: Write failing type/runtime tests for identities and markers**

Cover strict round trips, wrong versions, malformed IDs, cross-review mismatches, spoofed raw text, control characters, and posted outcomes without identities.

```ts
const marker = formatChildMarker({
  kind: "action", parentId: "act_abc234def567", childId: "out_abc234def567",
  repositoryDigest: "a".repeat(64), reviewNumber: 42,
});
expect(parseChildMarker(marker)?.childId).toBe("out_abc234def567");
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/unit/conversation/markers.test.ts test/unit/vcs/adapter.test.ts`

Expected: FAIL because the new contracts are absent.

- [ ] **Step 3: Add narrow conversation adapter types**

Define discriminated records for `ReviewActivityEvent`, `ReviewThreadSummary`, `ReviewThreadSnapshot`, `ReviewEventCursor`, `OpenReviewPage`, `ReviewEventPage`, `ReviewThreadPage`, `BotIdentity`, and `ConversationItemIdentity`. Define `ConversationAdapter` methods matching the spec: identity, stable open-review pages, per-review event pages, paginated thread summaries, complete addressed thread snapshots, general reply, thread reply, and marker lookup. Normal `review` must be able to obtain current discussion directly from these read APIs even when `poll` has never run.

Use this posted identity shape in both conversation writes and successful inline outcomes:

```ts
export interface ConversationItemIdentity {
  provider: "github" | "gitlab";
  commentId: string;
  threadId?: string;
  url: string;
}

export type InlinePublishOutcome =
  | { clientId: string; status: "posted"; identity: ConversationItemIdentity }
  | { clientId: string; status: "failed"; reason: string };
```

Update `validateInlinePublishOutcomes` to reject a posted result without a valid identity or a failed result without a bounded reason.

- [ ] **Step 4: Implement versioned marker formatting/parsing**

Markers contain only kind, version, stable IDs, repository digest, review number, and content digest. Use canonical JSON fields plus base64url or fixed grammar, bounded length, and SHA-256 digests. Do not store bodies or secrets in markers.

- [ ] **Step 5: Run focused tests and type-check**

Run:

```bash
npx vitest run test/unit/conversation/markers.test.ts test/unit/vcs/adapter.test.ts
npm run test:type
```

Expected: PASS.

- [ ] **Step 6: Commit the contracts**

```bash
git add src/vcs/conversation-adapter.ts src/conversation/types.ts src/conversation/markers.ts src/vcs/adapter.ts test/unit/conversation/markers.test.ts test/unit/vcs/adapter.test.ts
git commit -m "feat: define conversation and marker contracts"
```

---

### Task 3: Implement repository-isolated state paths and validated storage

**Files:**
- Create: `src/conversation/state-paths.ts`
- Create: `src/conversation/state-schema.ts`
- Create: `src/conversation/state-store.ts`
- Modify: `src/workspace/lock.ts` only if a generic lock-path helper is required
- Test: `test/unit/conversation/state-paths.test.ts`
- Test: `test/unit/conversation/state-schema.test.ts`
- Test: `test/unit/conversation/state-store.test.ts`

- [ ] **Step 1: Write failing path-selection and isolation tests**

Test exact precedence (`--state-dir`, `TGD_REVIEW_STATE_DIR`, absolute XDG, Unix fallback, Windows fallback), rejection of relative environment paths, GitHub/GitLab/custom-port encoding, similar-name collision resistance, root escape, symlinked ancestors, and owner-only permissions.

- [ ] **Step 2: Write failing schema/store tests**

Use temporary directories to cover missing-state initialization, unknown versions, malformed/oversized JSON, cross-repository bindings, append-only memory/finding/event ledgers, tombstones, atomic snapshot replacement, fsync ordering through injected filesystem seams, and lock serialization.

- [ ] **Step 3: Run tests and verify failure**

Run: `npx vitest run test/unit/conversation/state-paths.test.ts test/unit/conversation/state-schema.test.ts test/unit/conversation/state-store.test.ts`

Expected: FAIL because state modules do not exist.

- [ ] **Step 4: Implement state paths by reusing workspace encoders**

Export/reuse `encodeWorkspaceAuthority` and `encodeWorkspaceComponent`; do not duplicate weaker encoding. Return exact paths for `cursor.json`, `events.jsonl`, `memories.jsonl`, `findings.jsonl`, `pending.json`, and `.conversation.lock` after proving each remains under the resolved state root.

- [ ] **Step 5: Implement unknown-first state validation**

Create explicit version-1 types and validators. Apply the spec limits before allocation/iteration. Reject duplicate action transitions, impossible state transitions, invalid repository bindings, active-memory overflow, and child manifest records without unique IDs.

- [ ] **Step 6: Implement lock-protected atomic state operations**

Expose small operations, not a mutable state bag:

```ts
interface ConversationStateStore {
  readContextSnapshot(): Promise<ConversationContextSnapshot>;
  transact<T>(fn: (tx: ConversationStateTransaction) => Promise<T>): Promise<T>;
}
```

Within transactions, append audit entries, fsync the file, atomically rename snapshots, and only then return. Never hold this lock during model generation; publication tasks will reacquire it for lookup/write transitions.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run test/unit/conversation/state-paths.test.ts test/unit/conversation/state-schema.test.ts test/unit/conversation/state-store.test.ts test/unit/workspace/lock.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit state storage**

```bash
git add src/conversation/state-paths.ts src/conversation/state-schema.ts src/conversation/state-store.ts src/workspace test/unit/conversation test/unit/workspace/lock.test.ts
git commit -m "feat: add repository-isolated conversation state"
```

---

### Task 4: Implement the exact command parser

**Files:**
- Create: `src/conversation/command-parser.ts`
- Test: `test/unit/conversation/command-parser.test.ts`

- [ ] **Step 1: Encode the approved grammar as table-driven failing tests**

Test all eight commands, authenticated mention case folding, CRLF→LF, NFC, ASCII space/tab collapsing, exact IDs, 1/2,000/2,001-scalar boundaries, fenced/inline/quoted/provider-quoted regions, surrounding prose, multiline arguments, two commands, bidi/control characters, near matches, unknown commands, and bot-authored events.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test/unit/conversation/command-parser.test.ts`

Expected: FAIL because `parseConversationCommand` is absent.

- [ ] **Step 3: Implement masking and strict parsing as pure functions**

Return a typed result:

```ts
type CommandParseResult =
  | { kind: "irrelevant" }
  | { kind: "invalid"; reason: "unknown" | "multiple" | "malformed" | "oversized" }
  | { kind: "command"; command: ConversationCommand; normalized: string };
```

Do not call an LLM and do not interpret text following an invalid construct. Hash only `normalized` plus event identity/revision.

- [ ] **Step 4: Run parser tests and lint**

Run:

```bash
npx vitest run test/unit/conversation/command-parser.test.ts
npm run lint -- --no-warn-ignored
```

Expected: PASS.

- [ ] **Step 5: Commit the parser**

```bash
git add src/conversation/command-parser.ts test/unit/conversation/command-parser.test.ts
git commit -m "feat: parse explicit review conversation commands"
```

---

### Task 5: Add GitHub activity and reply support

**Files:**
- Modify: `src/vcs/github-adapter.ts`
- Create fixtures: `test/fixtures/gh-open-prs.json`, `test/fixtures/gh-review-activity.json`, `test/fixtures/gh-review-threads.json`
- Modify: `test/unit/vcs/github-adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests for every new operation**

Assert exact argument arrays and explicit methods for authenticated identity, stable ascending open-PR pagination, issue comments, review comments/replies, GraphQL thread resolution/outdated state, full pagination, marker lookup, general write, thread reply, and identity recovery after inline publication.

- [ ] **Step 2: Add hostile/malformed response tests**

Cover repeated cursors, missing IDs/authors/URLs, wrong repository/PR, non-HTTPS URLs, spoofed markers from another author, oversized bodies, equal timestamps, edits, and an accepted write whose direct response is incomplete but marker recovery succeeds.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/vcs/github-adapter.test.ts`

Expected: FAIL on missing `ConversationAdapter` operations and inline identities.

- [ ] **Step 4: Implement GitHub translation through `gh` only**

Keep GraphQL query constants focused and paginate all connections. Use REST issue comments plus review-comment endpoints and GraphQL review threads. Pass untrusted bodies only through stdin JSON. Normalize into core events; do not parse commands in the adapter.

- [ ] **Step 5: Return/recover exact inline identities**

After the atomic review API succeeds, map returned comments to client markers. If the response does not expose a stable thread/comment binding, query the marked bot-authored threads and require exactly one match per posted child before returning `status: "posted"`.

- [ ] **Step 6: Run GitHub tests**

Run: `npx vitest run test/unit/vcs/github-adapter.test.ts test/unit/vcs/github-related-work.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit GitHub support**

```bash
git add src/vcs/github-adapter.ts test/unit/vcs/github-adapter.test.ts test/fixtures/gh-open-prs.json test/fixtures/gh-review-activity.json test/fixtures/gh-review-threads.json
git commit -m "feat: add GitHub review activity adapter"
```

---

### Task 6: Add GitLab activity and reply support

**Files:**
- Modify: `src/vcs/gitlab-adapter.ts`
- Create fixtures: `test/fixtures/glab-open-mrs.jsonl`, `test/fixtures/glab-review-activity.jsonl`
- Modify: `test/unit/vcs/gitlab-adapter.test.ts`

- [ ] **Step 1: Write failing parity tests**

Mirror the GitHub behavioral matrix using GitLab merge-request notes/discussions: stable open-MR pagination, per-review cursors, replies, resolved/outdated positions, edits, equal timestamps, marker lookup, and exact written identities.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test/unit/vcs/gitlab-adapter.test.ts`

Expected: FAIL on missing conversation methods/identity fields.

- [ ] **Step 3: Implement GitLab normalization through `glab api`**

Reuse `projectEndpoint`, explicit hostname, NDJSON pagination, `GlabCommandError`, and response validation. A successful discussion creation returns its discussion/note binding; partial inline outcomes retain one validated identity per posted child.

- [ ] **Step 4: Add provider-parity type assertions**

Build one normalized GitHub fixture and one normalized GitLab fixture with equivalent semantics and assert the core records differ only in provider identities/URLs.

- [ ] **Step 5: Run adapter tests**

Run: `npx vitest run test/unit/vcs/gitlab-adapter.test.ts test/unit/vcs/gitlab-related-work.test.ts test/unit/vcs/github-adapter.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit GitLab support**

```bash
git add src/vcs/gitlab-adapter.ts test/unit/vcs/gitlab-adapter.test.ts test/fixtures/glab-open-mrs.jsonl test/fixtures/glab-review-activity.jsonl
git commit -m "feat: add GitLab review activity adapter"
```

---

### Task 7: Build resumable polling discovery and bootstrap

**Files:**
- Create: `src/poll/discovery.ts`
- Create: `src/poll/config.ts`
- Create: `src/poll/poll.ts`
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Create: `test/unit/poll/discovery.test.ts`
- Create: `test/unit/poll/poll.test.ts`
- Modify: `test/unit/cli.test.ts`

- [ ] **Step 1: Write failing first-run and cursor tests**

Cover multi-page bootstrap with zero handled history, dry-run with zero state writes, failure on every discovery/cursor-fetch page leaving the state root uninitialized, one atomic bootstrap commit only after complete discovery, and two concurrent first initializers where the second rechecks under lock and cannot overwrite the first snapshot. Also cover later-created reviews starting at creation, independent per-review cursors, inclusive equal-time boundaries, round-robin fairness, 200-event continuation, closed-review retirement, repeated page-token failure, and one review's transient failure not advancing its cursor.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test/unit/poll/discovery.test.ts test/unit/poll/poll.test.ts test/unit/cli.test.ts`

Expected: FAIL because poll discovery/runtime is absent.

- [ ] **Step 3: Implement canonical poll configuration**

Resolve exactly one `RepositoryRef`, instantiate the matching adapter, resolve the state root, and retain the complete shared review options for future focused/forced actions. Reject ambient repositories for `poll`.

- [ ] **Step 4: Implement discovery as a state machine**

For an uninitialized repository, fetch the complete paginated open-review set and each current event high-water mark into bounded in-memory staging. Do not create the state root, lock, cursor, scan-progress file, or audit ledger during this fetch. Only after every page and high-water lookup succeeds, create and fsync the complete initial cursor snapshot in one state-store initialization transaction. Any failure discards staging and leaves the store indistinguishable from never initialized.

After initialization, persist resumable open-review scan epoch/page position, known review cursors, next round-robin review key, and retirement state. Fetch provider pages lazily. Never represent activity with one global timestamp.

- [ ] **Step 5: Implement classification-only `poll`**

For this task, classify events as irrelevant, oversized, invalid command, or recognized command; persist observations and print recognized actions, but leave recognized actions in `prepared` with a named “executor unavailable” local result. Do not post replies yet. Ensure bootstrap and irrelevant-event polling are fully usable.

- [ ] **Step 6: Wire `main()` to call `poll()` and set exit codes**

Use `0` for clean/bootstrap/more-remains, `1` for pre-write fatal or transient poll failure, and `2` only after a provider write occurred with a partial result, matching current review semantics.

- [ ] **Step 7: Run poll tests**

Run: `npx vitest run test/unit/poll test/unit/cli.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit polling foundation**

```bash
git add src/poll src/config.ts src/cli.ts test/unit/poll test/unit/cli.test.ts
git commit -m "feat: add resumable one-shot poll command"
```

---

### Task 8: Build deterministic discussion and memory context

**Files:**
- Create: `src/conversation/context.ts`
- Modify: `src/review/types.ts`
- Modify: `src/review/dispatch-prompt.ts`
- Test: `test/unit/conversation/context.test.ts`
- Modify: `test/unit/review/dispatch-prompt.test.ts`

- [ ] **Step 1: Write failing selection/budget tests**

Cover exact priority: addressed thread, current directions/pending, unresolved changed-line threads, current-head bot threads, active memories, previous-head bot threads. Exclude unrelated/resolved/outdated/older items unless directly addressed. Test 100-comment and 100,000-character limits, whole-item omission, visible omitted counts, stable ordering, and deterministic digest.

- [ ] **Step 2: Add prompt-injection boundary tests**

Embed fake closing tags, model/tool instructions, marker strings, control characters, and contradictory memories. Assert collision-resistant boundaries and explicit `UNTRUSTED_REVIEW_DISCUSSION` / `ADVISORY_LOCAL_MEMORY` labels.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/conversation/context.test.ts test/unit/review/dispatch-prompt.test.ts`

Expected: FAIL because conversation context is unsupported.

- [ ] **Step 4: Implement pure selection and rendering**

Return `{ text, digest, selectedIds, omittedCounts }`; never return provider payload objects directly to prompts. Drop complete low-priority items instead of cutting a thread mid-exchange.

- [ ] **Step 5: Extend `ReviewDispatchInput` and both prompt paths**

Add `conversationContext?: { text: string; digest: string }`. Insert it through `buildTaskText` for both direct and legacy dispatch; do not create different provider/dispatch behavior.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run test/unit/conversation/context.test.ts test/unit/review/dispatch-prompt.test.ts test/unit/review/direct-dispatch.test.ts test/unit/review/dispatch.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit context building**

```bash
git add src/conversation/context.ts src/review/types.ts src/review/dispatch-prompt.ts test/unit/conversation/context.test.ts test/unit/review/dispatch-prompt.test.ts test/unit/review/direct-dispatch.test.ts test/unit/review/dispatch.test.ts
git commit -m "feat: add bounded review discussion context"
```

---

### Task 9: Extend finding decisions and clarification presentation

**Files:**
- Modify: `src/review/types.ts`
- Modify: `src/review/dispatch-prompt.ts`
- Modify: `src/review/direct-dispatch.ts`
- Modify: `src/review/dispatch-results.ts`
- Modify: `src/review/orchestrate.ts`
- Modify: `src/review/comment-format.ts`
- Create: `src/conversation/clarification.ts`
- Modify tests: `test/unit/review/dispatch-prompt.test.ts`, `direct-dispatch.test.ts`, `dispatch.test.ts`, `orchestrate.test.ts`, `comment-format.test.ts`
- Create: `test/unit/conversation/clarification.test.ts`

- [ ] **Step 1: Write failing structured-contract tests**

Add `decision?: "new" | "still-valid" | "addressed" | "disputed" | "needs-clarification"` and `question?: string`. Test default `new`, required bounded question, forbidden question on other states, malformed state rejection, and advisor/index reconciliation preservation.

- [ ] **Step 2: Write failing orchestration tests**

Prove only `new`/`still-valid` count as actionable, `addressed` suppresses repeats, `disputed` is non-actionable status, and only the first deterministic clarification candidate is selected while deferred count is rendered separately.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/review test/unit/conversation/clarification.test.ts`

Expected: FAIL on missing states and clarification output.

- [ ] **Step 4: Update prompt contract and parsers**

Add optional fields to the JSON contract and strict normalization. Preserve backward compatibility for old reviewer output. Ensure both dispatch engines share one validator.

- [ ] **Step 5: Implement pure clarification selection**

Select by workflow/rule order then original finding order, enforce one active per review/head snapshot, create a deterministic `clar_` ID, and return deferred count without persisting deferred candidates.

- [ ] **Step 6: Render separate status sections**

Keep actionable counts unchanged; add singular `Needs clarification` plus disputed/context-unavailable status. Do not mark a pending question as a defect.

- [ ] **Step 7: Run review tests**

Run: `npx vitest run test/unit/review test/unit/conversation/clarification.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit decision states**

```bash
git add src/review src/conversation/clarification.ts test/unit/review test/unit/conversation/clarification.test.ts
git commit -m "feat: classify findings and clarification needs"
```

---

### Task 10: Freeze and recover immutable publication manifests

**Files:**
- Create: `src/conversation/publication-manifest.ts`
- Modify: `src/conversation/state-schema.ts`
- Modify: `src/conversation/state-store.ts`
- Modify: `src/cli.ts`
- Modify: `src/review/comment-marker.ts`
- Modify: `src/vcs/adapter.ts`
- Create: `test/unit/conversation/publication-manifest.test.ts`
- Modify: `test/unit/cli-review.test.ts`

- [ ] **Step 1: Write failing manifest state-machine tests**

Cover `observed → prepared → manifest-ready → published → completed` and `prepared → superseded → successor`. Reject skipped states, body changes after freeze, duplicate child IDs/markers, provider identity mismatch, and completion while a child lacks terminal posted/fallback state.

- [ ] **Step 2: Write crash-matrix integration tests**

Build a manifest with one grouping/summary body and three inline children. Crash before first write and after each child. On recovery, assert no model callback occurs, posted markers are recovered, and only missing children are written. Add GitHub atomic-inline fallback and GitLab selective fallback cases.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/conversation/publication-manifest.test.ts test/unit/cli-review.test.ts`

Expected: FAIL because publication remains implicit in `review()`.

- [ ] **Step 4: Implement immutable manifest creation**

Use exact sanitized bodies and placements:

```ts
interface PublicationChild {
  id: string;
  kind: "summary" | "group-reply" | "inline" | "general-question" | "fallback";
  body: string;
  bodyDigest: string;
  marker: string;
  placement: PublicationPlacement;
  status: "pending" | "posted" | "failed" | "fallback-selected";
  identity?: ConversationItemIdentity;
}
```

Freeze the full primary/fallback graph in state before any provider write.

- [ ] **Step 5: Extract review publication from `review()`**

Move the existing pending-summary checkpoint, GitHub all-inline fallback, and GitLab selective fallback behind the manifest executor without changing visible current behavior. Reacquire the repository state lock for marker lookup + provider write + validated state transition. Preserve dry-run as a no-state/no-provider path.

- [ ] **Step 6: Test concurrent publishers**

Run two injected review/poll executors against one state root and pause both before publication. Assert the lock-held critical section produces one child per marker.

- [ ] **Step 7: Run focused and regression tests**

Run: `npx vitest run test/unit/conversation/publication-manifest.test.ts test/unit/cli-review.test.ts test/unit/vcs`

Expected: PASS.

- [ ] **Step 8: Commit publication recovery**

```bash
git add src/conversation/publication-manifest.ts src/conversation/state-schema.ts src/conversation/state-store.ts src/cli.ts src/review/comment-marker.ts src/vcs/adapter.ts test/unit/conversation/publication-manifest.test.ts test/unit/cli-review.test.ts
git commit -m "feat: make review publication crash safe"
```

---

### Task 11: Add the finding ledger and conversation-aware normal review

**Files:**
- Modify: `src/conversation/state-schema.ts`
- Modify: `src/conversation/state-store.ts`
- Modify: `src/conversation/markers.ts`
- Modify: `src/review/comment-format.ts`
- Modify: `src/review/dedup.ts`
- Modify: `src/cli.ts`
- Create: `test/unit/conversation/finding-ledger.test.ts`
- Modify: `test/unit/review/dedup.test.ts`
- Modify: `test/unit/review/comment-format.test.ts`
- Modify: `test/unit/cli-review.test.ts`

- [ ] **Step 1: Write failing ledger and marker tests**

Before provider publication, expect a ledger entry containing stable finding ID, complete structured finding, exact trusted rule snapshot/digest, review options, base/head SHA, intended placement, and body digest. After publication, expect validated provider binding. Reject a marker without a matching repository/review ledger record.

- [ ] **Step 2: Write failing review-context integration tests**

Inject provider discussion pages plus local memory/pending snapshots and assert `review()` fetches current discussion even when no poll state exists, passes the bounded context to both dispatch modes, includes its digest in dedup, re-reviews on relevant changes, ignores unrelated comment changes, and renders a visible notice when optional context cannot load.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/conversation/finding-ledger.test.ts test/unit/cli-review.test.ts test/unit/review/dedup.test.ts`

Expected: FAIL.

- [ ] **Step 4: Add versioned finding markers to rendered inline bodies**

Keep the current generic bot marker for stale-thread protection and add the structured finding marker. The public marker stores IDs/digests only. Prepare the ledger record before freezing the publication manifest; finalize provider identity through manifest outcomes.

- [ ] **Step 5: Load and digest optional context in `review()`**

Resolve canonical repository identity even for ambient GitHub targets before state access. Fetch provider event/thread pages for the current review to completion within the approved atomic-item policies without changing poll cursors. Read memories/pending state under the repository lock, release before dispatch, and pass only the rendered bounded context.

Classify failures explicitly: unavailable optional context caused by provider auth/network/rate-limit/timeout or a missing state store may continue with rules+diff plus an explicit unavailable section; partial thread pagination is discarded. Corrupt/oversized state, unknown schema, symlink/path/permission violation, impossible transition, or cross-repository binding is an integrity failure and must abort before any provider write. Add one test for every class so a broad catch cannot downgrade fail-closed errors.

- [ ] **Step 6: Update dedup fingerprinting**

Hash only relevant selected discussion IDs/revisions, pending state, directions, active memory revisions, and state-root domain identifier. Exclude unrelated comments and raw bodies from logs.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run test/unit/conversation/finding-ledger.test.ts test/unit/cli-review.test.ts test/unit/review/dedup.test.ts test/unit/review/comment-format.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit normal-review integration**

```bash
git add src/conversation src/review src/cli.ts test/unit/conversation/finding-ledger.test.ts test/unit/cli-review.test.ts test/unit/review
git commit -m "feat: make normal reviews conversation aware"
```

---

### Task 12: Create read-only conversational sessions and structured actions

**Files:**
- Create: `src/conversation/session.ts`
- Create: `src/conversation/actions.ts`
- Create: `src/conversation/render.ts`
- Modify: `src/review/session-hermetics.ts` if a shared fresh-session helper is needed
- Create: `test/unit/conversation/session.test.ts`
- Create: `test/unit/conversation/actions.test.ts`
- Create: `test/unit/conversation/render.test.ts`

- [ ] **Step 1: Write failing session-isolation tests**

Assert a fresh isolated temp CWD, no bash/edit/write/provider/memory tools, explicit model resolution, bounded prompt/response sizes, cleanup on every error, and no target checkout reachable through relative paths.

- [ ] **Step 2: Write failing structured-action tests**

Cover:

```ts
type ReconsiderResult =
  | { outcome: "confirmed"; finding: Finding; rationale: string }
  | { outcome: "revised"; finding: Finding; rationale: string }
  | { outcome: "withdrawn"; rationale: string };
```

Also test explain output, clarification answer output, missing/invalid JSON, prompt injection in replies, 100,000-character output ceiling, current-head revalidation request, and no raw model error in public text.

- [ ] **Step 3: Write failing sanitization and renderer tests**

Use hostile author names, excerpts, memory text, provider URLs, generated Markdown links/images/HTML, fake tGDBot markers, bidi/control characters, and ````suggestion` fences. Assert authors/excerpts are flattened and Markdown-escaped, URLs are validated as HTTPS and bound to the active provider/repository/review, generated fences cannot create committable suggestions, hidden markers come only from `markers.ts`, and final bodies respect the smaller provider/32,000-character limit without cutting a marker.

- [ ] **Step 4: Run and verify failure**

Run: `npx vitest run test/unit/conversation/session.test.ts test/unit/conversation/actions.test.ts test/unit/conversation/render.test.ts`

Expected: FAIL because action sessions are absent.

- [ ] **Step 5: Implement narrow prompt builders and validators**

`explain` receives the historical finding/rule snapshot and current code hunk. `reconsider` receives those plus current trusted rule/current code and directly addressed thread. Clarification reassessment receives the saved candidate finding, original question, first selected human answer, current code hunk/diff position, and exact current trusted rule (plus attributed historical rule when changed). Focus receives the normal rule set/diff plus one direction. Put every human-authored value inside the approved untrusted boundaries.

- [ ] **Step 6: Implement provider-neutral safe renderers**

All action code returns structured semantic results, never final Markdown. `render.ts` alone turns them into public bodies using sanitized author/excerpt fields, validated provider URLs, escaped untrusted text, defanged generated fences/HTML, approved headings, and a marker supplied by `markers.ts`. Publication manifests accept only the branded rendered-body type so raw model/comment text cannot bypass this boundary.

- [ ] **Step 7: Implement rule-deletion and history failure behavior**

Legacy/lost ledger → terminal unsupported-history result. Successfully missing/disabled current rule → terminal inactive-rule result. Provider/rule loading failure or missing credentials → transient error with no public body.

- [ ] **Step 8: Run action tests**

Run: `npx vitest run test/unit/conversation/session.test.ts test/unit/conversation/actions.test.ts test/unit/conversation/render.test.ts test/unit/review/session-hermetics.test.ts`

Expected: PASS. If `session-hermetics.test.ts` does not exist, run the existing dispatch/session tests that cover the helper instead.

- [ ] **Step 9: Commit action sessions**

```bash
git add src/conversation/session.ts src/conversation/actions.ts src/conversation/render.ts src/review/session-hermetics.ts test/unit/conversation/session.test.ts test/unit/conversation/actions.test.ts test/unit/conversation/render.test.ts test/unit/review
git commit -m "feat: add read-only review conversation actions"
```

---

### Task 13: Execute explain, reconsider, and usage replies from `poll`

**Files:**
- Modify: `src/poll/poll.ts`
- Modify: `src/conversation/actions.ts`
- Modify: `src/conversation/publication-manifest.ts`
- Modify: `src/conversation/state-store.ts`
- Modify: `test/unit/poll/poll.test.ts`
- Modify: `test/unit/conversation/actions.test.ts`

- [ ] **Step 1: Write failing event-to-action tests**

Cover irrelevant/self events, invalid command usage, explain/reconsider only in marked bot-started threads, spoofed finding marker, material edit revision, formatting-only edit, unknown/lost history, model transient failure, deterministic scope error, and one response per event.

- [ ] **Step 2: Write ambiguous-write recovery tests**

For each response, simulate accepted provider write followed by transport failure; on retry, marker lookup must supply the identity, complete the child, and avoid a second model call/write once the manifest is ready.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/poll/poll.test.ts test/unit/conversation/actions.test.ts`

Expected: FAIL because recognized commands are not executed.

- [ ] **Step 4: Implement action journal transitions**

Persist `observed`, then `prepared`; perform model work outside the lock; reacquire, revalidate the head, freeze one-child reply manifest, marker-recover/write under lock, apply domain effect, mark `completed`, then advance only that review's contiguous cursor.

- [ ] **Step 5: Implement stale-head successors**

Atomically mark the old action `superseded` and create a successor bound to the newest head. The event remains incomplete until its latest successor completes. Test repeated pushes without publishing stale output.

- [ ] **Step 6: Run poll/action tests**

Run: `npx vitest run test/unit/poll test/unit/conversation/actions.test.ts test/unit/conversation/publication-manifest.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit conversational replies**

```bash
git add src/poll/poll.ts src/conversation/actions.ts src/conversation/publication-manifest.ts src/conversation/state-store.ts test/unit/poll test/unit/conversation/actions.test.ts
git commit -m "feat: answer review discussion commands"
```

---

### Task 14: Implement the clarification lifecycle

**Files:**
- Modify: `src/conversation/clarification.ts`
- Modify: `src/conversation/state-schema.ts`
- Modify: `src/conversation/state-store.ts`
- Modify: `src/conversation/publication-manifest.ts`
- Modify: `src/cli.ts`
- Modify: `src/poll/poll.ts`
- Modify: `src/review/comment-format.ts`
- Modify: `test/unit/conversation/clarification.test.ts`
- Modify: `test/unit/cli-review.test.ts`
- Modify: `test/unit/poll/poll.test.ts`

- [ ] **Step 1: Write failing transition and association tests**

Cover `prepared → published → answer-observed → terminal`, inline first-human reply without mention, unthreaded `answer clar_id:` only, wrong repository/review/head non-disclosure, mentionless general comment ignored, stale-head response, later same-head next candidate, and silence after terminal without a new mention.

- [ ] **Step 2: Write question-publication crash tests**

Crash before write, after accepted ambiguous write, and before local `published`. Assert marker recovery creates one tracked question. Concurrent `review` and `poll` with one state root must publish once.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/conversation/clarification.test.ts test/unit/cli-review.test.ts test/unit/poll/poll.test.ts`

Expected: FAIL on missing persistent lifecycle.

- [ ] **Step 4: Prepare and publish questions through manifests**

Create deterministic `clar_` IDs from repository/review/head/rule/finding digests. Inline when safely anchorable; otherwise publish a marked general comment and show the exact `answer` syntax. The managed summary links only to a validated published identity; while recovery is pending, state that publication is pending.

- [ ] **Step 5: Reassess exactly one answer**

Persist the first valid answer identity, run the narrow action session, then manifest/publish confirmed, revised, withdrawn, or stale. Revised/confirmed actionable findings use the existing safe inline/fallback path and ledger.

- [ ] **Step 6: Run lifecycle tests**

Run: `npx vitest run test/unit/conversation/clarification.test.ts test/unit/cli-review.test.ts test/unit/poll/poll.test.ts test/unit/review/comment-format.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit clarifications**

```bash
git add src/conversation src/cli.ts src/poll/poll.ts src/review/comment-format.ts test/unit/conversation/clarification.test.ts test/unit/cli-review.test.ts test/unit/poll/poll.test.ts test/unit/review/comment-format.test.ts
git commit -m "feat: support bounded review clarifications"
```

---

### Task 15: Implement local remember, forget, and memories commands

**Files:**
- Modify: `src/conversation/state-schema.ts`
- Modify: `src/conversation/state-store.ts`
- Modify: `src/poll/poll.ts`
- Create: `src/conversation/memories.ts`
- Create: `test/unit/conversation/memories.test.ts`
- Modify: `test/unit/poll/poll.test.ts`
- Modify: `test/unit/conversation/context.test.ts`

- [ ] **Step 1: Write failing memory lifecycle tests**

Cover exact normalized text, stable opaque ID, author/source attribution, repository binding, append-only creation, tombstone, unknown ID non-disclosure, active-only listing, conflict preservation, 2,000-scalar item limit, 200-active capacity terminal response, and retry after capacity later changes remaining terminal.

- [ ] **Step 2: Write local-before-reply crash tests**

For `remember` and `forget`, crash after idempotent local domain update but before acknowledgement. Retry must recover/publish one acknowledgement and never duplicate/toggle the memory operation.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run test/unit/conversation/memories.test.ts test/unit/poll/poll.test.ts test/unit/conversation/context.test.ts`

Expected: FAIL because memory command effects are absent.

- [ ] **Step 4: Implement pure memory operations and safe renderers**

Store only normalized lesson + bounded attribution, never entire surrounding threads. `memories` returns IDs and escaped one-line summaries. Do not let memory text become a rule or a model/tool selector.

- [ ] **Step 5: Integrate through the action journal**

Prepare deterministic operation, apply idempotently under lock, freeze acknowledgement manifest, publish/recover, then complete. Cross-repository IDs always return the same not-found response.

- [ ] **Step 6: Run memory tests**

Run: `npx vitest run test/unit/conversation/memories.test.ts test/unit/poll/poll.test.ts test/unit/conversation/context.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit local learning**

```bash
git add src/conversation/memories.ts src/conversation/state-schema.ts src/conversation/state-store.ts src/poll/poll.ts test/unit/conversation/memories.test.ts test/unit/poll/poll.test.ts test/unit/conversation/context.test.ts
git commit -m "feat: add explicit repository-local review memories"
```

---

### Task 16: Implement focused and forced review commands

**Files:**
- Modify: `src/conversation/actions.ts`
- Modify: `src/poll/poll.ts`
- Modify: `src/cli.ts`
- Modify: `src/review/dedup.ts`
- Modify: `src/conversation/publication-manifest.ts`
- Modify: `test/unit/conversation/actions.test.ts`
- Modify: `test/unit/poll/poll.test.ts`
- Modify: `test/unit/cli-review.test.ts`

- [ ] **Step 1: Write failing configuration-parity tests**

Invoke `poll` with every shared flag and assert `review focus`/`check latest` receive exactly the parsed rules dir, builtin toggle, model, advisor, suggestions, max diff, dispatch, trust-local-rules, repository, and state root. Never read hidden ambient review defaults.

- [ ] **Step 2: Write focused-review tests**

Assert the focus direction is durably stored in `pending.json` with repository/review/head/action/author/source attribution before the supplemental run. It is additive untrusted context, all trusted rules still run, results reply beneath the command, safely anchorable findings publish as child outputs, prior summary is unchanged, and previous findings are not resolved. A later normal `review` on the same head selects the direction, changes the relevant context digest, and re-reviews; a new head excludes/expires it from active context while retaining audit history.

- [ ] **Step 3: Write forced-review tests**

Assert `check latest` bypasses SHA/config dedup once for its event, updates the normal summary, uses the full manifest/fallback path, and retrying the event neither dispatches nor publishes twice.

- [ ] **Step 4: Write multi-output crash tests**

Freeze group/summary plus N inline/fallback children. Crash after every child for GitHub and GitLab. Verify exact manifest recovery and zero model regeneration after `manifest-ready`.

- [ ] **Step 5: Run and verify failure**

Run: `npx vitest run test/unit/conversation/actions.test.ts test/unit/poll/poll.test.ts test/unit/cli-review.test.ts`

Expected: FAIL because focus/force actions are not wired.

- [ ] **Step 6: Implement explicit force reason and supplemental path**

Add an internal `ReviewInvocation` object rather than a boolean:

```ts
type ReviewInvocation =
  | { kind: "normal" }
  | { kind: "forced-command"; actionId: string }
  | { kind: "focused-command"; actionId: string; direction: string };
```

Only `forced-command` bypasses normal dedup. Focused review renders/publishes supplemental outputs and does not call normal summary upsert/stale-thread cleanup.

Before focused model work, apply an idempotent head-bound direction creation through the action journal and `pending.json`; if the action later fails transiently, the direction remains attributable and available to its retry. `context.ts` selects active same-head directions and includes their stable revisions in the normal-review digest. Head changes mark directions inactive for selection without deleting their audit entries.

- [ ] **Step 7: Run command-review tests**

Run: `npx vitest run test/unit/conversation/actions.test.ts test/unit/poll/poll.test.ts test/unit/cli-review.test.ts test/unit/review/dedup.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit focus and force**

```bash
git add src/conversation/actions.ts src/conversation/publication-manifest.ts src/poll/poll.ts src/cli.ts src/review/dedup.ts test/unit/conversation/actions.test.ts test/unit/poll/poll.test.ts test/unit/cli-review.test.ts test/unit/review/dedup.test.ts
git commit -m "feat: support focused and forced review commands"
```

---

### Task 17: Harden limits, dry-run, diagnostics, and end-to-end behavior

**Files:**
- Modify: `src/poll/discovery.ts`
- Modify: `src/poll/poll.ts`
- Modify: `src/conversation/context.ts`
- Modify: `src/conversation/session.ts`
- Modify: `src/conversation/state-schema.ts`
- Modify: `src/vcs/github-adapter.ts`
- Modify: `src/vcs/gitlab-adapter.ts`
- Modify: `test/unit/poll/discovery.test.ts`
- Modify: `test/unit/poll/poll.test.ts`
- Create: `test/smoke/poll.test.ts`

- [ ] **Step 1: Add the complete resource-limit matrix**

Test 200-event resumable batches, page size ≤100, 32,000-scalar event bodies, 100-comment addressed threads, 2,000-scalar arguments/memories, 200 active memories, 100,000-character context/model output, provider/public reply limits, and non-advancing pagination. Oversized atomic items must follow terminal/omission policy and never wedge later events.

- [ ] **Step 2: Prove dry-run has no writes**

Inject spies for every provider write, state mkdir/file/lock/write/rename, cursor initialization, model session, and review publication. `poll --dry-run` may create a model session only when previewing a recognized model-backed command (`explain`, `reconsider`, `answer`, `review focus`, or `check latest`); irrelevant, invalid, `remember`, `forget`, and `memories` events must not create one. It must never mutate provider or local state. Existing `review --dry-run` remains unchanged except context preview.

- [ ] **Step 3: Add failure and log-safety tests**

Cover auth failure, rate limit metadata, malformed provider/model output, partial discussion loading, state corruption, unknown schema, symlink root, repeated cursor, and credentials/raw request fragments in errors. Public bodies contain classified explanations only; transient command errors produce no public response. Re-run the hostile author/excerpt/URL/generated-Markdown corpus through every command renderer and both adapters to prove no provider-specific path bypasses `render.ts`.

- [ ] **Step 4: Add smoke tests for both providers with fake executors**

Exercise bootstrap, one command, one memory, one clarification answer, a focused review, and a retry after accepted-but-ambiguous write without network access.

- [ ] **Step 5: Run focused hardening tests**

Run: `npx vitest run test/unit/poll test/unit/conversation test/smoke/poll.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit hardening**

```bash
git add src/poll src/conversation src/vcs test/unit/poll test/unit/conversation test/smoke/poll.test.ts
git commit -m "test: harden conversational review operations"
```

---

### Task 18: Document operation and run final verification

**Files:**
- Modify: `README.md`
- Modify: `package.json` only if test/build scripts need to include the new smoke test
- Modify: `test/unit/docs.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

Require README coverage for `review` vs one-shot `poll`, no daemon/CI requirement, manual/cron examples, both providers' auth/permissions, exact command grammar, first-run bootstrap, local path precedence, backup/deletion/recovery, repository isolation, any-commenter advisory memories, clarification limits, multi-root warning, dry-run, exit codes, rate limits, and resource ceilings.

- [ ] **Step 2: Update README with exact commands and safety boundaries**

Include examples such as:

```bash
tgd-review-agent poll --repo owner/repo --state-dir /secure/tgdbot-state
```

State explicitly that `poll` must be invoked repeatedly by a human or external scheduler, local state is not committed, memories never cross repositories, and multiple state roots for one repository can duplicate replies.

- [ ] **Step 3: Run documentation and CLI tests**

Run: `npx vitest run test/unit/docs.test.ts test/unit/cli.test.ts test/smoke/poll.test.ts`

Expected: PASS.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm run build
npm run lint
npm test
npm run test:smoke
git diff --check
git status --short
```

Expected: build, lint, unit/type, and smoke suites pass; diff check is clean; status contains only intentional feature changes (and any separately recorded pre-existing user changes).

- [ ] **Step 5: Perform two manual dry-run acceptance checks**

With authenticated test repositories or recorded CLI fixtures:

```bash
tgd-review-agent poll --repo <github-owner/repo> --dry-run
tgd-review-agent poll --repo <https://gitlab.example.com/group/project> --vcs gitlab --dry-run
```

Expected: canonical target and proposed/ignored actions print; no comments, discussions, cursors, memories, or locks are created.

- [ ] **Step 6: Commit docs and final verification changes**

```bash
git add README.md package.json test/unit/docs.test.ts
git commit -m "docs: explain conversational review and local learning"
```

- [ ] **Step 7: Review the final branch**

Run:

```bash
git log --oneline --decorate -20
git diff HEAD~18..HEAD --stat
```

Expected: small, ordered commits corresponding to the tasks above, with no reviewed-repository content or local state files accidentally committed.
