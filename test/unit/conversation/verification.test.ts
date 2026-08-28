// Issue #57, stages 2 and 3. The model call is injected, so this exercises the
// whole path — queue entry in, verdict and reply and record out — without a
// provider.
import { describe, expect, it } from "vitest";
import { verifyFinding } from "../../../src/conversation/verification.js";

const repository = { provider: "github" as const, repositoryDigest: "a".repeat(64) };
const HEX32 = "1".repeat(32);

const ledger = {
  version: 1 as const,
  repository,
  id: `finding_${HEX32}`,
  reviewNumber: 42,
  reviewId: "PR_kwDOReview42",
  baseSha: "b".repeat(40),
  headSha: "c".repeat(40),
  contentDigest: "d".repeat(64),
  bodyDigest: "e".repeat(64),
  ruleDigest: "f".repeat(64),
  ruleSnapshot: "Never log credentials.",
  finding: {
    ruleName: "security-audit",
    file: "src/auth.ts",
    line: 14,
    category: "security",
    severity: "blocking" as const,
    message: "Token is logged.",
  },
  reviewOptions: {
    advisor: "on" as const, suggestions: "on" as const, disableBuiltinRule: false,
    trustLocalRules: false, rulesDir: ".review/rules", dispatch: "direct" as const,
  },
  placement: null,
  at: "2026-08-28T00:00:00.000Z",
};

const currentRule = {
  name: "security-audit",
  body: "Never log credentials.",
  sourcePath: "rules/security.md",
  dependsOn: [],
};

// The reconsider contract requires the restated finding for confirmed and
// revised; only `withdrawn` may omit it.
const stillStands = (outcome: "confirmed" | "revised", rationale: string) => JSON.stringify({
  outcome,
  rationale,
  finding: {
    file: "src/auth.ts",
    line: 14,
    category: "security",
    severity: "blocking",
    message: "Token is logged.",
    decision: "still-valid",
  },
});

const session = (finalOutput: string) => async () => ({
  prompt: async () => finalOutput,
  getLastAssistantText: () => finalOutput,
});

const input = (over: Record<string, unknown> = {}) => ({
  pending: { findingId: ledger.id, trigger: "thread-comment" as const, severity: "blocking" as const },
  ledger,
  currentRule,
  currentCodeHunk: "@@ -1,2 +1,2 @@\n-log(token)\n+log(redact(token))",
  addressedThread: "alice: fixed in the latest push",
  headSha: "e".repeat(40),
  repository,
  marker: "<!-- tgd-verification -->",
  outcomeId: `outcome_${HEX32}`,
  at: "2026-08-28T01:00:00.000Z",
  anchorChanged: true,
  model: "anthropic/claude-opus-4-5",
  createSession: session(JSON.stringify({
    outcome: "withdrawn",
    rationale: "The token is redacted before logging now.",
  })),
  ...over,
});

describe("verifyFinding", () => {
  it("plans a reply and a record for a withdrawn finding", async () => {
    const result = await verifyFinding(input() as never);

    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    expect(result.plan.verdict).toBe("withdrawn");
    expect(result.plan.replyBody).toContain("redacted before logging");
    expect(result.plan.outcome.verdict).toBe("withdrawn");
  });

  // Only a concern the tool has DROPPED, and only its own thread. Resolving a
  // human-started thread is a documented non-goal.
  it("offers to resolve its own thread only when it withdrew the finding", async () => {
    const withdrawn = await verifyFinding(input() as never);
    const confirmed = await verifyFinding(input({
      createSession: session(stillStands("confirmed", "Still logged.")),
    }) as never);

    // Asserted on the PLAN, not on `"plan" in result && …` — that expression
    // is false for a skip, so it passes without ever reading the flag.
    if (!("plan" in withdrawn)) throw new Error("expected a plan for withdrawn");
    if (!("plan" in confirmed)) throw new Error("expected a plan for confirmed");
    expect(withdrawn.plan.resolveOwnThread).toBe(true);
    expect(confirmed.plan.resolveOwnThread).toBe(false);
  });

  it("records the rule and category as digests, never as labels", async () => {
    const result = await verifyFinding(input() as never);

    if (!("plan" in result)) throw new Error("expected a plan");
    expect(JSON.stringify(result.plan.outcome)).not.toContain("security-audit");
    expect(result.plan.outcome.ruleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the head it verified against, not the one that raised the finding", async () => {
    const result = await verifyFinding(input() as never);

    if (!("plan" in result)) throw new Error("expected a plan");
    expect(result.plan.outcome.headSha).toBe("e".repeat(40));
    expect(result.plan.outcome.headSha).not.toBe(ledger.headSha);
  });

  // Nobody asked for this, so the reason handed to the model is the HOST's.
  // Interpolating the thread would put untrusted text into a prompt field the
  // command path treats as an untrusted argument.
  it("does not put the thread's text into the reason", async () => {
    const prompts: string[] = [];
    await verifyFinding(input({
      addressedThread: "alice: SMUGGLED-THREAD-TEXT",
      createSession: async () => ({
        prompt: async (text: string) => {
          prompts.push(text);
          return stillStands("confirmed", "r");
        },
        getLastAssistantText: () => stillStands("confirmed", "r"),
      }),
    }) as never);

    // The thread is supplied as its own untrusted section; what must not happen
    // is it arriving as the host's stated REASON for looking.
    const reasons = prompts.join("\n").split("Automatic verification:")[1] ?? "";
    expect(reasons.split("\n")[0]).not.toContain("SMUGGLED-THREAD-TEXT");
  });

  it("says why it looked, per trigger", async () => {
    const prompts: string[] = [];
    const capture = async () => ({
      prompt: async (text: string) => {
        prompts.push(text);
        return stillStands("confirmed", "r");
      },
      getLastAssistantText: () => stillStands("confirmed", "r"),
    });

    await verifyFinding(input({
      pending: { findingId: ledger.id, trigger: "head-change", severity: "warning" },
      createSession: capture,
    }) as never);

    expect(prompts.join("\n")).toMatch(/new commit changed the lines/i);
  });
});

// A failure is reported, never swallowed: three different situations a caller
// may want to retry, report or drop differently.
describe("verifyFinding — what it cannot do", () => {
  it("reports a transient provider failure", async () => {
    const result = await verifyFinding(input({
      createSession: async () => ({
        prompt: async () => { throw new Error("No API key found for anthropic"); },
        getLastAssistantText: () => undefined,
      }),
    }) as never);

    expect("skip" in result && result.skip.kind).toBe("transient");
  });

  it("reports a rule that is no longer active", async () => {
    const result = await verifyFinding(input({ currentRule: undefined }) as never);

    expect("skip" in result && result.skip.kind).toBe("inactive-rule");
  });

  it("never returns a plan without an outcome record", async () => {
    const result = await verifyFinding(input() as never);

    if (!("plan" in result)) throw new Error("expected a plan");
    expect(result.plan.outcome).toBeDefined();
    expect(result.plan.outcome.findingId).toBe(ledger.id);
  });
});
