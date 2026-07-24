// Which (file, line) pairs in a code-review diff can carry an inline comment.
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

export interface DiffPositionEndpoint {
  readonly type: "old" | "new";
  readonly oldLine?: number;
  readonly newLine: number;
}

export interface DiffPositionRange {
  readonly oldPath: string;
  readonly newPath: string;
  readonly start: DiffPositionEndpoint;
  readonly end: DiffPositionEndpoint;
  readonly sameHunk: true;
}

interface PositionedLine {
  endpoint: DiffPositionEndpoint;
  hunk: number;
  oldPath: string;
  newPath: string;
}

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@`. The counts are optional and
// default to 1 when omitted (git emits `@@ -3 +4 @@` for single-line hunks).
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function commentableLines(diff: string): CommentableLines {
  const result: CommentableLines = new Map();
  for (const [file, lines] of positionedLines(diff)) {
    result.set(file, new Set(lines.keys()));
  }
  return result;
}

/**
 * True iff `file`:`line` is a valid new-side inline anchor.
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

/**
 * True iff EVERY line in `start`..`end` (inclusive) is commentable.
 *
 * ADR-007's committable suggestions replace a whole line range, and GitHub
 * requires that range to lie within a SINGLE hunk — it 422s the entire review
 * otherwise, killing every inline comment on the run. Checking only the endpoints
 * is unsound, because this module merges a file's hunks into one set: two lines in
 * DIFFERENT hunks would both pass while the lines between them are not in the diff
 * at all.
 *
 * Because context lines are part of the anchor set, "every line in the range is
 * commentable" is exactly equivalent to "the range is inside one hunk".
 */
export function rangeIsCommentable(
  map: CommentableLines,
  file: string,
  start: number,
  end: number,
): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return false;
  const lines = map.get(file);
  if (!lines) return false;
  for (let line = start; line <= end; line += 1) {
    if (!lines.has(line)) return false;
  }
  return true;
}

/**
 * Resolves new-side finding lines into provider-neutral diff coordinates.
 * Context lines deliberately use `type: "old"` while retaining both counters;
 * added lines use `type: "new"` and have no old counter.
 */
export function diffPositionRange(
  diff: string,
  file: string,
  startLine: number,
  endLine = startLine,
): DiffPositionRange | undefined {
  const positions = positionedLines(diff).get(file);
  const start = positions?.get(startLine);
  const end = positions?.get(endLine);
  if (!start || !end || start.hunk !== end.hunk) return undefined;
  return {
    oldPath: start.oldPath,
    newPath: start.newPath,
    start: start.endpoint,
    end: end.endpoint,
    sameHunk: true,
  };
}

function positionedLines(diff: string): Map<string, Map<number, PositionedLine>> {
  const result = new Map<string, Map<number, PositionedLine>>();
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let hunk = 0;
  interface PendingHunk {
    oldLine: number;
    newLine: number;
    oldRemaining: number;
    newRemaining: number;
    readonly oldPath: string;
    readonly newPath: string;
    readonly hunk: number;
    readonly staged: Map<number, PositionedLine>;
  }
  let pending: PendingHunk | undefined;

  const complete = (): boolean =>
    pending !== undefined && pending.oldRemaining === 0 && pending.newRemaining === 0;
  const commit = (): void => {
    if (!pending || !complete()) {
      pending = undefined;
      return;
    }
    let fileLines = result.get(pending.newPath);
    if (!fileLines) {
      fileLines = new Map();
      result.set(pending.newPath, fileLines);
    }
    // Earlier validated hunks win. A malformed or unusual later overlapping
    // hunk can therefore never overwrite a known-good provider position.
    for (const [line, position] of pending.staged) {
      if (!fileLines.has(line)) fileLines.set(line, position);
    }
    pending = undefined;
  };
  const discard = (): void => {
    pending = undefined;
  };
  const record = (endpoint: DiffPositionEndpoint): void => {
    if (!pending) return;
    pending.staged.set(endpoint.newLine, {
      endpoint,
      hunk: pending.hunk,
      oldPath: pending.oldPath,
      newPath: pending.newPath,
    });
  };
  const prematureBoundary = (rawLine: string): boolean =>
    rawLine.startsWith("diff --git ") ||
    HUNK_RE.test(rawLine) ||
    (rawLine.startsWith("--- ") && pending?.oldRemaining === 0) ||
    (rawLine.startsWith("+++ ") && pending?.newRemaining === 0);

  for (const rawLine of diff.split("\n")) {
    if (pending && !complete() && prematureBoundary(rawLine)) {
      // A new file/header/hunk before the declared counts are consumed makes
      // the current hunk incomplete. Discard it, then parse the boundary.
      discard();
    }

    if (pending && !complete()) {
      const marker = rawLine[0];
      if (marker === "+") {
        if (pending.newRemaining <= 0) {
          discard();
          continue;
        }
        record({ type: "new", oldLine: undefined, newLine: pending.newLine });
        pending.newLine += 1;
        pending.newRemaining -= 1;
      } else if (marker === "-") {
        if (pending.oldRemaining <= 0) {
          discard();
          continue;
        }
        pending.oldLine += 1;
        pending.oldRemaining -= 1;
      } else if (marker === "\\") {
        // `\ No newline at end of file` consumes neither side.
      } else if (marker === " ") {
        if (pending.oldRemaining <= 0 || pending.newRemaining <= 0) {
          discard();
          continue;
        }
        record({
          type: "old",
          oldLine: pending.oldLine,
          newLine: pending.newLine,
        });
        pending.oldLine += 1;
        pending.newLine += 1;
        pending.oldRemaining -= 1;
        pending.newRemaining -= 1;
      } else {
        discard();
      }
      continue;
    }

    if (pending && complete()) {
      if (rawLine === "") continue;
      if (rawLine.startsWith("\\")) continue;
      if (rawLine.startsWith("+") || rawLine.startsWith("-") || rawLine.startsWith(" ")) {
        // Extra diff content beyond the declared counts invalidates the hunk.
        discard();
        continue;
      }
      commit();
    }

    if (rawLine.startsWith("diff --git ")) {
      oldPath = undefined;
      newPath = undefined;
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      const path = rawLine.slice(4).trim();
      oldPath = path === "/dev/null" ? "/dev/null" : stripOldDiffPathPrefix(path);
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const path = rawLine.slice(4).trim();
      newPath = path === "/dev/null" ? undefined : stripDiffPathPrefix(path);
      continue;
    }
    const match = HUNK_RE.exec(rawLine);
    if (!match || !oldPath || !newPath) continue;
    hunk += 1;
    pending = {
      oldLine: Number(match[1]),
      oldRemaining: match[2] === undefined ? 1 : Number(match[2]),
      newLine: Number(match[3]),
      newRemaining: match[4] === undefined ? 1 : Number(match[4]),
      oldPath,
      newPath,
      hunk,
      staged: new Map(),
    };
  }
  if (complete()) commit();
  else discard();
  return result;
}

function stripOldDiffPathPrefix(target: string): string {
  return target.startsWith("a/") ? target.slice(2) : target;
}
