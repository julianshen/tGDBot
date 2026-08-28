// GitHub rejects the ENTIRE review request (422) if any inline comment targets a
// line that isn't part of the diff. So before anchoring a finding we must know,
// from the diff itself, exactly which (file, line) pairs are commentable.
//
// Commentable = a line present on the RIGHT (new-file) side of a hunk — i.e. an
// added (`+`) or context (` `) line. Removed (`-`) lines exist only on the LEFT
// and cannot carry a RIGHT-side comment.
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  changedFilesWithRenameSources,
  removedLinesByFile,
  renameSourcesByHeadPath,
  quoteGitPathOperand,
  commentableLines,
  diffPositionRange,
  parseDiffPositions,
  isCommentable,
  hunkSnippet,
} from "../../../src/review/diff-anchors.js";

const SIMPLE = `diff --git a/src/a.go b/src/a.go
index 111..222 100644
--- a/src/a.go
+++ b/src/a.go
@@ -10,3 +10,4 @@ func f() {
 ctx1
-removed
+added1
+added2
 ctx2
`;

describe("commentableLines", () => {
  it("maps added and context lines to their NEW-file line numbers", () => {
    const map = commentableLines(SIMPLE);

    // Hunk starts at new line 10: ctx1=10, added1=11, added2=12, ctx2=13.
    // The removed line consumes an OLD line number only — it must not shift these.
    expect([...(map.get("src/a.go") ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("never marks a removed line as commentable (it has no RIGHT side)", () => {
    const map = commentableLines(SIMPLE);
    const lines = map.get("src/a.go") ?? new Set();
    // Old line 11 was `-removed`. New line 11 is `added1` — commentable, but only
    // because of the ADDED line, not the removed one. The count is what proves it:
    // 4 commentable lines from 1 ctx + 2 added + 1 ctx.
    expect(lines.size).toBe(4);
  });

  it("handles multiple files and multiple hunks with correct per-hunk offsets", () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,2 @@
 a
+b
@@ -50,1 +60,2 @@
 c
+d
diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -5,0 +7,1 @@
+solo
`;
    const map = commentableLines(diff);

    expect([...(map.get("x.ts") ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 60, 61]);
    expect([...(map.get("y.ts") ?? [])]).toEqual([7]);
  });

  it("skips deleted files (+++ /dev/null) — nothing on the right side to comment on", () => {
    const diff = `diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;
    expect(commentableLines(diff).has("gone.ts")).toBe(false);
  });

  it("handles a new file (--- /dev/null) — every added line is commentable", () => {
    const diff = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    expect([...(commentableLines(diff).get("new.ts") ?? [])]).toEqual([1, 2, 3]);
  });

  it("defaults an omitted hunk count to 1 (@@ -3 +4 @@)", () => {
    const diff = `diff --git a/z.ts b/z.ts
--- a/z.ts
+++ b/z.ts
@@ -3 +4 @@
 only
`;
    expect([...(commentableLines(diff).get("z.ts") ?? [])]).toEqual([4]);
  });

  it("ignores diff noise (binary files, mode changes, \\\\ No newline) without throwing", () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/m.ts b/m.ts
old mode 100644
new mode 100755
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-old
+changed
\\ No newline at end of file
`;
    const map = commentableLines(diff);
    expect(map.has("img.png")).toBe(false);
    expect([...(map.get("m.ts") ?? [])]).toEqual([1]);
  });

  it("returns an empty map for an empty diff, never throws", () => {
    expect(commentableLines("").size).toBe(0);
  });
});

describe("diffPositionRange", () => {
  const renamed = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 80%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -9,2 +9,4 @@
 context
+added
+added two
 tail
@@ -30,1 +31,1 @@
 later
`;

  it("retains provider-neutral paths, endpoint sides, line numbers, and hunk identity", () => {
    expect(diffPositionRange(renamed, "src/new-name.ts", 10, 12)).toEqual({
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      start: { type: "new", oldLine: undefined, newLine: 10 },
      end: { type: "old", oldLine: 10, newLine: 12 },
      sameHunk: true,
    });
    expect(diffPositionRange(renamed, "src/new-name.ts", 12, 10)).toEqual({
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      start: { type: "old", oldLine: 10, newLine: 12 },
      end: { type: "new", oldLine: undefined, newLine: 10 },
      sameHunk: true,
    });
  });

  it("reuses one parsed position index for commentability and range lookup", () => {
    const positions = parseDiffPositions(renamed);
    expect(commentableLines(positions).get("src/new-name.ts")?.has(10)).toBe(true);
    expect(diffPositionRange(positions, "src/new-name.ts", 10, 12)).toMatchObject({
      newPath: "src/new-name.ts",
      start: { newLine: 10 },
      end: { newLine: 12 },
    });
  });

  it("represents added ranges and context endpoints exactly", () => {
    const added = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +10,3 @@
+one
+two
+three
`;
    expect(diffPositionRange(added, "src/new.ts", 10, 12)).toEqual({
      oldPath: "src/new.ts",
      newPath: "src/new.ts",
      start: { type: "new", oldLine: undefined, newLine: 10 },
      end: { type: "new", oldLine: undefined, newLine: 12 },
      sameHunk: true,
    });
    expect(diffPositionRange(renamed, "src/new-name.ts", 9)).toMatchObject({
      start: { type: "old", oldLine: 9, newLine: 9 },
      end: { type: "old", oldLine: 9, newLine: 9 },
    });
  });

  it("rejects cross-hunk, removed-side, cross-file, and missing endpoints", () => {
    expect(diffPositionRange(renamed, "src/new-name.ts", 10, 31)).toBeUndefined();
    expect(diffPositionRange(renamed, "src/old-name.ts", 10, 10)).toBeUndefined();
    expect(diffPositionRange(renamed, "missing.ts", 1, 1)).toBeUndefined();
  });

  it("fails the whole hunk closed when '+' appears after the new-side count is exhausted", () => {
    const malformed = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
 context
+overflow
`;
    expect(diffPositionRange(malformed, "a.ts", 1)).toBeUndefined();
    expect(commentableLines(malformed).get("a.ts")).toBeUndefined();
  });

  it("fails the whole hunk closed when '-' appears after the old-side count is exhausted", () => {
    const malformed = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,0 +1,1 @@
-overflow
+would-otherwise-leak
`;
    expect(diffPositionRange(malformed, "a.ts", 1)).toBeUndefined();
    expect(commentableLines(malformed).get("a.ts")).toBeUndefined();
  });

  it.each([
    ["an unknown marker after a valid prefix", "@@ -1,2 +1,2 @@\n context\n?invalid"],
    ["impossible context with no old-side lines", "@@ -1,0 +1,1 @@\n context"],
    ["premature EOF with positive counters", "@@ -1,2 +1,2 @@\n context\n"],
  ])("transactionally discards %s in both anchor APIs", (_name, hunk) => {
    const malformed = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
${hunk}`;
    expect(diffPositionRange(malformed, "a.ts", 1)).toBeUndefined();
    expect(commentableLines(malformed).get("a.ts")).toBeUndefined();
  });

  it("a later malformed overlapping hunk cannot delete or overwrite an earlier valid hunk", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
 valid
@@ -1,2 +1,2 @@
 later-prefix
?invalid
`;
    expect(diffPositionRange(diff, "a.ts", 1)).toMatchObject({
      start: { type: "old", oldLine: 1, newLine: 1 },
    });
    expect([...(commentableLines(diff).get("a.ts") ?? [])]).toEqual([1]);
  });

  it("preserves the earlier position when two valid hunks overlap", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
 first
@@ -9,1 +1,1 @@
 second
`;
    expect(diffPositionRange(diff, "a.ts", 1)).toMatchObject({
      start: { type: "old", oldLine: 1, newLine: 1 },
    });
    expect([...(commentableLines(diff).get("a.ts") ?? [])]).toEqual([1]);
  });
});

describe("isCommentable", () => {
  const map = commentableLines(SIMPLE);

  it("accepts a file+line inside a hunk", () => {
    expect(isCommentable(map, "src/a.go", 11)).toBe(true);
  });

  it("rejects a line outside every hunk (would 422 the whole review)", () => {
    expect(isCommentable(map, "src/a.go", 999)).toBe(false);
  });

  it("rejects a file that isn't in the diff at all", () => {
    expect(isCommentable(map, "src/never-touched.go", 11)).toBe(false);
  });

  it("rejects a null/undefined line (a finding with no line can't be anchored)", () => {
    expect(isCommentable(map, "src/a.go", undefined)).toBe(false);
    expect(isCommentable(map, "src/a.go", null)).toBe(false);
  });
});

// Attacker-reachable parser bugs found in review. Both 422 the ENTIRE review
// (GitHub rejects the whole request if one anchor is off-diff), and the first is
// triggerable by a PR that merely ADDS A DIFF FIXTURE — which this repo's own
// test files are.
describe("diff CONTENT that looks like diff SYNTAX (review findings)", () => {
  it("does not treat an added line whose content starts with '++ ' as a file header", () => {
    // Raw line is `+++ b/victim.ts`: a `+` marker plus the content `++ b/victim.ts`.
    // Naively this parses as a `+++ b/<path>` header and steers every subsequent
    // anchor onto victim.ts — a file this hunk never touches.
    const diff = `diff --git a/fixtures/diff.txt b/fixtures/diff.txt
--- a/fixtures/diff.txt
+++ b/fixtures/diff.txt
@@ -1,1 +1,2 @@
 keep
+++ b/victim.ts
diff --git a/victim.ts b/victim.ts
--- a/victim.ts
+++ b/victim.ts
@@ -1,1 +1,2 @@
 a
+b
`;
    const map = commentableLines(diff);

    // The fixture file owns lines 1-2; victim.ts owns ONLY its own hunk (1-2).
    expect([...(map.get("fixtures/diff.txt") ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...(map.get("victim.ts") ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("does not treat an in-hunk line starting with '@@ ' or 'diff --git ' as syntax", () => {
    const diff = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,1 +1,3 @@
 keep
+@@ -999,1 +999,1 @@
+diff --git a/evil.ts b/evil.ts
`;
    const map = commentableLines(diff);
    expect([...(map.get("doc.md") ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(map.has("evil.ts")).toBe(false);
  });

  it("emits no phantom anchor past the end of the last hunk (trailing blank lines)", () => {
    const diff = "diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -1,0 +1,1 @@\n+only\n\n\n";
    // Line 2 does not exist in the hunk; anchoring there would 422 the review.
    expect([...(commentableLines(diff).get("t.ts") ?? [])]).toEqual([1]);
  });

  it("keeps counting after a mid-hunk '\\ No newline at end of file'", () => {
    const diff = `diff --git a/n.ts b/n.ts
--- a/n.ts
+++ b/n.ts
@@ -1,2 +1,2 @@
 ctx
-old
\\ No newline at end of file
+new
`;
    // `+new` is line 2 and must survive — the `\\` line consumes no line.
    expect([...(commentableLines(diff).get("n.ts") ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

// A finding that lands in the summary instead of on the diff loses GitHub's
// native code context. hunkSnippet recovers it: the diff excerpt around the
// finding's lines, so the summary entry is readable on its own.
describe("hunkSnippet", () => {
  it("returns the diff excerpt around a single line, marking the target", () => {
    const snippet = hunkSnippet(SIMPLE, "src/a.go", 11);

    expect(snippet).toEqual({
      startLine: 11,
      endLine: 11,
      lines: [
        { marker: " ", text: "ctx1", newLine: 10, target: false },
        { marker: "-", text: "removed", newLine: undefined, target: false },
        { marker: "+", text: "added1", newLine: 11, target: true },
        { marker: "+", text: "added2", newLine: 12, target: false },
        { marker: " ", text: "ctx2", newLine: 13, target: false },
      ],
    });
  });

  it("marks every line of a multi-line range as target", () => {
    const snippet = hunkSnippet(SIMPLE, "src/a.go", 11, 12);

    expect(snippet?.startLine).toBe(11);
    expect(snippet?.endLine).toBe(12);
    expect(snippet?.lines.filter((l) => l.target).map((l) => l.text)).toEqual([
      "added1",
      "added2",
    ]);
  });

  it("bounds the excerpt to `context` lines either side of the range", () => {
    const wide = [
      "diff --git a/src/b.go b/src/b.go",
      "--- a/src/b.go",
      "+++ b/src/b.go",
      "@@ -1,9 +1,9 @@",
      ...["a", "b", "c", "d"].map((t) => ` ${t}`),
      "+target",
      ...["e", "f", "g", "h"].map((t) => ` ${t}`),
      "",
    ].join("\n");

    const snippet = hunkSnippet(wide, "src/b.go", 5, 5, 2);

    expect(snippet?.lines.map((l) => l.text)).toEqual(["c", "d", "target", "e", "f"]);
  });

  // A REMOVED line whose content begins "-- " renders as "--- " in the diff, and
  // an ADDED line beginning "++ " renders as "+++ ". Markdown rules and SQL
  // comments hit this constantly. Treating them as file headers truncated the
  // hunk and lost the excerpt. (CodeRabbit review of PR #23.)
  it("treats a removed \"--- \" line as content, not a file header", () => {
    const md = [
      "diff --git a/doc.md b/doc.md",
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,4 +1,4 @@",
      " intro",
      "--- ",
      "+***",
      " outro",
      "",
    ].join("\n");

    const snippet = hunkSnippet(md, "doc.md", 2);

    expect(snippet?.lines.map((l) => l.marker + l.text)).toEqual([
      " intro",
      "--- ",
      "+***",
      " outro",
    ]);
    // The removed line is content: marker "-", text "-- ".
    expect(snippet?.lines[1]).toMatchObject({ marker: "-", text: "-- ", target: false });
  });

  it("treats an added \"+++ \" line as content, not a file header", () => {
    const md = [
      "diff --git a/doc.md b/doc.md",
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,2 +1,3 @@",
      " intro",
      "+++ nested bullet",
      " outro",
      "",
    ].join("\n");

    const snippet = hunkSnippet(md, "doc.md", 2);

    expect(snippet?.lines.map((l) => l.marker + l.text)).toEqual([
      " intro",
      "+++ nested bullet",
      " outro",
    ]);
    expect(snippet?.lines[1]).toMatchObject({ marker: "+", text: "++ nested bullet", newLine: 2 });
  });

  it("does not let another file\x27s hunk content redirect the search", () => {
    const multi = [
      "diff --git a/other.md b/other.md",
      "--- a/other.md",
      "+++ b/other.md",
      "@@ -1,2 +1,2 @@",
      " x",
      "+++ b/target.md",
      "diff --git a/target.md b/target.md",
      "--- a/target.md",
      "+++ b/target.md",
      "@@ -10,1 +10,2 @@",
      " real",
      "+wanted",
      "",
    ].join("\n");

    const snippet = hunkSnippet(multi, "target.md", 11);

    expect(snippet?.lines.map((l) => l.text)).toEqual(["real", "wanted"]);
  });

  it("returns undefined for a line that is not in the diff", () => {
    expect(hunkSnippet(SIMPLE, "src/a.go", 999)).toBeUndefined();
    expect(hunkSnippet(SIMPLE, "src/missing.go", 11)).toBeUndefined();
  });

  it("returns undefined when the finding has no line at all", () => {
    expect(hunkSnippet(SIMPLE, "src/a.go", undefined)).toBeUndefined();
  });
});

const RENAME = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 94%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

const EDIT_AND_RENAME = `diff --git a/src/kept.ts b/src/kept.ts
--- a/src/kept.ts
+++ b/src/kept.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;
diff --git a/src/moved.ts b/src/relocated.ts
rename from src/moved.ts
rename to src/relocated.ts
--- a/src/moved.ts
+++ b/src/relocated.ts
@@ -1,1 +1,1 @@
-const y = 1;
+const y = 2;
`;

describe("changedFilesWithRenameSources", () => {
  it("keeps both sides of a rename, head-side first", () => {
    // The whole point: trusted-base context is mapped from the BASE commit,
    // where this file is still `src/old-name.ts`. Matching only the new path
    // finds no graph node and the pack comes back empty.
    expect(changedFilesWithRenameSources(RENAME)).toEqual([
      "src/new-name.ts",
      "src/old-name.ts",
    ]);
  });

  it("adds nothing for an ordinary edit, where both sides are the same path", () => {
    expect(changedFilesWithRenameSources(SIMPLE)).toEqual(changedFiles(SIMPLE));
  });

  it("handles a rename alongside an ordinary edit in one diff", () => {
    expect(changedFilesWithRenameSources(EDIT_AND_RENAME)).toEqual([
      "src/kept.ts",
      "src/relocated.ts",
      "src/moved.ts",
    ]);
  });

  it("parses the head side exactly as changedFiles does", () => {
    // The regex gained a capture group on the a/ side; its greediness, and so
    // the b/ side it yields, must be unchanged.
    for (const diff of [SIMPLE, RENAME, EDIT_AND_RENAME]) {
      for (const file of changedFiles(diff)) {
        expect(changedFilesWithRenameSources(diff)).toContain(file);
      }
    }
    expect(changedFiles(RENAME)).toEqual(["src/new-name.ts"]);
  });
});

describe("changedFiles stays head-side only", () => {
  it("does not gain the base-side path of a rename", () => {
    // Its callers — the summary's "files reviewed" list and changed-line
    // matching against review threads — describe the code as it is now.
    expect(changedFiles(RENAME)).not.toContain("src/old-name.ts");
    expect(changedFiles(EDIT_AND_RENAME)).toEqual(["src/kept.ts", "src/relocated.ts"]);
  });
});

const QUOTED = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

const QUOTED_RENAME = `diff --git "a/src/ol\\303\\251.ts" "b/src/nouve\\303\\241.ts"
rename from "src/ol\\303\\251.ts"
rename to "src/nouve\\303\\241.ts"
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

describe("git-quoted paths in the diff header", () => {
  it("decodes an octal-escaped UTF-8 name rather than dropping the file", () => {
    // Git quotes any path with a non-ASCII byte under the default
    // core.quotePath, so an unquoted-only regex loses the file entirely — it
    // vanishes from the summary, from changed-line matching, and from context
    // selection, where the pack then claims no graph nodes matched.
    expect(changedFiles(QUOTED)).toEqual(["src/café.ts"]);
    expect(changedFilesWithRenameSources(QUOTED)).toEqual(["src/café.ts"]);
  });

  it("keeps both sides of a quoted rename", () => {
    expect(changedFiles(QUOTED_RENAME)).toEqual(["src/nouveá.ts"]);
    expect(changedFilesWithRenameSources(QUOTED_RENAME))
      .toEqual(["src/nouveá.ts", "src/olé.ts"]);
  });

  it("still parses ordinary unquoted headers, spaces included", () => {
    expect(changedFiles("diff --git a/dir/a b.ts b/dir/a b.ts"))
      .toEqual(["dir/a b.ts"]);
    expect(changedFiles(SIMPLE)).toEqual(["src/a.go"]);
  });

  it("decodes the escaped quote and backslash forms", () => {
    expect(changedFiles('diff --git "a/say \\"hi\\".ts" "b/say \\"hi\\".ts"'))
      .toEqual(['say "hi".ts']);
    expect(changedFiles('diff --git "a/back\\\\slash.ts" "b/back\\\\slash.ts"'))
      .toEqual(["back\\slash.ts"]);
  });

  it("ignores a malformed header instead of emitting a broken path", () => {
    expect(changedFiles('diff --git "a/unterminated.ts b/x.ts')).toEqual([]);
    expect(changedFiles("diff --git nota/x b/y")).toEqual([]);
  });
});

describe("mixed and pathological diff headers", () => {
  it("parses a quoted head path after an unquoted base path", () => {
    // Git quotes each operand independently, so renaming an ASCII name to one
    // it must quote produces a mixed header. Requiring the FIRST path to be
    // quoted before using the quoted parser dropped these entirely.
    const mixed = 'diff --git a/old.ts "b/caf\\303\\251.ts"';
    expect(changedFiles(mixed)).toEqual(["café.ts"]);
    expect(changedFilesWithRenameSources(mixed)).toEqual(["café.ts", "old.ts"]);
  });

  it("parses an unquoted head path after a quoted base path", () => {
    const mixed = 'diff --git "a/caf\\303\\251.ts" b/plain.ts';
    expect(changedFiles(mixed)).toEqual(["plain.ts"]);
    expect(changedFilesWithRenameSources(mixed)).toEqual(["plain.ts", "café.ts"]);
  });

  it("omits a path carrying a control character rather than passing it on", () => {
    // `normalizeChangedFile` rejects controls, so letting one through would
    // fail the whole context build — and under `--context require` abort the
    // review — over a single filename. The summary also renders each path in a
    // backtick span, which a newline would break out of.
    expect(changedFiles('diff --git "a/we\\012ird.ts" "b/we\\012ird.ts"')).toEqual([]);
    expect(changedFilesWithRenameSources('diff --git "a/tab\\011.ts" "b/tab\\011.ts"')).toEqual([]);
  });

  it("keeps a control-free file in the same diff as a rejected one", () => {
    const diff = [
      'diff --git "a/we\\012ird.ts" "b/we\\012ird.ts"',
      "diff --git a/fine.ts b/fine.ts",
    ].join("\n");
    expect(changedFiles(diff)).toEqual(["fine.ts"]);
  });

  it("rejects a header whose quote does not follow the separating space", () => {
    expect(changedFiles('diff --git a/x"b/y.ts"')).toEqual([]);
  });

  it("keeps a literal quote in an unquoted path from the oversized-diff fallback", () => {
    // `reconstructDiffFromFiles` writes paths into the header without
    // C-quoting them, so a name containing a quote arrives unquoted. Treating
    // that quote as opening an operand dropped the file from context
    // selection, thread matching and the reviewed-files list alike.
    const reconstructed = 'diff --git a/foo"bar.ts b/foo"bar.ts';
    expect(changedFiles(reconstructed)).toEqual(['foo"bar.ts']);
    expect(changedFilesWithRenameSources(reconstructed)).toEqual(['foo"bar.ts']);
  });
});

describe("quoteGitPathOperand", () => {
  it("leaves an ordinary path bare, exactly as git would", () => {
    expect(quoteGitPathOperand("a", "src/index.ts")).toBe("a/src/index.ts");
    expect(quoteGitPathOperand("b", "dir/with space.ts")).toBe("b/dir/with space.ts");
  });

  it("quotes the two shapes that broke the parser", () => {
    expect(quoteGitPathOperand("a", 'foo"bar.ts')).toBe('"a/foo\\"bar.ts"');
    expect(quoteGitPathOperand("b", 'foo "bar.ts')).toBe('"b/foo \\"bar.ts"');
  });

  it("escapes backslashes and control characters octally", () => {
    expect(quoteGitPathOperand("a", "back\\slash.ts")).toBe('"a/back\\\\slash.ts"');
    expect(quoteGitPathOperand("a", "line\nbreak.ts")).toBe('"a/line\\nbreak.ts"');
  });

  it("round-trips through the header parser", () => {
    // The point of fixing the producer: whatever it emits, the parser reads
    // back unchanged — so no path shape needs its own parser special case.
    for (const name of ['foo"bar.ts', 'foo "bar.ts', "plain.ts", "with space.ts", "caf\u00e9.ts"]) {
      const header = `diff --git ${quoteGitPathOperand("a", name)} ${quoteGitPathOperand("b", name)}`;
      expect(changedFiles(header)).toEqual([name]);
    }
  });
});

// Issue #75. The structural check reports BASE-relative paths, so a map keyed
// only by the head side silently misses every file the pull request renames —
// and the reconciliation this feeds exists precisely to catch a PR that deletes
// a call site. Renaming that file too made it invisible again (CodeRabbit
// review).
describe("removedLinesByFile", () => {
  it("finds a renamed file's removed lines under either path", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1,2 +1,1 @@",
      " import { budget } from './retry.js';",
      "-export const a = budget(1);",
    ].join("\n");

    const removed = removedLinesByFile(diff);

    expect(removed.get("src/old.ts")?.text).toContain("budget(1)");
    expect(removed.get("src/new.ts")?.text).toContain("budget(1)");
    // The removed line is the second of the hunk, which starts at old line 1.
    expect(removed.get("src/old.ts")?.byLine.get(2)).toContain("budget(1)");
    expect(removed.get("src/old.ts")?.positioned).toBe(true);
  });

  it("keys an ordinary edit once, by its single path", () => {
    const diff = [
      "diff --git a/src/http.ts b/src/http.ts",
      "--- a/src/http.ts",
      "+++ b/src/http.ts",
      "@@ -1,2 +1,1 @@",
      "-export const a = budget(1);",
      "+export const a = 1;",
    ].join("\n");

    const removed = removedLinesByFile(diff);

    expect([...removed.keys()]).toEqual(["src/http.ts"]);
    expect(removed.get("src/http.ts")?.byLine.get(1)).toContain("budget(1)");
  });

  // `---` opens the file header and would otherwise read as a removed line
  // beginning with `--`, putting the base path itself into the removed text.
  it("does not mistake the file header for a removed line", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-const x = 1;",
    ].join("\n");

    expect(removedLinesByFile(diff).get("src/a.ts")?.text).not.toContain("a/src/a.ts");
  });

  // Codex review, round 7. A removed line whose CONTENT begins with `--` — a
  // decrement, say `--budget;` — is written `---budget;` in a unified diff.
  // Treating every `---` as a file header lost the removal, so reconciliation
  // kept the stale base occurrence and published a match against a correct
  // finding; worse, it also failed to advance the base line counter, sliding
  // every later removal in that file by one.
  it("reads a triple-minus line inside a hunk as removed content", () => {
    const diff = [
      "diff --git a/src/http.ts b/src/http.ts",
      "--- a/src/http.ts",
      "+++ b/src/http.ts",
      "@@ -1,3 +1,1 @@",
      " const keep = 1;",
      "---budget;",
      "-const after = 2;",
    ].join("\n");

    const removed = removedLinesByFile(diff);

    expect(removed.get("src/http.ts")?.byLine.get(2)).toBe("--budget;");
    // The counter advanced past the decrement, so the next removal is line 3.
    expect(removed.get("src/http.ts")?.byLine.get(3)).toBe("const after = 2;");
    expect(removed.get("src/http.ts")?.positioned).toBe(true);
  });

  // The mirror case: an added line whose content starts with `++` is `+++x;`,
  // and must not advance the base counter the way a context line does.
  it("does not let a triple-plus added line advance the base counter", () => {
    const diff = [
      "diff --git a/src/http.ts b/src/http.ts",
      "--- a/src/http.ts",
      "+++ b/src/http.ts",
      "@@ -1,2 +1,3 @@",
      " const keep = 1;",
      "+++counter;",
      "-const gone = budget(1);",
    ].join("\n");

    expect(removedLinesByFile(diff).get("src/http.ts")?.byLine.get(2))
      .toBe("const gone = budget(1);");
  });

  // Codex review, round 13. Round 12 fixed the ` b/` ambiguity for RENAME
  // endpoints; an ordinary modification still took its key from the greedy
  // header split. Verified against git, which writes an edit to `foo b/bar.ts`
  // as `diff --git a/foo b/bar.ts b/foo b/bar.ts` and terminates the
  // `---`/`+++` lines with a TAB when the path contains a space.
  it("keys removals by the real path when the header is ambiguous", () => {
    const diff = [
      "diff --git a/foo b/bar.ts b/foo b/bar.ts",
      "index 1eb743d..7898192 100644",
      "--- a/foo b/bar.ts\t",
      "+++ b/foo b/bar.ts\t",
      "@@ -1,2 +1 @@",
      " a",
      "-budget(1);",
    ].join("\n");

    const removed = removedLinesByFile(diff);

    expect(removed.get("foo b/bar.ts")?.byLine.get(2)).toBe("budget(1);");
    expect(removed.has("bar.ts")).toBe(false);
  });

  // A deleted file has `+++ /dev/null`, so the base-side path is the only one.
  it("keys a deleted file by its base-side path", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-const x = budget(1);",
    ].join("\n");

    expect(removedLinesByFile(diff).get("src/gone.ts")?.byLine.get(1))
      .toBe("const x = budget(1);");
  });

  // Codex review, round 8. A COPY diff also carries two different paths. Its
  // removed lines belong to the NEW file; recording them under the source path
  // would suppress occurrences in a file the diff never touched — and, through
  // `renameSourcesByHeadPath`, would exclude the still-existing original from
  // external matches entirely, hiding the best evidence against the claim.
  it("does not treat a copy's source as the same file", () => {
    const diff = [
      "diff --git a/src/original.ts b/src/copy.ts",
      "similarity index 95%",
      "copy from src/original.ts",
      "copy to src/copy.ts",
      "--- a/src/original.ts",
      "+++ b/src/copy.ts",
      "@@ -1,2 +1,1 @@",
      " const keep = 1;",
      "-const gone = budget(1);",
    ].join("\n");

    expect(renameSourcesByHeadPath(diff).has("src/copy.ts")).toBe(false);
    const removed = removedLinesByFile(diff);
    expect(removed.get("src/copy.ts")?.text).toContain("budget(1)");
    expect(removed.has("src/original.ts")).toBe(false);
  });

  // Codex review, round 12. A path may legally contain ` b/`, and git does NOT
  // quote it — verified against git, which writes a rename to `foo b/bar.ts` as
  // `diff --git a/old.ts b/foo b/bar.ts`. A greedy split yields `bar.ts` as the
  // head path, so the mapping never matches the finding's file and the base
  // file's own declaration is published as an external match.
  it("takes rename endpoints from the metadata, not the ambiguous header", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/foo b/bar.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/foo b/bar.ts",
    ].join("\n");

    const renames = renameSourcesByHeadPath(diff);

    expect(renames.get("src/foo b/bar.ts")).toBe("src/old.ts");
    expect(renames.has("bar.ts")).toBe(false);
  });

  // A C-quoted path is the one case the metadata lines cannot be read verbatim,
  // and it is exactly the case `parseDiffGitHeader` already handles — so the
  // header operands stay the source of truth there.
  it("falls back to the header operands for a quoted rename", () => {
    const diff = [
      'diff --git a/src/old.ts "b/src/caf\\303\\251.ts"',
      "rename from src/old.ts",
      'rename to "src/caf\\303\\251.ts"',
    ].join("\n");

    const renames = renameSourcesByHeadPath(diff);

    expect([...renames.values()]).toEqual(["src/old.ts"]);
    expect([...renames.keys()][0]).toContain("caf");
  });

  // The rename case still works, and now rests on the metadata rather than on
  // the paths merely differing.
  it("requires rename metadata, not just differing paths", () => {
    const withMeta = [
      "diff --git a/src/old.ts b/src/new.ts",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    const withoutMeta = "diff --git a/src/old.ts b/src/new.ts";

    expect(renameSourcesByHeadPath(withMeta).get("src/new.ts")).toBe("src/old.ts");
    expect(renameSourcesByHeadPath(withoutMeta).has("src/new.ts")).toBe(false);
  });

  // Base line numbers only advance on removed and CONTEXT lines. Counting an
  // added line would slide every later position, and a position that is off by
  // one suppresses the wrong occurrence — or none.
  it("numbers removals by their base-side line, ignoring additions", () => {
    const diff = [
      "diff --git a/src/http.ts b/src/http.ts",
      "--- a/src/http.ts",
      "+++ b/src/http.ts",
      "@@ -10,4 +10,4 @@",
      " const before = 1;",
      "+const added = 2;",
      "-const gone = budget(1);",
      " const after = 3;",
      "-const alsoGone = 4;",
    ].join("\n");

    const removed = removedLinesByFile(diff);

    expect(removed.get("src/http.ts")?.byLine.get(11)).toBe("const gone = budget(1);");
    expect(removed.get("src/http.ts")?.byLine.get(13)).toBe("const alsoGone = 4;");
    expect(removed.get("src/http.ts")?.positioned).toBe(true);
  });

  // An unparseable hunk header makes every later position a guess, and a wrong
  // position is worse than none: it would fail to suppress an occurrence the
  // diff really deleted. The whole-file text stays usable as a fallback.
  it("marks a file unpositioned when a hunk header cannot be parsed", () => {
    const diff = [
      "diff --git a/src/http.ts b/src/http.ts",
      "--- a/src/http.ts",
      "+++ b/src/http.ts",
      "@@ nonsense @@",
      "-const gone = budget(1);",
    ].join("\n");

    const removed = removedLinesByFile(diff);

    expect(removed.get("src/http.ts")?.positioned).toBe(false);
    expect(removed.get("src/http.ts")?.text).toContain("budget(1)");
  });
});
