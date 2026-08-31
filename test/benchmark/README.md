# Review benchmark

Issue #113. A fixed set of pull requests, what a good review of each would say,
and a committed baseline — so a change to a prompt, a rule, or the dispatch
path can be argued from numbers instead of from intuition.

```bash
npm run benchmark                 # recorded mode: no network, no model, no spend
npm run benchmark -- --check      # exit 3 if the run differs from the baseline
npm run benchmark -- --update     # accept this run as the new baseline
npm run benchmark -- --only unguarded-dereference
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

```
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
the message matches `messagePattern`. Only `id` and `file` are required, but a
matcher with neither `lines` nor `messagePattern` rewards a reviewer for saying
anything at all about the right file.

An empty `expected` is a legitimate fixture: a change the reviewer should stay
quiet about. Its only meaningful number is the false-positive count.

**`recorded.json`** (optional) — `{"rulesRun": [...], "findings": [...]}`. The
`findings` are `Finding` objects as the dispatcher would return them. Without
this file the fixture is real-mode only and recorded runs report it as skipped.

Then `npm run benchmark -- --update` and commit `baseline.json` with the
fixture.

## What the fixtures cover

| Fixture | Asserts |
|---|---|
| `unguarded-dereference` | a real defect is found, alongside a nit that costs precision |
| `explained-behavior-change` | silence, when the description explains the change |
| `step-one-of-three` | silence, when the description says the rest is coming |
| `dependency-major-bump` | a breaking bump is reported, a safe one is not |
| `injected-instruction-body` | an instruction-shaped body does not suppress a real finding |

The last two are worth real-mode runs specifically: whether a model obeys an
injected instruction, and whether it reads a manifest correctly, are properties
of the model that a recording cannot show.

## Pinned rules

Fixtures run against `test/benchmark/rules/`, not the repository's
`.review/rules` — a baseline that moved when someone edited their local rules
would compare two different reviewers and call the difference a regression. The
builtin rule stays enabled, because it ships with the product and a change to
it is exactly what this benchmark exists to measure.
