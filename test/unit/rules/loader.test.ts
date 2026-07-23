import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRules } from "../../../src/rules/loader.js";

// `test/fixtures/rules/` holds one valid rule file and two invalid ones
// (missing `provider`, missing `model`) — see TASKS.md Task 4 "Files Likely
// Touched". Resolved relative to this test file (not process.cwd()) so the
// suite works no matter where `vitest` is invoked from.
const fixturesDir = fileURLToPath(new URL("../../fixtures/rules", import.meta.url));
const nonexistentDir = path.join(fixturesDir, "this-directory-does-not-exist");

// `malformed-yaml-dir/` is a dedicated fixture directory (separate from
// `fixturesDir` above), holding just `malformed-yaml.md` (genuinely broken
// YAML frontmatter) and `sibling-valid-rule.md` (valid). Kept separate from
// `fixturesDir` deliberately: gray-matter caches parse results keyed by the
// exact raw file content it's given (`matter.cache[file.content]` in
// `node_modules/gray-matter/index.js`), and that cache entry is written
// *before* the YAML engine parses/throws — so a second `matter()` call on
// byte-identical content that previously threw returns the stale pre-parse
// cache entry instead of re-throwing. If `malformed-yaml.md` lived in the
// shared `fixturesDir`, the AC-4.1/4.2/4.3 tests below (which also call
// `loadRules(fixturesDir, ...)` and therefore also parse every file in it,
// including this one) would consume that one real throw first, and the
// malformed-YAML test itself would then see the poisoned cache entry
// instead of a fresh YAMLException. Isolating it here guarantees this is
// the only place in the whole suite that ever parses that exact content.
const malformedYamlDir = fileURLToPath(
  new URL("../../fixtures/rules/malformed-yaml-dir", import.meta.url),
);

// `duplicate-name-dir/` holds two valid rule files (`rule-a.md`, `rule-b.md`)
// that both set `name: duplicate-rule` — dedicated to the duplicate-name
// tests below, kept separate from `fixturesDir` so those tests' assertions
// don't have to account for the rest of `fixturesDir`'s fixture files.
const duplicateNameDir = fileURLToPath(
  new URL("../../fixtures/rules/duplicate-name-dir", import.meta.url),
);

// `duplicate-builtin-dir/` holds one valid user rule file that deliberately
// reuses the vendored builtin's `name: tgd-review`, for testing the
// user-rule-vs-builtin collision case specifically.
const duplicateBuiltinDir = fileURLToPath(
  new URL("../../fixtures/rules/duplicate-builtin-dir", import.meta.url),
);

