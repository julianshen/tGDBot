// Which (file, line) pairs in a code-review diff can carry an inline comment.
//
// Providers accept inline comments only at eligible diff positions, with
// provider-specific batching and error behavior handled by their adapters.
// Rather than post hopeful anchors, shared orchestration decides up front from
// the fetched diff which lines are addressable and routes everything else to
// the summary.
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

export interface PositionedLine {
  endpoint: DiffPositionEndpoint;
  hunk: number;
  oldPath: string;
  newPath: string;
}

/** Parsed diff positions, reusable across all findings in one orchestration. */
export type DiffPositions = Map<string, Map<number, PositionedLine>>;

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@`. The counts are optional and
// default to 1 when omitted (git emits `@@ -3 +4 @@` for single-line hunks).
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function commentableLines(diff: string | DiffPositions): CommentableLines {
  const result: CommentableLines = new Map();
  const positions = typeof diff === "string" ? parseDiffPositions(diff) : diff;
  for (const [file, lines] of positions) {
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
/**
 * Git quotes a path in the `diff --git` header whenever it contains a byte
 * outside the printable ASCII range (or a quote or backslash), producing
 * `diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"` under the default
 * `core.quotePath`. A plain `a/... b/...` regex misses those files entirely,
 * so they vanish from the summary's file list, from changed-line matching, and
 * from the trusted-base context selection — where the pack then reports that
 * no graph nodes matched.
 *
 * Returns the two sides with their `a/` and `b/` prefixes already removed, or
 * undefined when the line is not a `diff --git` header.
 */
export function parseDiffGitHeader(line: string): { readonly a: string; readonly b: string } | undefined {
  const rest = line.startsWith("diff --git ") ? line.slice("diff --git ".length) : undefined;
  if (rest === undefined) return undefined;

  // Each operand is quoted independently, so a rename from an ASCII name to
  // one git must quote yields a MIXED header: `a/old.ts "b/caf\303\251.ts"`.
  // Git quotes any path containing a double quote, so an unquoted operand can
  // never contain one — which makes the first `"` in the line, wherever it
  // falls, the unambiguous start of a quoted operand.
  const quote = rest.indexOf('"');

  if (quote === 0) {
    const first = readQuotedPath(rest);
    if (first === undefined || !rest.startsWith(" ", first.end)) return undefined;
    const secondRaw = rest.slice(first.end + 1);
    const second = secondRaw.startsWith('"')
      ? readQuotedPath(secondRaw)
      : { value: secondRaw, end: secondRaw.length };
    if (second === undefined || second.end !== secondRaw.length) return undefined;
    return stripSides(first.value, second.value);
  }

  if (quote > 0) {
    // Unquoted first operand, quoted second. The quote must open right after
    // the separating space.
    if (rest[quote - 1] !== " ") return undefined;
    const second = readQuotedPath(rest.slice(quote));
    if (second === undefined || second.end !== rest.length - quote) return undefined;
    return stripSides(rest.slice(0, quote - 1).trim(), second.value);
  }

  // Both unquoted. Kept greedy on the a/ side exactly as before: a path may
  // contain a space, which git does NOT quote, so there is no unambiguous split.
  const match = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (!match) return undefined;
  return stripSides(`a/${match[1]!.trim()}`, `b/${match[2]!.trim()}`);
}

function stripSides(first: string, second: string): { a: string; b: string } | undefined {
  if (!first.startsWith("a/") || !second.startsWith("b/")) return undefined;
  const a = first.slice(2);
  const b = second.slice(2);
  // A decoded `\n` or `\t` escape is a real control BYTE. Two consumers cannot
  // take one: `normalizeChangedFile` rejects control characters, so a single
  // such file would take the whole context down with it (and abort the review
  // outright under `--context require`); and the summary renders each path
  // inside a backtick span, where a newline breaks out of it. Git permits
  // these names, but the honest handling here is to omit the file — exactly
  // what the unquoted-only regex did before quoted parsing existed — rather
  // than to let one pathological filename cost the review its context.
  if (CONTROL_CHARACTERS.test(a) || CONTROL_CHARACTERS.test(b)) return undefined;
  return { a, b };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '"': '"', "\\": "\\",
};

/**
 * Reads one C-style quoted path, decoding `\nnn` octal escapes as raw bytes so
 * a multi-byte UTF-8 name reassembles correctly rather than one mojibake
 * character per byte.
 */
function readQuotedPath(input: string): { value: string; end: number } | undefined {
  const bytes: number[] = [];
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      return { value: Buffer.from(bytes).toString("utf8"), end: index + 1 };
    }
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const next = input[index + 1];
    if (next === undefined) return undefined;
    if (next >= "0" && next <= "7") {
      const octal = input.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/.test(octal)) return undefined;
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const mapped = ESCAPES[next];
    if (mapped === undefined) return undefined;
    bytes.push(...Buffer.from(mapped, "utf8"));
    index += 1;
  }
  return undefined;
}

export function changedFiles(diff: string): string[] {
  return collectChangedPaths(diff, (header) => [header.b]);
}

/**
 * Every path the diff touches on BOTH sides: the head-side `b/` path first,
 * then the base-side `a/` path when it differs — which it only does for a
 * rename or a copy.
 *
 * `changedFiles` above is deliberately head-side only, because its callers
 * (the summary's "files reviewed" list, and matching review threads to changed
 * lines) are talking about the code as it is now. Trusted-base context is the
 * one consumer that needs the other side: the repository map is built from the
 * BASE commit, so a renamed file is still filed there under its OLD path, and
 * matching only the new one finds nothing — a rename-only PR would get a pack
 * reporting no matching graph nodes and none of the callers this is for.
 *
 * Added files legitimately match nothing: they do not exist at the base.
 */
