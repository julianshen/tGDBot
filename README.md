# tGDBot

A GitHub/GitLab code review CLI built on the pi SDK, driven by the tGD-review
skill, with per-rule provider/model configuration and subagent-orchestrated
review workflows.

See `tgd-review-agent/` docs in the sibling `tGDBot-tGD` planning directory
(PRD.md, SPEC.md, TASKS.md) for the full spec and task breakdown.

## ⚠️ Security Considerations

**Read this before wiring `tgd-review-agent` into CI on any repository that
accepts contributions you don't fully trust.**

Every dispatched review subagent's task prompt includes the PR's diff
**verbatim**, and that diff is always attacker-controlled input by necessity
(the whole point of the tool is to review it). **This is now substantially
mitigated**: dispatched review subagents genuinely cannot call
`bash`/`edit`/`write` — those tools are not available to them at all, not
merely instructed against. See "Read-only enforcement" below for the full
technical explanation of the mechanism (a project-scoped agent override,
not just a prompt instruction).

What remains, and is much lower severity: a sufficiently adversarial diff
could still attempt to manipulate the reviewing LLM's *analysis or output* —
e.g. try to get it to under-report a real issue, or fabricate/inflate a
finding. The subagent can still reason and respond in natural language; it
just can no longer *act* (no code execution, no file mutation, no external
contact) — this closes the RCE-class risk while leaving a narrower,
output-integrity-only residual risk, tracked in `DEBT.md`.

