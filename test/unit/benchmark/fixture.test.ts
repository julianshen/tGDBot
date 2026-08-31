// Issue #113: fixtures are the ground truth every number is measured against,
// so loading them is strict. A typo that silently dropped an expectation would
// make the benchmark report an improvement.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixture, loadFixtures } from "../../../src/benchmark/fixture.js";

async function fixtureDir(manifest: unknown, extras: {
  readonly diff?: string;
  readonly recorded?: unknown;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-benchmark-"));
  const dir = path.join(root, "case");
  await mkdir(dir);
  await writeFile(path.join(dir, "fixture.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(dir, "diff.patch"), extras.diff ?? "diff --git a/x b/x\n", "utf8");
  if (extras.recorded !== undefined) {
    await writeFile(path.join(dir, "recorded.json"), JSON.stringify(extras.recorded), "utf8");
  }
  return root;
}

const PR = {
  id: "1", title: "t", description: "d",
  baseSha: "b".repeat(40), headSha: "h".repeat(40),
  url: "https://example.invalid/pull/1",
};

function manifest(expected: unknown[]): unknown {
  return { description: "a case", pr: PR, expected };
}

describe("loadFixture", () => {
  it("loads a well-formed fixture", async () => {
    const root = await fixtureDir(manifest([{ id: "a", file: "src/a.ts", lines: [1, 4] }]));
    const fixture = await loadFixture(path.join(root, "case"), "case");
    expect(fixture.expected[0]).toMatchObject({ id: "a", file: "src/a.ts", lines: [1, 4] });
  });

  it("treats an absent recording as real-mode-only rather than as an empty one", async () => {
    // An absent measurement is not a measurement of zero. The runner reports
    // these as skipped; scoring them as "found nothing" would drag the totals.
    const root = await fixtureDir(manifest([]));
    expect((await loadFixture(path.join(root, "case"), "case")).recordedFindings).toBeUndefined();
  });

  it("rejects duplicate expectation ids", async () => {
    // Ids name rows in a baseline diff; two rows with one name is unreadable.
    const root = await fixtureDir(manifest([
      { id: "a", file: "src/a.ts" },
      { id: "a", file: "src/b.ts" },
    ]));
    await expect(loadFixture(path.join(root, "case"), "case")).rejects.toThrow(/duplicate expectation id/);
  });

  it("rejects an inverted line range", async () => {
    const root = await fixtureDir(manifest([{ id: "a", file: "src/a.ts", lines: [9, 3] }]));
    await expect(loadFixture(path.join(root, "case"), "case")).rejects.toThrow(/inverted/);
  });

  it("rejects a message pattern that is not a valid regular expression", async () => {
    // Caught at load, so a bad pattern fails once rather than on every run.
    const root = await fixtureDir(manifest([{ id: "a", file: "src/a.ts", messagePattern: "user(" }]));
    await expect(loadFixture(path.join(root, "case"), "case")).rejects.toThrow(/valid regular expression/);
  });

  it("rejects an unknown severity instead of ignoring it", async () => {
    const root = await fixtureDir(manifest([{ id: "a", file: "src/a.ts", severity: "critical" }]));
    await expect(loadFixture(path.join(root, "case"), "case")).rejects.toThrow(/severity is invalid/);
  });

  it("rejects a malformed recording rather than treating it as absent", async () => {
    // Silently reading corrupt ground truth as "no recording" would turn a
    // broken fixture into a quietly shrinking benchmark.
    const root = await fixtureDir(manifest([]), { recorded: { rulesRun: ["r"] } });
    await expect(loadFixture(path.join(root, "case"), "case")).rejects.toThrow(/recorded.findings/);
  });
});

describe("loadFixtures", () => {
  it("returns fixtures in a stable order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tgd-benchmark-"));
    for (const name of ["zebra", "alpha"]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "fixture.json"), JSON.stringify(manifest([])), "utf8");
      await writeFile(path.join(root, name, "diff.patch"), "diff --git a/x b/x\n", "utf8");
    }
    expect((await loadFixtures(root)).map((fixture) => fixture.name)).toEqual(["alpha", "zebra"]);
  });
});
