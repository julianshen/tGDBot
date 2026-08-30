// Issue #69: a changed dependency whose name is one keystroke from another
// the same manifest already declares. Host-computed, no network.
import { describe, expect, it } from "vitest";
import { typosquatFacts, typosquatMatches } from "../../../src/review/dependency-typosquat.js";

describe("typosquatMatches", () => {
  it("flags a transposition of an already-declared name", () => {
    expect(typosquatMatches("lodahs", ["lodash", "express"])).toEqual([
      { existing: "lodash", distance: 1, kind: "transposition" },
    ]);
  });

  it("flags a truncated name of an already-declared package", () => {
    expect(typosquatMatches("expres", ["express"])).toEqual([
      { existing: "express", distance: 1, kind: "deletion" },
    ]);
  });

  it("flags a doubled letter of an already-declared package", () => {
    expect(typosquatMatches("chalkk", ["chalk"])).toEqual([
      { existing: "chalk", distance: 1, kind: "insertion" },
    ]);
  });

  it("flags a substitution of an already-declared name", () => {
    expect(typosquatMatches("lodqsh", ["lodash"])).toEqual([
      { existing: "lodash", distance: 1, kind: "substitution" },
    ]);
  });

  it("flags a scoped local-name transposition", () => {
    expect(typosquatMatches("@types/noed", ["@types/node"])).toEqual([
      { existing: "@types/node", distance: 1, kind: "transposition" },
    ]);
  });

  it("flags a scoped package that typosquats an unscoped name already declared", () => {
    expect(typosquatMatches("@acme/lodahs", ["lodash"])).toEqual([
      { existing: "lodash", distance: 1, kind: "transposition" },
    ]);
  });

  it("flags a one-keystroke typo in the scope, not the local name", () => {
    expect(typosquatMatches("@anuglar/core", ["@angular/core"])).toEqual([
      { existing: "@angular/core", distance: 1, kind: "transposition" },
    ]);
  });

  it("does not flag a name against itself", () => {
    expect(typosquatMatches("lodash", ["lodash", "express"])).toEqual([]);
  });

  it("does not flag unrelated names", () => {
    expect(typosquatMatches("left-pad", ["lodash", "express"])).toEqual([]);
  });

  // False positives the issue names: a check that flags these trains reviewers
  // to ignore it, which is worse than not having it.
  it("does not flag @types/node against node", () => {
    expect(typosquatMatches("@types/node", ["node"])).toEqual([]);
    expect(typosquatMatches("node", ["@types/node"])).toEqual([]);
  });

  it("does not flag react against preact", () => {
    expect(typosquatMatches("preact", ["react"])).toEqual([]);
    expect(typosquatMatches("react", ["preact"])).toEqual([]);
  });

  it("does not flag vue against vuex", () => {
    expect(typosquatMatches("vuex", ["vue"])).toEqual([]);
    expect(typosquatMatches("vue", ["vuex"])).toEqual([]);
  });

  it("does not flag scoped and unscoped names of the same local package", () => {
    expect(typosquatMatches("@angular/core", ["core"])).toEqual([]);
    expect(typosquatMatches("core", ["@angular/core"])).toEqual([]);
  });

  it("does not flag two scoped packages that only share a local name", () => {
    expect(typosquatMatches("@nestjs/core", ["@angular/core"])).toEqual([]);
  });
});

describe("typosquatFacts", () => {
  it("compares a changed name against other names in the same manifest", () => {
    const facts = typosquatFacts(
      [{ name: "lodahs", manifest: "package.json" }],
      new Map([["package.json", ["lodash", "lodahs", "express"]]]),
    );

    expect(facts).toEqual([
      {
        candidateName: "lodahs",
        manifest: "package.json",
        matches: [{ existing: "lodash", distance: 1, kind: "transposition" }],
      },
    ]);
  });

  it("does not compare across manifests", () => {
    const facts = typosquatFacts(
      [{ name: "lodahs", manifest: "web/package.json" }],
      new Map([
        ["web/package.json", ["lodahs"]],
        ["package.json", ["lodash"]],
      ]),
    );

    expect(facts[0]?.matches).toEqual([]);
    expect(facts[0]?.skipped).toBe("no-other-names");
  });

  it("says so when the manifest has no other name to compare against", () => {
    const facts = typosquatFacts(
      [{ name: "lodahs", manifest: "package.json" }],
      new Map([["package.json", ["lodahs"]]]),
    );

    expect(facts[0]).toEqual({
      candidateName: "lodahs",
      manifest: "package.json",
      matches: [],
      skipped: "no-other-names",
    });
  });

  it("does not treat a version bump of the same name as a typosquat of itself", () => {
    const facts = typosquatFacts(
      [{ name: "lodash", manifest: "package.json" }],
      new Map([["package.json", ["lodash", "express"]]]),
    );

    expect(facts[0]?.matches).toEqual([]);
    expect(facts[0]?.skipped).toBeUndefined();
  });

  it("compares non-semver candidates correctly", () => {
    const facts = typosquatFacts(
      [
        { name: "lodahs", manifest: "package.json" },
        { name: "expres", manifest: "package.json" },
      ],
      new Map([["package.json", ["lodash", "express", "lodahs", "expres"]]]),
    );

    expect(facts).toEqual([
      {
        candidateName: "lodahs",
        manifest: "package.json",
        matches: [{ existing: "lodash", distance: 1, kind: "transposition" }],
      },
      {
        candidateName: "expres",
        manifest: "package.json",
        matches: [{ existing: "express", distance: 1, kind: "deletion" }],
      },
    ]);
  });
});
