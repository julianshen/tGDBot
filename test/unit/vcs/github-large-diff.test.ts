import { describe, expect, it } from "vitest";
import {
  GitHubDiffIncompleteError,
  assertCompleteDiff,
  isDiffIncompleteError,
  isDiffTooLargeError,
  reconstructDiffFromFiles,
} from "../../../src/vcs/github-large-diff.js";
import { commentableLines, parseDiffPositions } from "../../../src/review/diff-anchors.js";

// The exact rejection GitHub produces for a PR over the 20,000-line diff
// ceiling, as observed against `hmchangw/newchat#188` (issue #33). `gh`
// surfaces it as a non-zero exit whose message carries the API's response.
const DIFF_TOO_LARGE_MESSAGE =
  "Command failed: gh pr diff 188 --repo github.com/hmchangw/newchat\n" +
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum " +
  "number of lines (20000)\nPullRequest.diff_too_large";

const modifiedRow = {
  filename: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;",
};

describe("isDiffTooLargeError", () => {
  it("recognizes the HTTP 406 diff_too_large rejection from `gh pr diff`", () => {
    expect(isDiffTooLargeError(new Error(DIFF_TOO_LARGE_MESSAGE))).toBe(true);
  });

  it("recognizes the bare API error code without the surrounding gh framing", () => {
    expect(isDiffTooLargeError(new Error("PullRequest.diff_too_large"))).toBe(true);
  });

  // A network or auth failure must stay fatal: silently switching to the
  // files API on any error would turn "your token expired" into a review
  // dispatched against whatever the fallback could scrape.
  it("does not claim a network failure is a size limit", () => {
    expect(isDiffTooLargeError(new Error("error connecting to api.github.com"))).toBe(false);
  });

  it("does not claim an unrelated 4xx is a size limit", () => {
    expect(isDiffTooLargeError(new Error("HTTP 404: Not Found"))).toBe(false);
  });

  // A 406 on some other endpoint is not this failure.
  it("requires the diff-size wording, not merely the 406 status", () => {
    expect(isDiffTooLargeError(new Error("HTTP 406: Not Acceptable"))).toBe(false);
  });

  it("is not fooled by a non-Error value", () => {
    expect(isDiffTooLargeError("PullRequest.diff_too_large")).toBe(false);
    expect(isDiffTooLargeError(undefined)).toBe(false);
  });
});

