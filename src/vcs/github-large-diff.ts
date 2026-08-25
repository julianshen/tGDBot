/**
 * Reviewing a pull request GitHub refuses to hand over as one diff (issue #33).
 *
 * `gh pr diff` is a thin wrapper over the PR's `.diff` media type, and GitHub
 * caps that response at 20,000 lines:
 *
 *   could not find pull request diff: HTTP 406: Sorry, the diff exceeded the
 *   maximum number of lines (20000)
 *   PullRequest.diff_too_large
 *
 * The review then exits before a single rule runs. The per-file endpoint
 * (`/pulls/{number}/files`) has no such ceiling — it pages, and each entry
 * carries that file's own patch — so the diff can be rebuilt from it.
 *
 * The rebuild is only useful if it is FAITHFUL. A patch assembled out of
 * per-file fragments has to parse exactly like git's own output, because
 * `review/diff-anchors` computes every inline comment's anchor from this text;
 * headers that don't parse turn into findings that silently relocate to the
 * summary. It also has to be HONEST about what it could not load: GitHub omits
 * `patch` for files it considers too large, and truncates the file list itself
 * past 3,000 entries. Reviewing what's left as though it were the whole PR is
 * precisely the "truncated subset" the issue rules out, so this module reports
 * both conditions rather than papering over them.
 */

// Paths are interpolated into diff headers, so a newline or other control
// character inside one could forge a `diff --git` line and make the
// reconstructed patch describe a file that is not in the PR. Patch BODIES are
// deliberately exempt: they are multi-line by nature, and a CRLF file's diff
// legitimately carries carriage returns.
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u;

/**
 * GitHub stops enumerating a pull request's files at 3,000. Past that the
 * list is silently short: the response is a normal 200 with no marker saying
 * anything is missing.
 */
export const GITHUB_PULL_FILES_CAP = 3000;

export interface ReconstructedDiff {
  /** The rebuilt unified diff, in the order GitHub returned the files. */
  readonly diff: string;
  /**
   * Files GitHub reported as changed but sent no patch for. Non-empty means
   * the diff is INCOMPLETE — some changed lines are simply not in it.
   */
  readonly omittedPatches: readonly string[];
  /**
   * Files with no patch and no changed lines: a binary file, or a mode-only
   * change. The endpoint renders the two identically, so which one this is
   * cannot be known from here — see `reconstructDiffFromFiles`. No line
   * content is missing (there is none), so these do not make the diff
   * incomplete; they are reported so an operator can see them.
   */
  readonly contentless: readonly string[];
  /**
   * Files whose patch arrived but accounts for fewer changed lines than the
   * entry itself reports. A non-null `patch` is not automatically a WHOLE
   * patch, and a fragment would let a rule review the prefix of a large file
   * and call it clean. Non-empty means the diff is INCOMPLETE.
   */
  readonly truncatedPatches: readonly string[];
}

/** Raised when the complete diff could not be loaded, naming what is missing. */
export class GitHubDiffIncompleteError extends Error {
  readonly code = "GITHUB_DIFF_INCOMPLETE";
  readonly omittedPatches: readonly string[];
  readonly truncatedPatches: readonly string[];
  readonly truncated: boolean;

  constructor(
    message: string,
    detail: {
      readonly omittedPatches: readonly string[];
      readonly truncated: boolean;
      readonly truncatedPatches?: readonly string[];
    },
  ) {
    super(message);
    this.name = "GitHubDiffIncompleteError";
    this.omittedPatches = detail.omittedPatches;
    this.truncatedPatches = detail.truncatedPatches ?? [];
    this.truncated = detail.truncated;
  }
}

/**
 * True for a diff that could not be loaded completely.
 *
 * Checks the `code` as well as the prototype so the guard still holds for an
 * error that crossed a module boundary, matching how the rest of the adapter
 * identifies its own typed failures.
 */
export function isDiffIncompleteError(error: unknown): error is GitHubDiffIncompleteError {
  if (error instanceof GitHubDiffIncompleteError) return true;
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "GITHUB_DIFF_INCOMPLETE"
  );
}

/**
 * True only for GitHub's diff-size refusal.
 *
 * Deliberately narrow, for the same reason `cli.ts`'s
 * `isOutputBufferExceededError` is: falling back to the files API on any
 * failure would turn an expired token or a dead network into a review
 * dispatched against whatever the fallback managed to scrape. Everything that
 * is not provably this refusal stays fatal.
 */
