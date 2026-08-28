import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkStructuralClaim,
  describeCheck,
  parseStructuralClaim,
  runStructuralChecks,
  type StructuralCheck,
} from "../../../src/review/structural-check.js";
import type { Finding } from "../../../src/review/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-structural-test-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  return root;
}

const claim = { kind: "no-other-references" as const, symbol: "budget" };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/retry.ts",
    line: 1,
    severity: "warning",
    category: "correctness",
    message: "budget() is never called.",
    ruleName: "rule-a",
    ...overrides,
  };
}

describe("parseStructuralClaim", () => {
  it("accepts a well-formed claim", () => {
    expect(parseStructuralClaim({ kind: "no-other-references", symbol: "budget" }))
      .toEqual({ kind: "no-other-references", symbol: "budget" });
  });

  // A claim the host cannot answer coherently must not become one it answers
  // anyway: "no references to `foo bar()`" would be a confident nonsense.
  it.each([
    ["null", null],
    ["an array", []],
    ["an unknown kind", { kind: "no-callers", symbol: "budget" }],
    ["a missing symbol", { kind: "no-other-references" }],
    ["a non-string symbol", { kind: "no-other-references", symbol: 7 }],
    ["a symbol with a space", { kind: "no-other-references", symbol: "foo bar" }],
    ["a dotted path", { kind: "no-other-references", symbol: "foo.bar" }],
    ["a call expression", { kind: "no-other-references", symbol: "budget()" }],
    ["a symbol with a newline", { kind: "no-other-references", symbol: "a\nb" }],
    ["a symbol with a backtick", { kind: "no-other-references", symbol: "a`b" }],
    ["an empty symbol", { kind: "no-other-references", symbol: "" }],
  ])("rejects %s", (_label, value) => {
    expect(parseStructuralClaim(value)).toBeUndefined();
  });
});

describe("checkStructuralClaim — what counts as a reference", () => {
  // THE correctness test for this feature. In TypeScript most references to a
  // symbol are `property_identifier`, not `identifier`: searching only the
  // latter finds the import and misses every member access, then reports "no
  // other references" — CONFIRMING a false finding, which is worse than not
  // checking at all. Each line below is a distinct reference form.
  it("finds every occurrence form, not just bare identifiers", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "src/member.ts": "import * as r from './retry.js';\nexport const a = r.budget(1);\n",
      "src/optional.ts": "declare const obj: any;\nexport const b = obj?.budget;\n",
      "src/named.ts": "import { budget } from './retry.js';\nexport const c = budget(2);\n",
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    expect(result.status).toBe("lexical-matches");
    if (result.status === "not-checked") throw new Error("unreachable");
    const files = new Set(result.references.map((reference) => reference.file));
    // `r.budget(1)` and `obj?.budget` are `property_identifier`, so an
    // identifier-only search would miss both.
    for (const file of ["src/member.ts", "src/optional.ts", "src/named.ts"]) {
      expect(files).toContain(file);
    }
  });

  // Codex review, round 4, and my own earlier fixture pinned the WRONG
  // behaviour here: it listed `{ budget: 1 }` — an object key with no relation
  // to the function — as a reference the check should find. ast-grep matches
  // syntax, not meaning, so an unrelated same-named member is indistinguishable
  // from a real caller. The result must therefore never be reported as a
  // resolved reference, and the wording is what carries that.
  it("cannot tell an unrelated same-named member from a real caller", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "src/unrelated.ts": "export class Wallet { budget() { return 0; } }\nexport const cfg = { budget: 1 };\n",
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    // It DOES match them — that is the limitation, stated rather than hidden.
    expect(result.status).toBe("lexical-matches");
    if (result.status === "not-checked") throw new Error("unreachable");
    expect(result.references.some((reference) => reference.file === "src/unrelated.ts")).toBe(true);
    // So the prose must not present them as references to this symbol.
    const text = describeCheck(claim, result);
    expect(text).toMatch(/LEXICAL matches/);
    expect(text).toMatch(/did not resolve/);
    expect(text).not.toMatch(/contradicts/i);
  });

  // The reason to prefer a parser over `grep` at all: these are the false
  // positives a text search produces, and each one would turn a correct
  // "no other references" into a spurious contradiction.
  it("ignores substrings, comments and string literals", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "src/noise.ts": [
        "const budgetish = 3;",
        "const rebudget = 4;",
        "// budget in a comment",
        "/* budget in a block comment */",
        "const s = 'budget in a string';",
        "export const all = [budgetish, rebudget, s];",
      ].join("\n"),
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    // No contradiction: the noise file's matches are all textual, and a parser
    // does not see them. That is a refusal, not a clean bill of health.
    expect(result.status).toBe("not-checked");
    if (result.status !== "not-checked") throw new Error("unreachable");
    expect(result.reason).toMatch(/not evidence that no reference exists/);
  });

  it("does not search dependency or build directories", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "node_modules/pkg/index.ts": "export const budget = 999;\n",
      "dist/bundle.js": "export const budget = 999;\n",
      ".git/hooks/sample.js": "export const budget = 999;\n",
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    // Only src/retry.ts was searched — the other three live in directories a
    // review has no business walking.
    expect(result.status).toBe("not-checked");
    if (result.status !== "not-checked") throw new Error("unreachable");
    expect(result.reason).toMatch(/in 1 file\(s\)/);
  });

  // A same-file reference cannot be told apart from the definition itself: the
  // finding's line counts the PR head, and this searches the base, so the two
  // do not correspond. Only another file is an unambiguous contradiction.
  it("treats a reference in another file as the contradiction, not one in its own", async () => {
    const sameFile = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\nexport const local = budget(1);\n",
    });
    const otherFile = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "src/http.ts": "import { budget } from './retry.js';\nexport const a = budget(1);\n",
    });

    await expect(checkStructuralClaim(claim, { baseRoot: sameFile, findingFile: "src/retry.ts" }))
      .resolves.toMatchObject({ status: "not-checked" });
    await expect(checkStructuralClaim(claim, { baseRoot: otherFile, findingFile: "src/retry.ts" }))
      .resolves.toMatchObject({ status: "lexical-matches" });
  });

  // Codex review, round 1. `findingFile` is a HEAD path; when the PR renames the
  // file, the base tree holds the same code under the old name — so the
  // symbol's own declaration looked like a reference from another file and the
  // check published a contradiction that was purely an artefact of the rename.
  it("does not call a renamed file's own declaration an external reference", async () => {
    const root = await tree({
      "src/old-name.ts": "export function budget(n: number) { return n; }\n",
    });

    // Without the base-side path this reads as "a reference in another file".
    await expect(checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/new-name.ts" }))
      .resolves.toMatchObject({ status: "lexical-matches" });

    await expect(checkStructuralClaim(claim, {
      baseRoot: root,
      findingFile: "src/new-name.ts",
      findingFileAtBase: "src/old-name.ts",
    })).resolves.toMatchObject({ status: "not-checked" });
  });

  it("never follows a symlink out of the worktree", async () => {
    const outside = await tree({ "secret.ts": "export const budget = 1;\n" });
    const root = await tree({ "src/retry.ts": "export function budget(n: number) { return n; }\n" });
    await symlink(outside, path.join(root, "linked"));

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    expect(result.status).toBe("not-checked");
  });
});

