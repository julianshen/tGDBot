// Issue #132: `metrics` is present on the TGD_REVIEW_RESULT line if and only
// if the process dispatched rules.
//
// That is the invariant an aggregator keys on, and it is only useful if the
// set of telemetry-free emitters is knowable. It is documented in the README
// as a table of `reason` values; this pins the table against the source, so a
// new emitter cannot join the list silently and leave the documentation
// describing a contract the code no longer keeps.
//
// A SOURCE-SHAPE test, which is unusual here and deliberate. The alternative
// is nine end-to-end tests driving paths that mostly have coverage already,
// and none of them would notice a TENTH emitter being added — which is the
// thing that actually goes wrong.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));

/**
 * The reasons a status line carries when the run dispatched nothing.
 *
 * Kept in step with the table under "The `TGD_REVIEW_RESULT` line" in the
 * README. `null` is the head-SHA dedup skip, which carries no `reason` at all
 * — it predates the field and keeps its original shape so anyone already
 * parsing that line sees no change.
 */
const TELEMETRY_FREE_REASONS: readonly (string | null)[] = [
  null,
  "context-required",
  "diff-incomplete",
  "diff-too-large",
  "inline-publication-awaiting-consistency",
  "inline-publication-still-ambiguous",
  "recovered-ambiguous-inline-review",
  "recovered-pending-review",
  "recovered-pending-review-dry-run",
];

/** Every `logStatus({ … })` argument in the file, as source text. */
function statusCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "logStatus({";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) return calls;
    // Balanced-brace scan from the opening `{`. The arguments here are plain
    // object literals — no template literals spanning braces — so counting is
    // enough, and a malformed count would surface as a failing parse rather
    // than a quietly wrong answer.
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, index + 1));
    from = index + 1;
  }
}

/**
 * The `reason:` string literals in one call, or `null` when it sets none.
 *
 * One emitter picks its reason with a ternary, so the expression contains a
 * literal that is a COMPARISON OPERAND rather than a reason — taking every
 * literal after `reason:` reported `"none"` from `status === "none" ? …` as an
 * undocumented reason. Literals preceded by an equality operator are dropped
 * for that reason, which is narrow enough to state and wrong in no case this
 * file contains.
 */
function reasonsOf(call: string): (string | null)[] {
  const start = call.indexOf("reason:");
  // A ternary yields two; a plain assignment one; absence means the dedup skip.
  if (start === -1) return [null];
  const expression = call.slice(start, endOfProperty(call, start));
  const found = [...expression.matchAll(/(===|!==|==|!=)?\s*["']([^"']+)["']/gu)]
    .filter((match) => match[1] === undefined)
    .map((match) => match[2]!);
  return found.length === 0 ? [null] : found;
}

/** Where the `reason:` property ends: the next comma or brace at its own depth. */
function endOfProperty(call: string, from: number): number {
  let depth = 0;
  for (let index = from; index < call.length; index += 1) {
    const char = call[index]!;
    if (char === "{" || char === "(") depth += 1;
    else if (char === "}" || char === ")") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === "," && depth === 0) return index;
  }
  return call.length;
}

describe("TGD_REVIEW_RESULT telemetry contract", () => {
  it("emits metrics if and only if the run dispatched, and every other reason is documented", async () => {
    const source = await readFile(cliPath, "utf8");
    const calls = statusCalls(source);

    // A guard on the guard: if the scan stops finding call sites — renamed
    // helper, reformatted arguments — this test would pass by examining
    // nothing at all.
    expect(calls.length, "no logStatus call sites found; the scanner needs updating").toBeGreaterThan(5);

    const undocumented = calls
      .filter((call) => !call.includes("metrics:"))
      .flatMap(reasonsOf)
      .filter((reason) => !TELEMETRY_FREE_REASONS.includes(reason));

    expect(
      undocumented,
      "a status line without `metrics` carries a reason the README's table does not list — " +
        "add it there and here, or give the emitter its run's metrics",
    ).toEqual([]);
  });

  it("keeps the documented reasons in step with the README", async () => {
    // The table is the contract a consumer reads. A reason retired from the
    // code but left in the table is as misleading as one added and not
    // documented, so both directions are checked.
    const readme = await readFile(
      fileURLToPath(new URL("../../../README.md", import.meta.url)),
      "utf8",
    );
    for (const reason of TELEMETRY_FREE_REASONS) {
      if (reason === null) continue;
      expect(readme, `the README table does not mention "${reason}"`).toContain(`\`${reason}\``);
    }
  });
});
