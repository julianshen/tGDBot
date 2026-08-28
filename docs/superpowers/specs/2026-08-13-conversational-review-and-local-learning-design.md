# Conversational Review and Local Learning Design

## Summary

Extend tGDBot from a one-way code reviewer into a conversation-aware reviewer that can:

1. use relevant PR/MR discussions when reviewing new revisions;
2. answer explicit commands and conduct bounded clarification conversations; and
3. retain explicitly approved, repository-isolated lessons in local tGDBot state without modifying the reviewed repository.

The existing `review` command remains a one-shot operation. A new one-shot `poll` command discovers discussion activity since its last successful run, handles explicit `@tGDBot` commands, advances durable local cursors, and exits. Users may invoke it manually or schedule it with any external mechanism; tGDBot does not add a daemon, webhook server, or CI requirement.

## Goals

- Give review rules the relevant prior discussion needed to avoid repeating answered, addressed, or intentionally accepted concerns.
- Let people ask tGDBot to explain or reconsider a finding and request a focused or forced review.
- Let a normal review ask one focused clarification question when correctness depends on product intent.
- Persist lessons only after an explicit command.
- Isolate all cursors, pending decisions, directions, and memories by canonical repository identity.
- Support GitHub and GitLab through provider-neutral core types and provider-specific adapters.
- Preserve tGDBot's existing trusted-rule, read-only-session, diff-anchor, summary-upsert, and stale-thread safety properties.
- Make polling and every visible response safe to retry after interruption or an ambiguous network result.

## Non-goals

- Training or fine-tuning a model from review conversations.
- Automatically inferring persistent lessons from ordinary discussion, or
  writing any prose into a future review prompt without an explicit human
  `remember`. **Amended by #57**, which draws the line more precisely than the
  original wording did. Two classes are now distinguished:
  - **Memories** — advisory PROSE injected into review prompts. Unchanged:
    `@tGDBot remember` stays the only way text reaches a future model. Anything
    auto-written here would turn replying to a bot comment into editing the
    reviewer's instructions, which on a repository accepting outside
    contributions is a prompt-injection channel with a persistence guarantee.
  - **Outcome records** — mechanical and written automatically. Every field is
    an enumerated value, a digest, a number or a timestamp; the rule and
    category are stored as SHA-256 digests computed by the host from the
    finding ledger, never accepted from a caller, because a validator can prove
    a value is 64 hex characters but not that it came from a hash — and hex
    decodes. **No code path may place a raw outcome record into a review
    prompt.** That is a prohibition rather than a schema property, and it is
    the reason these records are scoped to idempotency and to calibration
    reported to a human. They record what became of a finding so a
    poll knows what it has already verified, and so calibration can be reported
    to a maintainer.

  The non-goal that remains, and is strengthened: no statistic derived from
  outcome records may suppress or reweight a rule, and none may become prompt
  text. A rule dismissed often may be miscalibrated, or may be a team ignoring
  real problems, and counts cannot tell those apart.
- Sharing memories, directions, or discussion state across repositories.
- Committing knowledge files, opening knowledge PRs, or otherwise modifying the reviewed repository.
- Running a resident watcher, webhook receiver, or scheduler.
- Allowing comments or memories to disable trusted rules, change models, grant tools, or alter security policy.
- Automatically resolving human-started threads or deciding that a disputed violation is waived.
- Replaying historical commands during initial state bootstrap.
- Supporting free-form bot conversation without an explicit mention or an outstanding bot clarification.

## User-visible behavior

### One-shot polling

The new command is:

```bash
tgd-review-agent poll \
  --repo <repository> \
  [--vcs github|gitlab] \
  [--state-dir <path>] \
  [--model <provider/model>] \
  [--dry-run]
```

`--repo` must normalize to one canonical repository identity. GitHub and GitLab repository formats follow the existing target parser. `--vcs` is optional when the repository input identifies its provider. `--model` selects the model used for conversational reassessment and focused review work; normal review rules retain their existing model resolution behavior.

Each invocation lists relevant open PRs/MRs, retrieves activity newer than its repository-local high-water mark, processes events oldest-first, records durable outcomes, and exits. Polling cadence belongs to the caller: a developer may run the command manually, or use cron, launchd, a systemd timer, or CI.

