import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli.js";

describe("parseArgs", () => {
  // AC-1.1: Given the CLI is invoked with `review --pr 42`, When argument
  // parsing runs, Then it returns the fully-defaulted CliArgs object.
  it("AC-1.1: parses `review --pr 42` into the fully-defaulted CliArgs", () => {
    const result = parseArgs(["review", "--pr", "42"]);

    expect(result).toEqual({
      pr: "42",
      vcs: "github",
      rulesDir: ".tgd-review/rules",
      disableBuiltinRule: false,
      advisor: "on",
      suggestions: "on",
      dryRun: false,
      trustLocalRules: false,
    });
  });

  // AC-1.1 (explicit overrides): every flag can override its default.
  it("AC-1.1: honors explicit overrides for every flag", () => {
    const result = parseArgs([
      "review",
      "--pr",
      "7",
      "--vcs",
      "gitlab",
      "--rules-dir",
      "custom/rules",
      "--disable-builtin-rule",
      "--advisor",
      "off",
      "--dry-run",
      "--trust-local-rules",
    ]);

    expect(result).toEqual({
      pr: "7",
      vcs: "gitlab",
      rulesDir: "custom/rules",
      disableBuiltinRule: true,
      advisor: "off",
      suggestions: "on",
      dryRun: true,
      trustLocalRules: true,
    });
  });

  // Design-review #13: --max-diff-chars is a hard cost ceiling on diff size.
  describe("--max-diff-chars", () => {
    it("defaults to undefined (unlimited) when not passed", () => {
      expect(parseArgs(["review", "--pr", "42"]).maxDiffChars).toBeUndefined();
    });

    it("parses a positive integer value", () => {
      expect(parseArgs(["review", "--pr", "42", "--max-diff-chars", "500000"]).maxDiffChars).toBe(
        500000,
      );
    });

    it.each(["0", "-5", "1.5", "abc", ""])(
      "rejects the non-positive-integer value %j with an error naming the flag",
      (bad) => {
        expect(() => parseArgs(["review", "--pr", "42", "--max-diff-chars", bad])).toThrow(
          /--max-diff-chars/,
        );
      },
    );
  });

  // New flag: --trust-local-rules skips the base-branch-via-API fetch
  // entirely and falls back to reading --rules-dir directly off the local
  // filesystem (the OLD behavior) — a developer convenience for iterating
  // on a not-yet-committed rule file, not a security bypass to use lightly.
  describe("--trust-local-rules", () => {
    it("defaults to false when not passed", () => {
      const result = parseArgs(["review", "--pr", "1"]);
      expect(result.trustLocalRules).toBe(false);
    });

    it("is true when --trust-local-rules is passed", () => {
      const result = parseArgs(["review", "--pr", "1", "--trust-local-rules"]);
      expect(result.trustLocalRules).toBe(true);
    });
  });

  // AC-1.2: Given the CLI is invoked without `--pr`, When argument parsing
  // runs, Then it throws an error naming `--pr` as required.
  it("AC-1.2: throws naming --pr as required when --pr is missing", () => {
    expect(() => parseArgs(["review"])).toThrow(/--pr/);
  });

  // AC-1.2: the thrown error is catchable by main() to exit with code 1.
  it("AC-1.2: throws an Error instance (not a bare string/exit) when --pr is missing", () => {
    let caught: unknown;
    try {
      parseArgs([]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/--pr/);
  });

  // Security hardening (DEBT.md): a non-numeric --pr value throws, the same
  // way the missing---pr case does, rather than being silently accepted and
  // later interpolated into a `gh api` path unchecked.
  it("security hardening: throws naming --pr as invalid when --pr is not a plain positive integer", () => {
    expect(() => parseArgs(["review", "--pr", "abc"])).toThrow(/--pr/);
  });

  it("security hardening: throws an Error instance for a non-numeric --pr value", () => {
    let caught: unknown;
    try {
      parseArgs(["review", "--pr", "42; rm -rf /"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/--pr/);
  });

  it("security hardening: rejects a --pr value with a leading sign, decimal, or leading zero-padded non-integer form like '+1' or '1.5'", () => {
    expect(() => parseArgs(["review", "--pr", "+1"])).toThrow(/--pr/);
    expect(() => parseArgs(["review", "--pr", "1.5"])).toThrow(/--pr/);
    expect(() => parseArgs(["review", "--pr", "-1"])).toThrow(/--pr/);
  });

  it("security hardening: still accepts a plain positive integer --pr value", () => {
    expect(() => parseArgs(["review", "--pr", "007"])).not.toThrow();
    expect(parseArgs(["review", "--pr", "0"]).pr).toBe("0");
  });
});
