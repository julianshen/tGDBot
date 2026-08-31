// Issue #113: `npm run benchmark`.
//
// Recorded mode is the default and spends nothing — no network, no model — so
// the common case is safe to run on any change. Real mode is opt-in and costs
// money, which is why it is a flag rather than a fallback.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadFixtures, FIXTURE_ROOT } from "./fixture.js";
import { diffBaselines, formatReport, toBaseline, type Baseline } from "./report.js";
import { runFixture, type BenchmarkMode } from "./run.js";
import type { FixtureRunResult, RunReport } from "./types.js";

const BASELINE_PATH = "test/benchmark/baseline.json";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
/** A baseline difference. Distinct from failure: a diff may be the point. */
const EXIT_DIFF = 3;

interface Options {
  readonly mode: BenchmarkMode;
  readonly model?: string;
  readonly only?: string;
  /** Overwrite the committed baseline with this run. */
  readonly update: boolean;
  /** Exit non-zero when the run differs from the baseline. */
  readonly check: boolean;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`benchmark: ${(error as Error).message}`);
    return EXIT_FAILED;
  }

  const root = path.resolve(process.cwd(), FIXTURE_ROOT);
  const fixtures = (await loadFixtures(root))
    .filter((fixture) => options.only === undefined || fixture.name === options.only);
  if (fixtures.length === 0) {
    console.error(`benchmark: no fixtures matched under ${FIXTURE_ROOT}`);
    return EXIT_FAILED;
  }

  const results: FixtureRunResult[] = [];
  const skipped: { fixture: string; reason: string }[] = [];
  for (const fixture of fixtures) {
    // A fixture with no recording cannot be replayed. Reported as skipped
    // rather than run to an empty result, which would score as "found
    // nothing" and quietly drag the totals down.
    if (options.mode === "recorded" && fixture.recordedFindings === undefined) {
      skipped.push({ fixture: fixture.name, reason: "no recorded.json; real mode only" });
      continue;
    }
    try {
      results.push(await runFixture(fixture, options.mode, options.model));
    } catch (error) {
      // One broken fixture must not take the suite down, and must not be
      // mistaken for a fixture that ran and found nothing.
      skipped.push({ fixture: fixture.name, reason: `run failed: ${(error as Error).message}` });
    }
  }

  const report: RunReport = {
    mode: options.mode,
    generatedAt: new Date().toISOString(),
    results,
    skipped,
  };
  console.log(formatReport(report));

  if (options.mode === "real") {
    // A real run is not reproducible, so it never becomes the baseline. It is
    // for looking at, and for deciding whether a recording needs refreshing.
    if (options.update || options.check) {
      console.error("benchmark: --update and --check apply to recorded mode only");
      return EXIT_FAILED;
    }
    return skipped.length > 0 ? EXIT_FAILED : EXIT_OK;
  }

  const baseline = toBaseline(results);
  if (options.update) {
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log(`\nbaseline written to ${BASELINE_PATH}`);
    return EXIT_OK;
  }

  const previous = await readBaseline();
  if (previous === undefined) {
    console.log(`\nno committed baseline at ${BASELINE_PATH}; run with --update to create one`);
    return options.check ? EXIT_FAILED : EXIT_OK;
  }

  const deltas = diffBaselines(previous, baseline);
  if (deltas.length === 0) {
    console.log("\nno change against the committed baseline");
    return EXIT_OK;
  }
  console.log(`\n${deltas.length} change(s) against ${BASELINE_PATH}:`);
  for (const delta of deltas) {
    console.log(`  ${delta.fixture} ${delta.metric}: ${JSON.stringify(delta.before)} -> ${JSON.stringify(delta.after)}`);
  }
  return options.check ? EXIT_DIFF : EXIT_OK;
}

async function readBaseline(): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseArgs(argv: readonly string[]): Options {
  let mode: BenchmarkMode = "recorded";
  let model: string | undefined;
  let only: string | undefined;
  let update = false;
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--mode": {
        const raw = value();
        if (raw !== "recorded" && raw !== "real") throw new Error(`--mode must be recorded or real`);
        mode = raw;
        break;
      }
      case "--model": model = value(); break;
      case "--only": only = value(); break;
      case "--update": update = true; break;
      case "--check": check = true; break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }

  if (update && check) throw new Error("--update and --check are mutually exclusive");
  if (mode === "recorded" && model !== undefined) {
    // Silently ignoring it would let someone believe they had measured a model
    // when they had replayed a recording.
    throw new Error("--model applies to real mode only");
  }
  return { mode, ...(model === undefined ? {} : { model }), ...(only === undefined ? {} : { only }), update, check };
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`benchmark: ${(error as Error).message}`);
      process.exitCode = EXIT_FAILED;
    },
  );
}
