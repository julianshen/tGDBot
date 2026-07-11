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

// Security review fix #2 (critical): rule files must be loaded from the PR's
// BASE branch, never from the PR's own (attacker-controlled) checkout — see
// the long comment in tgd-review.yml above the "Fetch rule files from the
// BASE branch" step for the full attack scenario. These assertions are
// provable purely from the YAML structure (no live GitHub Actions run
// needed): the workflow's `review` command must NOT rely on the CLI's
// default `--rules-dir` (which would resolve against the PR checkout's own
// `.tgd-review/rules`), and a step must fetch/checkout the PR base sha
// before that command runs.
describe("workflow rule-file trust boundary: rules load from the base branch, not the PR ref", () => {
  function getReviewStep(): { run?: unknown; name?: unknown } {
    const doc = loadYaml(workflowSource) as {
      jobs: { review: { steps: { run?: unknown; name?: unknown; uses?: unknown }[] } };
    };
    const steps = doc.jobs.review.steps;
    const reviewStep = steps.find(
      (step) => typeof step.run === "string" && step.run.includes("review --pr"),
    );
    if (!reviewStep) {
      throw new Error("could not find the `review --pr` step in the workflow's steps");
    }
    return reviewStep;
  }

  it("the `review --pr` step passes an explicit --rules-dir (not the bare default)", () => {
    const reviewStep = getReviewStep();
    const run = reviewStep.run as string;

    expect(run).toContain("--rules-dir");
    // The default rules dir (relative `.tgd-review/rules`, resolved against
    // the PR's own checkout) must never appear as the --rules-dir value —
    // only an absolute path pointing at the separately-checked-out base
    // branch worktree.
    expect(run).not.toMatch(/--rules-dir\s+\.tgd-review\/rules\b/);
    expect(run).toMatch(/--rules-dir\s+\/[^\s]+\.tgd-review\/rules\b/);
  });

  it("a step fetches/checks out the PR's base sha before the review step runs", () => {
    const doc = loadYaml(workflowSource) as {
      jobs: { review: { steps: { run?: unknown; name?: unknown }[] } };
    };
    const steps = doc.jobs.review.steps;

    const baseShaStepIndex = steps.findIndex(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("pull_request.base.sha") &&
        (step.run.includes("git worktree add") || step.run.includes("git fetch")),
    );
    const reviewStepIndex = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.includes("review --pr"),
    );

    expect(baseShaStepIndex).toBeGreaterThanOrEqual(0);
    expect(reviewStepIndex).toBeGreaterThan(baseShaStepIndex);
  });

  it("the --rules-dir value points into the base-sha worktree path used by the fetch step", () => {
    const doc = loadYaml(workflowSource) as {
      jobs: { review: { steps: { run?: unknown }[] } };
    };
    const steps = doc.jobs.review.steps;

    const fetchStep = steps.find(
      (step) => typeof step.run === "string" && step.run.includes("git worktree add"),
    );
    expect(fetchStep).toBeDefined();
    const worktreeMatch = /git worktree add\s+(\S+)\s/.exec(fetchStep!.run as string);
    expect(worktreeMatch).not.toBeNull();
    const worktreePath = worktreeMatch![1];

    const reviewStep = getReviewStep();
    expect(reviewStep.run as string).toContain(`--rules-dir ${worktreePath}/.tgd-review/rules`);
  });
});