describe("reconstructDiffFromFiles", () => {
  it("rebuilds a modified file with git's own headers", () => {
    const { diff, omittedPatches } = reconstructDiffFromFiles([modifiedRow]);

    expect(diff).toBe(
      "diff --git a/src/a.ts b/src/a.ts\n" +
        "--- a/src/a.ts\n" +
        "+++ b/src/a.ts\n" +
        "@@ -1,2 +1,2 @@\n" +
        "-const a = 1;\n" +
        "+const a = 2;\n" +
        " const b = 3;\n",
    );
    expect(omittedPatches).toEqual([]);
  });

  it("marks an added file's old side as /dev/null", () => {
    const { diff } = reconstructDiffFromFiles([
      {
        filename: "src/new.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -0,0 +1 @@\n+export const x = 1;",
      },
    ]);

    expect(diff).toContain("diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n");
  });

  it("marks a removed file's new side as /dev/null", () => {
    const { diff } = reconstructDiffFromFiles([
      {
        filename: "src/gone.ts",
        status: "removed",
        additions: 0,
        deletions: 1,
        changes: 1,
        patch: "@@ -1 +0,0 @@\n-export const x = 1;",
      },
    ]);

    expect(diff).toContain("diff --git a/src/gone.ts b/src/gone.ts\n--- a/src/gone.ts\n+++ /dev/null\n");
  });

  // The old path drives the LEFT side of every hunk; taking `filename` for
  // both sides of a rename would misattribute every removed line.
  it("uses previous_filename for the old side of a rename", () => {
    const { diff } = reconstructDiffFromFiles([
      {
        filename: "src/new-name.ts",
        previous_filename: "src/old-name.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
      },
    ]);

    expect(diff).toContain(
      "diff --git a/src/old-name.ts b/src/new-name.ts\n" +
        "rename from src/old-name.ts\n" +
        "rename to src/new-name.ts\n" +
        "--- a/src/old-name.ts\n" +
        "+++ b/src/new-name.ts\n",
    );
  });

  // A pure rename carries no patch and no changed lines. That is a COMPLETE
  // description of the file, not an omission — treating it as one would
  // abort every review of a PR that moved a file.
  it("treats a content-free rename as complete", () => {
    const { diff, omittedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/new-name.ts",
        previous_filename: "src/old-name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ]);

    expect(diff).toBe(
      "diff --git a/src/old-name.ts b/src/new-name.ts\n" +
        "rename from src/old-name.ts\n" +
        "rename to src/new-name.ts\n",
    );
    expect(omittedPatches).toEqual([]);
  });

  // A binary file and a mode-only change are INDISTINGUISHABLE in this
  // endpoint's output: both are a no-patch entry with zero additions and
  // deletions. Claiming either one would be inventing a fact — "Binary files
  // differ" on a chmod hides the permission change behind a false label, and
  // `old mode`/`new mode` on a PNG is simply wrong. The header alone says
  // what is actually known: this file is part of the change, with no
  // line-level content to show. (Codex review, PR #34.)
  it("does not invent content for an entry with no patch and no changed lines", () => {
    const { diff, omittedPatches } = reconstructDiffFromFiles([
      { filename: "docs/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(diff).toBe("diff --git a/docs/logo.png b/docs/logo.png\n");
    expect(omittedPatches).toEqual([]);
  });

  it("never labels a mode-only change as binary", () => {
    const { diff } = reconstructDiffFromFiles([
      { filename: "scripts/build.sh", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(diff).not.toMatch(/Binary files/);
  });

  // Codex review, PR #34: only "binary vs mode-only" is unknown for these
  // entries — whether the file was ADDED or REMOVED is stated plainly by the
  // API, and dropping it made an addition read as an unspecified
  // modification. The /dev/null side says which it was without inventing
  // anything about the content.
  it("keeps the add visible for a contentless added file", () => {
    const { diff, omittedPatches } = reconstructDiffFromFiles([
      { filename: "docs/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(diff).toBe(
      "diff --git a/docs/logo.png b/docs/logo.png\n--- /dev/null\n+++ b/docs/logo.png\n",
    );
    expect(omittedPatches).toEqual([]);
  });

  it("keeps the delete visible for a contentless removed file", () => {
    const { diff } = reconstructDiffFromFiles([
      { filename: "docs/logo.png", status: "removed", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(diff).toBe(
      "diff --git a/docs/logo.png b/docs/logo.png\n--- a/docs/logo.png\n+++ /dev/null\n",
    );
  });

  // A MODIFIED contentless entry is the genuinely ambiguous one: binary or
  // mode-only, with nothing further known. It stays header-only.
  it("says nothing beyond the header for a contentless modification", () => {
    const { diff } = reconstructDiffFromFiles([
      { filename: "docs/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(diff).toBe("diff --git a/docs/logo.png b/docs/logo.png\n");
  });

  // A file header with no hunk yields no anchors, so these can never attract
  // an inline comment that has nowhere to land.
  it("offers no commentable lines for a contentless entry", () => {
    const { diff } = reconstructDiffFromFiles([
      { filename: "docs/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(commentableLines(diff).size).toBe(0);
  });

  // These entries are still surfaced, so an operator can see the reconstruction
  // could not show line content for them.
  it("names the entries it could show no content for", () => {
    const { contentless } = reconstructDiffFromFiles([
      modifiedRow,
      { filename: "docs/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(contentless).toEqual(["docs/logo.png"]);
  });

  // This once asserted the opposite — that a rename is fully described by its
  // headers, so nothing about it is unknown. That was wrong (issue #35): a
  // renamed BINARY whose content also changed reports identically to a pure
  // rename, so the headers cannot prove the file is fully described. It is
  // still not an omission, because there was never a patch to deliver.
  it("counts a no-patch rename as contentless, not as an omission", () => {
    const { contentless, omittedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/new-name.ts",
        previous_filename: "src/old-name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ]);

    expect(contentless).toEqual(["src/new-name.ts"]);
    expect(omittedPatches).toEqual([]);
  });

  // THE case that must never pass silently: GitHub reports the file changed
  // by N lines but declines to send the patch. Reviewing the rest as if it
  // were the whole PR is exactly the "truncated subset" the issue forbids.
  it("reports a file whose patch GitHub omitted despite changed lines", () => {
    const { omittedPatches } = reconstructDiffFromFiles([
      modifiedRow,
      { filename: "src/huge.ts", status: "modified", additions: 9000, deletions: 12, changes: 9012 },
    ]);

    expect(omittedPatches).toEqual(["src/huge.ts"]);
  });

  // Codex review, PR #34: a non-null `patch` is not automatically a WHOLE
  // patch. `additions`/`deletions` describe the entire file change, so hunks
  // carrying fewer changed lines than that mean content is missing — and
  // accepting the fragment would let rules review a prefix of a large file
  // and report it clean.
  it("reports a patch carrying fewer changed lines than the file claims", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/big.ts",
        status: "modified",
        additions: 900,
        deletions: 12,
        changes: 912,
        patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;",
      },
    ]);

    expect(truncatedPatches).toEqual(["src/big.ts"]);
  });

  it("accepts a patch whose hunks account for every changed line", () => {
    const { truncatedPatches, omittedPatches } = reconstructDiffFromFiles([modifiedRow]);

    expect(truncatedPatches).toEqual([]);
    expect(omittedPatches).toEqual([]);
  });

  // A removed line whose CONTENT is "--" renders as "---", and an added line
  // reading "++" renders as "+++". Inside a hunk body those are ordinary
  // changed lines, not file headers — GitHub's `patch` carries no headers —
  // so they must count, or a legitimate diff would look truncated.
  it("counts hunk-body lines that look like file headers", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/dashes.md",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1,2 +1,2 @@\n---\n+++\n context",
      },
    ]);

    expect(truncatedPatches).toEqual([]);
  });

  // The hunk header itself starts with neither + nor -, and "\ No newline at
  // end of file" must not be mistaken for content either.
  it("does not count hunk headers or no-newline markers as changed lines", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/eof.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
      },
    ]);

    expect(truncatedPatches).toEqual([]);
  });

  it("refuses the whole diff when a patch is truncated", () => {
    expect(() =>
      assertCompleteDiff(
        reconstructDiffFromFiles([
          {
            filename: "src/big.ts",
            status: "modified",
            additions: 900,
            deletions: 0,
            changes: 900,
            patch: "@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;",
          },
        ]),
        { truncated: false, fileCount: 1 },
      ),
    ).toThrow(/src\/big\.ts/);
  });

  it("keeps every file that did arrive when another was omitted", () => {
    const { diff, omittedPatches } = reconstructDiffFromFiles([
      modifiedRow,
      { filename: "src/huge.ts", status: "modified", additions: 9000, deletions: 12, changes: 9012 },
    ]);

    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(omittedPatches).toHaveLength(1);
  });

  it("joins multiple files into one diff, in the order GitHub returned them", () => {
    const { diff } = reconstructDiffFromFiles([
      modifiedRow,
      {
        filename: "src/b.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1 +1,2 @@\n const b = 3;\n+const c = 4;",
      },
    ]);

    expect(diff.indexOf("a/src/a.ts")).toBeLessThan(diff.indexOf("a/src/b.ts"));
    expect(diff.endsWith("\n")).toBe(true);
    expect(diff).not.toContain("\n\n");
  });

  it("rejects a malformed file entry rather than inventing a path", () => {
    expect(() => reconstructDiffFromFiles([{ status: "modified", additions: 0, deletions: 0 }]))
      .toThrow(/Invalid GitHub pull request file/);
    expect(() => reconstructDiffFromFiles([{ filename: "src/a.ts", status: "modified", additions: "lots", deletions: 0 }]))
      .toThrow(/Invalid GitHub pull request file/);
  });

  it("rejects a path that would forge a diff header", () => {
    expect(() =>
      reconstructDiffFromFiles([
        {
          filename: "src/a.ts\ndiff --git a/etc/passwd b/etc/passwd",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ -1 +1 @@\n+x",
        },
      ]),
    ).toThrow(/Invalid GitHub pull request file/);
  });
});

// The whole point of reconstructing the diff is to review it, and every
// finding's inline anchor is computed from this text. If the rebuilt headers
// do not parse, findings silently fall back to the summary comment.
describe("reconstructed diffs stay anchorable", () => {
  it("yields the same commentable lines a real diff would", () => {
    const { diff } = reconstructDiffFromFiles([
      modifiedRow,
      {
        filename: "src/new.ts",
        status: "added",
        additions: 2,
        deletions: 0,
        changes: 2,
        patch: "@@ -0,0 +1,2 @@\n+export const x = 1;\n+export const y = 2;",
      },
    ]);

    const anchors = commentableLines(diff);

    // Modified file: the changed line (1) and the context line (2).
    expect([...(anchors.get("src/a.ts") ?? [])].sort((l, r) => l - r)).toEqual([1, 2]);
    expect([...(anchors.get("src/new.ts") ?? [])].sort((l, r) => l - r)).toEqual([1, 2]);
    expect(parseDiffPositions(diff).get("src/a.ts")?.get(1)?.oldPath).toBe("src/a.ts");
  });

  it("anchors a rename against its new path", () => {
    const { diff } = reconstructDiffFromFiles([
      {
        filename: "src/new-name.ts",
        previous_filename: "src/old-name.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
      },
    ]);

    const anchors = commentableLines(diff);

    expect([...(anchors.get("src/new-name.ts") ?? [])]).toEqual([1]);
    expect(anchors.has("src/old-name.ts")).toBe(false);
  });
});

describe("GitHubDiffIncompleteError", () => {
  it("names the files it could not load, and stays identifiable by code", () => {
    const error = new GitHubDiffIncompleteError("incomplete", {
      omittedPatches: ["src/huge.ts"],
      truncated: false,
    });

    expect(error.code).toBe("GITHUB_DIFF_INCOMPLETE");
    expect(error.omittedPatches).toEqual(["src/huge.ts"]);
    expect(error.truncated).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("isDiffIncompleteError", () => {
  it("recognizes the error, including a copy that lost its prototype", () => {
    const thrown = new GitHubDiffIncompleteError("incomplete", { omittedPatches: [], truncated: true });
    expect(isDiffIncompleteError(thrown)).toBe(true);
    expect(isDiffIncompleteError(Object.assign(new Error("incomplete"), { code: "GITHUB_DIFF_INCOMPLETE" }))).toBe(true);
  });

  it("does not swallow an unrelated failure", () => {
    expect(isDiffIncompleteError(new Error("error connecting to api.github.com"))).toBe(false);
    expect(isDiffIncompleteError({ code: "GITHUB_DIFF_INCOMPLETE" })).toBe(false);
  });
});


// Issue #35, gap 1. Counting changed lines is a proxy: a patch truncated after
// its last +/- line but before the hunk's declared trailing context still
// satisfies the totals. diff-anchors then discards the incomplete hunk while
// the reconstruction reports itself whole.
describe("reconstructDiffFromFiles — hunk integrity", () => {
  it("reports a hunk cut short of its declared context", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        // Declares 4 old / 4 new lines, delivers 3 of each: the trailing
        // context is missing even though every changed line arrived.
        patch: "@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three",
      },
    ]);

    expect(truncatedPatches).toEqual(["src/a.ts"]);
  });

  it("accepts a hunk whose line counts add up", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three",
      },
    ]);

    expect(truncatedPatches).toEqual([]);
  });

  // `@@ -3 +4 @@` means one line on each side; a missing count is not zero.
  it("treats an omitted count as one", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
        patch: "@@ -3 +3 @@\n-two\n+TWO" },
    ]);

    expect(truncatedPatches).toEqual([]);
  });

  it("counts across several hunks and flags only a short one", () => {
    const whole = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three";
    const short = "@@ -10,3 +10,3 @@\n ten\n-eleven\n+ELEVEN";

    expect(reconstructDiffFromFiles([
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 2, changes: 4,
        patch: `${whole}\n${short}` },
    ]).truncatedPatches).toEqual(["src/a.ts"]);
  });

  // "\ No newline at end of file" is a marker, not a line of either side.
  it("does not count the no-newline marker as content", () => {
    const { truncatedPatches } = reconstructDiffFromFiles([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
        patch: "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file" },
    ]);

    expect(truncatedPatches).toEqual([]);
  });
});

