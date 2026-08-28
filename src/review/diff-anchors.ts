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

  // Unquoted first operand, quoted second — but only when the quote opens
  // right after the separating space. A quote anywhere else is a LITERAL one
  // inside an unquoted path, which the oversized-diff fallback really does
  // emit: `reconstructDiffFromFiles` (github-large-diff.ts) writes paths into
  // the header without C-quoting them, so `foo"bar.ts` arrives as
  // `a/foo"bar.ts b/foo"bar.ts`. Those fall through to the unquoted branch
  // rather than being rejected.
  if (quote > 0 && rest[quote - 1] === " ") {
    const second = readQuotedPath(rest.slice(quote));
    if (second === undefined || second.end !== rest.length - quote) return undefined;
    return stripSides(rest.slice(0, quote - 1).trim(), second.value);
  }

  // Both unquoted (or carrying a literal quote, per above). Kept greedy on the
  // a/ side exactly as before: a path may contain a space, which git does NOT
  // quote, so there is no unambiguous split.
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

/**
 * Head path -> base path, for the files this diff renames.
 *
 * Anything that compares a finding's file against the BASE tree needs this: the
 * finding names the head path, and the base holds the same code under the old
 * one. Only genuine renames are included — an unchanged path maps to itself and
 * is left out, so the map is empty for the common case.
 */
export function renameSourcesByHeadPath(diff: string): Map<string, string> {
  const renames = new Map<string, string>();
  let pending: { readonly a: string; readonly b: string } | undefined;
  for (const line of diff.split("\n")) {
    const header = parseDiffGitHeader(line);
    if (header !== undefined) {
      pending = header.a && header.b && header.a !== header.b ? header : undefined;
      continue;
    }
    // Differing paths are NOT enough. A COPY diff also has two paths, and
    // treating the source as "this file at the base commit" excludes the
    // original — still present, still referencing the symbol — from external
    // matches, hiding the clearest evidence against a "no other references"
    // claim (Codex review, round 8). Only `rename from`/`rename to` means the
    // base tree holds this same file under the other name.
    //
    // Safe on the oversized-diff path too: `reconstructDiffFromFiles` emits
    // `rename`/`copy` metadata from GitHub's own file status, so a real rename
    // is still recognised there.
    if (pending !== undefined && line.startsWith("rename from ")) {
      renames.set(pending.b, pending.a);
      pending = undefined;
    }
  }
  return renames;
}

/**
 * What a reviewed diff DELETES from each file, positioned where it can be.
 *
 * The structural check reads the BASE commit while the finding is about the
 * head, so an occurrence it found may be one of the very lines this pull
 * request removes. This is the evidence for deciding that.
 *
 * Keyed by BOTH sides of the `diff --git` header, because a rename makes them
 * differ and a caller may hold either. `checkStructuralClaim` reports
 * BASE-relative paths while the header's right-hand side is the HEAD path, so
 * keying by one alone silently missed every renamed file — the reconciliation
 * failing on a superset of its own motivating case (CodeRabbit review).
 */
export interface RemovedLines {
  /**
   * Base-side line number -> the text removed from it.
   *
   * Base line numbers and the diff's old-side numbers are the same coordinates
   * by construction: both count lines in the file at the base commit. That is
   * what lets a single untouched caller survive in a file that also loses one.
   */
  readonly byLine: ReadonlyMap<number, string>;
  /** Every removed line in the file, joined. The fallback when `positioned` is false. */
  readonly text: string;
  /**
   * False when a hunk header could not be parsed, so `byLine` is incomplete.
   *
   * The oversized-diff path reconstructs headers itself, so untrustworthy
   * positions are a real possibility rather than a theoretical one. Callers
   * fall back to the whole-file text there, which over-suppresses instead of
   * publishing an accusation about a line the pull request deleted.
   */
  readonly positioned: boolean;
}