On the first non-dry run, `poll` records the current provider high-water mark without handling historical commands and prints that it initialized the repository with zero processed events. This prevents a newly installed bot from unexpectedly reviving old conversations. Historical replay is not part of the first version.

`--dry-run` fetches and classifies activity and prints proposed actions, but performs no provider writes and no local-state writes, including cursor initialization or advancement.

### Commands

Commands are accepted only in a new human-authored comment or reply that explicitly mentions the authenticated bot identity. Mention matching is provider-aware and case-insensitive after provider normalization. The examples use `@tGDBot`; in practice the mention must match the identity returned by the active provider account. A strict parser, not an LLM, decides whether a command exists and which command it is.

The initial command set is:

- `@tGDBot explain` — explain the tGDBot finding that started the current thread.
- `@tGDBot reconsider <reason>` — reassess that finding against the current diff and complete thread.
- `@tGDBot review focus: <direction>` — run a supplemental review emphasizing the requested direction.
- `@tGDBot check latest` — force the ordinary review pipeline for the current head, even if the normal SHA/config deduplication marker already matches.
- `@tGDBot remember <lesson>` — store the supplied lesson as advisory local knowledge for this repository.
- `@tGDBot forget <memory-id>` — deactivate a repository-local memory.
- `@tGDBot memories` — list active memory IDs and length-bounded summaries.

Any human commenter may issue these commands. Bot-authored comments, including tGDBot's own responses, never trigger commands. Only one recognized command is allowed per event. Ambiguous multiple-command text receives usage help and is marked handled without model work.

`explain` and `reconsider` are valid only inside a thread whose first comment is a marked tGDBot finding. Elsewhere, tGDBot posts a concise scope error. `remember`, `forget`, `memories`, `review focus`, and `check latest` are valid in either a general PR/MR comment or a discussion thread.

### Focused and forced reviews

`review focus:` creates a supplemental pass bound to the command event, current review number, and current head SHA. The direction adds emphasis but does not remove or rewrite the trusted base-branch rule set. Results are grouped by a reply to the command. Safely anchorable actionable findings may also be published inline with an action marker linking them to the supplemental pass. The normal managed summary is not replaced, and prior tGDBot findings are not automatically resolved.

`check latest` invokes the ordinary review flow with an explicit force reason. It may update the managed summary and publish the current run's normal inline output even when the existing SHA/config marker would otherwise skip. The command event ID is part of the action identity, so retrying the same command cannot force multiple runs.

### Clarification flow

The finding contract gains a decision state:

- `new`
- `still-valid`
- `addressed`
- `disputed`
- `needs-clarification`

Existing reviewers that omit the field remain compatible: their findings default to `new`.

Only `new` and `still-valid` are actionable. `addressed` suppresses a repeated finding. `disputed` records that discussion exists but does not silently waive a rule violation. A `needs-clarification` result must include one short, answerable question and enough candidate-finding metadata to reassess it later; it is not published as an actionable defect.

The summary renders pending questions under a separate `Needs clarification` section and excludes them from actionable counts. When possible, each question is posted at the relevant diff location as a marked bot thread; an unanchorable question appears in the summary with its stable pending ID.

The pending record binds repository, review number, head SHA, rule, candidate finding, question, and bot thread or summary identity. A subsequent `poll` invocation may process the first human reply to that outstanding question without requiring another mention. tGDBot reassesses once and posts exactly one terminal outcome: confirmed finding, revised finding, or withdrawn concern with a short rationale. It then closes the pending record and remains silent unless explicitly mentioned again. Replies to stale-head questions are acknowledged as stale and do not create current-head findings.

### Persistent local memories

`remember` stores exactly the normalized lesson supplied after the command; it does not silently synthesize a broader rule from the surrounding conversation. Each memory has a stable opaque ID, canonical repository identity, normalized text, author identity, source review/comment URL, creation time, and active state. Provider comment text is retained only to the bounded extent necessary for the lesson and attribution.

`forget` appends a tombstone rather than erasing the audit trail. Anyone may remember or forget a lesson, as requested. Memories are advisory evidence, not trusted policy. Conflicting memories remain visible to reviewers until explicitly forgotten; tGDBot does not choose a winner or merge them automatically.

