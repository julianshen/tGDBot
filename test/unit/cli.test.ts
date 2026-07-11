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
      dryRun: false,
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
    ]);

    expect(result).toEqual({
      pr: "7",
      vcs: "gitlab",
      rulesDir: "custom/rules",
      disableBuiltinRule: true,
      advisor: "off",
      dryRun: true,
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
});
