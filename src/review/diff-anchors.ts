// Which (file, line) pairs in a PR's diff can carry an INLINE review comment.
//
// This exists because of a hard GitHub constraint: `POST /pulls/{n}/reviews`
// rejects the ENTIRE request with 422 if even one comment targets a line that
// isn't part of the diff. One bad anchor loses every finding in the review. So
// rather than post hopefully and handle failure, we decide up front — from the
// same diff we already fetched — exactly which lines are addressable, and route
// everything else to the summary comment instead.
//
// "Addressable" means: present on the RIGHT (new-file) side of a hunk, i.e. an
// added (`+`) or context (` `) line. A removed (`-`) line exists only on the
// LEFT side and cannot carry a RIGHT-side comment.
//
// Pure and synchronous — no I/O, no network. Never throws: a malformed or
// unfamiliar diff simply yields fewer anchors, which degrades to "put it in the
// summary comment", never to a crash or a lost finding.

/** file path (new-file, repo-relative) -> set of commentable NEW-file line numbers. */
export type CommentableLines = Map<string, Set<number>>;

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@`. The counts are optional and
// default to 1 when omitted (git emits `@@ -3 +4 @@` for single-line hunks).
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function commentableLines(diff: string): CommentableLines {
  const result: CommentableLines = new Map();

  let currentFile: string | undefined;
  let newLine = 0;
  // Lines still expected in the current hunk, from the hunk header's own counts.
  // Counting them out is what makes this parser safe against DIFF CONTENT that
  // looks like diff SYNTAX: inside a hunk we consume exactly as many lines as the
  // header declared, so an added line whose text happens to be `++ b/victim.ts`
  // (raw line: `+++ b/victim.ts`) is treated as CONTENT, never as a file header.
  // Without this bound, a PR that merely adds a diff fixture — this repo's own
  // test files are that shape — could steer anchors onto a file it never touched,
  // and GitHub 422s the ENTIRE review. It also stops the counter from running off
  // the end of the last hunk into trailing blank lines.
  let oldRemaining = 0;
  let newRemaining = 0;

  const inHunk = (): boolean => oldRemaining > 0 || newRemaining > 0;

  for (const rawLine of diff.split("\n")) {
    if (inHunk()) {
      // Inside a hunk, the FIRST character is the only thing that matters. No
      // header patterns are considered here — that is the whole point.
      const marker = rawLine[0];
      if (marker === "+") {
        if (currentFile) addLine(result, currentFile, newLine);
        newLine += 1;
        newRemaining -= 1;
      } else if (marker === "-") {
        // Left side only: must NOT advance the new-file counter, or every
        // subsequent anchor in this hunk is off by one.
        oldRemaining -= 1;
      } else if (marker === "\\") {
        // `\ No newline at end of file` — metadata attached to the PREVIOUS line.
        // It consumes no line from either side. (Routing it anywhere else would
        // silently drop the rest of the hunk.)
      } else if (marker === " " || rawLine === "") {
        // Context: present on BOTH sides, so it needs a line remaining on each.
        // An empty string is an unchanged empty line whose single leading space
        // some producers strip — but it is ALSO what a trailing blank line looks
        // like. Requiring both counters is what stops a hunk whose header lies
        // (or a diff with trailing newlines) from emitting a phantom anchor one
        // line past the hunk, which would 422 the whole review.
        if (oldRemaining <= 0 || newRemaining <= 0) {
          oldRemaining = 0;
          newRemaining = 0;
          continue;
        }
        if (currentFile) addLine(result, currentFile, newLine);
        newLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
      } else {
        // Malformed: the hunk claimed more lines than it delivered. Abandon it
        // rather than mis-attribute anchors.
        oldRemaining = 0;
        newRemaining = 0;
      }
      continue;
    }

    // --- Outside a hunk: header territory. ---
    if (rawLine.startsWith("diff --git ")) {
      currentFile = undefined;
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      currentFile = target === "/dev/null" ? undefined : stripDiffPathPrefix(target);
      continue;
    }

    if (rawLine.startsWith("--- ")) continue; // old-side header

    const hunk = HUNK_RE.exec(rawLine);
    if (hunk) {
      // `@@ -oldStart[,oldCount] +newStart[,newCount] @@`; an omitted count is 1.
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
    }
  }

  return result;
}

/**
 * True iff an inline comment on `file`:`line` would be accepted by GitHub.
 *
 * A finding with no line (`line: null`, per the JSON contract) can never be
 * anchored — it belongs in the summary comment.
 */
export function isCommentable(
  map: CommentableLines,
  file: string,
  line: number | null | undefined,
): boolean {
  if (typeof line !== "number") return false;
  return map.get(file)?.has(line) ?? false;
}

function addLine(map: CommentableLines, file: string, line: number): void {
  const existing = map.get(file);
  if (existing) existing.add(line);
  else map.set(file, new Set([line]));
}

// `+++ b/src/a.go` → `src/a.go`. git prefixes the new side with `b/` by default,
// but `--no-prefix` (and some providers) omit it, so only strip when present.
function stripDiffPathPrefix(target: string): string {
  return target.startsWith("b/") ? target.slice(2) : target;
}

/**
 * Every file the diff touches, in first-seen order — including deletions, which
 * have no right-hand side and therefore never appear in `commentableLines`.
 * Used for the summary's "Files reviewed" list.
 */
export function changedFiles(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split("\n")) {
    // `diff --git a/<old> b/<new>` — take the NEW path (the b/ side).
    const match = /^diff --git a\/(?:.+) b\/(.+)$/.exec(line);
    if (!match) continue;
    const file = match[1].trim();
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}