No memory is stored in the reviewed repository, committed to Git, or loaded by another repository. Losing the local state loses the memories; provider comments remain the human-visible source record.

## Architecture

### Provider-neutral activity model

Extend the VCS boundary with focused discussion operations rather than exposing provider payloads to the review core. Provider-neutral records include:

- canonical repository and review identity;
- stable provider event, comment, and thread IDs;
- event kind (`general-comment`, `thread-comment`, `thread-resolution`, or `comment-edit`);
- author identity and whether it is the authenticated bot;
- created and updated timestamps;
- normalized body and validated web URL;
- parent comment and thread relationships;
- resolution and outdated state;
- optional file, side, line, and original/current head information; and
- a deterministic event revision derived from provider ID, update time, and validated body hash.

Adapters provide operations to:

1. identify the authenticated bot;
2. list open reviews changed after a provider cursor;
3. fetch complete paginated discussion snapshots for those reviews;
4. post a general reply;
5. reply to a thread;
6. locate a prior tGDBot action marker after an ambiguous write result; and
7. use the existing review, diff, inline-review, summary, and stale-thread operations for code-review actions.

GitHub translates issue comments, pull-request review comments/replies, and GraphQL review-thread state. GitLab translates MR notes and discussions. Provider code validates IDs, URLs, pagination, authors, positions, and write responses. Core code owns command semantics and never depends on GitHub-only or GitLab-only thread shapes.

### Activity discovery and cursor semantics

The repository cursor is a provider-specific opaque high-water mark plus a core tie-break key. Adapters must return a stable total order and include every event whose update ordering is greater than the cursor. Events sharing a timestamp are ordered by stable provider identity. Edited comments create a new event revision but do not re-execute an already completed identical command hash.

Polling first selects open reviews whose provider `updated_at` is newer than or equal to the cursor boundary, then fetches their complete paginated discussion snapshots and derives unseen revisions locally. The inclusive boundary prevents equal-timestamp loss; the handled-event journal removes duplicates. The design must not assume default API page sizes are complete.

The cursor advances only across a contiguous prefix of durably classified events. A transient failure stops processing before the failed event. Later events remain pending for the next invocation. Irrelevant events are still recorded as observed so they are not repeatedly parsed.

### Local state store

Add a focused conversation-state store alongside, but separate from, managed Git mirrors and worktrees. The root selection order is:

1. explicit `--state-dir`;
2. `TGD_REVIEW_STATE_DIR` when set;
3. `$XDG_STATE_HOME/tgd-review-agent` on Unix when `XDG_STATE_HOME` is absolute;
4. `$HOME/.local/state/tgd-review-agent` on other Unix systems; or
5. `%LOCALAPPDATA%\tgd-review-agent\state` on Windows.

Missing or relative required environment paths are rejected rather than interpreted against the current checkout. Repository directories reuse the existing percent-encoded provider/authority/namespace/repository scheme. Path derivation proves every candidate remains inside the resolved state root.

State is split by responsibility:

- `cursor.json` — schema version, provider cursor, and last completed ordering key;
- `events.jsonl` — append-only observed/action audit records and action status;
- `memories.jsonl` — append-only memory creations and tombstones;
- `pending.json` — active clarification records and current-head review directions.

Files are owner-only where the platform supports POSIX permissions. State updates occur under the existing repository-lock pattern, use temporary sibling files plus atomic rename for snapshots, fsync before acknowledgement, and reject symlinked roots or ancestors. JSON is parsed as unknown and schema-validated with resource bounds before use. Unknown future schema versions or internally conflicting action records fail closed before provider writes.

The lock protects a single canonical repository. Two `poll` processes for the same repository serialize; different repository roots do not block one another. Normal `review` acquires the same repository state lock only while reading a stable context snapshot or updating pending clarification records, not while waiting on model/provider work.

### Command router and action journal

A pure command parser receives the authenticated bot identity and normalized event body. It recognizes one exact command grammar, bounds command and argument lengths, and returns a typed command or a permanent parse result. Markdown quoting and fenced code do not create commands; the mention and command must occur in ordinary text.

Each recognized command becomes an action identity containing canonical repository, review number, event ID, event revision, normalized command, and current head SHA where applicable. Provider-visible responses include a hidden marker containing a versioned, non-secret digest of that identity.

