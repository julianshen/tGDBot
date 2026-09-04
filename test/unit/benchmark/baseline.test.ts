// Issue #125: the committed baseline must match a fresh recorded run.
//
// `npm run benchmark -- --check` already answers this, and nothing ran it. The
// baseline went stale the moment a prompt change merged, and a stale baseline
// is worse than none: every later run reports the same known rows, a real
// regression arrives buried in them, and the natural response is to stop
// reading the diff — which is exactly the failure `test/benchmark/README.md`
// warns about.
//
// So the check lives in the ordinary suite, where a prompt change trips over
// it immediately. Recorded mode spends nothing and the whole thing is about a
// second, which is the only reason this belongs in `npm test` at all.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtures } from "../../../src/benchmark/fixture.js";
import { diffBaselines, toBaseline, type Baseline } from "../../../src/benchmark/report.js";
import { runFixture } from "../../../src/benchmark/run.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureRoot = path.join(repoRoot, "test/benchmark/fixtures");
const baselinePath = path.join(repoRoot, "test/benchmark/baseline.json");

describe("committed benchmark baseline", () => {
  it("matches a fresh recorded run", async () => {
    const committed = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
    const fixtures = await loadFixtures(fixtureRoot);

    const results = [];
    for (const fixture of fixtures) {
      // A fixture with no recording has no committed row to compare, and the
      // runner reports it skipped rather than scoring it as "found nothing".
      if (fixture.recordedFindings === undefined) continue;
      results.push(await runFixture(fixture, "recorded", undefined));
    }

    const deltas = diffBaselines(committed, toBaseline(results));
    expect(
      deltas.map((delta) => `${delta.fixture} ${delta.metric}: ` +
        `${JSON.stringify(delta.before)} -> ${JSON.stringify(delta.after)}`),
      "the committed baseline is stale — run `npm run benchmark -- --update` and " +
        "say in the commit message WHICH change moved it",
    ).toEqual([]);
  }, 60_000);
});
