import { describe, expect, it, vi } from "vitest";
import { describeCommandFailure, main, parseArgs } from "../../src/cli.js";
import { parseCommandArgs } from "../../src/cli-args.js";

describe("parseCommandArgs", () => {
  it("preserves the legacy review invocation without an explicit subcommand", () => {
    expect(parseCommandArgs(["--pr", "42"])).toMatchObject({ command: "review", pr: "42" });
  });
  it("parses review with shared state directory", () => {
    expect(parseCommandArgs(["review", "--pr", "42", "--state-dir", "/tmp/tgd-state"])).toMatchObject({
      command: "review",
      stateDir: "/tmp/tgd-state",
    });
  });

  it("parses poll with its required repository and shared flags", () => {
    expect(parseCommandArgs([
      "poll", "--repo", "owner/repo", "--model", "openai/gpt-5",
      "--dispatch", "direct", "--advisor", "off", "--state-dir", "/tmp/tgd-state",
    ])).toMatchObject({
      command: "poll",
      repo: "owner/repo",
      model: "openai/gpt-5",
      dispatch: "direct",
      advisor: "off",
      stateDir: "/tmp/tgd-state",
    });
  });

  it("preserves every review default", () => {
    expect(parseCommandArgs(["review", "--pr", "42"])).toEqual({
      command: "review",
      pr: "42",
      vcs: "github",
      repo: undefined,
      model: undefined,
      rulesDir: ".review/rules",
      disableBuiltinRule: false,
      advisor: "on",
      // Outbound network is opt-in. If this default ever flips, a review of a
      // private repository starts telling npm what it depends on (PR #54).
      dependencyFacts: "off",
      suggestions: "on",
      dryRun: false,
      trustLocalRules: false,
      dispatch: "direct",
      maxDiffChars: undefined,
      context: "auto",
      contextMaxChars: undefined,
      allowDegradedContext: false,
      contextDir: undefined,
      stateDir: undefined,
    });
  });

  it("requires --pr for review", () => {
    expect(() => parseCommandArgs(["review"])).toThrow(/--pr/);
  });

  it("requires --repo for poll", () => {
    expect(() => parseCommandArgs(["poll"])).toThrow(/--repo/);
  });

  it.each([
    ["unknown command", ["inspect", "--pr", "42"]],
    ["review preceded by options", ["--pr", "42", "review"]],
    ["poll preceded by options", ["--repo", "owner/repo", "poll"]],
    ["extra review positional", ["review", "extra", "--pr", "42"]],
    ["extra poll positional", ["poll", "extra", "--repo", "owner/repo"]],
    ["review-only --pr on poll", ["poll", "--repo", "owner/repo", "--pr", "42"]],
  ])("rejects incompatible or unknown positionals: %s", (_label, argv) => {
    expect(() => parseCommandArgs(argv)).toThrow();
  });
});

