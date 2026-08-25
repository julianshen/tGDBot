// The shipped example rules are only useful if they actually load. A rule with
// broken frontmatter fails at review time, in someone else's repository, with
// nothing here to have caught it.
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRules } from "../../../src/rules/loader.js";

const examplesDir = fileURLToPath(new URL("../../../examples/rules", import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("shipped example rules", () => {
  it("load without error, and without the builtin standing in for them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tgd-example-rules-"));
    temporary.push(dir);
    await cp(examplesDir, dir, { recursive: true });

    const loaded = await loadRules(dir, false);

    expect(loaded.errors).toEqual([]);
    expect(loaded.rules.map((rule) => rule.name)).toContain("dependency-currency");
  });

  // The rule is worthless if it does not tell the model where the facts are:
  // it cannot look anything up itself.
  it("point the dependency rule at the trusted context, not the diff", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tgd-example-rules-"));
    temporary.push(dir);
    await cp(examplesDir, dir, { recursive: true });

    const loaded = await loadRules(dir, false);
    const rule = loaded.rules.find((candidate) => candidate.name === "dependency-currency");

    expect(rule?.body).toContain("TRUSTED_CONTEXT");
    expect(rule?.body).toMatch(/silence\s+is\s+not\s+approval/i);
  });
});