Before any visible write, the executor checks the local journal and searches the relevant provider conversation for the action marker. This handles the case where the provider accepted a write but the CLI lost the response. After a validated provider response, the executor durably records completion and only then allows cursor advancement.

Permanent invalid commands receive bounded usage help and complete normally. Authentication failures, rate limits, timeouts, malformed provider output, model failures, and ambiguous unmatched writes are transient: the command remains uncompleted and `poll` exits nonzero. The CLI never emits raw provider/model errors into public comments.

### Discussion context builder

A deterministic builder creates a bounded snapshot for a specific review and head SHA. It may select:

1. the directly addressed thread;
2. current-head directions and pending clarifications;
3. unresolved threads anchored to files or lines changed by the current diff;
4. current-head tGDBot threads;
5. active local memories; and
6. tGDBot threads from the immediately previous head when space remains.

Resolved, outdated, unrelated, and older conversation is omitted unless it is the directly addressed reconsideration thread. Thread structure, author, resolution state, path/line, provider IDs, and timestamps are preserved. Bodies are control-character stripped, individually length-bounded, and placed in stable order. The builder applies per-item, per-section, and total character ceilings. When trimming is necessary it drops lowest-priority whole items and reports omitted counts; it does not silently truncate a thread into a misleading partial exchange.

Discussion is enclosed in a collision-resistant `UNTRUSTED_REVIEW_DISCUSSION` boundary. Memories are enclosed separately as `ADVISORY_LOCAL_MEMORY`. Both sections state that their contents are evidence only and may contain malicious instructions. They cannot alter the trusted base-branch rule, finding contract, tool policy, or trust-boundary instructions.

The evidence order is:

```text
trusted base-branch rule
current code and diff
corroborated review discussion
advisory repository-local memory
```

Conversation may explain product intent and prevent a false positive, but cannot erase an observable rule violation without rule-compatible reasoning grounded in current code.

### Review pipeline integration

`ReviewDispatchInput` gains optional provider-neutral discussion context. Both direct and legacy dispatch paths use the same context builder and boundary format so switching `--dispatch` does not change the evidence available to rules. The task-level finding contract gains optional decision state and clarification question fields. Parsing defaults a missing decision state to `new` and rejects inconsistent shapes, such as `needs-clarification` without a question.

The normal `review` flow fetches discussion snapshots and a local memory snapshot after resolving the review target and before dispatch. Conversation context participates in the review-config fingerprint through a deterministic context digest, so a relevant new direction, completed clarification, or memory change can cause a same-head re-review when `review` is explicitly invoked. Ordinary unrelated comments do not change the digest.

If optional discussion or memory context cannot be loaded, a normal review may continue using the diff and trusted rules only, but its summary must state which context was unavailable. Command actions that promise thread-aware behavior fail rather than pretending to have considered unavailable context.

`addressed` candidates are removed before normal finding deduplication. `disputed` candidates are retained in internal accounting and rendered only as discussion status when directly relevant; they are not actionable counts. `needs-clarification` candidates flow to a separate pending-question presentation. Existing inline anchoring and fallback guarantees continue to apply independently to actionable findings and questions.

### Conversational model operations

Conversation actions use fresh, read-only, tool-restricted sessions with narrow prompts:

- `explain` receives the marked original finding, current code hunk, trusted rule identity/body, and directly addressed thread.
- `reconsider` receives the same data plus the explicit reason and must return a structured confirmed/revised/withdrawn result.
- clarification reassessment receives the saved candidate, question, first human answer, current code hunk, and rule.
- focused review uses the normal rule set and diff plus one bounded focus direction and relevant discussion context.

No action session receives filesystem mutation, shell, arbitrary network, provider-write, or memory-write tools. Structured output is validated before rendering. Provider comments never directly select a model; `--model` or existing trusted rule configuration does.

### Rendering and reply behavior

All generated replies use provider-neutral renderers and provider adapters for placement. Untrusted author names, excerpts, memory text, and URLs are sanitized and Markdown-escaped. Hidden tGDBot markers are versioned and contain no raw prompt, comment body, credential, or model error.

One recognized event produces at most one conversational reply, excluding separately anchored findings from a focused or forced review. A clarification produces at most one question and one terminal reassessment. tGDBot never replies to itself and does not continue a conversation after a terminal result without a new explicit mention.

