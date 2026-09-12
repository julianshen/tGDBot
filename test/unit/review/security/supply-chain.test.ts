// Issue #139, `security:supply-chain`. Ordered by how much the property
// matters, not by how the module is laid out.
import { describe, expect, it } from "vitest";
import {
  detectSupplyChainHazards,
  SUPPLY_CHAIN_POLICY,
  SUPPLY_CHAIN_RULE_NAME,
} from "../../../../src/review/security/supply-chain.js";

function diffAdding(file: string, ...lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${1 + lines.length} @@`,
    " keep",
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

const WORKFLOW = ".github/workflows/ci.yml";

describe("mutable action refs", () => {
  it("reports a tag-pinned action", () => {
    // A tag can be repointed by anyone who can push to that repository, so the
    // code this workflow runs can change without this repository changing —
    // the shape of the tj-actions/changed-files compromise.
    const [finding] = detectSupplyChainHazards(diffAdding(WORKFLOW, "      - uses: actions/checkout@v4"));

    expect(finding).toMatchObject({
      file: WORKFLOW,
      severity: "warning",
      category: "security",
      ruleName: SUPPLY_CHAIN_RULE_NAME,
    });
    // The author needs to see WHICH action; unlike a credential, this is
    // public information and safe to quote.
    expect(finding?.title).toContain("actions/checkout");
  });

  it("accepts a full commit SHA", () => {
    const sha = "a".repeat(40);
    expect(detectSupplyChainHazards(diffAdding(WORKFLOW, `      - uses: actions/checkout@${sha}`)))
      .toEqual([]);
  });

  it("rejects a short SHA, which is not immutable either", () => {
    // A 7-character prefix can collide and is not what the ref resolves by.
    expect(detectSupplyChainHazards(diffAdding(WORKFLOW, "      - uses: actions/checkout@abc1234")))
      .toHaveLength(1);
  });

  it("ignores a local action, which this pull request is already reviewing", () => {
    // `./.github/actions/x` is the repository's own code — there is no
    // external ref to move.
    expect(detectSupplyChainHazards(diffAdding(WORKFLOW, "      - uses: ./.github/actions/setup")))
      .toEqual([]);
  });

  it("ignores a docker:// reference", () => {
    expect(detectSupplyChainHazards(diffAdding(WORKFLOW, "      - uses: docker://alpine:3.19")))
      .toEqual([]);
  });

  it("applies to an action definition too, not only a workflow", () => {
    // A composite action's own `uses:` runs in every workflow that calls it.
    expect(detectSupplyChainHazards(diffAdding(".github/actions/setup/action.yml", "  - uses: actions/cache@v3")))
      .toHaveLength(1);
  });

  it("ignores a uses: line outside a workflow file", () => {
    // The detector reads workflow SYNTAX; the same text in documentation or a
    // test fixture is not a workflow step.
    expect(detectSupplyChainHazards(diffAdding("docs/ci.md", "      - uses: actions/checkout@v4")))
      .toEqual([]);
  });
});

describe("pull_request_target", () => {
  // Reported only in COMBINATION. The trigger alone is the documented way to
  // label or comment on a fork's pull request; warning on it everywhere is the
  // alarm fatigue that trains people to skip the section.
  it("reports the trigger combined with a checkout of the PR head", () => {
    const [finding] = detectSupplyChainHazards(diffAdding(
      WORKFLOW,
      "on: pull_request_target",
      "      - uses: actions/checkout@" + "a".repeat(40),
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
    ));

    expect(finding).toMatchObject({ severity: "blocking", ruleName: SUPPLY_CHAIN_RULE_NAME });
    expect(finding?.message).toMatch(/secrets/u);
  });

  it("reports a head checkout ADDED to a workflow that already had the trigger", () => {
    // The half-and-half case. Added-lines-only saw one half and stayed silent,
    // while the pull request introduced the exploitable combination just as
    // surely as one adding both (Codex review of PR #151).
    const diff = diffAdding(WORKFLOW, "          ref: ${{ github.event.pull_request.head.sha }}");
    const head = new Map([[WORKFLOW, "on: pull_request_target\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@" + "a".repeat(40)]]);

    const findings = detectSupplyChainHazards(diff, head);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocking");
  });

  it("reports a trigger ADDED to a workflow that already checked out the head", () => {
    const diff = diffAdding(WORKFLOW, "on: pull_request_target");
    const head = new Map([[WORKFLOW, "          ref: ${{ github.event.pull_request.head.sha }}"]]);

    expect(detectSupplyChainHazards(diff, head)).toHaveLength(1);
  });

  it("stays silent when the combination predates this pull request", () => {
    // Neither half added. Reporting it on every unrelated change to the file
    // is the alarm fatigue added-lines-only exists to avoid.
    const diff = diffAdding(WORKFLOW, "      - run: echo hello");
    const head = new Map([[WORKFLOW,
      "on: pull_request_target\n          ref: ${{ github.event.pull_request.head.sha }}"]]);

    expect(detectSupplyChainHazards(diff, head)).toEqual([]);
  });

  it("anchors the finding to the half this pull request added", () => {
    // That is the line its author can act on, and the line a reviewer is
    // looking at.
    const diff = diffAdding(WORKFLOW, "      - run: setup", "on: pull_request_target");
    const head = new Map([[WORKFLOW, "          ref: ${{ github.event.pull_request.head.sha }}"]]);

    expect(detectSupplyChainHazards(diff, head)[0]?.line).toBe(3);
  });

  it("stays silent on the trigger alone", () => {
    expect(detectSupplyChainHazards(diffAdding(WORKFLOW, "on: pull_request_target")))
      .toEqual([]);
  });

  it("stays silent on a head checkout under an ordinary trigger", () => {
    // Without `pull_request_target` the job has no base-repository secrets, so
    // checking out the pull request's code is exactly what CI is for.
    expect(detectSupplyChainHazards(diffAdding(
      WORKFLOW,
      "on: pull_request",
      "          ref: ${{ github.event.pull_request.head.sha }}",
    ))).toEqual([]);
  });

  it("recognises the trigger inside a list", () => {
    const findings = detectSupplyChainHazards(diffAdding(
      WORKFLOW,
      "on: [push, pull_request_target]",
      "          ref: ${{ github.event.pull_request.head.ref }}",
    ));
    expect(findings).toHaveLength(1);
  });
});

describe("workflow permissions", () => {
  it("reports write-all", () => {
    const [finding] = detectSupplyChainHazards(diffAdding(WORKFLOW, "permissions: write-all"));

    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toMatch(/contents: read/u);
  });

  it("stays silent on a scoped permission block", () => {
    expect(detectSupplyChainHazards(diffAdding(WORKFLOW, "permissions:", "  contents: read")))
      .toEqual([]);
  });
});

describe("moving dependency refs", () => {
  it("reports a git URL dependency", () => {
    const [finding] = detectSupplyChainHazards(diffAdding(
      "package.json",
      '    "thing": "git+https://github.com/o/r.git#main",',
    ));

    expect(finding).toMatchObject({ severity: "warning", ruleName: SUPPLY_CHAIN_RULE_NAME });
    expect(finding?.message).toMatch(/integrity/u);
  });

  it("reports a github: shorthand", () => {
    expect(detectSupplyChainHazards(diffAdding("package.json", '    "thing": "github:owner/repo",')))
      .toHaveLength(1);
  });

  it("accepts a git dependency pinned to a full commit SHA", () => {
    // Immutable. Without this the detector told the author to pin to exactly
    // the form already in front of them (Codex review of PR #151).
    const sha = "b".repeat(40);
    expect(detectSupplyChainHazards(diffAdding(
      "package.json",
      `    "thing": "git+https://github.com/o/r.git#${sha}",`,
    ))).toEqual([]);
  });

  it("still reports a git dependency pinned to a tag", () => {
    expect(detectSupplyChainHazards(diffAdding(
      "package.json",
      '    "thing": "git+https://github.com/o/r.git#v1.2.3",',
    ))).toHaveLength(1);
  });

  it("stays silent on an ordinary semver range", () => {
    // A caret range is ordinary practice and the lockfile pins it. Reporting
    // it would bury the genuinely mutable specs underneath.
    expect(detectSupplyChainHazards(diffAdding("package.json", '    "vitest": "^3.0.0",')))
      .toEqual([]);
  });

  it("ignores a git URL outside a manifest", () => {
    expect(detectSupplyChainHazards(diffAdding("README.md", '    "thing": "github:owner/repo",')))
      .toEqual([]);
  });
});

describe("what the detector refuses to do", () => {
  it("reports only lines this pull request ADDED", () => {
    // A hazard already at the base was not introduced here. Reporting it on
    // every unrelated change to the file is the alarm fatigue this pass exists
    // to avoid — a real problem, but not this review's finding.
    const diff = [
      `diff --git a/${WORKFLOW} b/${WORKFLOW}`,
      `--- a/${WORKFLOW}`,
      `+++ b/${WORKFLOW}`,
      "@@ -1,2 +1,2 @@",
      "       - uses: actions/checkout@v4",
      "-      - run: old",
      "+      - run: new",
    ].join("\n");

    expect(detectSupplyChainHazards(diff)).toEqual([]);
  });

  it("does not report a removed hazard", () => {
    // Deleting one is the fix, not the defect.
    const diff = [
      `diff --git a/${WORKFLOW} b/${WORKFLOW}`,
      `--- a/${WORKFLOW}`,
      `+++ b/${WORKFLOW}`,
      "@@ -1,2 +1,1 @@",
      "       - run: keep",
      "-      - uses: actions/checkout@v4",
    ].join("\n");

    expect(detectSupplyChainHazards(diff)).toEqual([]);
  });

  it("never rates a finding as a suggestion", () => {
    // `suggestion` asserts the code is correct as written, and a fired
    // detector has by construction found something that is not.
    const findings = detectSupplyChainHazards(diffAdding(
      WORKFLOW,
      "      - uses: actions/checkout@v4",
      "permissions: write-all",
    ));

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.severity !== "suggestion")).toBe(true);
  });

  it("does not redact its own source lines", () => {
    // Deliberately unlike `secrets.ts`: a mutable action ref is public
    // information and the author needs to see which one. Redacting everything
    // would make these findings harder to act on for no gain.
    const [finding] = detectSupplyChainHazards(diffAdding(WORKFLOW, "      - uses: actions/checkout@v4"));

    expect(finding?.redactSource).toBeUndefined();
  });

  it("survives a diff it understands nothing in", () => {
    expect(detectSupplyChainHazards("not a diff at all")).toEqual([]);
  });
});

describe("SUPPLY_CHAIN_POLICY", () => {
  it("is a host-owned rule the loader never dispatches", () => {
    expect(SUPPLY_CHAIN_POLICY.name).toBe(SUPPLY_CHAIN_RULE_NAME);
    expect(SUPPLY_CHAIN_POLICY.sourcePath).toMatch(/^<host:/u);
  });

  it("forbids claiming the referenced action was inspected", () => {
    // The host matched a pattern in the workflow text. It did not read what
    // `actions/checkout@v4` actually does, and an explanation must not imply
    // otherwise.
    expect(SUPPLY_CHAIN_POLICY.body).toMatch(/do not invent/iu);
    expect(SUPPLY_CHAIN_POLICY.body).toMatch(/inspected/iu);
  });
});
