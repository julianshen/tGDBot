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

// DEBT.md (Security, Medium): "No npm audit/provenance gate in CI" — the
// runtime dependency chain (pi-subagents / rpiv-advisor / pi-coding-agent)
// is pinned to exact versions but otherwise unaudited, despite being able
// to execute code and influence agent behavior. Assert the CI job actually
// runs `npm audit` as its own step (not folded into the build step), gated
// on high/critical severity, and that it runs after `npm ci` and before the
// build/review steps.
describe("workflow dependency audit gate: npm audit runs as its own CI step", () => {
  function getSteps(): { run?: unknown; name?: unknown; uses?: unknown }[] {
    const doc = loadYaml(workflowSource) as {
      jobs: { review: { steps: { run?: unknown; name?: unknown; uses?: unknown }[] } };
    };
    return doc.jobs.review.steps;
  }

  it("a step's `run:` contains `npm audit` with a high/critical threshold", () => {
    const steps = getSteps();
    const auditStep = steps.find(
      (step) => typeof step.run === "string" && step.run.includes("npm audit"),
    );

    expect(auditStep).toBeDefined();
    const run = auditStep!.run as string;
    expect(run).toContain("npm audit");
    expect(run).toMatch(/--audit-level[= ]high/);
  });

  it("the audit step is separate from `npm ci` and `npm run build` (not folded into either)", () => {
    const steps = getSteps();
    const auditStep = steps.find(
      (step) => typeof step.run === "string" && step.run.includes("npm audit"),
    );

    expect(auditStep).toBeDefined();
    const run = auditStep!.run as string;
    // The audit step's own run: must not also perform `npm ci` or
    // `npm run build` — those must be distinct steps, so an audit failure
    // is attributable in the Actions UI to "dependency audit failed" and
    // not conflated with an install or build failure.
    expect(run).not.toContain("npm ci");
    expect(run).not.toContain("npm run build");
  });

  it("npm ci runs before the audit step, which runs before npm run build", () => {
    const steps = getSteps();
    const ciIndex = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.trim() === "npm ci",
    );
    const auditIndex = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.includes("npm audit"),
    );
    const buildIndex = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.trim() === "npm run build",
    );

    expect(ciIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(ciIndex);
    expect(buildIndex).toBeGreaterThan(auditIndex);
  });
});

// ADR-002 / CLI-native fix: rule files must be loaded from the PR's BASE
// branch, never from the PR's own (attacker-controlled) checkout — but that
// trust boundary is now enforced INSIDE the CLI itself (review()'s default
// `getRuleFilesFromBase` flow, driven off `pr.baseSha` fetched via `gh api`
// — see src/cli.ts's `loadRulesForReview` and src/vcs/github-adapter.ts's
// `getRuleFilesFromBase`), not by bespoke workflow-YAML ceremony. The old
// `git fetch`/`git worktree add` step and the `--rules-dir
// /tmp/base-rules-checkout/...` override are gone: the CLI's own default
// `--rules-dir` value (the repo-relative `.tgd-review/rules`) already means
// "fetch from the base branch via the API" without any workflow-specific
// wiring, and it works identically for a local `gh`-authenticated run, this
// workflow, or any future CI system — not just GitHub Actions' `git
// worktree` primitives.
describe("workflow rule-file trust boundary: sourced from the base branch via the CLI, not workflow YAML", () => {
  function getSteps(): { run?: unknown; name?: unknown; uses?: unknown }[] {
    const doc = loadYaml(workflowSource) as {
      jobs: { review: { steps: { run?: unknown; name?: unknown; uses?: unknown }[] } };
    };
    return doc.jobs.review.steps;
  }

  function getReviewStep(): { run?: unknown; name?: unknown } {
    const reviewStep = getSteps().find(
      (step) => typeof step.run === "string" && step.run.includes("review --pr"),
    );
    if (!reviewStep) {
      throw new Error("could not find the `review --pr` step in the workflow's steps");
    }
    return reviewStep;
  }

  it("the `review --pr` step no longer passes an explicit --rules-dir override — the CLI's own default now sources from the base branch", () => {
    const reviewStep = getReviewStep();
    const run = reviewStep.run as string;

    expect(run).not.toContain("--rules-dir");
    expect(run).not.toContain("/tmp/base-rules-checkout");
  });

  it("the workflow no longer contains a dedicated 'fetch rule files from the base branch' git worktree step", () => {
    const steps = getSteps();

    const worktreeStep = steps.find(
      (step) => typeof step.run === "string" && step.run.includes("git worktree add"),
    );
    expect(worktreeStep).toBeUndefined();

    const fetchStep = steps.find(
      (step) => typeof step.run === "string" && /\bgit fetch\b/.test(step.run),
    );
    expect(fetchStep).toBeUndefined();
  });

  it("the workflow no longer references github.event.pull_request.base.sha — that logic moved into the CLI", () => {
    expect(workflowSource).not.toContain("pull_request.base.sha");
  });

  it("the review step still passes --pr (the CLI resolves baseSha itself via gh pr view)", () => {
    const reviewStep = getReviewStep();
    const run = reviewStep.run as string;

    expect(run).toContain("review --pr");
  });
});
