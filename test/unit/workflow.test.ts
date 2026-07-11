import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "tgd-review.yml",
);
const workflowSource = readFileSync(workflowPath, "utf8");

// AC-9.1: Given the workflow file `.github/workflows/tgd-review.yml`, When
// it is validated with `actionlint` (or GitHub's own workflow syntax
// check), Then it reports no syntax errors.
//
// Primary assertion: parse the file as YAML and check the top-level shape
// GitHub Actions requires. This always runs, with no environment
// dependency (unlike actionlint, which may not be installed everywhere
// `npm test` runs).
describe("AC-9.1: .github/workflows/tgd-review.yml syntax", () => {
  it("AC-9.1: parses as valid YAML with the expected top-level keys", () => {
    let parsed: unknown;
    expect(() => {
      parsed = loadYaml(workflowSource);
    }).not.toThrow();

    expect(parsed).toBeTypeOf("object");
    expect(parsed).not.toBeNull();

    const doc = parsed as Record<string, unknown>;
    // js-yaml parses the unquoted top-level `on:` key as the boolean `true`
    // (YAML 1.1 quirk), so check for either key form.
    const topLevelKeys = Object.keys(doc);
    expect(topLevelKeys.includes("on") || topLevelKeys.includes("true")).toBe(
      true,
    );
    expect(doc).toHaveProperty("permissions");
    expect(doc).toHaveProperty("jobs");
  });

  it("AC-9.1: declares pull-requests write and contents read permissions", () => {
    const doc = loadYaml(workflowSource) as Record<string, unknown>;
    expect(doc.permissions).toEqual({
      "pull-requests": "write",
      contents: "read",
    });
  });

  // Bonus/conditional check: if actionlint is installed in the environment
  // running this test, also run it for a second, stricter opinion (it
  // understands GitHub Actions semantics beyond plain YAML syntax, e.g.
  // valid `uses:` refs and context expressions). Skipped gracefully when
  // actionlint isn't on PATH, since it isn't guaranteed to be present
  // everywhere `npm test` runs.
  const actionlintAvailable = (() => {
    try {
      execFileSync("which", ["actionlint"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!actionlintAvailable)(
    "AC-9.1: actionlint reports no syntax errors (skipped if actionlint is not installed)",
    () => {
      expect(() =>
        execFileSync("actionlint", [workflowPath], {
          cwd: repoRoot,
          stdio: "pipe",
        }),
      ).not.toThrow();
    },
  );
});