export function changedFilesWithRenameSources(diff: string): string[] {
  return collectChangedPaths(diff, (header) => [header.b, header.a]);
}

function collectChangedPaths(
  diff: string,
  select: (header: { readonly a: string; readonly b: string }) => readonly string[],
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split("\n")) {
    const header = parseDiffGitHeader(line);
    if (header === undefined) continue;
    for (const file of select(header)) {
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/** One rendered line of a fallback excerpt, with its diff marker preserved. */
export interface SnippetLine {
  /** `+` added, `-` removed, ` ` context — as it appears in the diff. */
  readonly marker: " " | "+" | "-";
  readonly text: string;
  /** NEW-file line number; undefined for a removed line (it has no right side). */
  readonly newLine: number | undefined;
  /** True when this line is inside the finding's own range. */
  readonly target: boolean;
}

export interface HunkSnippet {
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly SnippetLine[];
}

/**
 * The diff excerpt around `line`..`endLine`, for a finding that could NOT be
 * shown inline.
 *
 * An inline comment sits on the diff, so the provider renders the surrounding
 * code for free. A finding relocated to the summary loses exactly that, and
 * becomes a claim about code the reader has to go and find. This recovers it.
 *
 * Presentation only — never consulted when deciding whether a line is
 * anchorable. That keeps it free to be forgiving where `parseDiffPositions` is
 * strict: a hunk whose declared counts don't add up still yields a usable
 * excerpt here, and the worst case is `undefined` (the entry renders without
 * context) rather than a lost finding.
 */
export function hunkSnippet(
  diff: string,
  file: string,
  line: number | null | undefined,
  endLine?: number,
  context = 3,
): HunkSnippet | undefined {
  if (typeof line !== "number" || !Number.isInteger(line)) return undefined;
  const last = Number.isInteger(endLine) && (endLine as number) > line ? (endLine as number) : line;

  let newPath: string | undefined;
  let newLine = 0;
  // Two separate facts. `insideHunk` says we are in SOME file's hunk body, where
  // `--- `/`+++ ` are content rather than headers; `capturing` narrows that to
  // the file being searched.
  let insideHunk = false;
  let capturing = false;
  let lines: SnippetLine[] = [];

  // The excerpt is whichever hunk contains the range's FIRST line: a finding's
  // range is single-hunk by construction (see rangeIsCommentable).
  const finish = (): HunkSnippet | undefined => {
    const first = lines.findIndex((l) => l.target);
    if (first === -1) return undefined;
    let end = first;
    for (let i = lines.length - 1; i >= first; i -= 1) {
      if (lines[i]!.target) {
        end = i;
        break;
      }
    }
    return {
      startLine: line,
      endLine: last,
      lines: lines.slice(Math.max(0, first - context), end + context + 1),
    };
  };

  for (const raw of diff.split("\n")) {
    // `diff --git ` is the only header that stays unambiguous inside a hunk: a
    // removed line renders as `-` + content and an added one as `+` + content,
    // so neither can ever produce this prefix.
    if (raw.startsWith("diff --git ")) {
      if (capturing) {
        const found = finish();
        if (found) return found;
      }
      insideHunk = false;
      capturing = false;
      newPath = undefined;
      continue;
    }
    // `--- ` and `+++ ` are file headers ONLY outside a hunk body. Inside one
    // they are ordinary content: a removed line whose text starts "-- " renders
    // as "--- ", and an added line starting "++ " renders as "+++ ". Markdown
    // rules and SQL comments produce these constantly, and reading them as
    // headers truncated the hunk and lost the excerpt.
    if (!insideHunk) {
      if (raw.startsWith("--- ")) continue;
      if (raw.startsWith("+++ ")) {
        const path = raw.slice(4).trim();
        newPath = path === "/dev/null" ? undefined : stripDiffPathPrefix(path);
        continue;
      }
    }
    // A hunk header is likewise unambiguous: content would carry a leading
    // marker character before the `@@`.
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      if (capturing) {
        const found = finish();
        if (found) return found;
      }
      newLine = Number(hunk[3]);
      insideHunk = true;
      capturing = newPath === file;
      lines = [];
      continue;
    }
    if (!insideHunk) continue;
    if (!capturing) {
      // Still consume the body so a later hunk header is read in the right
      // state, but nothing from another file is ever recorded.
      if (!/^[-+ \\]/u.test(raw)) insideHunk = false;
      continue;
    }

    const marker = raw[0];
    if (marker === "+" || marker === " ") {
      lines.push({
        marker,
        text: raw.slice(1),
        newLine,
        target: newLine >= line && newLine <= last,
      });
      newLine += 1;
    } else if (marker === "-") {
      lines.push({ marker, text: raw.slice(1), newLine: undefined, target: false });
    } else if (marker === "\\") {
      // `\ No newline at end of file` is not a line of either side.
    } else {
      const found = finish();
      if (found) return found;
      insideHunk = false;
      capturing = false;
    }
  }
  return capturing ? finish() : undefined;
}

/**
 * True iff EVERY line in `start`..`end` (inclusive) is commentable.
 *
 * ADR-007's committable suggestions replace a whole line range, which must lie
 * within a SINGLE hunk for provider-neutral position construction. Checking
 * only the endpoints is unsound, because this module merges a file's hunks into
 * one set: two lines in DIFFERENT hunks would both pass while the lines between
 * them are not in the diff at all.
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
  diff: string | DiffPositions,
  file: string,
  startLine: number,
  endLine = startLine,
): DiffPositionRange | undefined {
  const positions =
    (typeof diff === "string" ? parseDiffPositions(diff) : diff).get(file);
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

export function parseDiffPositions(diff: string): DiffPositions {
  const result: DiffPositions = new Map();
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
      oldPath: oldPath === "/dev/null" ? newPath : oldPath,
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
