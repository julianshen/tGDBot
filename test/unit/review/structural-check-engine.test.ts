// The structural check publishes an answer produced by one ast-grep version.
// The dedup marker is keyed on head SHA plus config hash, so if the parser
// version is not in that hash, upgrading ast-grep leaves an already-reviewed
// head skipped and its stale answer standing.
//
// `STRUCTURAL_CHECK_ENGINE` is a constant rather than a runtime read of
// package.json, which buys a simpler build and costs the risk of drift. This
// file is what makes that trade safe.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { STRUCTURAL_CHECK_ENGINE, TREE_SITTER_GRAMMAR_VERSIONS } from "../../../src/review/structural-check.js";
import { computeReviewConfigHash } from "../../../src/review/dedup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const base = {
  advisor: "on" as const,
  suggestions: "on" as const,
  disableBuiltinRule: false,
  trustLocalRules: false,
  rulesDir: ".review/rules",
  dispatch: "direct" as const,
};

describe("structural-check engine identity", () => {
  it("names the exact version package.json pins", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const astGrep = manifest.dependencies["@ast-grep/napi"];
    const typescript = manifest.dependencies.typescript;

    // An exact pin, not a range: a caret would make the constant a guess about
    // whatever npm happened to install.
    expect(astGrep).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(typescript).toMatch(/^\d+\.\d+\.\d+$/u);
    // Resolution (issue #77) is part of the engine: a typescript upgrade can
    // change which occurrences resolve, so it belongs in the identity too.
    // Issue #142: the dynamic tree-sitter grammars are part of it as well —
    // their kind tables were measured against specific versions, and a
    // grammar upgrade can change what a reference IS.
    // The grammar versions come from the source table (they are compiled from
    // pinned grammar repos, not npm), so the identity is asserted against it.
    expect(STRUCTURAL_CHECK_ENGINE).toBe(
      `ast-grep@${astGrep}+typescript@${typescript}` +
      `+tree-sitter-python@${TREE_SITTER_GRAMMAR_VERSIONS.python}` +
      `+tree-sitter-go@${TREE_SITTER_GRAMMAR_VERSIONS.go}`,
    );
  });

  it("re-triggers a review when the parser version changes", () => {
    const before = computeReviewConfigHash({
      ...base,
      structuralChecks: "on",
      structuralCheckEngine: "ast-grep@0.45.2",
    });
    const after = computeReviewConfigHash({
      ...base,
      structuralChecks: "on",
      structuralCheckEngine: "ast-grep@0.46.0",
    });

    expect(before).not.toBe(after);
  });

  // Issue #142 / Codex review of PR #143 round two: AVAILABILITY changes what
  // a review produces (a Python finding is not-checked without the library,
  // checked with it), so installing a grammar must change the config hash and
  // re-check existing heads instead of matching a stale marker.
  it("re-triggers a review when a dynamic grammar is installed", () => {
    const before = computeReviewConfigHash({
      ...base,
      structuralChecks: "on",
      // An explicit engine pins the identity — the production default is what
      // this test varies, via the environment the identity function reads.
      structuralCheckEngine: undefined,
    });
    process.env.TGD_TREE_SITTER_LIB_DIR = "/tmp/does-not-exist";
    const emptyDir = computeReviewConfigHash({ ...base, structuralChecks: "on" });
    delete process.env.TGD_TREE_SITTER_LIB_DIR;
    // A directory with no libraries: same identity as no env at all.
    expect(emptyDir).toBe(computeReviewConfigHash({ ...base, structuralChecks: "on" }));

    // An installed grammar changes the identity.
    const libDir = mkdtempSync(path.join(os.tmpdir(), "tgd-grammars-"));
    writeFileSync(path.join(libDir, "tree_sitter_python.so"), "not a real library — availability is a file check");
    try {
      process.env.TGD_TREE_SITTER_LIB_DIR = libDir;
      const after = computeReviewConfigHash({ ...base, structuralChecks: "on" });
      expect(after).not.toBe(before);
    } finally {
      delete process.env.TGD_TREE_SITTER_LIB_DIR;
      rmSync(libDir, { recursive: true, force: true });
    }
  });

  // The cost of this feature has to land only on repositories that opted in.
  // An unconditional field would re-review every open PR on every upgrade,
  // including for people who never enabled the flag.
  it("costs nothing to a repository with the flag off", () => {
    const off = computeReviewConfigHash({ ...base, structuralChecks: "off" });
    const offNewEngine = computeReviewConfigHash({
      ...base,
      structuralChecks: "off",
      structuralCheckEngine: "ast-grep@99.0.0",
    });
    const absent = computeReviewConfigHash(base);

    expect(off).toBe(offNewEngine);
    expect(off).toBe(absent);
  });
});
