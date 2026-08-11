# Related Work References Design

## Summary

Add a deterministic `Related work` section to review summary comments. The section lists issues, GitHub pull requests, and GitLab merge requests that are explicitly referenced in the current PR/MR title or description.

The feature supports GitHub and GitLab, including cross-repository or cross-project references. It resolves reference metadata through the platform CLI (`gh` or `glab`) and degrades gracefully when metadata cannot be fetched.

## Goals

- Make explicitly related work visible in the generated review summary.
- Support both GitHub PRs and GitLab MRs through the existing VCS abstraction.
- Recognize same-project, cross-project, and full-URL references.
- Show resolved type, title, state, and link when available.
- Keep reference handling deterministic and isolated from the reviewer prompt.
- Preserve the existing review when reference resolution fails.

## Non-goals

- Searching for semantically similar issues, PRs, or MRs.
- Inferring relationships from the diff, commits, or comments.
- Fetching or analyzing referenced item descriptions or diffs.
- Adding references to individual inline findings.
- Supporting implicit issue-key formats from external trackers.

## User-visible behavior

When the PR/MR title or description contains supported explicit references, the review summary includes a `Related work` section. References retain their first-seen order and are deduplicated.

Examples:

```markdown
## Related work

- Issue #42 — Fix login timeout (open)
- PR owner/service#51 — Refactor authentication (merged)
- MR group/project!19 — Add session rotation (opened)
```

If metadata lookup fails, the entry uses the original normalized reference and a link when one can be constructed, without inventing a title, type, or state. If no references are found, the section is omitted.

## Supported reference syntax

Only the current PR/MR title and description are scanned.

### GitHub

- `#123` for an issue or PR in the current repository.
- `owner/repo#123` for an issue or PR in another repository.
- Full GitHub issue or pull-request URLs.

GitHub number syntax is ambiguous between issues and pull requests. Resolution through `gh` determines the actual type.

### GitLab

- `#123` for an issue in the current project.
- `!123` for an MR in the current project.
- `group/project#123` for an issue in another project.
- `group/project!123` for an MR in another project.
- Full GitLab issue or merge-request URLs.

Nested GitLab group paths are supported.

### Parsing rules

- Ignore references inside fenced code blocks and inline code spans.
- Exclude a reference to the current PR/MR itself.
- Deduplicate by provider, canonical project identity, item kind when known, and number.
- Preserve first-seen order across title followed by description.
- Resolve at most the first 10 unique references.
- Ignore additional references and emit a diagnostic log entry with the omitted count.

## Architecture

### Reference model

Introduce a provider-neutral model for parsed and resolved references. A parsed reference contains the provider, project identity, number, syntax-derived kind when available, original text, and a canonical or constructible URL. A resolved reference additionally contains the confirmed kind, title, state, and canonical URL.

The model must distinguish unresolved metadata from negative lookup results so rendering never presents guessed values.

### Extraction

A pure extractor accepts the provider, current project identity, current change number, title, and description. It removes code spans from consideration, recognizes provider-specific syntax, normalizes results, removes self-references and duplicates, and applies the 10-reference limit.

Extraction is deterministic and performs no external calls.

### Resolution

Extend the existing VCS adapter contract with a best-effort related-item resolution operation. Each provider implementation invokes its own CLI with structured argument arrays:

- GitHub uses `gh` to distinguish issues from pull requests and retrieve title, state, and URL.
- GitLab uses `glab` to retrieve issue or MR title, state, and URL according to the syntax-derived kind.

Cross-project lookups pass an explicit repository/project selector to the CLI. Implementations must not construct shell command strings from PR/MR content.

Resolution may be performed with bounded concurrency, but output order must match extraction order. Every lookup has a timeout, and individual failures are returned as unresolved entries rather than failing the review.

### Review integration

The review orchestration flow extracts references after loading PR/MR metadata, resolves them through the active VCS adapter, and passes the resulting display data to the summary comment formatter.

Reference titles and descriptions are never included in the LLM reviewer prompt. This keeps untrusted external content out of the instruction context and makes the section independent of model behavior.

### Rendering

The shared comment formatter renders `Related work` only when at least one parsed reference exists. Resolved entries include kind, qualified identifier when cross-project, escaped title, state, and canonical link. Unresolved entries include only the normalized identifier and safe link available from parsing.

All platform-provided strings are escaped for Markdown. The new section must not alter existing findings, summaries, or marker comments used to update prior reviews.

## Failure handling

- Missing CLI authentication, insufficient permissions, timeouts, deleted items, and malformed CLI responses are non-fatal.
- One failed lookup does not suppress successfully resolved references.
- A failure to resolve every entry still produces the normal review and may render unresolved references.
- Diagnostics identify the provider and normalized reference without logging PR/MR body contents or credentials.
- Existing behavior remains unchanged when extraction finds no supported references.

## Security and resource bounds

- Pass CLI arguments as arrays; never interpolate untrusted content into a shell command.
- Do not fetch referenced descriptions, comments, diffs, or other prompt-bearing content.
- Escape titles and identifiers before Markdown rendering.
- Limit resolution to 10 unique references per review.
- Apply a timeout to each CLI lookup and use bounded concurrency.
- Treat all resolved metadata as display-only, untrusted data.

## Testing strategy

### Extractor unit tests

- GitHub same-repository shorthand, cross-repository syntax, and full URLs.
- GitLab issue/MR shorthand, nested cross-project syntax, and full URLs.
- Mixed title and description ordering.
- Deduplication across alternate forms of the same reference.
- Current-change self-reference removal.
- Fenced and inline code exclusion.
- Ten-item limit and omitted-count diagnostics.
- Lookalike text that must not be parsed.

### Adapter tests

- Correct `gh` and `glab` argument construction for local and cross-project items.
- GitHub issue-versus-PR classification.
- GitLab issue-versus-MR selection.
- Successful structured metadata parsing.
- Missing authentication, not found, timeout, and malformed output behavior.
- Partial success while preserving input order.

### Formatter and integration tests

- Resolved entry rendering, including Markdown escaping.
- Unresolved fallback rendering.
- Cross-project qualification.
- Section omission when no references exist.
- Existing review formatting and managed-comment markers remain unchanged.
- End-to-end GitHub and GitLab review flows continue when all lookups fail.

## Acceptance criteria

- A review with explicit supported references includes a correctly ordered `Related work` section.
- GitHub and GitLab references resolve through `gh` and `glab`, respectively, without direct API implementation.
- Same-project and cross-project references, including full URLs, work as specified.
- Code examples do not create references, duplicates are removed, self-references are excluded, and no more than 10 lookups occur.
- Lookup failures never prevent the main review comment from being produced.
- Resolved external metadata never enters the reviewer prompt.
- All new and existing automated tests pass.
