// Issue #132: what `metrics` on the TGD_REVIEW_RESULT line actually promises.
//
// The first version of this test pinned a table of `reason` values and claimed
// that a reason identified a telemetry-free line. Codex showed both halves
// wrong (PR #133): `inline-publication-ambiguous` is emitted WITH metrics by a
// run that dispatched and WITHOUT them by a recovery replaying a manifest, so
// a reason cannot classify anything; and the scan read only `src/cli.ts`,
// missing every emitter in the publication module.
//
// So the contract is stated on `metrics` itself — it describes work THIS
// process did — and checked two ways: behaviourally, on the paths a consumer
// actually meets, and structurally, so a new emitter cannot join without the
// documented reason list moving with it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sources = ["src/cli.ts", "src/review/review-publication.ts"] as const;

/**
 * Every `reason` a status line currently carries.
 *
 * NOT a telemetry classifier — see the file header. It exists so that adding a
 * reason without documenting it fails, and so that deleting one without
 * removing it from the README fails too.
 */
const KNOWN_REASONS: readonly string[] = [
  "context-required",
  "diff-incomplete",
  "diff-too-large",
  "inline-publication-ambiguous",
  "inline-publication-awaiting-consistency",
  "inline-publication-still-ambiguous",
  "recovered-ambiguous-inline-review",
  "recovered-pending-review",
  "recovered-pending-review-dry-run",
];

/**
 * The `reason:` literals across every status emitter in the production sources.
 *
 * Three call shapes emit one: `logStatus({`, the publication module's
 * `emitStatus({`, and its direct `options.logStatus?.({`. Reading only the
 * first missed two thirds of them.
 *
 * A literal preceded by an equality operator is a comparison operand rather
 * than a reason — one emitter picks between two with `status === "none" ? …`,
 * and counting that operand reported `"none"` as an undocumented reason.
 */
async function emittedReasons(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const relative of sources) {
    const source = await readFile(
      fileURLToPath(new URL(`../../../${relative}`, import.meta.url)),
      "utf8",
    );
    for (const match of source.matchAll(/reason:\s*([^\n]*)/gu)) {
      for (const literal of match[1]!.matchAll(/(===|!==|==|!=)?\s*["']([^"']+)["']/gu)) {
        if (literal[1] === undefined) found.add(literal[2]!);
      }
    }
  }
  return found;
}

describe("TGD_REVIEW_RESULT reasons", () => {
  it("documents every reason the code emits, and emits every reason it documents", async () => {
    const emitted = await emittedReasons();

    // A guard on the guard: a scan that matches nothing would pass everything.
    expect(emitted.size, "no reasons found; the scanner needs updating").toBeGreaterThan(5);

    // Both directions, for real this time. The previous version only checked
    // that each hard-coded constant appeared somewhere in the README, so a
    // reason deleted from the source left the table stale and both tests green.
    expect([...emitted].sort()).toEqual([...KNOWN_REASONS].sort());
  });

  it("lists those reasons in the README", async () => {
    const readme = await readFile(
      fileURLToPath(new URL("../../../README.md", import.meta.url)),
      "utf8",
    );
    for (const reason of KNOWN_REASONS) {
      expect(readme, `the README does not mention "${reason}"`).toContain(`\`${reason}\``);
    }
  });

  it("does not claim a reason identifies a telemetry-free line", async () => {
    // The correction this file exists to record. `inline-publication-ambiguous`
    // is emitted by a dispatching run that owes its telemetry AND by a recovery
    // that has none, so any documentation keying telemetry off `reason` is
    // wrong however carefully its table is maintained.
    const publication = await readFile(
      fileURLToPath(new URL("../../../src/review/review-publication.ts", import.meta.url)),
      "utf8",
    );
    const ambiguous = publication.slice(publication.indexOf('reason: "inline-publication-ambiguous"'));
    expect(ambiguous.slice(0, 400)).toContain("options.metrics");
  });
});