// Issue #35, gap 2. A renamed binary that also changed content reports
// `renamed`, no patch, and 0/0 — indistinguishable from a pure rename — so the
// move headers alone were treated as a complete description.
describe("reconstructDiffFromFiles — moved entries with no patch", () => {
  it("reports a no-patch rename as carrying no line content", () => {
    const { contentless, omittedPatches } = reconstructDiffFromFiles([
      {
        filename: "src/new-name.ts",
        previous_filename: "src/old-name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ]);

    // Not an omission — nothing is missing that could have been shown — but no
    // longer claimed as fully described either.
    expect(contentless).toEqual(["src/new-name.ts"]);
    expect(omittedPatches).toEqual([]);
  });

  it("still renders the move itself", () => {
    const { diff } = reconstructDiffFromFiles([
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed",
        additions: 0, deletions: 0, changes: 0 },
    ]);

    expect(diff).toContain("rename from src/old.ts");
    expect(diff).toContain("rename to src/new.ts");
  });

  // A rename that DID deliver its patch is fully described and must stay clean.
  it("leaves a rename with a patch alone", () => {
    const { contentless } = reconstructDiffFromFiles([
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed",
        additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);

    expect(contentless).toEqual([]);
  });
});


// PR #52 review, found by both bots. Adding the hunk-integrity check gave
// `truncatedPatches` a second meaning, but the diagnosis still said every entry
// "account[s] for fewer changed lines than the file reports" — which is exactly
// false for the new case, where the totals match and the hunk is short.
describe("assertCompleteDiff explains which kind of truncation", () => {
  const shortfall = {
    filename: "src/short.ts", status: "modified", additions: 900, deletions: 0, changes: 900,
    patch: "@@ -1 +1,2 @@\n one\n+two",
  };
  const shortHunk = {
    filename: "src/hunk.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
    patch: "@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three",
  };
  const reasonFor = (rows: Record<string, unknown>[]): string => {
    try {
      assertCompleteDiff(reconstructDiffFromFiles(rows), { truncated: false, fileCount: rows.length });
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("says a shortfall is a shortfall", () => {
    const reason = reasonFor([shortfall]);

    expect(reason).toMatch(/fewer changed lines/i);
    expect(reason).toContain("src/short.ts");
  });

  // The case that was being misdescribed.
  it("does not call a short hunk a changed-line shortfall", () => {
    const reason = reasonFor([shortHunk]);

    expect(reason).toContain("src/hunk.ts");
    expect(reason).toMatch(/hunk/i);
    expect(reason).not.toMatch(/fewer changed lines/i);
  });

  it("describes both kinds when both occur, naming the right files", () => {
    const reason = reasonFor([shortfall, shortHunk]);

    expect(reason).toMatch(/fewer changed lines[^;]*src\/short\.ts/i);
    expect(reason).toMatch(/hunk[^;]*src\/hunk\.ts/i);
  });
});