describe("checkStructuralClaim — refusing rather than guessing", () => {
  // Codex found the oversized-file skip. The unreadable-file and parse-failure
  // skips beside it had the identical hazard, so the counter sits at every
  // `continue` rather than enumerating reasons — a future skip inherits it.
  // A gap cannot undo positive evidence: finding a reference elsewhere is a
  // fact, and an unread file cannot make it untrue. Only "I found nothing"
  // depends on having read everything.
  it("still contradicts despite a skipped file, because a gap only invalidates a clean result", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "src/http.ts": "import { budget } from './retry.js';\nexport const a = budget(1);\n",
      "src/huge.ts": `export const pad = "${"x".repeat(400)}";\n`,
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" }, {
      // Large enough for the two real files, small enough to skip src/huge.ts.
      maxFileBytes: 200,
    });

    expect(result.status).toBe("lexical-matches");
  });

  it("does not check a tree with no language it supports", async () => {
    const root = await tree({ "a.ts": "export const x = 1;\n" });
    await rm(path.join(root, "a.ts"));

    await expect(checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/a.ts" }))
      .resolves.toMatchObject({ status: "not-checked" });
  });

  it("does not check when the base worktree is missing", async () => {
    await expect(
      checkStructuralClaim(claim, { baseRoot: path.join(os.tmpdir(), "tgd-absent-root"), findingFile: "a.ts" }),
    ).resolves.toMatchObject({ status: "not-checked" });
  });

  it("does not check against a relative root", async () => {
    await expect(checkStructuralClaim(claim, { baseRoot: "relative/root", findingFile: "a.ts" }))
      .resolves.toMatchObject({ status: "not-checked", reason: expect.stringContaining("absolute") });
  });

  // Codex review, round 1: the time budget refused correctly and the FILE budget
  // did not — a truncated walk that found nothing reported `consistent`, which
  // is the false confirmation this whole check exists to avoid. Same property,
  // two code paths, and only one of them had it.
  // An exhausted budget must not read as a clean result: a partial search that
  // reported "consistent" would be the false confirmation in another costume.
  // Codex review, round 3: a claim on a file in a language this cannot parse
  // would otherwise walk the TypeScript files, find nothing, and report on a
  // language where neither the symbol nor its callers live.
  it("refuses a claim whose own file is in an unsupported language", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "main.go": "package main\nfunc budget() {}\n",
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "main.go" });

    expect(result.status).toBe("not-checked");
    if (result.status !== "not-checked") throw new Error("unreachable");
    expect(result.reason).toMatch(/TypeScript and JavaScript only/);
  });
});

