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
// but count indentation unreliably; everything else is verbatim. The search
// covers the finding's own file first and every other changed file after it —
// reviewers reading related files do sometimes quote the source file while
// filing against the header, and a unique match re-files the whole finding.

import { parseDiffGitHeader } from "./diff-anchors.js";

export interface QuoteAnchorResult {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
}

/** An added or context line on the new side of one file's diff. */
interface NewSideLine {
  readonly newLine: number;
  readonly text: string;
}

/** Cap on excerpt size — a quote longer than this is not a quote. */
const MAX_EXCERPT_LINES = 50;

function excerptLines(existingCode: string): string[] {
  return existingCode
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_EXCERPT_LINES);
}

/**
 * New-side lines (added and context) per file, in diff order. Reuses the
 * git-header and hunk-header handling of diff-anchors' parsers.
 */
export function newSideLinesByFile(diff: string): Map<string, NewSideLine[]> {
  const byFile = new Map<string, NewSideLine[]>();
  let currentFile: string | undefined;
  let newLine: number | undefined;
  for (const line of diff.split("\n")) {
    const header = parseDiffGitHeader(line);
    if (header !== undefined) {
      currentFile = header.b;
      newLine = undefined;
      continue;
    }
    if (currentFile === undefined) continue;
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = match === null ? undefined : Number.parseInt(match[1] as string, 10);
      continue;
    }
    if (newLine === undefined) continue;
    if (line.startsWith("+")) {
      const entry = { newLine, text: line.slice(1) };
      const lines = byFile.get(currentFile) ?? [];
      lines.push(entry);
      byFile.set(currentFile, lines);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") || line.startsWith("\\")) continue;
    if (line.startsWith(" ")) {
      const entry = { newLine, text: line.slice(1) };
      const lines = byFile.get(currentFile) ?? [];
      lines.push(entry);
      byFile.set(currentFile, lines);
      newLine += 1;
      continue;
    }
    // Anything else (empty trailing line, malformed row) ends the hunk.
    newLine = undefined;
  }
  return byFile;
}

/**
 * Occurrences of the excerpt in one file's new-side lines, as
 * `{ line, endLine }` per match. Whitespace-insensitive per line, blank lines
 * ignored, contiguous runs required.
 */
function matchesInFile(lines: readonly NewSideLine[], excerpt: readonly string[]): Array<{ line: number; endLine?: number }> {
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
 * multiple locations. `undefined` means "declined": the caller drops the
 * model-supplied line rather than publishing a location no quote supports.
 */
export function resolveQuoteAnchor(
  diff: string,
  findingFile: string,
  existingCode: string,
): QuoteAnchorResult | undefined {
  const excerpt = excerptLines(existingCode);
  if (excerpt.length === 0) return undefined;

  const byFile = newSideLinesByFile(diff);
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
    for (const match of matchesInFile(byFile.get(file) as NewSideLine[], excerpt)) {
      total += 1;
      if (total === 1) {
        found = {
          file,
          line: match.line,
          ...(match.endLine === undefined ? {} : { endLine: match.endLine }),
        };
      } else {
        // Second hit anywhere: ambiguous by the refusal rule. Still counted,
        // so the caller cannot mistake "first hit so far" for "unique".
        return undefined;
      }
    }
  }
  return total === 1 ? found : undefined;
}