**Findings are now posted as inline review comments on the diff, and that surface
has powers an issue comment does not.** GitHub renders a ` ```suggestion ` fence
inside a *review comment* as a **committable suggestion with a one-click "Commit
suggestion" button** — the same fence is inert in an issue comment. Since finding
text is LLM output over the (attacker-controlled) diff, an unhardened renderer
would have put attacker-chosen code one click from the PR branch. The renderer
therefore **defangs the `suggestion` info-string** in all finding-derived text
(ordinary code fences still render normally, because they are genuinely useful),
sizes the collapsed AI-prompt block's fence to its content so a message cannot
escape it, and sanitizes the `file`/`category` fields out of their code spans.
See ADR-006. This is enforced by `test/unit/review/comment-format.test.ts` and
recorded in `REGRESSION-CATALOG.md`.

One related attack vector **is** fully closed, natively by the CLI itself:
rule files (`.tgd-review/rules/*.md`) are loaded from the PR's **base**
branch via the VCS provider's API, never from the PR's own checkout — see
"Rule files are sourced from the base branch" below. Before that fix, a PR
could simply add its own rule file and get attacker-authored instructions
executed as a *trusted* subagent prompt with an attacker-chosen
provider/model; that specific hole is now closed, and closed the same way
whether you run this in the shipped GitHub Actions workflow, from your own
terminal, or (once built) from any other CI system `gh`/`glab` can
authenticate against.

**Additional defense-in-depth if you run this in CI** (worthwhile even now
that the tool-access risk is closed — the output-integrity residual risk
above, and ordinary operational hygiene, still benefit from these):

1. **Gate untrusted contributions before the workflow even triggers.** Do
   not run the shipped `pull_request` trigger unmodified on a repository
   that accepts first-time/fork/untrusted contributors without additional
   gating — e.g. require a maintainer-applied label (such as
   `safe-to-review`) as an additional `on.pull_request.types` condition or
   a manual approval step before the review job runs. GitHub also documents
   `pull_request_target` for exactly this class of risk (it runs with the
   base branch's workflow file and secrets, decoupled from the PR's own
   workflow changes) — but do **not** reach for it casually: `pull_request_target`
   is itself dangerous if misconfigured (e.g. if you then check out and
   execute the PR's own code with it, you reintroduce the same class of
   risk it was meant to prevent). If you use it, it needs the same level of
   care as the rule-file fix below: never check out and run PR-controlled
   code/config with `pull_request_target`'s elevated permissions.
2. **Run in an isolated, ephemeral CI environment with no persistent
   secrets beyond the PR-scoped token.** GitHub-hosted runners are
   ephemeral by default (a fresh VM per job) — keep it that way; don't add
   self-hosted runners with persistent state/credentials to this workflow
   without separately re-assessing this risk.
3. **Keep the `permissions:` block minimally scoped.** The shipped workflow
   already sets `pull-requests: write, contents: read` and nothing else —
   this is intentional, not an oversight, and should not be widened (e.g.
   no `contents: write`, no `actions: write`, no org-level secrets beyond
   the specific provider API keys the rules you actually use need).

## Setting up `tgd-review-agent` in CI

### Requirements

- **Node.js `>=22.19.0`** — see `package.json`'s `engines.node`. This matches
  the real installed `@earendil-works/pi-coding-agent` dependency's own
  `engines.node` requirement; the workflow below pins `setup-node` to this
  version.
- `gh` CLI, authenticated (in GitHub Actions this is automatic via
  `secrets.GITHUB_TOKEN`; locally, run `gh auth login` first).

### Install / build

```bash
npm ci
npm run build      # emits dist/cli.js and copies the vendored builtin rule
                    # to dist/rules/builtin/tgd-review.md
```

Run it directly with `node dist/cli.js review --pr <number>`, or install the
package so the `tgd-review-agent` bin is on your `PATH`.

### Wiring it into GitHub Actions

The example workflow at
[`.github/workflows/tgd-review.yml`](.github/workflows/tgd-review.yml) runs
the reviewer on every PR `opened`/`synchronize`/`reopened` event. Copy it into
a consuming repo's `.github/workflows/` directory (adjusting the checkout
target if `tgd-review-agent` isn't vendored into that repo directly) and add
the provider secrets described below.

The `review` command needs no special workflow-YAML wiring to source rule
files safely from the PR's base branch — that's now handled inside the CLI
itself (see "Rule files are sourced from the base branch" below). Do **not**
pass `--trust-local-rules` in this workflow; that flag reopens the exact
hole this design closes by reading `--rules-dir` off the PR's own checkout.

### CLI flags

The real flags, as parsed by `src/cli.ts`:

```
tgd-review-agent review \
  --pr <number>                  # required: PR number
  --vcs github|gitlab            # default: github (gitlab adapter is Phase 2, not yet implemented)
  --rules-dir <path>             # default: .tgd-review/rules — a REPO-RELATIVE path looked up on
                                  # the PR's BASE branch via the VCS provider's API (not a local
                                  # filesystem path), unless --trust-local-rules is also passed
  --disable-builtin-rule         # optional: skip the vendored tGD-review rule
  --advisor on|off               # default: on
  --model <provider>/<model>     # optional: the model that ORCHESTRATES the review (merges each
                                  # rule's findings). Each rule still runs on its OWN pinned model.
                                  # Default: the first rule whose model has working credentials on
                                  # this machine — NOT pi's ambient defaultModel, which this tool
                                  # has no relationship to and cannot verify. If nothing here has
                                  # credentials, pi picks its own available model. See "Which model
                                  # orchestrates?" below.
  --dry-run                      # post nothing: print the summary comment AND a preview of every
                                  # inline comment it would have posted (file:line + body)
  --trust-local-rules            # optional: read --rules-dir directly off the local filesystem
                                  # instead of fetching from the base branch — a developer
                                  # convenience for iterating on an uncommitted rule file, NOT a
                                  # security bypass to use in CI (see "Rule files are sourced from
                                  # the base branch" below)
```

Exit codes: `0` success (posted, or skipped because the head SHA was already
reviewed), `1` fatal (e.g. every rule failed to load), `2` partial (at least
one rule ran, but something also failed — the comment is still posted and
the failure is noted in it).

### What the review looks like

Findings are posted as **inline review comments, anchored to the line of the diff
they are about** — the model CodeRabbit and Cursor Bugbot use, because a finding
is most useful sitting next to the code, not in a list you have to cross-reference
by hand.

Each inline comment carries a metadata line, a scannable bold headline, the
reasoning, and a collapsed **🤖 Prompt for AI Agents** block — a self-contained,
copy-pasteable instruction that already names the file and line, so a coding agent
(or you) can act on it without re-deriving the context:

```
_🎯 correctness_ | _🔴 Blocking_ | _`terra-review`_

**The reaction toggle remains a check-then-act operation…**

Concurrent callers can observe the same state and take the same branch, so this
is not an atomic CAS and can lose a toggle...

<details><summary>🤖 Prompt for AI Agents</summary> ... </details>
```

A single **summary comment** is upserted alongside them with the counts, the
files reviewed, the rules that ran, and any rule that failed (and why). It also
carries the `<!-- tgd-review-agent:sha=... -->` marker, which is what makes the
bot idempotent per commit.

On a new commit the review runs again and posts fresh inline comments; the
previous commit's comments **remain** on the PR as history (the same behaviour
CodeRabbit has — there is no upsert for review comments, only for the summary).
If the head SHA hasn't changed, the run is skipped entirely, so the same comments
are never posted twice.

**A rule that fails says why.** If a rule's subagent can't run — most commonly
because the machine has no credentials for the provider that rule is pinned to —
the summary names it with an actionable reason
(``- tgd-review — no working credentials for provider `anthropic` on the machine
running the review``). The *raw* provider error goes to the CI logs, never into
the world-readable comment.

**Nothing is ever lost.** GitHub rejects an inline comment on a line that isn't
part of the diff — and rejects the *entire* review if even one is invalid. So a
finding is only anchored when the diff itself proves the line is addressable
(`src/review/diff-anchors.ts`). Anything else — a finding with no line number, a
line outside the changed hunks, a file this PR doesn't touch — is rendered in full
in the summary under **💬 Additional comments**. And if the inline post is
rejected outright, the run falls back to a summary containing *every* finding. A
finding is only ever relocated, never dropped.

### Which model orchestrates?

Every rule file is pinned to its own `provider`/`model` — that is the point of
the tool, and it is unchanged. But the **orchestrating** session (the one that
dispatches the rules as parallel subagents and merges their findings) needs a
model too.

It used to have none, so pi silently fell back to the machine's ambient
`defaultProvider`/`defaultModel` from `~/.pi/agent/settings.json`. That coupled
the tool to a global it has no relationship to and cannot verify: on a box whose
pi default could not resolve, the **entire review died** — even though every rule
declared a perfectly good model of its own
([#1](https://github.com/julianshen/tGDBot/issues/1)).

Now the orchestrator model is resolved explicitly. Candidates are tried in this
order, and **every one of them must have working credentials on the machine
running the review**:

1. `--model <provider>/<model>`, if you pass it.
2. pi's own `defaultProvider`/`defaultModel` from `settings.json` — so on a
   healthy machine the orchestrator keeps running on exactly the model it always
   did. Requiring credentials is what turns this from a hard binding into a
   preference.
3. each rule's own model, in rule order.
4. failing all that, pi's own auth-aware default.

The credential check is the load-bearing part. `ModelRegistry.find()` is a pure
name lookup with no auth check, and setting an explicit model *short-circuits*
pi's own auth-aware selection — so handing it an un-credentialed model is
strictly worse than handing it none: it guarantees a `No API key found` and
fails **every** rule. A rule pinned to `openai-codex` proves the rule *author's*
machine had that key, not that *this* one does. In CI, where typically only
`ANTHROPIC_API_KEY` is set, such a rule is simply skipped as an orchestrator
candidate (its own subagent still reports its own failure separately) and an
authenticated candidate is used instead — rather than failing the whole review.

A model id may carry a thinking suffix (`claude-opus-4-5:high`); it is stripped
before lookup, so it resolves the same way it does for the rule's own subagent.

Use `--dry-run` to test locally before wiring up CI — it runs the full
pipeline (fetch PR + diff via `gh`, load rules, dispatch, orchestrate) but
prints the would-be comment body to stdout instead of calling
`upsertComment`, so nothing is posted to the PR:

```bash
gh auth login   # if not already authenticated
node dist/cli.js review --pr 42 --dry-run
```

### Zero-config smoke test (AC-9.2)

Proves the "works with zero user configuration" claim: no `.tgd-review/rules/`
directory, only the vendored built-in `tgd-review` rule.

1. Clone the repo fresh and confirm there is no `.tgd-review/rules/`
   directory (nothing to author, nothing to configure).
2. `npm ci && npm run build`.
3. Export the provider API key your builtin rule's `provider`/`model` needs
   (the vendored rule uses `anthropic`/`claude-opus-4-5` — set
   `ANTHROPIC_API_KEY`) and make sure `gh auth login` / `GH_TOKEN` is set up.
4. Run `node dist/cli.js review --pr <a-real-open-PR-number> --dry-run`
   against a real repo/PR you have `gh` access to.
5. Confirm the printed comment body reflects the built-in `tgd-review`
   rule's review output — no custom rule files were loaded, yet a full
   review comment is produced end-to-end.
6. Optionally, re-run without `--dry-run` to confirm it actually
   posts/edits the PR comment (creates it the first time; a second run
   against the same unchanged head SHA is skipped instead, per the dedup
   behavior described above).

### Authoring a rule file

Rule files live under `.tgd-review/rules/*.md` (configurable via
`--rules-dir`) and supplement (not replace) the built-in `tgd-review` rule
unless `--disable-builtin-rule` is passed. Each file is Markdown with YAML
frontmatter, parsed by `src/rules/loader.ts` (`gray-matter`) into the
`RuleDefinition` shape defined in `src/rules/types.ts`:

```typescript
export interface RuleDefinition {
  name: string;
  provider: string;
  model: string;
  body: string;
  sourcePath: string;
}
```

`name`, `provider`, and `model` are all **required, non-empty strings** in
the frontmatter — a file missing any one of them is skipped (recorded as a
load error, surfaced in the run's log/comment) rather than failing the whole
run. Everything after the closing `---` becomes the rule's Markdown `body`,
which is sent verbatim as the dispatched subagent's task prompt (with a
fixed JSON-output contract appended automatically — you don't need to ask
for JSON yourself).

```markdown
---
name: security-review
provider: anthropic
model: claude-opus-4-5
---

Review this diff for security issues: injection, secret leakage, auth
bypass, unsafe deserialization. Report only findings you are highly
confident about.
```

`provider` should be one of the pi SDK's known provider ids (see "Provider
API key secrets" below for the full list, e.g. `anthropic`, `openai`,
`google`); `model` is that provider's model id. `provider`/`model` are
plain pass-through strings — nothing in `tgd-review-agent` validates them
against a fixed list, so any provider the underlying pi SDK can resolve
works, including custom/self-hosted providers you register yourself (see
"Custom model providers (e.g. NousResearch Hermes)" below).

### Rule files are sourced from the base branch, not the PR (security design decision)

This is enforced **inside the CLI itself** (see ADR-002 and its follow-up
CLI-native fix), not by any workflow-YAML ceremony. By default (no
`--trust-local-rules`), `review()` never reads `--rules-dir` off the local
filesystem at all — instead it:

1. Fetches the PR's `baseSha` (already resolved via `gh pr view` as part of
   `getPullRequest`).
2. Calls `vcsAdapter.getRuleFilesFromBase(baseSha, rulesDir)`, which lists
   and fetches `<rulesDir>/*.md` **as it exists on the base branch** via the
   VCS provider's own API — `gh api repos/{owner}/{repo}/contents/...` for
   `GitHubAdapter` — never via a local git checkout/worktree.
3. Writes the fetched files into a fresh, isolated temp directory and points
   `loadRules()` at that directory (cleaned up afterward).

`--rules-dir`'s default value (`.tgd-review/rules`) is therefore a
**repo-relative lookup key**, not a local filesystem path, in this default
mode — see "CLI flags" above.

This is deliberate, not an oversight. `dispatchRules` sends every rule
file's `body` verbatim as a **trusted** agent-instruction prompt, with an
attacker-chosen `provider`/`model` if the rule file itself is
attacker-controlled. Without this indirection, a PR author could add
`.tgd-review/rules/evil.md` to their own PR and have its contents executed
as a trusted instruction by a subagent with real tool access on the CI
runner — no prompt-injection cleverness required, just adding a file.
Sourcing rules from the base branch instead means:

- **A PR cannot introduce or modify a rule that affects its own review.**
  Rule changes only take effect once merged into the base branch.
- If the base branch has no `.tgd-review/rules/` directory at all,
  `getRuleFilesFromBase` returns zero files (a 404 from the Contents API is
  treated as "no rules," not an error) — same "directory doesn't exist"
  handling `loadRules()` already has for the local-filesystem case.
- Because this lives in the CLI (via the `VcsAdapter` abstraction), it works
  identically for the shipped GitHub Actions workflow, a developer running
  `tgd-review-agent review` from their own terminal against a real open PR,
  or (once a `GitLabAdapter` exists) any other CI system `gh`/`glab` can
  authenticate against — no bespoke `git worktree` step to remember, copy
  correctly, or accidentally "simplify" away.
- `--trust-local-rules` is the one deliberate escape hatch: it skips
  `getRuleFilesFromBase` and reverts to reading `--rules-dir` directly off
  the local filesystem (the pre-fix behavior). It exists for local
  rule-authoring iteration (testing an uncommitted rule file) — **never**
  pass it in a CI workflow that reviews untrusted PRs, since doing so
  reopens exactly the hole described above.

This closes the rule-file attack vector specifically. The PR *diff* itself
is still untrusted input sent to the dispatched subagent — but as of the
fix described in "Read-only enforcement" below, that subagent has no
`bash`/`edit`/`write` tool available to it at all, so untrusted diff content
can no longer cause real destructive action, only (at most) attempt to
mislead the subagent's own analysis/output. See "⚠️ Security
Considerations" at the top of this document and "Read-only enforcement"
below for the full picture.

### Provider API key secrets

Each dispatched rule runs as a pi SDK agent session; API keys are resolved
by the SDK's `AuthStorage`, which (absent a stored `auth.json`) falls back
to well-known environment variables per provider. Set whichever ones your
rule files' `provider` values need as **GitHub Actions secrets**, then pass
them through as `env:` on the workflow step that runs `tgd-review-agent`
(see `.github/workflows/tgd-review.yml`, which wires `ANTHROPIC_API_KEY` as
an example — add more `env:` entries for any other providers you use):

| Provider | Env var | `provider` id |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |

(Full list: `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`
— more providers are supported than shown here.) Set each as a repository
or organization secret (`Settings -> Secrets and variables -> Actions`),
then reference it as `${{ secrets.YOUR_KEY_NAME }}` in the workflow's `env:`
block, exactly like `GH_TOKEN`/`ANTHROPIC_API_KEY` in the example workflow.

### Custom model providers (e.g. NousResearch Hermes)

Open-weight model families like [NousResearch's Hermes](https://nousresearch.com/)
aren't one of the pi SDK's built-in providers (there's no `provider: hermes`
out of the box) — but nothing in `tgd-review-agent` restricts `provider`
values to a fixed list, either. As long as the pi SDK can resolve the
provider, a rule file can use it. Registering a new provider is a **user-side
pi SDK configuration step** (a `models.json` file), not a `tgd-review-agent`
code change — the same mechanism works for any custom or self-hosted model,
not just Hermes.

**1. Add the provider to `~/.pi/agent/models.json`** (created if it doesn't
exist; reloaded automatically, no restart needed). Hermes models are most
commonly reached through an OpenAI-compatible endpoint — pick whichever you
actually have access to:

Via [OpenRouter](https://openrouter.ai) (simplest if you already have an
OpenRouter key — it hosts several current Hermes releases):
```json
{
  "providers": {
    "hermes": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "$OPENROUTER_API_KEY",
      "models": [
        {
          "id": "nousresearch/hermes-4-405b",
          "name": "Hermes 4 405B",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Via a self-hosted server (vLLM, Ollama, LM Studio running a Hermes GGUF/weights
export) — only `id` is required per model for local servers:
```json
{
  "providers": {
    "hermes": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        { "id": "hermes4:70b" }
      ]
    }
  }
}
```

(See `node_modules/@earendil-works/pi-coding-agent/docs/models.md` for the
full schema — `compat` flags, `thinkingLevelMap`, cost tiers, etc. Any
provider name works, not just `hermes`; pick something that matches the
`provider` field you'll write in your rule files.)

**2. Create a custom rule file that uses it.** Rule files live at
`.tgd-review/rules/*.md` in your repo (the default `--rules-dir`; see
"Authoring a rule file" above for the full frontmatter reference). Create
one — the filename doesn't matter, only the `name` in the frontmatter does —
referencing your new provider exactly like a built-in one:

`.tgd-review/rules/hermes-readability-review.md`:
```markdown
---
name: hermes-readability-review
provider: hermes
model: nousresearch/hermes-4-405b
---

Review this diff for readability and maintainability only — do not repeat
findings that a security or correctness rule would already cover.

Focus on:
- Names that don't convey intent (vague `data`/`temp`/`result` without
  context, misleading names, inconsistent casing/conventions).
- Control flow that's harder to follow than it needs to be (deep nesting,
  long functions doing multiple unrelated things, clever one-liners that
  trade clarity for brevity).
- Duplicated logic that should be extracted, or premature abstraction that
  adds indirection without earning it.
- Comments that restate the code instead of explaining non-obvious *why*,
  or comments that are now stale/incorrect relative to the code they
  describe.

Report only findings you're genuinely confident improve readability — skip
purely stylistic nitpicks (formatting, quote style) that a linter would
already catch.
```

Commit the file to your repo (on the **base branch** — see "Rule files are
sourced from the base branch" below for why a PR can't add or edit this file
to affect its own review) and it takes effect on the next PR review
automatically. It runs *alongside* the built-in `tgd-review` rule and any
other rule files in the directory — `--disable-builtin-rule` only affects
the vendored default, not your own rules, and there's no limit on how many
rule files you add (each becomes its own dispatched subagent task; see
"Custom model providers" above for wiring the provider, and "Provider API
key secrets" for the general secrets pattern this rule's `hermes` provider
also follows via `OPENROUTER_API_KEY`).

**3. In CI**, `~/.pi/agent/models.json` needs to exist on the runner *before*
`tgd-review-agent review` runs (GitHub Actions runners start with a clean
`$HOME` every job — nothing persists from a manual local setup). Add a step
before the review step that writes the file, sourcing the API key from a
secret rather than committing it:
```yaml
- name: Configure custom model providers
  run: |
    mkdir -p ~/.pi/agent
    cat > ~/.pi/agent/models.json <<'EOF'
    {
      "providers": {
        "hermes": {
          "baseUrl": "https://openrouter.ai/api/v1",
          "api": "openai-completions",
          "apiKey": "$OPENROUTER_API_KEY",
          "models": [
            { "id": "nousresearch/hermes-4-405b", "reasoning": true, "contextWindow": 131072, "maxTokens": 8192 }
          ]
        }
      }
    }
    EOF
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```
The `apiKey` value in the JSON is the literal string `$OPENROUTER_API_KEY`
(pi's own env-var interpolation syntax, resolved when pi reads the file) —
it does not need the `env:` block's value substituted into the JSON itself;
pi reads the environment variable at request time. Add
`OPENROUTER_API_KEY` (or whichever provider you're using) as a repository
secret the same way as `ANTHROPIC_API_KEY` above.

### Read-only enforcement

See also: "⚠️ Security Considerations" at the top of this document for the
prominent version of this section, and
`decisions/ADR-003-restrict-dispatched-subagent-tools-via-project-scoped-agent-override.md`
in the sibling `tGDBot-tGD` planning directory for the full design record
(context, decision, alternatives considered).

Dispatched review subagents are instructed, via their prompt, not to edit
files, write files, or run mutating commands — and, as of this fix, that
instruction is backed by a genuine tool restriction, not just prompt
wording. Every dispatched task still references `agent: "reviewer"`, but
`dispatch.ts` no longer lets that resolve to `pi-subagents`' *bundled*
`reviewer` agent (which ships with `bash`/`edit`/`write`/`intercom`).
Instead, each dispatch run:

1. Creates a fresh, isolated temp directory via `os.tmpdir()` +
   `fs.mkdtemp` — **never** the target repo's own working directory, so the
   repo being reviewed is never touched or mutated by this mechanism.
2. Seeds it with `<tempDir>/.pi/agents/reviewer.md`: a vendored agent
   definition (`src/review/builtin-agents/reviewer.md`) whose `tools` list
   is `read, grep, find, ls` only.
3. Passes that temp directory as the orchestrating session's `cwd`.

`pi-subagents`' own documented agent discovery priority is Builtin <
Installed package < User < Project, and "if both `.agents/` and the project
config agents directory define the same parsed runtime agent name, the
project config directory wins." Because the temp directory's `.pi/agents/`
now defines a `reviewer` agent, it wins project-scope discovery over the
bundled builtin `reviewer` for every dispatched task in that session — the
dispatched subagent genuinely has no `bash`/`edit`/`write`/`intercom` tool
it could call, regardless of what the diff content tries to instruct it to
do. The temp directory is removed in a `finally` block after each dispatch
run completes (success or failure), so nothing leaks across CI runs.

Rule files are no longer part of this risk as of the base-branch fix above
(rule file *content* is now always trusted, since it's sourced from the
base branch, not the PR). The PR **diff** itself is still attacker-controlled
input embedded verbatim in every dispatched subagent's prompt — that can't
be avoided without the tool losing its purpose (reviewing the diff) — but
the *consequence* of a prompt-injection attempt in that diff is now bounded:
the subagent can at most try to skew its own analysis or output (e.g.
under-report a real issue), since it has no tool available that could take
a real destructive action. The operational mitigations in "⚠️ Security
Considerations" above (contribution gating, ephemeral/isolated CI,
minimally-scoped `permissions:`) remain worthwhile defense-in-depth, but are
no longer the *only* thing standing between an adversarial diff and real
tool execution.
