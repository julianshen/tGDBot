# Review benchmark

Issue #113. A fixed set of pull requests, what a good review of each would say,
and a committed baseline — so a change to a prompt, a rule, or the dispatch
path can be argued from numbers instead of from intuition.

```bash
npm run benchmark                 # recorded mode: no network, no model, no spend
npm run benchmark -- --check      # exit 3 if the run differs from the baseline
npm run benchmark -- --update     # accept this run as the new baseline
npm run benchmark -- --only unguarded-dereference   # report one fixture; cannot --update/--check
npm run benchmark -- --mode real --model anthropic/claude-opus-4-5
```

## What recorded mode does and does not measure

**Read this before quoting a number from it.**

Recorded mode replays a committed model output instead of calling a model. So
its precision and recall are a property of **the recording**, not of the
reviewer. They do not tell you whether tGDBot is good at reviewing code.

What they do tell you is whether the **deterministic pipeline** still does what
it did: anchoring, clustering, dedup, suppression, severity handling and
rendering all run for real. If a change to `orchestrate` drops a finding, or a
change to anchoring pushes one into the summary, the numbers move and `--check`
fails. `dispatchChars` moves whenever a prompt or a rule changes, which is the
one cost signal available without spending anything.

Real mode calls a model and measures the reviewer. It is not reproducible, so
it never becomes a baseline — `--update` and `--check` refuse it.

The recordings currently committed were **hand-authored** to exercise the
pipeline, not captured from a model. Replacing one with real output from
`--mode real` makes that fixture's quality numbers meaningful; until then, treat
them as fixture design rather than as measurement.

## Reading a diff

`--check` prints one line per changed metric:

```text
3 change(s) against test/benchmark/baseline.json:
  unguarded-dereference falseNegatives: 0 -> 1
  unguarded-dereference missed: [] -> ["deref-missing-guard"]
  unguarded-dereference dispatchChars: 17945 -> 17997
```

- `missed` names the **expectation id** that stopped being found, so you can go
  straight to it in `fixture.json`.
- `dispatchChars` moving on every fixture at once is a prompt or rule change.
  Moving on one is that fixture's diff or context changing.
- `anchoredInline` dropping while `findingsCount` holds means findings stopped
  being placeable and fell into the summary — a real regression in what a
  reader sees, and invisible to precision and recall.
- `renderedChars` moving while `findingTextChars` holds is a **rendering**
  change: the findings are the same, the published bytes are not. Only this
  number catches a formatter that started dropping content. It is measured
  from the dry-run preview the CLI actually prints — the review digest, every
  inline body, and the composed summary with its signature and marker — rather
  than reproduced here, so it cannot drift from what would be published.
- A fixture appearing as `present -> absent` means it stopped running. That is
  never an improvement, even though the failing rows disappear with it.

`n/a` is not `0%`. Precision is undefined when a run produced no findings, and
recall is undefined when a fixture asserts none; reporting zero there would
read as "got everything wrong" about a run that said nothing.

Exit codes: `0` clean, `1` failed, `3` differs from the baseline (`--check`).

## Adding a fixture

Create `test/benchmark/fixtures/<name>/`:

**`diff.patch`** — a unified diff. Line numbers matter: an expectation's range
is on the **head** side, and a finding only anchors inline if its line is one
this diff makes commentable.

**`fixture.json`**

```json
{
  "description": "One line on why this fixture exists.",
  "pr": {
    "id": "1",
    "title": "Add displayName helper",
    "description": "Body text. Fixtures that test intent handling live here.",
    "baseSha": "bbbb…", "headSha": "hhhh…",
    "url": "https://github.com/benchmark/fixture/pull/1"
  },
  "expected": [
    {
      "id": "deref-missing-guard",
      "file": "src/session.js",
      "lines": [15, 17],
      "messagePattern": "undefined|absent|missing|guard",
      "severity": "blocking"
    }
  ]
}
```

`expected` is a list of **matchers**, not copies of findings — pinning exact
prose would make every wording change a regression and train you to ignore the
diff. A finding matches when the file agrees, its line overlaps `lines`, and
the message matches `messagePattern`.

