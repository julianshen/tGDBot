import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

// AC-9.2: Given a fresh clone of the repo with no `.review/rules/`
// directory, When the workflow runs `review` on a real PR, Then the
// built-in rule alone produces a posted comment.
//
// This AC's own TASKS.md "Test:" field says the verification is a "manual
// smoke test (documented in README, per SPEC.md Testing Strategy's 'no
// live LLM calls in automated tests' rule)" — SPEC.md explicitly forbids
// live LLM/gh calls in the automated suite, so this AC genuinely cannot be
// exercised end-to-end here. The honest automated substitute: assert the
// documented manual procedure actually exists in README.md with
// substantive walkthrough content, so this test fails if someone deletes
// or guts the walkthrough while leaving the heading behind.
describe("AC-9.2: README documents the zero-config smoke test procedure", () => {
  it("AC-9.2: README has a 'Zero-config smoke test' section", () => {
    expect(readme).toMatch(/^### Zero-config smoke test/m);
  });

  it("AC-9.2: the smoke-test section walks through the fresh-clone, zero-config procedure", () => {
    const startMatch = readme.match(/^### Zero-config smoke test.*$/m);
    expect(startMatch).not.toBeNull();
    const startIndex = readme.indexOf(startMatch![0]);

    // Section runs until the next level-3 (or higher) heading.
    const rest = readme.slice(startIndex + startMatch![0].length);
    const nextHeadingMatch = rest.match(/^#{1,3} .*$/m);
    const sectionBody = nextHeadingMatch
      ? rest.slice(0, nextHeadingMatch.index)
      : rest;

    // Substantive-content checks: these fail if the walkthrough's actual
    // steps are stripped out even though the heading remains.
    expect(sectionBody).toMatch(/clone the repo fresh/i);
    expect(sectionBody).toContain(".review/rules/");
    expect(sectionBody).toContain("--dry-run");
    expect(sectionBody).toMatch(/no custom rule files were loaded/i);
    // A real numbered walkthrough, not just a one-line pointer.
    const numberedSteps = sectionBody.match(/^\d+\./gm) ?? [];
    expect(numberedSteps.length).toBeGreaterThanOrEqual(4);
  });
});

describe("direct workflow scheduling documentation", () => {
  it("states that direct dispatch consumes sequential waves and legacy does not yet", () => {
    expect(readme).toMatch(/default `direct` dispatch engine consumes these waves/i);
    expect(readme).toMatch(/waves run\s+sequentially/i);
    expect(readme).toMatch(/`legacy` engine does not consume this plan yet/i);
  });
});

describe("GitLab review documentation", () => {
  it("documents GitLab CLI installation, authentication, and API transport", () => {
    expect(readme).toMatch(/install.*`glab`/i);
    expect(readme).toContain("glab auth login --hostname");
    expect(readme).toMatch(
      /glab auth login --hostname[\s\S]{0,120}--api-host/,
    );
    expect(readme).toContain("glab api");
  });

  it("documents GitLab.com, self-managed, custom-port, and full-URL targets", () => {
    expect(readme).toContain("--repo gitlab.com/group/project");
    expect(readme).toContain("--pr 42");
    expect(readme).toContain(
      "--repo gitlab.example.com:8443/group/subgroup/project",
    );
    expect(readme).toContain(
      "--pr https://gitlab.example.com/group/project/-/merge_requests/42",
    );
  });

  it("documents GitLab permissions, trusted rules, fallback, and dry-run behavior", () => {
    expect(readme).toMatch(/minimum GitLab permissions/i);
    expect(readme).toMatch(/notes.*discussions.*repository files/is);
    expect(readme).toMatch(/base branch.*trusted rules/is);
    expect(readme).toMatch(/inline.*partial.*fall(?:s|ing)? back.*summary/is);
    expect(readme).toContain("--dry-run");
  });

  it("documents opt-in GitLab smoke testing while preserving GitHub defaults", () => {
    expect(readme).toMatch(/GitHub remains the default/i);
    expect(readme).toMatch(/opt-in GitLab smoke test/i);
    expect(readme).toMatch(/not part of the default test suite/i);
  });
});