describe("describeCheck", () => {
  // The single most important sentence in the feature. A clean result must
  // describe what was searched, never assert that no caller exists: a dynamic
  // reference, an unparsed language, or a caller in another repository is
  // invisible here, and a reader who takes a gap for proof has been misled.
  // There is no clean verdict to word any more (see `StructuralCheck`), so the
  // property is that everything which is not a contradiction reports what the
  // host did and declines to conclude from it.
  it("states what was searched, and does not claim there are no callers", () => {
    const check: StructuralCheck = {
      status: "not-checked",
      reason: "no reference outside its own file was found in 12 file(s) of the base branch, which is not evidence that none exists",
    };
    const text = describeCheck(claim, check);

    expect(text).toContain("12 file(s)");
    expect(text).toMatch(/not evidence that none exists/);
    expect(text).not.toMatch(/there are no (callers|references)/i);
  });

  it("names the locations and calls them unresolved lexical matches", () => {
    const check: StructuralCheck = {
      status: "lexical-matches",
      references: [{ file: "src/http.ts", line: 88 }, { file: "src/queue.ts", line: 12 }],
      filesSearched: 40,
    };
    const text = describeCheck(claim, check);

    expect(text).toContain("src/http.ts:88");
    expect(text).toContain("src/queue.ts:12");
    expect(text).toMatch(/LEXICAL matches/);
    expect(text).not.toMatch(/contradicts/i);
  });

  it("always says why a check was not performed", () => {
    expect(describeCheck(claim, { status: "not-checked", reason: "the base worktree is unavailable" }))
      .toContain("the base worktree is unavailable");
  });

  // A path from the base tree may legally contain a backtick, which git writes
  // bare and which closes the code span it lands in (#63).
  it("escapes interpolated paths through the caller's escaper", () => {
    const check: StructuralCheck = {
      status: "lexical-matches",
      references: [{ file: "src/a`.ts", line: 1 }],
      filesSearched: 1,
    };
    const text = describeCheck(claim, check, (value) => value.replaceAll("`", " "));

    expect(text).not.toContain("a`.ts");
    expect(text).toContain("src/a .ts:1");
  });
});