describe("loadRules", () => {
  it("loads depends_on and parallel_group as snapshotted workflow metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-workflow-rule-"));
    await writeFile(
      path.join(dir, "workflow.md"),
      [
        "---",
        "name: workflow-rule",
        "depends_on:",
        "  - prerequisite-a",
        "  - prerequisite-b",
        "parallel_group: security",
        "---",
        "",
        "Review the diff.",
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = await loadRules(dir, false);

      expect(result.errors).toEqual([]);
      expect(result.rules[0]).toMatchObject({
        name: "workflow-rule",
        dependsOn: ["prerequisite-a", "prerequisite-b"],
        parallelGroup: "security",
      });
      expect(Object.isFrozen(result.rules[0]?.dependsOn)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["a scalar dependency", "depends_on: prerequisite", "depends_on"],
    ["a blank dependency", "depends_on:\n  - \"\"", "depends_on"],
    ["duplicate dependencies", "depends_on:\n  - prerequisite\n  - prerequisite", "duplicate"],
    ["a blank group", "parallel_group: \"\"", "parallel_group"],
    ["an invalid group", "parallel_group: Not Valid!", "parallel_group"],
  ])("records %s as a per-file load error while loading a valid sibling", async (_label, metadata, errorText) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-invalid-workflow-"));
    await writeFile(
      path.join(dir, "bad.md"),
      `---\nname: bad-rule\n${metadata}\n---\n\nBad.\n`,
      "utf-8",
    );
    await writeFile(
      path.join(dir, "good.md"),
      "---\nname: good-rule\n---\n\nGood.\n",
      "utf-8",
    );

    try {
      const result = await loadRules(dir, false);

      expect(result.rules.map((rule) => rule.name)).toEqual(["good-rule"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain(errorText);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // AC-4.1: Given a valid rule file with name/provider/model set, When
  // loadRules runs, Then the returned rules array contains a matching
  // RuleDefinition with those exact fields and body equal to the file's
  // Markdown content.
  it("AC-4.1: a valid rule file loads with exact name/provider/model/body/sourcePath fields", async () => {
    const result = await loadRules(fixturesDir, false);

    const valid = result.rules.find((r) => r.name === "valid-rule");
    expect(valid).toEqual({
      name: "valid-rule",
      provider: "anthropic",
      model: "claude-opus-4-5",
      dependsOn: [],
      body: "Review this diff for correctness and note any test gaps.",
      sourcePath: path.join(fixturesDir, "valid-rule.md"),
    });
  });

  // AC-4.2: Given a rule file missing `provider`, When loadRules runs, Then
  // it is NOT included in rules, and errors contains an entry naming that
  // file and the missing field — loadRules does not throw.
  it("AC-4.2: a rule file missing provider is excluded from rules and recorded in errors, without throwing", async () => {
    const result = await loadRules(fixturesDir, false);

    expect(result.rules.some((r) => r.name === "missing-provider")).toBe(false);
    const err = result.errors.find(
      (e) => e.sourcePath === path.join(fixturesDir, "missing-provider.md"),
    );
    expect(err).toBeDefined();
    expect(err?.message.toLowerCase()).toContain("provider");
  });

  // AC-4.3: Given a rule file missing `model`, When loadRules runs, Then it
  // is NOT included in rules, and errors names that file and the missing
  // field.
  it("AC-4.3: a rule file missing model is excluded from rules and recorded in errors", async () => {
    const result = await loadRules(fixturesDir, false);

    expect(result.rules.some((r) => r.name === "missing-model")).toBe(false);
    const err = result.errors.find(
      (e) => e.sourcePath === path.join(fixturesDir, "missing-model.md"),
    );
    expect(err).toBeDefined();
    expect(err?.message.toLowerCase()).toContain("model");
  });

  // Same required-field validation path as AC-4.2/AC-4.3, exercised for the
  // untested `name` branch (Test Coverage debt item: `provider`/`model` each
  // had their own fixture + test, `name` did not, despite being the same
  // code path in `parseRuleFile`'s `REQUIRED_STRING_FIELDS` check).
  it("a rule file missing name is excluded from rules and recorded in errors, without throwing", async () => {
    const result = await loadRules(fixturesDir, false);

    expect(result.rules.some((r) => r.sourcePath === path.join(fixturesDir, "missing-name.md"))).toBe(
      false,
    );
    const err = result.errors.find(
      (e) => e.sourcePath === path.join(fixturesDir, "missing-name.md"),
    );
    expect(err).toBeDefined();
    expect(err?.message.toLowerCase()).toContain("name");
  });

  // AC-4.4: Given includeBuiltin: true and an empty rulesDir (here: a
  // rulesDir that doesn't exist on disk at all, which the loader treats as
  // zero user rules found, not an error — see TASKS.md Task 4 technical
  // design), When loadRules runs, Then rules contains exactly one entry
  // sourced from src/rules/builtin/tgd-review.md.
  it("AC-4.4: includeBuiltin true + empty rulesDir yields exactly one rule, the vendored builtin", async () => {
    const result = await loadRules(nonexistentDir, true);

    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    const [builtin] = result.rules;
    expect(builtin?.name).toBe("tgd-review");
    // Design-review #6: the builtin rule is UNPINNED — it runs on the
    // deployment's default model (--model, settings default, or the first
    // credentialed provider), which is what makes zero-config work with ANY
    // one provider key rather than requiring anthropic's specifically.
    expect(builtin?.provider).toBeUndefined();
    expect(builtin?.model).toBeUndefined();
    expect(builtin?.sourcePath.endsWith(path.join("rules", "builtin", "tgd-review.md"))).toBe(
      true,
    );
    expect(builtin?.body.length).toBeGreaterThan(0);
  });

  // Design-review #6: provider/model are optional — a rule with only `name`
  // loads fine (it runs on the default model)...
  it("design-review #6: a rule with no provider/model pin loads successfully", async () => {
    // CodeRabbit review (PR #7): isolated OS temp dir, never the source tree —
    // a crash before cleanup must not leave a stray fixture behind, and a
    // concurrent test reading fixturesDir must never see this file appear.
    const dir = await mkdtemp(path.join(os.tmpdir(), "tgd-review-agent-unpinned-rule-"));
    await writeFile(
      path.join(dir, "unpinned.md"),
      "---\nname: unpinned-rule\n---\n\nReview the diff.\n",
      "utf-8",
    );
    try {
      const result = await loadRules(dir, false);

      expect(result.errors).toEqual([]);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].name).toBe("unpinned-rule");
      expect(result.rules[0].provider).toBeUndefined();
      expect(result.rules[0].model).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // AC-4.5: Given includeBuiltin: false (the --disable-builtin-rule flag),
  // When loadRules runs, Then rules does not contain the built-in rule.
  it("AC-4.5: includeBuiltin false excludes the built-in rule even when rulesDir is empty", async () => {
    const result = await loadRules(nonexistentDir, false);

    expect(result.rules.some((r) => r.name === "tgd-review")).toBe(false);
    expect(result.rules).toHaveLength(0);
  });

  // Non-existent rulesDir is treated as zero user rules found, not an error
  // (TASKS.md Task 4 technical design) — confirmed here independent of the
  // builtin rule.
  it("a non-existent rulesDir produces zero user rules and no errors (not a throw)", async () => {
    const result = await loadRules(nonexistentDir, false);

    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  // Task 4 review fix #1 (critical test gap): malformed YAML frontmatter
  // (e.g. an unclosed `[` flow sequence) makes gray-matter's underlying
  // YAML parser throw a `YAMLException`. Before this fix, nothing caught
  // that exception, so it propagated straight out of `loadRules()` and
  // aborted the ENTIRE run — directly violating SPEC.md's "skip and warn
  // on a single bad rule rather than failing the whole run" boundary
  // (already correctly applied to missing-field errors, just not to
  // YAML-syntax errors). `test/fixtures/rules/malformed-yaml.md` has
  // genuinely malformed frontmatter, so this proves loadRules converts the
  // thrown YAMLException into a `loadError` entry instead of letting it
  // propagate — and, critically, that `valid-rule.md` in the SAME
  // directory still loads successfully alongside it (one bad rule file
  // does not kill the run).
  it("a rule file with malformed YAML frontmatter is recorded as a load error, not thrown, and other valid rule files in the same directory still load", async () => {
    const result = await loadRules(malformedYamlDir, false);

    // loadRules must not have thrown to get here at all — the assertions
    // below double-check the shape of what it returned instead.
    const err = result.errors.find(
      (e) => e.sourcePath === path.join(malformedYamlDir, "malformed-yaml.md"),
    );
    expect(err).toBeDefined();
    expect(err?.message.toLowerCase()).toContain("yaml");
    expect(result.rules.some((r) => r.name === "malformed-yaml")).toBe(false);

    // Proves one bad rule file doesn't kill the run: the valid rule file
    // living in the very same directory still loads successfully.
    const sibling = result.rules.find((r) => r.name === "sibling-valid-rule");
    expect(sibling).toBeDefined();
    expect(sibling?.provider).toBe("anthropic");
  });

  // Code Quality debt item: two rule files defining the same `name` must
  // not both end up in `rules` — that would make attribution in the
  // dispatch prompt and in `Finding.ruleName`/`rulesRun`/`rulesFailed`
  // ambiguous (which file is "rule X" if two claim that name?). loadRules
  // resolves this the same "skip and record, never throw" way as
  // missing-field validation: the FIRST-loaded rule with a given name wins
  // and is kept in `rules`; every later rule sharing that name is dropped
  // and recorded as a `loadError` instead. "First" here means discovery
  // order: user rule files in `duplicate-name-dir/` are read in the
  // alphabetical-by-filename order `listMarkdownFiles` sorts them into, so
  // `rule-a.md` (alphabetically first) is the one that wins.
  it("two user rule files sharing the same name: the alphabetically-first file's rule loads, the second becomes a loadError naming both the duplicate name and its own sourcePath", async () => {
    const result = await loadRules(duplicateNameDir, false);

    const loaded = result.rules.filter((r) => r.name === "duplicate-rule");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sourcePath).toBe(path.join(duplicateNameDir, "rule-a.md"));
    expect(loaded[0]?.provider).toBe("anthropic");

    const err = result.errors.find(
      (e) => e.sourcePath === path.join(duplicateNameDir, "rule-b.md"),
    );
    expect(err).toBeDefined();
    expect(err?.message).toContain("duplicate-rule");
    expect(err?.message.toLowerCase()).toContain("duplicate");
  });

  // Same duplicate-name handling, specifically for a user rule file that
  // reuses the vendored builtin's `name: tgd-review`. Because user rule
  // files are loaded (and therefore win ties) before the builtin is
  // appended, the USER rule loads into `rules` and the builtin is skipped
  // and recorded as a loadError instead — asserting the actual "first
  // wins" choice documented on `dedupeByName` in loader.ts.
  it("a user rule file reusing the builtin's name (tgd-review): the user rule wins, the builtin becomes a loadError", async () => {
    const result = await loadRules(duplicateBuiltinDir, true);

    const loaded = result.rules.filter((r) => r.name === "tgd-review");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sourcePath).toBe(path.join(duplicateBuiltinDir, "user-rule.md"));
    expect(loaded[0]?.provider).toBe("openai");

    const err = result.errors.find((e) => e.sourcePath.endsWith(path.join("builtin", "tgd-review.md")));
    expect(err).toBeDefined();
    expect(err?.message).toContain("tgd-review");
    expect(err?.message.toLowerCase()).toContain("duplicate");
  });
});