export function removedLinesByFile(diff: string): Map<string, RemovedLines> {
  interface Accumulator {
    readonly byLine: Map<number, string>;
    text: string;
    positioned: boolean;
  }
  const removed = new Map<string, Accumulator>();
  // Aliasing is gated on real rename metadata, not merely differing paths: a
  // COPY's removed lines belong to the new file, and recording them under the
  // source path would suppress occurrences in a file the diff never touched.
  const renameSources = renameSourcesByHeadPath(diff);
  let keys: readonly string[] = [];
  let oldLine: number | undefined;
  // `---`/`+++` are FILE HEADERS only BEFORE the first hunk. Inside a hunk they
  // are content: a removed line whose text starts with `--` — a decrement, say
  // `--budget;` — is written `---budget;`, and skipping it both lost the
  // removal AND slid every later base line number in that file by one (Codex
  // review, round 7). Tracked separately from `oldLine`, which is undefined
  // when a hunk header could not be parsed even though we are inside a hunk.
  let inHunk = false;

  const each = (visit: (entry: Accumulator) => void): void => {
    for (const key of keys) {
      let entry = removed.get(key);
      if (entry === undefined) {
        entry = { byLine: new Map(), text: "", positioned: true };
        removed.set(key, entry);
      }
      visit(entry);
    }
  };

  for (const line of diff.split("\n")) {
    const header = parseDiffGitHeader(line);
    if (header !== undefined) {
      const head = header.b || header.a;
      const base = renameSources.get(head);
      keys = (base === undefined ? [head] : [base, head]).filter((value) => value !== "");
      oldLine = undefined;
      inHunk = false;
      continue;
    }
    if (keys.length === 0) continue;

    if (line.startsWith("@@")) {
      inHunk = true;
      const hunk = HUNK_RE.exec(line);
      if (hunk === null) {
        // Unparseable header: every later position in this file is a guess.
        oldLine = undefined;
        each((entry) => { entry.positioned = false; });
      } else {
        oldLine = Number(hunk[1]);
      }
      continue;
    }
    if (!inHunk && (line.startsWith("---") || line.startsWith("+++"))) continue;
    // "\ No newline at end of file" belongs to the line before it.
    if (line.startsWith("\\")) continue;

    if (line.startsWith("-")) {
      const text = line.slice(1);
      const at = oldLine;
      each((entry) => {
        entry.text = `${entry.text}\n${text}`;
        if (at === undefined) entry.positioned = false;
        else entry.byLine.set(at, text);
      });
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) continue;
    // A context line advances the base side; so does the blank line git writes
    // for an empty context line.
    if (oldLine !== undefined) oldLine += 1;
  }

  return new Map([...removed].map(([key, entry]) => [key, {
    byLine: entry.byLine,
    text: entry.text,
    positioned: entry.positioned,
  }]));
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

const NEEDS_GIT_QUOTING = /["\\\u0000-\u001f\u007f]/u;

const C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\u0007", "\\a"], ["\b", "\\b"], ["\f", "\\f"], ["\n", "\\n"],
  ["\r", "\\r"], ["\t", "\\t"], ["\v", "\\v"], ['"', '\\"'], ["\\", "\\\\"],
]);

/**
 * Renders one `diff --git` operand the way git would.
 *
 * A path with none of the characters git escapes is emitted bare, which is
 * exactly git's own output for it; anything containing a quote, a backslash or
 * a control character is C-quoted. Callers that BUILD a diff header must use
 * this: a raw interpolation produces a header git would never emit, and a
 * parser written against git's format then has to guess — which is how
 * `foo"bar.ts` and `foo "bar.ts` each became their own parsing defect.
 */
export function quoteGitPathOperand(prefix: "a" | "b", filePath: string): string {
  const full = `${prefix}/${filePath}`;
  if (!NEEDS_GIT_QUOTING.test(full)) return full;
  let quoted = '"';
  for (const character of full) {
    const escape = C_ESCAPES.get(character);
    if (escape !== undefined) {
      quoted += escape;
      continue;
    }
    const code = character.codePointAt(0)!;
    quoted += code < 0x20 || code === 0x7f
      ? `\\${code.toString(8).padStart(3, "0")}`
      : character;
  }
  return `${quoted}"`;
}
