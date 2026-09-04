// Issue #114: the finding location is the last model-supplied input tGDBot
// publishes on trust. Everywhere else the pattern is host verification — a
// structural claim is re-derived against the base tree, a citation must
// appear in the rule's own text, a suggestion is provenance-checked. This
// module closes that gap: the reviewer returns a verbatim excerpt of the code
// it is commenting on (`existingCode`), and the host derives the location by
// finding that excerpt in the diff.
//
// The refusal rule is the whole point, and it is deliberately strict: the
// excerpt must match EXACTLY ONE location across the changed files. Zero
// matches means the reviewer quoted something that is not in this change;
// multiple matches means the same boilerplate legitimately appears in several
// places and guessing between them would trade one wrong location for
// another. Both decline — the caller drops the model's line and the finding
// falls to the summary, exactly like any other unanchorable finding.
//
// Matching is whitespace-insensitive per line (leading/trailing whitespace
// stripped, blank lines ignored on both sides) because models quote reliably
// but count indentation unreliably; everything else is verbatim. Lines never
// match ACROSS hunk boundaries — the last line of one hunk and the first of
// the next are not contiguous in the source. The search covers the finding's
// own file first and every other changed file after it — reviewers reading
// related files do sometimes quote the source file while filing against the
// header, and a unique match re-files the whole finding.

import { parseDiffGitHeader } from "./diff-anchors.js";

export interface QuoteAnchorResult {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
}

/** A non-blank added or context line on the new side of one file's diff. */
export interface NewSideLine {
  readonly newLine: number;
  readonly text: string;
}

/**
 * Cap on the normalized excerpt — a quote longer than this is not a quote.
 * Over the cap DECLINES rather than truncates: accepting a prefix would
 * verify a quote whose remaining lines occur nowhere in the diff (PR #130
 * review).
 */
const MAX_EXCERPT_LINES = 50;

/**
 * New-side lines (added and context, blanks dropped) per file, grouped by
 * HUNK. Grouping is load-bearing: the last recorded line of one hunk and the
 * first of the next are not contiguous in the source, so a multi-line match
 * must never span two hunks. Reuses the git-header and hunk-header handling
 * of diff-anchors' parsers.
 */
export function newSideHunksByFile(diff: string): Map<string, NewSideLine[][]> {
  const byFile = new Map<string, NewSideLine[][]>();
  let currentFile: string | undefined;
  let currentHunk: NewSideLine[] = [];
  let newLine: number | undefined;

  const endHunk = (): void => {
    if (currentFile !== undefined && currentHunk.length > 0) {
      const hunks = byFile.get(currentFile) ?? [];
      hunks.push(currentHunk);
      byFile.set(currentFile, hunks);
    }
    currentHunk = [];
    newLine = undefined;
  };

  for (const line of diff.split("\n")) {
    const header = parseDiffGitHeader(line);
    if (header !== undefined) {
      endHunk();
      currentFile = header.b;
      continue;
    }
    if (currentFile === undefined) continue;
    if (line.startsWith("@@")) {
      // A hunk boundary within the same file (multi-hunk diffs).
      endHunk();
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = match === null ? undefined : Number.parseInt(match[1] as string, 10);
      continue;
    }
    if (newLine === undefined) continue;
    let text: string | undefined;
    if (line.startsWith("+")) text = line.slice(1);
    else if (line.startsWith("-") || line.startsWith("\\")) continue;
    else if (line.startsWith(" ")) text = line.slice(1);
    else {
      // Anything else (empty trailing line, malformed row) ends the hunk.
      endHunk();
      continue;
    }
    // Blank lines are dropped: matching is per-line, and a blank source line
    // must not break a quote that spans it. Hunk boundaries are what remain.
    if (text.trim().length === 0) {
      newLine += 1;
      continue;
    }
    currentHunk.push({ newLine, text });
    newLine += 1;
  }
  endHunk();
  return byFile;
}

/**
 * Occurrences of the excerpt within ONE hunk's lines, as `{ line, endLine }`
 * per match. Whitespace-insensitive per line, contiguous runs required.
 */
function matchesInHunk(lines: readonly NewSideLine[], excerpt: readonly string[]): Array<{ line: number; endLine?: number }> {
  const normalized = lines.map((entry) => ({ newLine: entry.newLine, text: entry.text.trim() }));
  const matches: Array<{ line: number; endLine?: number }> = [];
  if (excerpt.length === 1) {
    const wanted = excerpt[0] as string;
    for (const entry of normalized) {
      if (entry.text === wanted) matches.push({ line: entry.newLine });
    }
    return matches;
  }
  for (let start = 0; start + excerpt.length <= normalized.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < excerpt.length; offset += 1) {
      if (normalized[start + offset]?.text !== excerpt[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const first = normalized[start] as { newLine: number };
      const last = normalized[start + excerpt.length - 1] as { newLine: number };
      matches.push({ line: first.newLine, endLine: last.newLine });
    }
  }
  return matches;
}

/**
 * Resolves a reviewer's verbatim excerpt to a location in the diff.
 *
 * Returns the unique match — searching the finding's own file first, then
 * every other changed file — or `undefined` when the excerpt matches zero or
 * multiple locations, or is longer than the excerpt cap. `undefined` means
 * "declined": the caller drops the model-supplied line rather than publishing
 * a location no quote supports.
 */
export function resolveQuoteAnchor(
  diff: string,
  findingFile: string,
  existingCode: string,
): QuoteAnchorResult | undefined {
  const excerpt = existingCode
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Over the cap declines — WITHOUT truncating. A truncated prefix matching
  // the diff would verify a quote whose remaining lines exist nowhere (PR
  // #130 review).
  if (excerpt.length === 0 || excerpt.length > MAX_EXCERPT_LINES) return undefined;

  const byFile = newSideHunksByFile(diff);
  // The finding's file first, then every other changed file, so the search
  // order is deterministic even though the uniqueness rule makes it matter
  // only for error messages.
  const orderedFiles = [
    ...(byFile.has(findingFile) ? [findingFile] : []),
    ...[...byFile.keys()].filter((file) => file !== findingFile),
  ];

  let found: QuoteAnchorResult | undefined;
  let total = 0;
  for (const file of orderedFiles) {
    for (const hunk of byFile.get(file) as NewSideLine[][]) {
      for (const match of matchesInHunk(hunk, excerpt)) {
        total += 1;
        if (total === 1) {
          found = {
            file,
            line: match.line,
            ...(match.endLine === undefined ? {} : { endLine: match.endLine }),
          };
        } else {
          // Second hit anywhere: ambiguous by the refusal rule. Returning
          // immediately also stops the search from continuing.
          return undefined;
        }
      }
    }
  }
  return total === 1 ? found : undefined;
}