## Race handling and idempotency

- Before a diff-dependent action, capture the review head SHA and discussion snapshot.
- Immediately before publishing, re-fetch the head metadata. If the head changed, discard generated output, leave the action retryable, and do not publish stale findings.
- Bind pending clarifications and review directions to their captured head SHA.
- Treat a reply to an older-head clarification as stale; acknowledge it once without turning it into a current finding.
- Key completion by event revision and normalized command hash. Editing a handled comment to a materially different command creates a new action; inconsequential formatting with the same normalized command does not.
- Search provider-visible action markers before retrying any ambiguous write.
- Retain existing bot-summary identity validation and inline-publish fallback behavior for forced reviews.
- Never auto-resolve human-started threads. Existing stale-thread cleanup remains restricted to marked tGDBot-started threads.

## Failure handling

- First-run bootstrap failure performs no writes and leaves the store uninitialized.
- Corrupt, oversized, symlinked, cross-repository, or unknown-version state fails closed before provider writes.
- Failure to list or paginate complete activity leaves the cursor unchanged.
- One permanently invalid command is answered with usage help and does not block later events.
- One transient action failure stops the contiguous processing batch and returns nonzero.
- Missing model credentials or invalid model output produce a safe public failure message only when a command requires a response; raw details remain in local logs.
- Memory conflicts are displayed as conflicts and never resolved automatically.
- A missing memory ID receives a deterministic not-found response and is marked handled.
- If local state is lost, provider action markers prevent duplicate visible command replies where the provider history remains accessible. The first run against the new empty store otherwise bootstraps at the current high-water mark.
- Rate-limit metadata should be logged when available, but v1 does not sleep or run an internal retry loop; the caller decides when to invoke `poll` again.

## Security and resource bounds

- Treat every provider comment, author name, direction, reply, and local memory as untrusted input.
- Parse commands deterministically outside the model.
- Never interpolate provider content into a shell command; continue using argument arrays and stdin JSON.
- Validate provider response identities, URLs, authors, pagination, thread relationships, and write bodies.
- Keep trusted rules sourced from the review base branch unless the user explicitly opts into the existing local-rule escape hatch.
- Prevent comments and memories from changing models, tools, output contracts, rules, repository target, state path, or provider arguments.
- Apply explicit limits to open reviews per poll batch, events per review, pages, threads, comments per thread, body length, command length, memory count, individual memory length, context size, model response size, and public reply size. Hitting a limit is visible and retry-safe; no cursor advances past content that was not safely classified.
- Store only bounded lesson text and attribution required by the feature. Do not copy entire discussions into the memory store.
- Use collision-resistant boundary tokens when embedding untrusted discussion and memory content.
- Mask credentials and raw provider/model request data in logs and public replies.

## Testing strategy

### Pure model and parser tests

- Normalize GitHub and GitLab general comments, inline threads, replies, resolutions, outdated positions, edits, and equal-timestamp ordering into equivalent core records.
- Parse every command with provider-aware case-insensitive mentions.
- Reject quoted, fenced, bot-authored, multiple, malformed, oversized, and near-match commands.
- Prove normalized formatting-only edits do not re-execute a command while material edits do.
- Validate decision-state defaults and reject inconsistent structured findings.

### State-store tests

- Derive isolated paths for GitHub, nested GitLab namespaces, custom GitLab ports, and similar repository names without collisions.
- Reject relative roots, traversal, symlinks, unsafe permissions, malformed JSON, oversized files, cross-repository records, and unknown schemas.
- Verify atomic snapshot replacement, append-only audit records, lock serialization, crash recovery, and tombstones.
- Verify no state path for one repository is read while processing another.
- Cover default root selection and explicit `--state-dir` precedence on supported platforms.

### Polling and idempotency tests

- First real run bootstraps without processing history; dry-run does not bootstrap.
- Inclusive cursor boundaries and stable tie-breaks neither miss nor duplicate events.
- Pagination is complete before cursor advancement.
- Irrelevant and self-authored events are recorded without model work.
- Permanent invalid commands allow later events to proceed.
- Transient failures stop at the failed event and retry on the next invocation.
- Simulate provider-write success followed by lost response; marker lookup prevents a duplicate reply.
- Simulate failure before write, during write, after write, and before local completion persistence.
- Verify the head-SHA check discards stale generated output.

