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
  it("finds every reference form, not just bare identifiers", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "src/member.ts": "import * as r from './retry.js';\nexport const a = r.budget(1);\n",
      "src/object.ts": "export const o = { budget: 1 };\n",
      "src/optional.ts": "declare const obj: any;\nexport const b = obj?.budget;\n",
      "src/klass.ts": "export class C { budget() { return 1; } }\n",
      "src/type.ts": "export type T = { budget: string };\n",
      "src/named.ts": "import { budget } from './retry.js';\nexport const c = budget(2);\n",
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    expect(result.status).toBe("contradicted");
    if (result.status === "not-checked") throw new Error("unreachable");
    const files = new Set(result.references.map((reference) => reference.file));
    // Every one of these would be lost by an identifier-only search.
    for (const file of ["src/member.ts", "src/object.ts", "src/optional.ts", "src/klass.ts", "src/type.ts"]) {
      expect(files).toContain(file);
    }
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

    expect(result.status).toBe("consistent");
    if (result.status === "not-checked") throw new Error("unreachable");
    expect(result.references.every((reference) => reference.file === "src/retry.ts")).toBe(true);
  });

  it("does not search dependency or build directories", async () => {
    const root = await tree({
      "src/retry.ts": "export function budget(n: number) { return n; }\n",
      "node_modules/pkg/index.ts": "export const budget = 999;\n",
      "dist/bundle.js": "export const budget = 999;\n",
      ".git/hooks/sample.js": "export const budget = 999;\n",
    });

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    expect(result.status).toBe("consistent");
    if (result.status === "not-checked") throw new Error("unreachable");
    expect(result.filesSearched).toBe(1);
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
      .resolves.toMatchObject({ status: "consistent" });
    await expect(checkStructuralClaim(claim, { baseRoot: otherFile, findingFile: "src/retry.ts" }))
      .resolves.toMatchObject({ status: "contradicted" });
  });

  it("never follows a symlink out of the worktree", async () => {
    const outside = await tree({ "secret.ts": "export const budget = 1;\n" });
    const root = await tree({ "src/retry.ts": "export function budget(n: number) { return n; }\n" });
    await symlink(outside, path.join(root, "linked"));

    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "src/retry.ts" });

    expect(result.status).toBe("consistent");
    if (result.status === "not-checked") throw new Error("unreachable");
    expect(result.references.every((reference) => !reference.file.includes("linked"))).toBe(true);
  });
});

describe("checkStructuralClaim — refusing rather than guessing", () => {
  it("does not check a tree with no language it supports", async () => {
    const root = await tree({ "main.go": "package main\nfunc budget() {}\n" });

    await expect(checkStructuralClaim(claim, { baseRoot: root, findingFile: "main.go" }))
      .resolves.toMatchObject({ status: "not-checked", reason: expect.stringContaining("supports") });
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

  // An exhausted budget must not read as a clean result: a partial search that
  // reported "consistent" would be the false confirmation in another costume.
  it("reports an exhausted time budget as not-checked, never as consistent", async () => {
    const root = await tree({
      "a.ts": "export const x = 1;\n",
      "b.ts": "export const y = 2;\n",
      "c.ts": "export const z = 3;\n",
    });
    let clock = 0;
    const result = await checkStructuralClaim(claim, { baseRoot: root, findingFile: "a.ts" }, {
      timeBudgetMs: 5,
      now: () => (clock += 10),
    });

    expect(result.status).toBe("not-checked");
    if (result.status !== "not-checked") throw new Error("unreachable");
    expect(result.reason).toMatch(/budget/i);
    expect(result.reason).toMatch(/incomplete/i);
  });
});

describe("describeCheck", () => {
  // The single most important sentence in the feature. A clean result must
  // describe what was searched, never assert that no caller exists: a dynamic
  // reference, an unparsed language, or a caller in another repository is
  // invisible here, and a reader who takes a gap for proof has been misled.
  it("states what was searched, and does not claim there are no callers", () => {
    const check: StructuralCheck = { status: "consistent", references: [], filesSearched: 12 };
    const text = describeCheck(claim, check);

    expect(text).toContain("searched 12 file(s)");
    expect(text).toMatch(/not proof/i);
    expect(text).toMatch(/dynamic references/i);
    expect(text).not.toMatch(/there are no (callers|references)/i);
  });

  it("names the contradicting locations and says it contradicts", () => {
    const check: StructuralCheck = {
      status: "contradicted",
      references: [{ file: "src/http.ts", line: 88 }, { file: "src/queue.ts", line: 12 }],
      filesSearched: 40,
    };
    const text = describeCheck(claim, check);

    expect(text).toContain("src/http.ts:88");
    expect(text).toContain("src/queue.ts:12");
    expect(text).toMatch(/contradicts/i);
  });

  it("always says why a check was not performed", () => {
    expect(describeCheck(claim, { status: "not-checked", reason: "the base worktree is unavailable" }))
      .toContain("the base worktree is unavailable");
  });

  // A path from the base tree may legally contain a backtick, which git writes
  // bare and which closes the code span it lands in (#63).
  it("escapes interpolated paths through the caller's escaper", () => {
    const check: StructuralCheck = {
      status: "contradicted",
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
  const stub = (result: StructuralCheck) => async () => result;

  it("leaves findings without a claim untouched", async () => {
    const input = [finding(), finding({ file: "src/b.ts" })];
    const output = await runStructuralChecks({ findings: input, baseRoot: root, check: stub({ status: "consistent", references: [], filesSearched: 1 }) });

    expect(output).toEqual(input);
    expect(output.every((f) => f.hostCheck === undefined)).toBe(true);
  });

  it("attaches the host's result to a claimed finding without mutating the input", async () => {
    const input = [finding({ claim })];
    const output = await runStructuralChecks({
      findings: input,
      baseRoot: root,
      check: stub({ status: "contradicted", references: [{ file: "src/http.ts", line: 8 }], filesSearched: 3 }),
    });

    expect(output[0]?.hostCheck).toMatchObject({ status: "contradicted" });
    expect(input[0]?.hostCheck).toBeUndefined();
  });

  // A contradicted claim is evidence for a reader, not grounds for the host to
  // silently discard a finding a human might still agree with.
  it("never drops or reorders a finding whose claim was contradicted", async () => {
    const input = [finding({ claim }), finding({ file: "src/b.ts", message: "second" })];
    const output = await runStructuralChecks({
      findings: input,
      baseRoot: root,
      check: stub({ status: "contradicted", references: [{ file: "x.ts", line: 1 }], filesSearched: 1 }),
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

  it("checks blocking findings first when the budget binds, and says so on the rest", async () => {
    const input = [
      finding({ severity: "suggestion", claim, file: "src/s.ts" }),
      finding({ severity: "blocking", claim, file: "src/b.ts" }),
    ];
    const output = await runStructuralChecks({
      findings: input,
      baseRoot: root,
      claimBudget: 1,
      check: stub({ status: "consistent", references: [], filesSearched: 2 }),
    });

    // The blocking one was spent the budget; the suggestion is told why not.
    expect(output[1]?.hostCheck).toMatchObject({ status: "consistent" });
    expect(output[0]?.hostCheck).toMatchObject({ status: "not-checked" });
    expect((output[0]?.hostCheck as { reason: string }).reason).toMatch(/limit of 1/);
  });
});
