// Issue #115. A surprising match here is a rule that silently did not review
// something, so the cases are written out rather than sampled.
import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAnyPath, normalizeGlobPath } from "../../../src/rules/glob.js";

function matches(glob: string, candidate: string): boolean {
  return globToRegExp(glob).test(normalizeGlobPath(candidate));
}

describe("globToRegExp", () => {
  it("matches a literal path", () => {
    expect(matches("package.json", "package.json")).toBe(true);
    expect(matches("package.json", "app/package.json")).toBe(false);
  });

  it("keeps `*` inside one segment", () => {
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    // The whole point of the segment bound: `*` must not swallow a directory,
    // or every rule scoped to a folder silently reviews the tree below it.
    expect(matches("src/*.ts", "src/nested/a.ts")).toBe(false);
  });

  it("lets `**/` match zero directories", () => {
    // `**/*.ts` has to match a file at the root, or a rule scoped that way
    // misses exactly the top-level files most likely to matter.
    expect(matches("**/*.ts", "a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/deep/nested/a.ts")).toBe(true);
  });

  it("does not let `**/` cross into a different prefix", () => {
    expect(matches("src/**/*.ts", "src/a/b.ts")).toBe(true);
    expect(matches("src/**/*.ts", "test/a/b.ts")).toBe(false);
  });

  it("matches a brace alternation", () => {
    expect(matches("**/*.{yaml,yml}", "ci/build.yml")).toBe(true);
    expect(matches("**/*.{yaml,yml}", "ci/build.yaml")).toBe(true);
    expect(matches("**/*.{yaml,yml}", "ci/build.json")).toBe(false);
  });

  it("matches exactly one character for `?`, never a separator", () => {
    expect(matches("src/a?.ts", "src/ab.ts")).toBe(true);
    expect(matches("src/a?.ts", "src/abc.ts")).toBe(false);
    expect(matches("a?b", "a/b")).toBe(false);
  });

  it("treats regex syntax in a glob as literal text", () => {
    // A dot is the common case and the dangerous one: unescaped, `*.ts` would
    // match `foots` and a rule would run on files it never claimed.
    expect(matches("src/a.ts", "src/aXts")).toBe(false);
    expect(matches("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(matches("src/(x).ts", "src/(x).ts")).toBe(true);
  });

  it("refuses syntax it does not implement rather than matching loosely", () => {
    // A rule declaring one of these and silently matching nothing would stop
    // running with no explanation. The loader turns each throw into a load
    // error naming the file.
    expect(() => globToRegExp("src/[a-z].ts")).toThrow(/character classes/);
    expect(() => globToRegExp("!src/a.ts")).toThrow(/negated/);
    expect(() => globToRegExp("src/{a,{b,c}}.ts")).toThrow(/nested braces/);
    expect(() => globToRegExp("src/{a.ts")).toThrow(/unbalanced brace/);
    expect(() => globToRegExp("src/a}.ts")).toThrow(/unbalanced brace/);
    expect(() => globToRegExp("")).toThrow(/must not be empty/);
  });
});

describe("normalizeGlobPath", () => {
  it("collapses equivalent spellings of one path", () => {
    // A cosmetic difference must never be the reason a rule did not run.
    for (const spelling of ["./src/a.ts", "src//a.ts", "/src/a.ts", "src\\a.ts"]) {
      expect(normalizeGlobPath(spelling)).toBe("src/a.ts");
    }
  });
});

describe("matchesAnyPath", () => {
  const patterns = [globToRegExp("**/*.ts")];

  it("matches when any changed path matches", () => {
    // ANY, not all: a README touched alongside the code must not disable a
    // rule that cares about the code.
    expect(matchesAnyPath(patterns, ["README.md", "src/a.ts"])).toBe(true);
  });

  it("does not match when no changed path does", () => {
    expect(matchesAnyPath(patterns, ["README.md", "main.go"])).toBe(false);
  });

  it("normalizes the candidate paths", () => {
    expect(matchesAnyPath(patterns, ["./src/a.ts"])).toBe(true);
  });

  it("does not match an empty path list", () => {
    expect(matchesAnyPath(patterns, [])).toBe(false);
  });
});