describe("runStructuralChecks", () => {
  const root = "/base";
  const stub = (result: StructuralCheck) => async (): Promise<StructuralCheck> => result;

  it("leaves findings without a claim untouched", async () => {
    const input = [finding(), finding({ file: "src/b.ts" })];
    const output = await runStructuralChecks({ findings: input, baseRoot: root, check: stub({ status: "lexical-matches", references: [{ file: "src/other.ts", line: 3 }], filesSearched: 1 }) });

    expect(output).toEqual(input);
    expect(output.every((f) => f.hostCheck === undefined)).toBe(true);
  });

  it("attaches the host's result to a claimed finding without mutating the input", async () => {
    const input = [finding({ claim })];
    const output = await runStructuralChecks({
      findings: input,
      baseRoot: root,
      check: stub({ status: "lexical-matches", references: [{ file: "src/http.ts", line: 8 }], filesSearched: 3 }),
    });

    expect(output[0]?.hostCheck).toMatchObject({ status: "lexical-matches" });
    expect(input[0]?.hostCheck).toBeUndefined();
  });

  // A contradicted claim is evidence for a reader, not grounds for the host to
  // silently discard a finding a human might still agree with.
  it("never drops or reorders a finding whose claim was contradicted", async () => {
    const input = [finding({ claim }), finding({ file: "src/b.ts", message: "second" })];
    const output = await runStructuralChecks({
      findings: input,
      baseRoot: root,
      check: stub({ status: "lexical-matches", references: [{ file: "x.ts", line: 1 }], filesSearched: 1 }),
    });

    expect(output).toHaveLength(2);
    expect(output[0]?.message).toBe(input[0]?.message);
    expect(output[1]?.message).toBe("second");
  });

  it("reports a thrown check as not-checked rather than failing the review", async () => {
    const output = await runStructuralChecks({
      findings: [finding({ claim })],
      baseRoot: root,
      check: () => Promise.reject(new Error("napi exploded")),
    });

    expect(output[0]?.hostCheck).toMatchObject({ status: "not-checked" });
    expect((output[0]?.hostCheck as { reason: string }).reason).toContain("napi exploded");
  });

  it("passes a renamed finding's base-side path to the check", async () => {
    const seen: { findingFile: string; findingFileAtBase?: string }[] = [];
    await runStructuralChecks({
      findings: [finding({ claim, file: "src/new-name.ts" })],
      baseRoot: root,
      renamedFrom: new Map([["src/new-name.ts", "src/old-name.ts"]]),
      check: async (_claim, input) => {
        seen.push({ findingFile: input.findingFile, ...(input.findingFileAtBase === undefined ? {} : { findingFileAtBase: input.findingFileAtBase }) });
        return { status: "lexical-matches", references: [{ file: "src/other.ts", line: 3 }], filesSearched: 1 };
      },
    });

    expect(seen).toEqual([{ findingFile: "src/new-name.ts", findingFileAtBase: "src/old-name.ts" }]);
  });

  it("omits the base-side path when the file was not renamed", async () => {
    const seen: (string | undefined)[] = [];
    await runStructuralChecks({
      findings: [finding({ claim })],
      baseRoot: root,
      renamedFrom: new Map([["src/other.ts", "src/was.ts"]]),
      check: async (_claim, input) => {
        seen.push(input.findingFileAtBase);
        return { status: "lexical-matches", references: [{ file: "src/other.ts", line: 3 }], filesSearched: 1 };
      },
    });

    expect(seen).toEqual([undefined]);
  });

  // Codex review, round 3, and the deepest finding on this PR: the search reads
  // the BASE while the finding is about the HEAD. A pull request that deletes
  // the last caller is CORRECT to say the symbol is now unused — and the base
  // still contains that caller, so a naive check contradicts a right finding.
  it("drops an occurrence the diff removes from that same file", async () => {
    const output = await runStructuralChecks({
      findings: [finding({ claim })],
      baseRoot: root,
      removedLinesByFile: new Map([["src/http.ts", "export const a = budget(1);"]]),
      check: stub({
        status: "lexical-matches",
        references: [{ file: "src/http.ts", line: 88 }],
        filesSearched: 40,
      }),
    });

    expect(output[0]?.hostCheck?.status).toBe("not-checked");
    expect((output[0]?.hostCheck as { reason: string }).reason).toMatch(/every file where it was found/);
  });

  // Round 4: the first version tested the whole diff as one string, so editing
  // the claimed function's OWN body discarded an untouched caller elsewhere.
  it("keeps an untouched caller when the PR only edits the symbol's own file", async () => {
    const output = await runStructuralChecks({
      findings: [finding({ claim })],
      baseRoot: root,
      // The claimed function's own body changed, so its file's removed lines
      // mention the name — but src/http.ts was not touched.
      removedLinesByFile: new Map([["src/retry.ts", "export function budget(n) { return n; }"]]),
      check: stub({
        status: "lexical-matches",
        references: [{ file: "src/http.ts", line: 88 }],
        filesSearched: 40,
      }),
    });

    expect(output[0]?.hostCheck?.status).toBe("lexical-matches");
  });

  it("does not treat a longer identifier as the symbol", async () => {
    const output = await runStructuralChecks({
      findings: [finding({ claim })],
      baseRoot: root,
      removedLinesByFile: new Map([["src/http.ts", "const rebudget = 1;"]]),
      check: stub({
        status: "lexical-matches",
        references: [{ file: "src/http.ts", line: 88 }],
        filesSearched: 40,
      }),
    });

    expect(output[0]?.hostCheck?.status).toBe("lexical-matches");
  });

  it("checks blocking findings first when the budget binds, and says so on the rest", async () => {
    const input = [
      finding({ severity: "suggestion", claim, file: "src/s.ts" }),
      finding({ severity: "blocking", claim, file: "src/b.ts" }),
    ];
    const output = await runStructuralChecks({
      findings: input,
      baseRoot: root,
      claimBudget: 1,
      check: stub({ status: "lexical-matches", references: [{ file: "src/other.ts", line: 3 }], filesSearched: 2 }),
    });

    // The blocking one was spent the budget; the suggestion is told why not.
    expect(output[1]?.hostCheck).toMatchObject({ status: "lexical-matches" });
    expect(output[0]?.hostCheck).toMatchObject({ status: "not-checked" });
    expect((output[0]?.hostCheck as { reason: string }).reason).toMatch(/limit of 1/);
  });
});