export function isDiffTooLargeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // The API's own error code, present whether or not `gh`'s framing survives.
  if (/diff_too_large/i.test(error.message)) return true;
  // Belt and braces: the human-readable form, pinned to the size wording so a
  // 406 from some other endpoint cannot pass for it.
  return /HTTP 406/.test(error.message) && /diff exceeded the maximum/i.test(error.message);
}

function fileText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER_RE.test(value)) {
    throw new Error(`Invalid GitHub pull request file ${label}`);
  }
  return value;
}

function fileCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid GitHub pull request file ${label}`);
  }
  return value;
}


// `@@ -oldStart[,oldCount] +newStart[,newCount] @@`. A missing count means one,
// not zero — git writes `@@ -3 +4 @@` for a single-line hunk.
const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * True when every hunk in a patch delivers the number of lines it declares.
 *
 * Issue #35: counting changed lines against the entry's totals is a proxy, and
 * it misses a patch cut short after its last `+`/`-` line but before the hunk's
 * trailing context. The totals still match; the hunk is still incomplete, and
 * `diff-anchors` discards an incomplete hunk — so the finding loses its anchor
 * while the reconstruction reports itself whole.
 *
 * Only a SHORTFALL is a failure, matching the changed-line check: more lines
 * than declared is a disagreement about counting, not evidence of loss.
 */
function hunksAreComplete(body: readonly string[]): boolean {
  let oldRemaining = 0;
  let newRemaining = 0;
  let seenHeader = false;
  for (const line of body) {
    const header = HUNK_HEADER_RE.exec(line);
    if (header) {
      // A new hunk starting before the previous one finished is a short hunk.
      if (seenHeader && (oldRemaining > 0 || newRemaining > 0)) return false;
      oldRemaining = header[1] === undefined ? 1 : Number(header[1]);
      newRemaining = header[2] === undefined ? 1 : Number(header[2]);
      seenHeader = true;
      continue;
    }
    if (!seenHeader) continue;
    // "\ No newline at end of file" annotates the previous line; it belongs to
    // neither side and must not be counted as content.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) newRemaining -= 1;
    else if (line.startsWith("-")) oldRemaining -= 1;
    else {
      oldRemaining -= 1;
      newRemaining -= 1;
    }
  }
  return oldRemaining <= 0 && newRemaining <= 0;
}

/**
 * Rebuilds one unified diff from `/pulls/{number}/files` rows.
 *
 * Each row carries only its hunks; the `diff --git`/`---`/`+++` headers that
 * bind them to a path are git's, not the API's, so they are re-emitted here in
 * exactly git's shape — including `/dev/null` for the missing side of an
 * add or delete, and `rename from`/`rename to` for a move, whose old path
 * drives the LEFT side of every hunk.
 */
export function reconstructDiffFromFiles(
  rows: readonly Record<string, unknown>[],
): ReconstructedDiff {
  const lines: string[] = [];
  const omittedPatches: string[] = [];
  const contentless: string[] = [];
  const truncatedPatches: string[] = [];

  for (const row of rows) {
    const newPath = fileText(row.filename, "path");
    const status = fileText(row.status, "status");
    const previous = row.previous_filename;
    const oldPath = previous === undefined || previous === null
      ? newPath
      : fileText(previous, "previous path");
    const changedLines =
      fileCount(row.additions, "addition count") + fileCount(row.deletions, "deletion count");
    const added = status === "added";
    const removed = status === "removed";
    const moved = status === "renamed" || status === "copied";

    lines.push(`diff --git a/${oldPath} b/${newPath}`);
    if (moved) {
      const verb = status === "renamed" ? "rename" : "copy";
      lines.push(`${verb} from ${oldPath}`, `${verb} to ${newPath}`);
    }

    if (row.patch !== undefined && row.patch !== null) {
      // A patch is passed through verbatim, exactly as `gh pr diff` would have
      // delivered it. A body line that looks like a header is no more of a
      // hazard here than in git's own output — diff-anchors disambiguates
      // headers from hunk content by the hunk's own line counts.
      if (typeof row.patch !== "string") throw new Error("Invalid GitHub pull request file patch");
      const patch = row.patch.replace(/\n$/, "");
      const body = patch.split("\n");
      lines.push(
        added ? "--- /dev/null" : `--- a/${oldPath}`,
        removed ? "+++ /dev/null" : `+++ b/${newPath}`,
        ...body,
      );
      // GitHub's `patch` carries hunks only — no `---`/`+++` file headers — so
      // every line starting with + or - is a changed line, including a removed
      // line whose content happens to read "--". Counting them against the
      // entry's own totals is what catches a patch that arrived in fragments
      // (Codex review, PR #34).
      let patchAdditions = 0;
      let patchDeletions = 0;
      for (const line of body) {
        if (line.startsWith("+")) patchAdditions += 1;
        else if (line.startsWith("-")) patchDeletions += 1;
      }
      // Only a SHORTFALL is evidence of loss. If the counts ever exceed what
      // the entry reports, that is a disagreement about how GitHub counts,
      // not missing content, and must not fail an otherwise whole diff.
      const reportedAdditions = fileCount(row.additions, "addition count");
      const reportedDeletions = fileCount(row.deletions, "deletion count");
      if (
        patchAdditions < reportedAdditions ||
        patchDeletions < reportedDeletions ||
        !hunksAreComplete(body)
      ) {
        truncatedPatches.push(newPath);
      }
      continue;
    }

    if (changedLines > 0) {
      // GitHub says this file changed but declined to send the patch. The
      // header stays so the file is visibly part of the PR; the caller decides
      // what to do about a diff that is missing content.
      omittedPatches.push(newPath);
      continue;
    }

    // No patch and nothing changed textually. Anything here is a binary file, a
    // mode-only change, or a move — and this endpoint renders them IDENTICALLY:
    // no patch, no additions, no deletions, and no mode field. A renamed binary
    // whose CONTENT also changed looks exactly like a pure rename (issue #35),
    // so the move headers alone are not proof the file is fully described.
    // Guessing would put a falsehood in the diff: "Binary files differ" on a
    // chmod hides the permission change behind a wrong label, and `old mode`/
    // `new mode` on a PNG is simply untrue. (Codex review, PR #34.)
    //
    // What IS known is whether the file was added or removed — the API states
    // it — so the `/dev/null` side is emitted to say so. Only a MODIFIED entry
    // is wholly ambiguous, and that one gets the header alone. Either way the
    // path is reported so the gap in line content stays visible.
    if (!moved) {
      if (added) lines.push("--- /dev/null", `+++ b/${newPath}`);
      else if (removed) lines.push(`--- a/${oldPath}`, "+++ /dev/null");
    }
    // Reported for a move as well. Nothing is MISSING that could have been
    // shown — there is no patch to deliver — so this is not an omission, but it
    // is no longer claimed as a complete description either.
    contentless.push(newPath);
  }

  return {
    diff: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    omittedPatches,
    contentless,
    truncatedPatches,
  };
}

/**
 * A patch that is missing content cannot be reviewed as if it were whole, so
 * this converts either incompleteness into a typed, diagnosable rejection
 * naming what is missing and how to proceed.
 */
export function assertCompleteDiff(
  reconstructed: ReconstructedDiff,
  detail: { readonly truncated: boolean; readonly fileCount: number },
): string {
  const { omittedPatches, truncatedPatches } = reconstructed;
  if (omittedPatches.length === 0 && truncatedPatches.length === 0 && !detail.truncated) {
    return reconstructed.diff;
  }

  const reasons: string[] = [];
  if (detail.truncated) {
    reasons.push(
      `GitHub lists at most ${GITHUB_PULL_FILES_CAP} files per pull request and this one hit ` +
        `that cap, so an unknown number of files are missing entirely`,
    );
  }
  if (omittedPatches.length > 0) {
    const shown = omittedPatches.slice(0, 10).join(", ");
    const rest = omittedPatches.length > 10 ? `, and ${omittedPatches.length - 10} more` : "";
    reasons.push(
      `GitHub sent no patch for ${omittedPatches.length} changed ` +
        `file${omittedPatches.length === 1 ? "" : "s"} (${shown}${rest})`,
    );
  }

  if (truncatedPatches.length > 0) {
    const shown = truncatedPatches.slice(0, 10).join(", ");
    const rest = truncatedPatches.length > 10 ? `, and ${truncatedPatches.length - 10} more` : "";
    reasons.push(
      `${truncatedPatches.length} patch(es) account for fewer changed lines than the file ` +
        `reports, so part of the change is missing from them (${shown}${rest})`,
    );
  }

  throw new GitHubDiffIncompleteError(
    `the pull request diff exceeds GitHub's single-diff limit, and the per-file fallback could ` +
      `not load all of it: ${reasons.join("; ")}. Reviewing the ${detail.fileCount} file(s) that ` +
      `did load would silently review a subset of the pull request, so nothing was posted. ` +
      `Split the pull request, or set --max-diff-chars to skip oversized ones instead of failing.`,
    { omittedPatches, truncatedPatches, truncated: detail.truncated },
  );
}