### Conversation and memory tests

- `explain` and `reconsider` require a marked tGDBot-started thread.
- Reconsideration can confirm, revise, or withdraw without reply loops.
- One clarification question produces one terminal response; stale-head answers are acknowledged but not promoted.
- Focus directions add emphasis without suppressing trusted rules.
- Forced review bypasses normal SHA/config dedup once per command action.
- Remembered lessons preserve exact normalized text and attribution.
- `forget` creates a tombstone; unknown IDs are deterministic; `memories` lists only active bounded summaries.
- Conflicting memories remain separately visible.
- Comment and memory prompt-injection strings remain inside untrusted boundaries and cannot alter tools or contracts.

### Context and review integration tests

- Select directly addressed, pending, unresolved changed-line, current bot, memory, and previous-head items in the specified priority order.
- Exclude unrelated, resolved, outdated, and older context unless directly addressed.
- Apply item and total budgets by dropping whole low-priority items with visible omitted counts.
- Produce the same context for direct and legacy dispatch.
- Re-review on relevant context-digest change, but not on unrelated comments.
- Keep actionable, disputed, addressed, and clarification accounting separate.
- Preserve existing inline anchors, committable-suggestion protections, summary markers, partial-failure fallback, and stale bot-thread cleanup.
- Continue a normal review with a visible context-unavailable notice; fail thread-dependent commands when the thread cannot be loaded.

### Adapter and CLI tests

- Assert exact `gh`/`glab` argument arrays, explicit methods, pagination, hostname/repository selectors, and stdin bodies.
- Validate authenticated bot identity and ignore spoofed action markers from other authors.
- Validate general and thread reply response IDs/bodies and marker round trips.
- Parse `poll` independently of `review`, require a canonical repository, and reject incompatible flags.
- Verify `--dry-run` performs no provider or state writes.
- Build, type-check, lint, unit-test, and smoke-test the complete CLI.

## Documentation

Update the README with:

- the difference between `review` and one-shot `poll`;
- manual and scheduler examples without implying CI is required;
- GitHub and GitLab authentication/permission requirements for reading and writing discussions;
- exact command grammar and examples;
- first-run bootstrap behavior;
- local state path selection, permissions, backup, deletion, and recovery;
- the repository-isolation guarantee and lack of cross-repository learning;
- the advisory trust level of memories and the fact that any commenter may create or forget them;
- clarification and reply-loop limits;
- dry-run behavior, exit statuses, rate-limit behavior, and operational diagnostics.

## Delivery sequence

The implementation plan should preserve a working CLI after each stage:

1. provider-neutral discussion records, adapter reads, context selection, and conversation-aware normal review;
2. local state store, bootstrap, cursors, action journal, and read-only `poll` classification;
3. strict commands, provider replies, marker-based retry safety, explain/reconsider, and focused/forced review;
4. clarification lifecycle and summary presentation; and
5. remember/list/forget local memory and final documentation/hardening.

Although staged, these are one integrated feature: every later capability reuses the same normalized activity, state, trust boundaries, and idempotency model.

## Acceptance criteria

- A normal GitHub or GitLab review can use relevant current discussions and repository-local memories without exposing them as trusted instructions.
- Existing answered or addressed bot findings are not blindly repeated; actionable, disputed, addressed, and pending states remain distinguishable.
- `poll` is a one-shot CLI command, requires one repository, bootstraps without historical replies, and safely processes later events in deterministic order.
- Every initial command behaves as specified for any human commenter, and tGDBot never responds to itself or loops without a new mention.
- Explicit clarification produces at most one question and one reassessment bound to the correct head SHA.
- Persistent learning occurs only through `remember`; memories stay local, advisory, auditable, and repository-isolated, and `forget` tombstones them.
- Comments and memories cannot disable trusted rules, change tools/models, cross repositories, or mutate reviewed files.
- Retrying after any modeled interruption does not duplicate visible replies or forced/focused review actions.
- First-run, pagination, cursor, race, corruption, provider failure, and context-unavailable behavior is visible and deterministic.
- No feature operation commits to or otherwise modifies the reviewed repository.
- All new and existing automated tests pass for both GitHub and GitLab.