At least one of `lines` or `messagePattern` is **required**, and the loader
refuses a fixture without one. A matcher naming only a file matches any finding
in that file, so an unrelated finding would count as the defect and inflate both
precision and recall.

An empty `expected` is a legitimate fixture: a change the reviewer should stay
quiet about. Its only meaningful number is the false-positive count.

**`recorded.json`** (optional) — `{"rulesRun": [...], "findings": [...]}`. The
`findings` are `Finding` objects as the dispatcher would return them, and they
are loaded through the **production parser**, so a recording cannot express a
finding the reviewer could never have produced. Without this file the fixture is
real-mode only and recorded runs report it as skipped.

**`baseFiles` / `headFiles`** (optional, in `fixture.json`) — path-to-content
maps the review may read at each revision. Needed whenever the diff touches a
manifest: dependency extraction reads it at both revisions, and without the
content it reports the manifest unreadable and dispatches a degraded pack
instead of the parsed changes. `dependency-major-bump` shows the shape.

Then `npm run benchmark -- --update` and commit `baseline.json` with the
fixture.

## Keeping the baseline honest

`test/unit/benchmark/baseline.test.ts` runs this comparison as part of the
ordinary suite, so a change that moves a number fails `npm test` immediately
rather than waiting for someone to remember `--check`.

**If it fails, do not reach for `--update` first.** The failure is the
measurement. Read which metric moved and decide whether you meant to move it:

- `dispatchChars` on **every** fixture by the **same** amount is shared prompt
  text — the builtin rule, or the contract in `dispatch-prompt.ts`. Multiply
  the per-rule delta by the number of rules a fixture runs to confirm.
- `dispatchChars` on **one** fixture is that fixture's own diff or context.
- anything under `quality`, `findingsCount` or `anchoredInline` is the
  pipeline behaving differently, which is rarely what a prompt change intends.

Then run `--update` and say in the commit message **which** change moved it.
A baseline refreshed without that sentence records a number nobody has
examined.

This went wrong once already (#125): the benchmark landed with a baseline
recorded against an older `main`, six pull requests merged while it was open,
and the numbers were stale from the moment it merged.

## What the fixtures cover

| Fixture | Asserts |
|---|---|
| `unguarded-dereference` | a real defect is found, alongside a nit that costs precision |
| `explained-behavior-change` | silence, when the description explains the change |
| `step-one-of-three` | silence, when the description says the rest is coming |
| `dependency-major-bump` | a breaking bump is reported, a safe one is not |
| `injected-instruction-body` | an instruction-shaped body does not suppress a real finding |
| `suppressed-findings` | `addressed` and `needs-clarification` findings are scored as the reader sees them: not at all |

`dependency-major-bump` and `injected-instruction-body` are worth real-mode
runs specifically: whether a model reads a manifest correctly, and whether it
obeys an injected instruction, are properties of the model that no recording
can show.

## What is scored

The **published** finding set — what `orchestrate` returns, not what the
dispatcher produced. Orchestration drops `addressed` and `needs-clarification`
findings and collapses duplicates into one per root cause, so scoring its input
would count findings nobody receives and would leave the suppression and dedup
paths unmeasured. `suppressed-findings` exists to pin this: its recording has
three findings and one reaches a reader.

## Whole-suite invariants

The baseline covers the suite, so two combinations are refused rather than
half-honoured:

- `--only` with `--update` or `--check`. A filtered run written as the baseline
  deletes every unselected row; compared against one it reports them all as
  vanished.
- `--update` after any fixture **failed** to run. That would bless a partial
  measurement and delete the failing fixture's row. A fixture that is merely
  real-mode-only is a different case: it has no recorded row to lose, and does
  not block an update.

A review that exits non-zero — a missing API key, an unloadable rule — fails its
fixture rather than scoring as "found nothing". Infrastructure failures must not
be readable as model misses.

## Pinned rules

Fixtures run against `test/benchmark/rules/`, not the repository's
`.review/rules` — a baseline that moved when someone edited their local rules
would compare two different reviewers and call the difference a regression. The
builtin rule stays enabled, because it ships with the product and a change to
it is exactly what this benchmark exists to measure.
