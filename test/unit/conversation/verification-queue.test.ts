// Issue #57, stage 1: deciding WHICH findings are worth re-examining, before
// any model is called. Verification costs a model call per finding, so this is
// where the cost is controlled and where "verify once per head" is guaranteed.
import { describe, expect, it } from "vitest";
import { pendingVerifications } from "../../../src/conversation/verification-queue.js";
import type { Finding } from "../../../src/review/types.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

const ledger = (over: Record<string, unknown> = {}) => ({
  id: `finding_${"1".repeat(32)}`,
  headSha: OLD,
  finding: {
    ruleName: "tgd-review",
    file: "src/a.ts",
    line: 10,
    category: "correctness",
    severity: "warning" as Finding["severity"],
    message: "m",
  },
  placement: { path: "src/a.ts", line: 10, side: "RIGHT" },
  identity: { provider: "github", commentId: "100", threadId: "t1", url: "u" },
  ...over,
});

const event = (over: Record<string, unknown> = {}) => ({
  kind: "thread-comment",
  threadId: "t1",
  authorIsBot: false,
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  headSha: HEAD,
  findings: [ledger()],
  events: [event()],
  outcomes: [],
  changedLines: new Map<string, ReadonlySet<number>>(),
  ceiling: 10,
  ...over,
});

describe("pendingVerifications — what makes a finding worth re-examining", () => {
  it("queues a finding whose thread a human replied in", () => {
    const queue = pendingVerifications(input());

    expect(queue).toHaveLength(1);
    expect(queue[0]?.trigger).toBe("thread-comment");
  });

  it("queues a finding whose thread a human resolved", () => {
    const queue = pendingVerifications(input({
      events: [event({ kind: "thread-resolution", resolved: true, authorIsBot: undefined })],
    }));

    expect(queue[0]?.trigger).toBe("thread-resolution");
  });

  // The bot's own replies must not trigger verification, or a run answers
  // itself forever.
  it("ignores the bot's own reply", () => {
    expect(pendingVerifications(input({ events: [event({ authorIsBot: true })] }))).toEqual([]);
  });

  it("ignores an event in a thread that is not a finding's", () => {
    expect(pendingVerifications(input({ events: [event({ threadId: "other" })] }))).toEqual([]);
  });

  // A new head only matters where it touched the finding.
  it("queues a finding whose anchored line the new head changed", () => {
    const queue = pendingVerifications(input({
      events: [],
      changedLines: new Map([["src/a.ts", new Set([10])]]),
    }));

    expect(queue[0]?.trigger).toBe("head-change");
  });

  it("does not queue every open finding just because something was pushed", () => {
    const queue = pendingVerifications(input({
      events: [],
      changedLines: new Map([["src/unrelated.ts", new Set([1])]]),
    }));

    expect(queue).toEqual([]);
  });

  it("does not queue a finding with no anchor when unrelated lines change", () => {
    const queue = pendingVerifications(input({
      findings: [ledger({ placement: null })],
      events: [],
      changedLines: new Map([["src/a.ts", new Set([10])]]),
    }));

    expect(queue).toEqual([]);
  });
});

describe("pendingVerifications — one verdict per finding per head", () => {
  it("skips a finding already verified at this head", () => {
    const queue = pendingVerifications(input({
      outcomes: [{ findingId: ledger().id, headSha: HEAD }],
    }));

    expect(queue).toEqual([]);
  });

  it("re-queues it once the head moves on", () => {
    const queue = pendingVerifications(input({
      outcomes: [{ findingId: ledger().id, headSha: OLD }],
    }));

    expect(queue).toHaveLength(1);
  });

  // Three replies in one thread in one poll is still one verification.
  it("queues a finding once however many events name it", () => {
    const queue = pendingVerifications(input({
      events: [event(), event(), event({ kind: "thread-resolution", resolved: true })],
    }));

    expect(queue).toHaveLength(1);
  });
});

describe("pendingVerifications — the ceiling and what survives it", () => {
  const many = (severity: Finding["severity"], index: number, thread: string) => ledger({
    id: `finding_${String(index).padStart(32, "0")}`,
    finding: { ...ledger().finding, severity },
    identity: { provider: "github", commentId: String(index), threadId: thread, url: "u" },
    placement: { path: "src/a.ts", line: index, side: "RIGHT" },
  });

  it("never returns more than the ceiling", () => {
    const findings = Array.from({ length: 20 }, (_, i) => many("warning", i, `t${i}`));
    const queue = pendingVerifications(input({
      findings,
      events: findings.map((_, i) => event({ threadId: `t${i}` })),
      ceiling: 5,
    }));

    expect(queue).toHaveLength(5);
  });

  // A cost ceiling that drops blockers first would be worse than useless.
  it("keeps blocking findings ahead of warnings and suggestions", () => {
    const findings = [
      many("suggestion", 0, "t0"),
      many("warning", 1, "t1"),
      many("blocking", 2, "t2"),
    ];
    const queue = pendingVerifications(input({
      findings,
      events: findings.map((_, i) => event({ threadId: `t${i}` })),
      ceiling: 1,
    }));

    expect(queue[0]?.severity).toBe("blocking");
  });

  // A human who replied is waiting for an answer; an inferred code change is
  // not, so direct replies outrank head changes at equal severity.
  it("keeps a human reply ahead of an inferred code change", () => {
    const findings = [many("warning", 0, "t0"), many("warning", 1, "t1")];
    const queue = pendingVerifications(input({
      findings,
      events: [event({ threadId: "t1" })],
      changedLines: new Map([["src/a.ts", new Set([0, 1])]]),
      ceiling: 1,
    }));

    expect(queue[0]?.trigger).toBe("thread-comment");
  });
});

// PR #73 review: `verified` removes findings that already have an outcome, but
// nothing stopped the same finding appearing twice in the input. Two entries
// for one finding means the verifier runs twice on one head — the exact thing
// the idempotency rule exists to prevent.
describe("pendingVerifications — one entry per finding", () => {
  it("queues a duplicated finding once", () => {
    const entry = ledger();
    const queue = pendingVerifications(input({ findings: [entry, entry] }));

    expect(queue).toHaveLength(1);
  });

  it("keeps the stronger trigger when duplicates disagree", () => {
    const entry = ledger();
    const queue = pendingVerifications(input({
      // Stronger trigger FIRST, so a last-write-wins implementation would
      // demote it — which is the mistake this pins.
      findings: [
        entry,
        { ...entry, identity: { ...entry.identity, threadId: "none" } },
      ],
      events: [event()],
      changedLines: new Map([["src/a.ts", new Set([10])]]),
    }));

    expect(queue).toHaveLength(1);
    expect(queue[0]?.trigger).toBe("thread-comment");
  });
});
