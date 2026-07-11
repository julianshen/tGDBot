# tGDBot

A GitHub/GitLab code review CLI built on the pi SDK, driven by the tGD-review
skill, with per-rule provider/model configuration and subagent-orchestrated
review workflows.

See `tgd-review-agent/` docs in the sibling `tGDBot-tGD` planning directory
(PRD.md, SPEC.md, TASKS.md) for the full spec and task breakdown.

## ⚠️ Security Considerations

**Read this before wiring `tgd-review-agent` into CI on any repository that
accepts contributions you don't fully trust.**

Every dispatched review subagent is a real pi SDK agent session with
`bash`/`edit`/`write` tool access on the CI runner, and its task prompt
includes the PR's diff **verbatim**. A malicious PR's diff content — file
contents, filenames, even commit messages if a rule quotes them — could
attempt to manipulate the reviewing LLM into calling those tools for real
(a classic prompt-injection attack against an agent with real capabilities).
**This risk is inherent to the current design and is not fully closed by
this codebase alone.** See "Read-only enforcement caveat" below for the
full technical explanation of why it can't be closed purely with a prompt
instruction.

One related attack vector **is** fully closed, at the workflow level: rule
files (`.tgd-review/rules/*.md`) are loaded from the PR's **base** branch,
never from the PR's own checkout — see "Rule files are sourced from the
base branch" below. Before that fix, a PR could simply add its own rule
file and get attacker-authored instructions executed as a *trusted*
subagent prompt with an attacker-chosen provider/model; that specific hole
is now closed. The PR diff content itself remains untrusted input by
necessity (the whole point of the tool is to review it), which is why the
warning above still stands.

**Concrete mitigations if you run this in CI:**

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

Note the workflow's `git worktree add`/`--rules-dir` steps before the
`review` command — those exist to source rule files from the PR's base
branch rather than the PR's own checkout, and are load-bearing for the
security fix described in "Rule files are sourced from the base branch"
below. Preserve them if you adapt the workflow.

### CLI flags

The real flags, as parsed by `src/cli.ts`:

```
tgd-review-agent review \
  --pr <number>                  # required: PR number
  --vcs github|gitlab            # default: github (gitlab adapter is Phase 2, not yet implemented)
  --rules-dir <path>             # default: .tgd-review/rules
  --disable-builtin-rule         # optional: skip the vendored tGD-review rule
  --advisor on|off               # default: on
  --dry-run                      # print the synthesized comment body to stdout instead of posting it
```

Exit codes: `0` success (posted, or skipped because the head SHA was already
reviewed), `1` fatal (e.g. every rule failed to load), `2` partial (at least
one rule ran, but something also failed — the comment is still posted and
the failure is noted in it).

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
`google`); `model` is that provider's model id.

### Rule files are sourced from the base branch, not the PR (security design decision)

`loadRules()` itself just reads whatever `--rules-dir` it's given — it has
no opinion about which commit that directory belongs to. The **workflow**
is what enforces the trust boundary: in
[`.github/workflows/tgd-review.yml`](.github/workflows/tgd-review.yml), a
dedicated step checks out `.tgd-review/rules/` from
`github.event.pull_request.base.sha` (the PR's *base* branch) into a
separate `git worktree`, and `--rules-dir` is pointed at that checkout —
**not** at the PR's own `.tgd-review/rules/`, even though `actions/checkout@v4`
in the same job also checks out the PR's merge ref (needed for building the
CLI and reading the diff).

This is deliberate, not an oversight. `dispatchRules` sends every rule
file's `body` verbatim as a **trusted** agent-instruction prompt, with an
attacker-chosen `provider`/`model` if the rule file itself is
attacker-controlled. Without this indirection, a PR author could add
`.tgd-review/rules/evil.md` to their own PR and have its contents executed
as a trusted instruction by a subagent with real `bash`/`edit`/`write` tool
access on the CI runner — no prompt-injection cleverness required, just
adding a file. Sourcing rules from the base branch instead means:

- **A PR cannot introduce or modify a rule that affects its own review.**
  Rule changes only take effect once merged into the base branch.
- If the base branch has no `.tgd-review/rules/` directory at all, that's
  just zero user rules (same "directory doesn't exist" handling
  `loadRules()` already has) — not an error.
- If you fork this workflow into your own repo, **keep this indirection**.
  The inline comment above the fetch step in `tgd-review.yml` says so too:
  don't "simplify" it back to the CLI's default `--rules-dir`, which would
  resolve against the PR's own (attacker-controlled) checkout and reopen
  this hole.

This closes the rule-file attack vector specifically. It does **not**
close the separate, inherent risk that the PR *diff* itself is untrusted
input sent to a tool-capable subagent — see "⚠️ Security Considerations"
at the top of this document and "Read-only enforcement caveat" below for
that (unclosed, must-mitigate-operationally) risk.

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

### Read-only enforcement caveat (v1 limitation)

See also: "⚠️ Security Considerations" at the top of this document for the
prominent version of this warning plus concrete CI mitigations. This
section is the fuller technical explanation of *why* it can't be closed
purely in this codebase.

Dispatched review subagents are instructed, via their prompt, not to edit
files, write files, or run mutating commands — but this is **not** a hard
sandboxed guarantee in v1. The bundled `pi-subagents` `reviewer` agent has
`bash`/`edit`/`write` tools available in its default tool list, and
`pi-subagents`' current `TaskItem`/`ParallelTaskSchema` expose no per-task
tool-allowlist override to strip them. In other words: the review is
*read-only by convention and prompt instruction*, not by sandbox
enforcement.

This is an inherent limitation of the current `pi-subagents` extension API,
not something this codebase can fully close on its own. Rule files are no
longer part of this risk as of the base-branch fix above (rule file
*content* is now always trusted, since it's sourced from the base branch,
not the PR) — but the PR **diff** itself is still attacker-controlled input
embedded verbatim in every dispatched subagent's prompt, and that can't be
avoided without the tool losing its purpose (reviewing the diff). Do not
run this tool against diffs where a prompt-injection attempt getting a
subagent to call `bash`/`edit`/`write` would be a real risk without the
operational mitigations described in "⚠️ Security Considerations" above
(contribution gating, ephemeral/isolated CI, minimally-scoped
`permissions:`) — that risk is not mitigated by this codebase alone.
