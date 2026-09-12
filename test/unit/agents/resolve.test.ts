// Issue #138 phase 2: binding rules to definitions, and the fallout of
// refusing to bind one.
import { describe, expect, it } from "vitest";
import { parseAgentFile, type AgentDefinition } from "../../../src/agents/definition.js";
import {
  applyAgentPin,
  composeSystemPrompt,
  excludeRulesWithUnresolvedAgents,
  resolveRuleAgents,
} from "../../../src/agents/resolve.js";
import type { RuleDefinition } from "../../../src/rules/types.js";

const agent = (frontmatter: string): AgentDefinition =>
  parseAgentFile("/a.agent.md", `---\n${frontmatter}\n---\n\nPersona prose.\n`).agent!;

const rule = (overrides: Partial<RuleDefinition> = {}): RuleDefinition => ({
  name: "rule-a",
  body: "Review it.",
  dependsOn: [],
  sourcePath: "/rules/a.md",
  ...overrides,
});

describe("binding rules to definitions", () => {
  it("binds a rule to the agent it names", () => {
    const { byRule, errors } = resolveRuleAgents([rule({ agent: "docs" })], [agent("name: docs")]);

    expect(errors).toEqual([]);
    expect(byRule.get("rule-a")?.name).toBe("docs");
  });

  it("leaves a rule with no reference unbound", () => {
    const { byRule } = resolveRuleAgents([rule()], [agent("name: docs")]);

    expect(byRule.size).toBe(0);
  });

  it("reports an unknown agent rather than falling back", () => {
    // The point of the reference is a narrower tool scope and a chosen model,
    // so running the rule without one would widen exactly what the author
    // wrote the file to narrow.
    const { byRule, errors } = resolveRuleAgents([rule({ agent: "missing" })], [agent("name: docs")]);

    expect(byRule.size).toBe(0);
    expect(errors[0]?.ruleName).toBe("rule-a");
    // Naming what IS available turns "it does not work" into "you meant docs".
    expect(errors[0]?.message).toMatch(/known agents: docs/u);
  });

  it("says so plainly when no definitions were loaded at all", () => {
    const { errors } = resolveRuleAgents([rule({ agent: "missing" })], []);

    expect(errors[0]?.message).toMatch(/no agent definitions loaded/u);
  });
});

// This is the finding that mattered most on PR #149: excluding a rule left its
// name in every surviving rule's `dependsOn`, and `planReviewWorkflow` rejects
// a dependency on a rule it cannot see — so ONE bad `agent:` reference aborted
// dispatch for every remaining rule. Far worse than the silent fallback the
// exclusion was meant to avoid.
describe("excluding a rule takes its dependency edges with it", () => {
  const rules = [
    rule({ name: "broken", agent: "missing" }),
    rule({ name: "dependent", dependsOn: ["broken"] }),
    rule({ name: "unrelated", dependsOn: ["dependent"] }),
  ];

  it("removes the rule that could not be bound", () => {
    const kept = excludeRulesWithUnresolvedAgents(rules, new Set(["broken"]));

    expect(kept.map((r) => r.name)).toEqual(["dependent", "unrelated"]);
  });

  it("strips the dangling edge, so the workflow still plans", () => {
    const kept = excludeRulesWithUnresolvedAgents(rules, new Set(["broken"]));

    expect(kept.find((r) => r.name === "dependent")?.dependsOn).toEqual([]);
  });

  it("leaves edges between surviving rules alone", () => {
    // Dropping more than the dead edge would reorder a review that was
    // ordered deliberately.
    const kept = excludeRulesWithUnresolvedAgents(rules, new Set(["broken"]));

    expect(kept.find((r) => r.name === "unrelated")?.dependsOn).toEqual(["dependent"]);
  });

  it("returns the same array when nothing is excluded", () => {
    // Identity, not merely equality: the common path must not rebuild every
    // rule object for nothing.
    expect(excludeRulesWithUnresolvedAgents(rules, new Set())).toBe(rules);
  });
});

describe("which model pin wins", () => {
  // Folded into the RULE before default resolution, not consulted after it:
  // `resolveEffectiveRules` fills every unpinned rule with the deployment
  // default, so a check performed later sees a rule that is always pinned and
  // the agent's tier can never win (Codex review of PR #149).
  it("prefers the rule's own pin", () => {
    // A rule pin names ONE review; the agent's is the persona's default.
    expect(
      applyAgentPin(
        rule({ provider: "openai", model: "gpt-5" }),
        agent("name: docs\nprovider: anthropic\nmodel: claude-sonnet-5"),
      ),
    ).toMatchObject({ provider: "openai", model: "gpt-5" });
  });

  it("falls back to the agent's", () => {
    expect(applyAgentPin(rule(), agent("name: docs\nprovider: anthropic\nmodel: claude-sonnet-5")))
      .toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("leaves the rule unpinned when neither pins", () => {
    // Unpinned must stay unpinned, so `resolveEffectiveRules` can still apply
    // the deployment default — inventing a pin here would defeat it.
    const pinned = applyAgentPin(rule(), agent("name: docs"));

    expect(pinned.provider).toBeUndefined();
    expect(pinned.model).toBeUndefined();
  });

  it("returns the same object when there is nothing to add", () => {
    // Identity, not equality: rebuilding every rule for nothing would
    // needlessly break reference-keyed maps downstream.
    const unpinned = rule();
    expect(applyAgentPin(unpinned, agent("name: docs"))).toBe(unpinned);
  });
});

describe("composing the system prompt", () => {
  it("returns the vendored prompt untouched when there is no agent", () => {
    expect(composeSystemPrompt("REVIEWER CONTRACT", undefined)).toBe("REVIEWER CONTRACT");
  });

  it("puts the contract first and the persona after it", () => {
    // Order is the guarantee, not the style: the contract carries ADR-003 and
    // the finding schema, and a persona that could precede or replace it could
    // quietly drop both.
    const composed = composeSystemPrompt("REVIEWER CONTRACT", agent("name: docs"));

    expect(composed.indexOf("REVIEWER CONTRACT")).toBeLessThan(composed.indexOf("Persona prose."));
  });

  it("tells the model the persona does not relax the contract", () => {
    const composed = composeSystemPrompt("REVIEWER CONTRACT", agent("name: docs"));

    expect(composed).toMatch(/does NOT relax anything above/u);
  });
});
