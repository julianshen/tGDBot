// Issue #115: which rules a pull request's files call for.
import { describe, expect, it } from "vitest";
import { scopeRulesToChangedFiles } from "../../../src/rules/scope.js";
import type { RuleDefinition } from "../../../src/rules/types.js";

function rule(name: string, appliesTo?: readonly string[]): RuleDefinition {
  return {
    name,
    dependsOn: [],
    body: "body",
    sourcePath: `${name}.md`,
    ...(appliesTo === undefined ? {} : { appliesTo }),
  };
}

describe("scopeRulesToChangedFiles", () => {
  it("dispatches a rule that declares no scope", () => {
    // The compatibility guarantee: every existing rule, and the builtin, keeps
    // behaving exactly as it did, so no repository changes meaning on upgrade.
    const scoped = scopeRulesToChangedFiles([rule("unscoped")], ["main.go"]);
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["unscoped"]);
    expect(scoped.skipped).toEqual([]);
  });

  it("dispatches a scoped rule when the diff touches its paths", () => {
    const scoped = scopeRulesToChangedFiles([rule("ts", ["**/*.ts"])], ["src/a.ts", "README.md"]);
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["ts"]);
  });

  it("skips a scoped rule the diff does not touch, and names it", () => {
    const scoped = scopeRulesToChangedFiles([rule("sql", ["**/*.sql"])], ["src/a.ts"]);
    expect(scoped.applicable).toEqual([]);
    // Named, not merely counted: the summary has to say which coverage the
    // review did not have.
    expect(scoped.skipped).toEqual(["sql"]);
  });

  it("treats an empty applies_to as no scope at all", () => {
    const scoped = scopeRulesToChangedFiles([rule("empty", [])], ["main.go"]);
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["empty"]);
  });

  it("dispatches every rule when the changed-file list is empty", () => {
    // An empty list means the diff said nothing about which files changed —
    // unparsed, or absent. Scoping on that would disable every scoped rule at
    // the moment there is least reason to trust the input, so it fails OPEN:
    // a wasted dispatch costs money, a skipped rule costs the review.
    const scoped = scopeRulesToChangedFiles([rule("sql", ["**/*.sql"])], []);
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["sql"]);
    expect(scoped.skipped).toEqual([]);
  });

  it("keeps the skipped list sorted and the applicable list in rule order", () => {
    const scoped = scopeRulesToChangedFiles(
      [rule("zeta", ["**/*.sql"]), rule("alpha", ["**/*.sql"]), rule("keep"), rule("ts", ["**/*.ts"])],
      ["src/a.ts"],
    );
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["keep", "ts"]);
    expect(scoped.skipped).toEqual(["alpha", "zeta"]);
  });

  it("drops a dependency edge to a rule the scoping removed", () => {
    // `planReviewWorkflow` rejects a dependency on a rule it cannot see, so
    // leaving the name behind aborted the WHOLE review: a broad rule depending
    // on a narrowly scoped prerequisite failed on any diff that prerequisite
    // did not match. Dropping the edge is what the dependency already means —
    // it establishes order, and there is no order left to establish.
    const dependent: RuleDefinition = { ...rule("broad"), dependsOn: ["sql-only", "also-broad"] };
    const scoped = scopeRulesToChangedFiles(
      [dependent, rule("sql-only", ["**/*.sql"]), rule("also-broad")],
      ["src/a.ts"],
    );

    expect(scoped.skipped).toEqual(["sql-only"]);
    // The dependent rule still runs: a dependency establishes order, and a
    // prerequisite that does not run does not suppress what came after it.
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["broad", "also-broad"]);
    expect(scoped.applicable[0]?.dependsOn).toEqual(["also-broad"]);
  });

  it("leaves an untouched rule object alone rather than copying it", () => {
    // Only a rule whose edges actually changed is rebuilt, so nothing else in
    // the flow sees a different object identity than it did before.
    const original = rule("plain");
    const scoped = scopeRulesToChangedFiles([original], ["src/a.ts"]);
    expect(scoped.applicable[0]).toBe(original);
  });

  it("matches a rule declaring several globs when any one of them hits", () => {
    const scoped = scopeRulesToChangedFiles(
      [rule("manifests", ["**/package.json", "**/Cargo.toml"])],
      ["Cargo.toml"],
    );
    expect(scoped.applicable.map((entry) => entry.name)).toEqual(["manifests"]);
  });
});
