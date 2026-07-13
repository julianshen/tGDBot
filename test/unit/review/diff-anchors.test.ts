// GitHub rejects the ENTIRE review request (422) if any inline comment targets a
// line that isn't part of the diff. So before anchoring a finding we must know,
// from the diff itself, exactly which (file, line) pairs are commentable.
//
// Commentable = a line present on the RIGHT (new-file) side of a hunk — i.e. an
// added (`+`) or context (` `) line. Removed (`-`) lines exist only on the LEFT
// and cannot carry a RIGHT-side comment.
import { describe, expect, it } from "vitest";
import { commentableLines, isCommentable } from "../../../src/review/diff-anchors.js";

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
+only
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
    const diff = "diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -1,1 +1,1 @@\n+only\n\n\n";
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
