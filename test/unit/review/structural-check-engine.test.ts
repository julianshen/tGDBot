// The structural check publishes an answer produced by one ast-grep version.
// The dedup marker is keyed on head SHA plus config hash, so if the parser
// version is not in that hash, upgrading ast-grep leaves an already-reviewed
// head skipped and its stale answer standing.
//
// `STRUCTURAL_CHECK_ENGINE` is a constant rather than a runtime read of
// package.json, which buys a simpler build and costs the risk of drift. This
// file is what makes that trade safe.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRUCTURAL_CHECK_ENGINE } from "../../../src/review/structural-check.js";
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
    const pinned = manifest.dependencies["@ast-grep/napi"];

    // An exact pin, not a range: a caret would make the constant a guess about
    // whatever npm happened to install.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(STRUCTURAL_CHECK_ENGINE).toBe(`ast-grep@${pinned}`);
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