describe("parseArgs", () => {
  // AC-1.1: Given the CLI is invoked with `review --pr 42`, When argument
  // parsing runs, Then it returns the fully-defaulted CliArgs object.
  it("AC-1.1: parses `review --pr 42` into the fully-defaulted CliArgs", () => {
    const result = parseArgs(["review", "--pr", "42"]);

    expect(result).toEqual({
      pr: "42",
      vcs: "github",
      repo: undefined,
      rulesDir: ".review/rules",
      disableBuiltinRule: false,
      advisor: "on",
      // Outbound network is opt-in. If this default ever flips, a review of a
      // private repository starts telling npm what it depends on (PR #54).
      dependencyFacts: "off",
      suggestions: "on",
      dryRun: false,
      trustLocalRules: false,
      dispatch: "direct",
      maxDiffChars: undefined,
      context: "auto",
      contextMaxChars: undefined,
      allowDegradedContext: false,
      contextDir: undefined,
      model: undefined,
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
      "--dependency-facts",
      "on",
      "--dry-run",
      "--trust-local-rules",
      "--dispatch",
      "legacy",
      "--context",
      "require",
      "--context-max-chars",
      "12000",
      "--allow-degraded-context",
      "--context-dir",
      "/srv/ctx",
    ]);

    expect(result).toEqual({
      pr: "7",
      vcs: "gitlab",
      rulesDir: "custom/rules",
      disableBuiltinRule: true,
      advisor: "off",
      dependencyFacts: "on",
      suggestions: "on",
      dryRun: true,
      trustLocalRules: true,
      dispatch: "legacy",
      context: "require",
      contextMaxChars: 12_000,
      allowDegradedContext: true,
      contextDir: "/srv/ctx",
    });
  });

  // Design-review P0: --dispatch selects the engine (direct is the default).
  describe("--dispatch", () => {
    it("defaults to direct", () => {
      expect(parseArgs(["review", "--pr", "42"]).dispatch).toBe("direct");
    });

    it("accepts legacy", () => {
      expect(parseArgs(["review", "--pr", "42", "--dispatch", "legacy"]).dispatch).toBe("legacy");
    });

    it("rejects anything else with an error naming the flag", () => {
      expect(() => parseArgs(["review", "--pr", "42", "--dispatch", "turbo"])).toThrow(
        /--dispatch/,
      );
    });
  });

  // #58: trusted-base repository context. `auto` is the default, so a review
  // that says nothing about context still gets it when it can be mapped.
  describe("--context", () => {
    it("defaults to auto", () => {
      expect(parseArgs(["review", "--pr", "42"]).context).toBe("auto");
      expect(parseArgs(["review", "--pr", "42"]).allowDegradedContext).toBe(false);
      expect(parseArgs(["review", "--pr", "42"]).contextMaxChars).toBeUndefined();
      expect(parseArgs(["review", "--pr", "42"]).contextDir).toBeUndefined();
    });

    it("accepts each mode", () => {
      for (const mode of ["off", "auto", "require"] as const) {
        expect(parseArgs(["review", "--pr", "42", "--context", mode]).context).toBe(mode);
      }
    });

    it("rejects an unknown mode by name", () => {
      expect(() => parseArgs(["review", "--pr", "42", "--context", "maybe"])).toThrow(/--context/);
    });

    it("accepts --allow-degraded-context as a flag", () => {
      expect(parseArgs(["review", "--pr", "42", "--allow-degraded-context"]).allowDegradedContext)
        .toBe(true);
    });

    it("takes a per-rule size ceiling inside the pack builder's bounds", () => {
      expect(parseArgs(["review", "--pr", "42", "--context-max-chars", "12000"]).contextMaxChars)
        .toBe(12_000);
    });

    it("rejects an out-of-range or non-numeric ceiling at the flag, naming it", () => {
      // Below MIN, above MAX, and not a number at all: each must fail here
      // rather than surfacing later as a context that silently went missing.
      for (const bad of ["100", "999999", "lots", "-1", ""]) {
        expect(() => parseArgs(["review", "--pr", "42", "--context-max-chars", bad]))
          .toThrow(/--context-max-chars/);
      }
    });

    it("requires --context-dir to be absolute", () => {
      expect(parseArgs(["review", "--pr", "42", "--context-dir", "/srv/ctx"]).contextDir)
        .toBe("/srv/ctx");
      expect(() => parseArgs(["review", "--pr", "42", "--context-dir", "relative/ctx"]))
        .toThrow(/--context-dir/);
    });

    it("is available to poll as well, so a command review runs the same way", () => {
      const polled = parseCommandArgs(["poll", "--repo", "acme/app", "--context", "off"]);
      expect(polled.context).toBe("off");
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

  it("accepts an explicit GitLab repository with a numeric IID", () => {
    const result = parseArgs([
      "review",
      "--pr",
      "42",
      "--vcs",
      "gitlab",
      "--repo",
      "gitlab.example.com/group/project",
    ]);

    expect(result.repo).toBe("gitlab.example.com/group/project");
  });

  it("accepts a complete GitLab merge-request URL as --pr", () => {
    const url = "https://gitlab.example.com/group/project/-/merge_requests/42";
    expect(parseArgs(["review", "--pr", url]).pr).toBe(url);
  });

  it("rejects a nonnumeric --pr that is not a complete PR or MR URL", () => {
    expect(() => parseArgs(["review", "--pr", "group/project!42"])).toThrow(/--pr/);
  });
});

describe("main poll exit codes", () => {
  it("exits 0 for clean, bootstrap, and more-remains poll results", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await main(["poll", "--repo", "owner/repo"], { runPoll: async () => 0 });
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it("exits 1 for a pre-write fatal or transient poll failure", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await main(["poll", "--repo", "owner/repo"], {
        runPoll: async () => {
          throw new Error("discovery page 2 failed");
        },
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("discovery page 2 failed"));
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("exits 2 only after a provider write occurred with a partial result", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await main(["poll", "--repo", "owner/repo"], { runPoll: async () => 2 });
      expect(exit).toHaveBeenCalledWith(2);
    } finally {
      exit.mockRestore();
    }
  });
});

// Issue #30: a transient network failure surfaced as a raw command dump —
// "Command failed: gh api -X GET ... error connecting to api.github.com" —
// which reads like a tGDBot logic failure rather than "the network blipped".
describe("describeCommandFailure", () => {
  it("names a transient provider failure", () => {
    const described = describeCommandFailure(new Error(
      "Command failed: gh api -X GET -f per_page=50 repos/o/r/issues/279/comments\nerror connecting to api.github.com",
    ));
    expect(described).toContain("transient provider failure");
    expect(described).toContain("error connecting to api.github.com");
  });

  it("marks it retryable so an operator knows to run it again", () => {
    const described = describeCommandFailure(new Error("HTTP 503: No server is currently available"));
    expect(described.toLowerCase()).toContain("retry");
  });

  it("leaves a definite rejection unclassified rather than mislabelling it", () => {
    const described = describeCommandFailure(new Error("gh: Not Found (HTTP 404)"));
    expect(described).not.toContain("transient provider failure");
    expect(described).toContain("HTTP 404");
  });

  it("leaves an ordinary logic error alone", () => {
    const described = describeCommandFailure(new Error("Review metadata is too large for a provider comment"));
    expect(described).toBe("Review metadata is too large for a provider comment");
  });

  it("redacts credentials echoed by a failing command", () => {
    const described = describeCommandFailure(new Error(
      "Command failed: gh api https://user:sup3rs3cret@github.com/o/r\nerror connecting to api.github.com",
    ));
    expect(described).not.toContain("sup3rs3cret");
  });
});
