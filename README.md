# tGDBot

A GitHub/GitLab code review CLI built on the pi SDK, driven by the tGD-review
skill, with per-rule provider/model configuration and subagent-orchestrated
review workflows.

See `tgd-review-agent/` docs in the sibling `tGDBot-tGD` planning directory
(PRD.md, SPEC.md, TASKS.md) for the full spec and task breakdown.

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

Dispatched review subagents are instructed, via their prompt, not to edit
files, write files, or run mutating commands — but this is **not** a hard
sandboxed guarantee in v1. The bundled `pi-subagents` `reviewer` agent has
`bash`/`edit`/`write` tools available in its default tool list, and
`pi-subagents`' current `TaskItem`/`ParallelTaskSchema` expose no per-task
tool-allowlist override to strip them. In other words: the review is
*read-only by convention and prompt instruction*, not by sandbox
enforcement. Do not run this tool against untrusted rule files or diffs
where a prompt-injection attempt getting a subagent to call `bash`/`edit`/
`write` would be a real risk — that risk is not mitigated in this version.
