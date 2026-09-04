// Issue #114: the reviewer's verbatim excerpt is host-verified evidence of
// where a finding lives. These tests pin the matching hierarchy and — more
// important — the refusal rule: zero or multiple matches decline, because a
// line number no quote supports is never published as a location.
import { describe, expect, it } from "vitest";
import {
  newSideHunksByFile,
  relocateFindingsByQuote,
  resolveQuoteAnchor,
} from "../../../src/review/quote-anchor.js";

function diffOf(file: string, hunk: string): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, hunk].join("\n");
}

const HUNK = [
  "@@ -10,7 +10,8 @@ function existing() {",
  " const before = 1;",
  "+const added = 2;",
  "+const added2 = 3;",
  " const after = 4;",
].join("\n");

describe("newSideHunksByFile", () => {
  it("collects added and context lines with their new-side numbers", () => {
    const byFile = newSideHunksByFile(diffOf("src/a.ts", HUNK));
    const lines = (byFile.get("src/a.ts") ?? []).flat();
    expect(lines.map((line) => line.newLine)).toEqual([10, 11, 12, 13]);
    expect(lines[1]?.text).toBe("const added = 2;");
  });

  it("separates files and skips removed lines", () => {
    const diff = [
      diffOf("src/a.ts", "@@ -1,2 +1,3 @@\n-a\n+a1\n context\n+b1"),
      diffOf("src/b.ts", "@@ -5,1 +5,2 @@\n-keep\n+keep2"),
    ].join("\n");
    const byFile = newSideHunksByFile(diff);
    expect([...byFile.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect((byFile.get("src/a.ts") ?? []).flat().map((line) => line.text)).toEqual(["a1", "context", "b1"]);
    expect((byFile.get("src/b.ts") ?? []).flat().map((line) => line.text)).toEqual(["keep2"]);
  });
});

describe("resolveQuoteAnchor", () => {
  it("locates a single-line excerpt on the finding's own file", () => {
    const anchor = resolveQuoteAnchor(
      diffOf("src/a.ts", HUNK),
      "src/a.ts",
      "const added = 2;",
    );
    expect(anchor).toEqual({ file: "src/a.ts", line: 11 });
  });

  it("locates a multi-line excerpt and derives both endpoints", () => {
    const anchor = resolveQuoteAnchor(
      diffOf("src/a.ts", HUNK),
      "src/a.ts",
      "const added = 2;\nconst added2 = 3;",
    );
    expect(anchor).toEqual({ file: "src/a.ts", line: 11, endLine: 12 });
  });

  it("is whitespace-insensitive per line and ignores blank lines in the quote", () => {
    const anchor = resolveQuoteAnchor(
      diffOf("src/a.ts", HUNK),
      "src/a.ts",
      "  const added = 2;\n\n   const added2 = 3;  ",
    );
    expect(anchor).toEqual({ file: "src/a.ts", line: 11, endLine: 12 });
  });

  it("declines when the excerpt matches nothing", () => {
    expect(resolveQuoteAnchor(diffOf("src/a.ts", HUNK), "src/a.ts", "const missing = 9;")).toBeUndefined();
  });

  it("declines when the excerpt matches more than one location", () => {
    const duplicated = diffOf(
      "src/a.ts",
      "@@ -1,5 +1,6 @@\n const x = 1;\n+return null;\n const y = 2;\n+return null;\n const z = 3;",
    );
    expect(resolveQuoteAnchor(duplicated, "src/a.ts", "return null;")).toBeUndefined();
  });

  it("re-files the finding when the quote is unique in ANOTHER changed file", () => {
    // The reviewer read related files and filed against the header while
    // quoting the source file — the cross-file case from issue #114.
    const diff = [
      diffOf("src/handler.ts", HUNK),
      diffOf("src/source.ts", "@@ -20,3 +20,4 @@\n const a = 1;\n+const quoted = 2;\n const b = 3;"),
    ].join("\n");
    const anchor = resolveQuoteAnchor(diff, "src/handler.ts", "const quoted = 2;");
    expect(anchor).toEqual({ file: "src/source.ts", line: 21 });
  });

  it("declines when the quote matches once in the finding's file AND once elsewhere", () => {
    const diff = [
      diffOf("src/a.ts", HUNK),
      diffOf("src/other.ts", "@@ -1,2 +1,3 @@\n const a = 1;\n+const added = 2;\n const b = 3;"),
    ].join("\n");
    expect(resolveQuoteAnchor(diff, "src/a.ts", "const added = 2;")).toBeUndefined();
  });

  it("groups lines by hunk so a match can never span two hunks", () => {
    // The excerpt's lines exist, but in DIFFERENT hunks of the same file —
    // they are not contiguous in the source and must decline.
    const diff = diffOf(
      "src/a.ts",
      "@@ -10,1 +10,2 @@\n+added\n@@ -50,1 +50,2 @@\n+added2",
    );
    expect(resolveQuoteAnchor(diff, "src/a.ts", "added\nadded2")).toBeUndefined();
    // Each line alone still matches uniquely within its own hunk.
    expect(resolveQuoteAnchor(diff, "src/a.ts", "added")).toEqual({ file: "src/a.ts", line: 10 });
  });

  it("matches a quote spanning a blank source line (blanks ignored on both sides)", () => {
    const diff = diffOf(
      "src/a.ts",
      "@@ -10,1 +10,4 @@\n+first\n+\n+second\n",
    );
    expect(resolveQuoteAnchor(diff, "src/a.ts", "first\nsecond")).toEqual({
      file: "src/a.ts",
      line: 10,
      endLine: 12,
    });
  });

  it("declines an excerpt over the line cap instead of truncating it", () => {
    // 51 distinct lines: no prefix of the quote occurs in the diff, and the
    // full quote must NOT be accepted via a truncated prefix either.
    const lines = Array.from({ length: 51 }, (_, index) => `const v${index} = ${index};`);
    const diff = diffOf("src/a.ts", `@@ -1,1 +1,2 @@\n+${lines[0]}\n`);
    expect(resolveQuoteAnchor(diff, "src/a.ts", lines.join("\n"))).toBeUndefined();
  });

  it("declines an empty or whitespace-only quote", () => {
    expect(resolveQuoteAnchor(diffOf("src/a.ts", HUNK), "src/a.ts", "")).toBeUndefined();
    expect(resolveQuoteAnchor(diffOf("src/a.ts", HUNK), "src/a.ts", "  \n  ")).toBeUndefined();
  });
});

// PR #130 review: quote relocation must run BEFORE the consumers that read a
// finding's location — structural checks and clarification persistence — so
// the pass is exported for the composition root and must be idempotent (the
// quote is stripped on relocation, so a second application is a no-op).
describe("relocateFindingsByQuote — shared preprocessing (#114)", () => {
  const DIFF = diffOf("src/a.ts", HUNK);

  it("relocates, strips the quote, and is idempotent", () => {
    const findings = [
      { file: "src/a.ts", line: 10, severity: "blocking" as const, category: "c", message: "m", ruleName: "r", existingCode: "const added = 2;" },
    ];
    const first = relocateFindingsByQuote(findings, DIFF);
    expect(first[0]).toMatchObject({ file: "src/a.ts", line: 11 });
    expect(first[0].existingCode).toBeUndefined();

    const second = relocateFindingsByQuote(first, DIFF);
    expect(second).toEqual(first);
  });

  it("drops the model's line when the quote declines", () => {
    const findings = [
      { file: "src/a.ts", line: 10, severity: "blocking" as const, category: "c", message: "m", ruleName: "r", existingCode: "not in the diff" },
    ];
    const relocated = relocateFindingsByQuote(findings, DIFF);
    expect(relocated[0]?.line).toBeUndefined();
    expect(relocated[0]?.endLine).toBeUndefined();
  });
});
