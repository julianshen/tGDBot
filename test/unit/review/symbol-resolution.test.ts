// Issue #77: the type checker resolves which lexical matches are references.
//
// The lexical walk answers "does the name occur elsewhere"; this file answers
// the question that actually decides a claim — "do those occurrences BIND to
// the symbol the finding's file declares?" Every test here is a fixture on
// disk: a real tsconfig, real sources, a real Program. The resolver's whole
// value is that its answers come from the same machinery the compiler uses,
// so the tests must go through that machinery, not a mock of it.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkStructuralClaim,
  describeCheck,
  describeCheckCompact,
  runStructuralChecks,
  type StructuralCheck,
} from "../../../src/review/structural-check.js";
import type { Finding } from "../../../src/review/types.js";
import {
  createSymbolResolver,
  DEFAULT_RESOLUTION_TIME_BUDGET_MS,
} from "../../../src/review/symbol-resolution.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-resolution-test-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  return root;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: "commonjs", target: "es2022" },
  include: ["src/**/*.ts"],
});

const claim = { kind: "no-other-references" as const, symbol: "budget" };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/wallet.ts",
    line: 1,
    severity: "warning",
    category: "correctness",
    message: "budget() is never called.",
    ruleName: "rule-a",
    ...overrides,
  };
}

describe("symbol resolution (issue #77)", () => {
  it("resolves a real caller through an import, and not the unrelated same-named method", async () => {
    // The headline case from the issue: one true caller, one unrelated class
    // with a same-named method. The lexical walk reports both; only the
    // import is a reference.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": [
        "export function budget(amount: number): number {",
        "  return amount * 2;",
        "}",
        "",
        "export class Wallet {",
        "  budget = 1;",
        "}",
        "",
      ].join("\n"),
      "src/caller.ts": [
        'import { budget } from "./wallet.js";',
        "export const total = budget(21);",
        "",
      ].join("\n"),
      "src/unrelated.ts": [
        "class NotAWallet {",
        "  budget(): void {}",
        "}",
        "export const x = new NotAWallet().budget();",
        "",
      ].join("\n"),
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
      findingLine: 1,
    }, { resolver });

    // `budget` the FUNCTION is referenced twice from caller.ts — the import
    // specifier (line 1, which the lexical walk also counts) and the call
    // (line 2). The finding's anchor (line 1 of wallet.ts) picks the function
    // over the class property `budget = 1` further down the same file.
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.occurrences).toBe(2);
    expect(result.references).toEqual([
      { file: "src/caller.ts", line: 1 },
      { file: "src/caller.ts", line: 2 },
    ]);
    // The unrelated method's two occurrences (declaration + call) do not
    // resolve to the function.
    expect(result.unresolvedOccurrences).toBe(2);
    expect(result.unresolved).toEqual([
      { file: "src/unrelated.ts", line: 2 },
      { file: "src/unrelated.ts", line: 4 },
    ]);
    expect(result.filesResolved).toBe(3);
  });

  it("resolves a call through an import alias", async () => {
    // `import { budget as b }` — the call site's identifier is `b`, and the
    // lexical walk never even saw it. The checker follows the alias to the
    // declaration; this is resolution doing what syntax matching cannot.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget as b } from "./wallet.js";\nexport const total = b(1);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    // The call site spells the alias `b`; the one occurrence of the CLAIMED
    // text is the import specifier itself, which resolves through the alias
    // to the function.
    expect(result.occurrences).toBe(1);
    expect(result.references).toEqual([{ file: "src/caller.ts", line: 1 }]);
  });

  it("resolves a property access on the declared object but not on an unrelated type", async () => {
    // Five of the seven reference forms are property positions, and this is
    // where the checker earns its keep: `wallet.budget()` IS a reference to
    // the declared member, while `config.budget` on the unrelated interface
    // is a different symbol that lexical matching cannot tell apart.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": [
        "export const wallet = { budget: (amount: number): number => amount };",
        "",
      ].join("\n"),
      "src/caller.ts": [
        'import { wallet, type Config } from "./wallet.js";',
        "export const spent = wallet.budget(3);",
        "export interface Config { budget: number }",
        "export function take(config: Config): number {",
        "  return config.budget;",
        "}",
        "",
      ].join("\n"),
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
      findingLine: 1,
    }, { resolver });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.occurrences).toBe(1);
    expect(result.references).toEqual([{ file: "src/caller.ts", line: 2 }]);
    // Both the interface member's own declaration and the `config.budget`
    // access spell the name but bind to the OTHER symbol.
    expect(result.unresolvedOccurrences).toBe(2);
    expect(result.unresolved).toEqual([
      { file: "src/caller.ts", line: 3 },
      { file: "src/caller.ts", line: 5 },
    ]);
  });

  it("keeps the lexical answer for files the program does not cover", async () => {
    // A plain-JS caller the tsconfig does not include. The checker cannot
    // attribute it; the lexical answer must survive — coexistence is the
    // requirement, not a compromise.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
      "legacy/caller.js": 'const { budget } = require("./src/wallet");\nmodule.exports.ran = budget(1);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    // The covered caller resolves; the plain-JS caller keeps the lexical
    // answer, with its own exact census.
    expect(result.occurrences).toBe(2);
    expect(result.lexicalFallback).toEqual({
      references: [
        { file: "legacy/caller.js", line: 1 },
        { file: "legacy/caller.js", line: 2 },
      ],
      occurrences: 2,
    });
  });

  it("degrades to the lexical answer when resolution finds only other symbols and uncovered files have the name", async () => {
    // Zero resolved occurrences never invents a clean verdict, and when the
    // only surviving occurrences are in files the checker cannot attribute,
    // the published answer is the lexical one — unchanged from before #77.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/unrelated.ts": "class Other {\n  budget(): void {}\n}\nexport const x = new Other().budget();\n",
      "legacy/caller.js": 'const { budget } = require("./src/wallet");\nmodule.exports.ran = budget(1);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 4 });
  });

  it("excludes references the diff removes from the resolved census", async () => {
    // The PR deletes the last real caller. The lexical walk suppresses the
    // deleted line during collection; the resolver walks the base tree
    // independently and MUST apply the same reconciliation, or the deleted
    // caller is published as a resolved contradiction against a finding
    // about the head revision (Codex review of PR #104).
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
      "src/keeper.ts": "import { budget } from \"./wallet.js\";\nexport const other = budget(1);\n",
    });
    // The removed lines map: caller.ts line 2 (the call) is deleted. The
    // import specifier on line 1 survives; keeper.ts is untouched.
    const removed = new Map([["src/caller.ts", {
      positioned: true,
      byLine: new Map([[2, "export const total = budget(21);"]]),
      text: "",
    }]]);
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver, removedLinesByFile: removed });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    // The deleted call is gone from the census; the import specifiers and
    // the keeper's call survive.
    expect(result.occurrences).toBe(3);
    expect(result.references).toEqual([
      { file: "src/caller.ts", line: 1 },
      { file: "src/keeper.ts", line: 1 },
      { file: "src/keeper.ts", line: 2 },
    ]);
  });

  it("refuses an ambiguous anchor whose same-named declarations are equidistant", async () => {
    // Two declarations at lines 2 and 6, an anchor at line 4: both are two
    // lines away. A tie cannot attribute, and a guessed pick would publish
    // the other symbol's uses as resolved references.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": [
        "export function budget(amount: number): number {",
        "  return amount;",
        "}",
        "",
        "",
        "export namespace inner {",
        "  export function budget(amount: number): number {",
        "    return amount;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
      // One-based lines 1 and 7 declare the name; the anchor at 4 is
      // EQUIDISTANT (three lines from each), so attribution is a coin toss
      // and the resolver refuses instead of guessing.
      findingLine: 4,
    }, { resolver });

    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 2 });
  });

  it("compares the anchor and declaration lines in one coordinate system", async () => {
    // Declarations on one-based lines 1 and 2; an anchor on line 1. The
    // compiler reports zero-based lines, and without normalizing the bases
    // the anchor 'line 1' is NEAREST to the zero-based line 0... wait, to
    // the line-2 declaration (distance 0 vs 1) — the wrong symbol wins, and
    // the caller's use of the outer function goes unpublished. The fix
    // compares one-based against one-based: the outer declaration is
    // distance 0 and the caller resolves.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": [
        "export function budget(amount: number): number {",
        "  return amount;",
        "}",
        "export namespace inner {",
        "  export function budget(amount: number): number {",
        "    return amount;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
      findingLine: 1,
    }, { resolver });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.occurrences).toBe(2);
  });

  it("reports the inspected scope when the per-claim deadline stops the walk", async () => {
    // The resolved references found before the deadline are sound, but the
    // census is not whole — the result must flag the partial walk and report
    // the files actually reached, not the program's full count (Codex review
    // of PR #104).
    const files: Record<string, string> = {
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    };
    for (const index of [1, 2, 3, 4, 5, 6]) {
      files[`src/module${index}.ts`] = `export const value${index} = ${index};\n`;
    }
    const base = await tree(files);
    const resolver = await createSymbolResolver(base);
    let calls = 0;
    const resolution = await resolver.resolve({
      claim,
      findingFile: "src/wallet.ts",
    }, {
      // Each clock read advances 1ms past a 2ms budget: the walk stops after
      // the first couple of deadline checks, mid-program.
      timeBudgetMs: 2,
      now: () => {
        calls += 1;
        return calls;
      },
    });
    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    expect(resolution.partial).toBe(true);
    expect(resolution.filesResolved).toBeLessThan(8);
  });

  it("never publishes a clean verdict, even when every checked occurrence resolves elsewhere", async () => {
    // The checker proved the two lexical matches are another symbol's method.
    // That SUPPORTS "no other references" but cannot prove it: dynamic
    // references, string access and uncovered files stay invisible — the
    // same invariant the lexical walk holds.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/unrelated.ts": "class Other {\n  budget(): void {}\n}\nexport const x = new Other().budget();\n",
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result.status).toBe("not-checked");
    if (result.status !== "not-checked") return;
    expect(result.reason).toContain("not evidence that no reference exists");
    expect(result.reason).toContain("2 occurrence(s)"); // declaration + call of Other.budget
  });

  it("falls back to the lexical answer when there is no tsconfig", async () => {
    const base = await tree({
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 2 });
  });

  it("falls back to the lexical answer when the compiler is unavailable", async () => {
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base, { loadCompiler: async () => undefined });
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 2 });
  });

  it("falls back when the finding's file does not declare the symbol", async () => {
    // The finding anchors to a file that merely USES the symbol; the claim's
    // "this symbol" cannot be attributed to a declaration here.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/observer.ts": 'import { budget } from "./wallet.js";\nexport const used = typeof budget;\n',
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/observer.ts",
    }, { resolver });

    // observer.ts imports the name, but an import specifier is a reference,
    // not a declaration — the claim cannot be attributed here, and the
    // lexical answer (the wallet declaration plus the caller's two uses)
    // stands unchanged.
    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 3 });
  });

  it("falls back when the finding's file declares several different symbols with one name", async () => {
    // Two distinct value symbols with one name in the finding's file (a
    // module-level function and a namespace-scoped one — an interface and a
    // function would MERGE into one symbol and are not ambiguous). Without
    // the finding's anchor line the attribution is a guess, and a guessed
    // resolved contradiction is the credibility failure this feature exists
    // to avoid.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": [
        "export function budget(amount: number): number {",
        "  return amount;",
        "}",
        "export namespace inner {",
        "  export function budget(amount: number): number {",
        "    return amount;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    // The namespace member is IN the finding's own file, so it is not part
    // of the lexical census either; the two caller occurrences are.
    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 2 });
  });

  it("falls back when the resolution budget is exhausted before the program builds", async () => {
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    let calls = 0;
    const resolver = await createSymbolResolver(base, {
      now: () => {
        calls += 1;
        // The first read sets the start; the second (the post-construction
        // budget check) is already past due.
        return calls === 1 ? 0 : DEFAULT_RESOLUTION_TIME_BUDGET_MS + 1;
      },
    });
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/wallet.ts",
    }, { resolver });

    expect(result).toMatchObject({ status: "lexical-matches", occurrences: 2 });
  });

  it("resolves a renamed file's declaration through findingFileAtBase", async () => {
    // The PR renames wallet.ts to purse.ts; the finding names the head path.
    // The base tree holds the declaration under the old name, and without
    // the base-side path the own-file lookup would miss it.
    const base = await tree({
      "tsconfig.json": TSCONFIG,
      "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
      "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
    });
    const resolver = await createSymbolResolver(base);
    const result = await checkStructuralClaim(claim, {
      baseRoot: base,
      findingFile: "src/purse.ts",
      findingFileAtBase: "src/wallet.ts",
    }, { resolver });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.occurrences).toBe(2);
    expect(result.references).toEqual([
      { file: "src/caller.ts", line: 1 },
      { file: "src/caller.ts", line: 2 },
    ]);
  });

  describe("wording", () => {
    const resolved: StructuralCheck = {
      status: "resolved",
      references: [{ file: "src/caller.ts", line: 2 }],
      occurrences: 2,
      unresolved: [{ file: "src/unrelated.ts", line: 4 }],
      unresolvedOccurrences: 3,
      lexicalFallback: { references: [{ file: "legacy/a.js", line: 9 }], occurrences: 1 },
      filesSearched: 5,
      filesResolved: 4,
    };

    it("says plainly that resolved references are resolved, and accounts for the rest", () => {
      const text = describeCheck(claim, resolved);
      expect(text).toContain("resolves to 2 reference(s) outside this file");
      expect(text).toContain("RESOLVED references");
      expect(text).toContain("3 other occurrence(s) of the name in those files do NOT resolve");
      expect(text).toContain("Plus 1 occurrence(s) in file(s) the type checker does not cover");
      expect(text).toContain("LEXICAL matches only");
    });

    it("keeps the word `resolved` in the compact rendering", () => {
      const text = describeCheckCompact(resolved);
      expect(text).toContain("resolves to 2 reference(s)");
      expect(text).toContain("resolved references");
      expect(text).toContain("3 same-named but unresolved");
    });

    it("says the walk was cut short when the result is partial", () => {
      const text = describeCheck(claim, { ...resolved, partial: true });
      expect(text).toContain("The deadline stopped the walk after 4 file(s)");
      expect(text).toContain("the counts cover what the checker reached");
    });

    it("omits the unresolved and fallback clauses when there is nothing to account for", () => {
      const text = describeCheck(claim, {
        ...resolved,
        unresolved: [],
        unresolvedOccurrences: 0,
        lexicalFallback: undefined,
      });
      expect(text).not.toContain("do NOT resolve");
      expect(text).not.toContain("LEXICAL matches only");
    });
  });

  describe("runStructuralChecks wiring", () => {
    it("shares one resolver across claims and passes it to the real check", async () => {
      const base = await tree({
        "tsconfig.json": TSCONFIG,
        "src/wallet.ts": "export function budget(amount: number): number {\n  return amount;\n}\n",
        "src/caller.ts": 'import { budget } from "./wallet.js";\nexport const total = budget(21);\n',
        "src/other.ts": "export function other(): void {}\n",
      });
      // Two findings, two DISTINCT claims: both get resolved answers from the
      // one program build.
      const findings = [
        { ...finding(), file: "src/wallet.ts", claim: { kind: "no-other-references" as const, symbol: "budget" } },
        {
          ...finding(),
          file: "src/other.ts",
          claim: { kind: "no-other-references" as const, symbol: "other" },
        },
      ];
      const [first, second] = await runStructuralChecks({ findings, baseRoot: base });
      expect(first?.hostCheck?.status).toBe("resolved");
      expect(second?.hostCheck?.status).toBe("not-checked"); // zero occurrences → lexical not-checked
      expect(second?.hostCheck).toMatchObject({ status: "not-checked" });
    });
  });
});

