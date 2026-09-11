// Issue #138's acceptance criteria that are STRUCTURAL: properties about what
// the codebase no longer contains, rather than about what a function returns.
//
// Source-text assertions are usually a poor substitute for behavioural ones,
// and most of this suite avoids them. They earn their place here because the
// property being protected is an ABSENCE — "no orchestrating LLM exists on the
// data path" cannot be demonstrated by calling anything, only by showing there
// is nothing to call. A behavioural test would pass just as happily the day
// someone reintroduced the relay beside the direct path.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url)), "utf-8");

const exists = (relative: string): boolean => {
  try {
    source(relative);
    return true;
  } catch {
    return false;
  }
};

describe("no orchestrating LLM is on the data path", () => {
  it("the legacy engine's module is gone, not merely unreferenced", () => {
    // Unreferenced-but-present is how a deleted engine comes back: the next
    // person to need an escape hatch finds it still compiling.
    expect(exists("review/dispatch.ts")).toBe(false);
  });

  it("nothing imports the deleted engine", () => {
    for (const module of ["cli.ts", "review/direct-dispatch.ts", "conversation/session.ts"]) {
      expect(source(module), `${module} still imports the legacy engine`)
        .not.toMatch(/from "\.{1,2}[\w/.]*\/dispatch\.js"/u);
    }
  });

  it("the correction layer that repaired the relay is gone", () => {
    // Each of these existed ONLY to repair a probabilistic merge. Keeping them
    // after the merge became code would leave the impression that the merge is
    // still something that needs repairing.
    const results = source("review/dispatch-results.ts");
    for (const symbol of [
      "reconcileWithCapturedResults",
      "enforceSuggestionProvenance",
      "suggestionProvenanceKeys",
    ]) {
      expect(results, `${symbol} outlived the engine it corrected`).not.toContain(symbol);
    }
  });

  it("the orchestrator's merge prompt is gone", () => {
    expect(source("review/dispatch-prompt.ts")).not.toContain("buildDispatchPrompt");
  });

  it("the engine is no longer selectable", () => {
    // A flag that still parsed but accepted only one value would keep scripts
    // working while quietly meaning nothing.
    expect(source("cli-args.ts")).not.toMatch(/dispatch: \{ type: "string" \}/u);
  });
});

describe("the surviving engine reads files, not prose", () => {
  it("prefers the submitted findings file over the assistant text", () => {
    const direct = source("review/direct-dispatch.ts");
    const submitted = direct.indexOf("readSubmittedFindings");
    const text = direct.indexOf("getLastAssistantText");

    expect(submitted).toBeGreaterThan(-1);
    // Order is the assertion: the file is consulted first, and the text path is
    // only reached when the tool was never called.
    expect(submitted).toBeLessThan(text);
  });

  it("gives a delegated child no text fallback at all", () => {
    // The parent's fallback exists for reviewers predating the file contract.
    // A child is created by this host, in this release, with the tool always
    // registered — so accepting prose would put a parse of model output back
    // on the nested path for no compatibility benefit.
    expect(source("agents/delegate-runner.ts")).not.toContain("getLastAssistantText");
  });
});

describe("a definition cannot widen what the host allows", () => {
  it("the session's tool list is built from the allowlist, not from the file", () => {
    const direct = source("review/direct-dispatch.ts");

    expect(direct).toContain("sessionToolsFor(scope.agent)");
    // The literal list that used to be inline must not linger beside the
    // scoped one, or a future edit re-enables the unscoped path.
    expect(direct).not.toContain('tools: ["read", "grep", "find", "ls", "submit_findings"]');
  });

  it("the persona is appended to the vendored contract, never substituted", () => {
    const resolve = source("agents/resolve.ts");
    const composed = resolve.indexOf("reviewerPrompt,");
    const persona = resolve.indexOf("agent.body,");

    expect(composed).toBeGreaterThan(-1);
    expect(persona).toBeGreaterThan(composed);
  });
});

describe("definitions are trusted like rule files", () => {
  it("reads them from the base branch unless local rules are trusted", () => {
    const cli = source("cli.ts");
    const loader = cli.slice(cli.indexOf("async function loadAgentDefinitionsForReview"));

    // The same provider call rule files use. A definition read from the PR's
    // own checkout would let a pull request widen the review that judges it.
    expect(loader).toContain("getRuleFilesFromBase");
    expect(loader).toContain("config.trustLocalRules");
  });
});
