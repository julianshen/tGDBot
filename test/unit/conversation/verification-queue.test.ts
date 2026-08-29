// Issue #57, stage 1: deciding WHICH findings are worth re-examining, before
// any model is called. Verification costs a model call per finding, so this is
// where the cost is controlled and where "verify once per head" is guaranteed.
import { describe, expect, it } from "vitest";
import { observeResolvedThreads, pendingVerifications } from "../../../src/conversation/verification-queue.js";
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
  // Nothing observed resolved yet, which is the state a fresh repository is in.
  resolvedThreads: new Set<string>(),
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

  it("scopes a touch to the finding's own origin head, not a union of incrementals", () => {
    const earlier = "c".repeat(40);
    const later = "d".repeat(40);
    const raisedEarlier = ledger({ id: "finding_earlier", headSha: earlier });
    const raisedLater = ledger({ id: "finding_later", headSha: later, identity: { threadId: "t2" } });
    const queue = pendingVerifications(input({
      events: [],
      findings: [raisedEarlier, raisedLater],
      changedLines: new Map(),
      touchedLinesByOriginHead: new Map([
        [earlier, new Map([["src/a.ts", new Set([10])]])],
        [later, new Map([["src/unrelated.ts", new Set([1])]])],
      ]),
    }));

    expect(queue).toEqual([expect.objectContaining({ findingId: "finding_earlier", trigger: "head-change" })]);
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

// PR #73 review: a finding RAISED by the review of head X is commonly anchored
// to a line that head X changed — that is what the review was reading. Queuing
// it as a head-change verification at that same head means re-reading a finding
// against the commit that produced it, spending the ceiling and eventually
// posting an unsolicited reply to a thread nobody has answered.
describe("pendingVerifications — a finding is not verified against its own head", () => {
  it("ignores a head change for a finding raised at that head", () => {
    const queue = pendingVerifications(input({
      findings: [ledger({ headSha: HEAD })],
      events: [],
      changedLines: new Map([["src/a.ts", new Set([10])]]),
    }));

    expect(queue).toEqual([]);
  });

  it("still queues it once a later head touches the anchor", () => {
    const queue = pendingVerifications(input({
      findings: [ledger({ headSha: OLD })],
      events: [],
      changedLines: new Map([["src/a.ts", new Set([10])]]),
    }));

    expect(queue[0]?.trigger).toBe("head-change");
  });

  // A human replying is a signal regardless of which head raised the finding.
  it("still queues a reply on a finding raised at the current head", () => {
    const queue = pendingVerifications(input({
      findings: [ledger({ headSha: HEAD })],
    }));

    expect(queue[0]?.trigger).toBe("thread-comment");
  });
});

// PR #73 round two: both adapters timestamp each resolution SNAPSHOT with the
// pull request's update time, so an already-resolved thread emits
// `resolved: true` again on a later push. Treating each of those as a fresh
// human signal would re-queue every previously resolved finding at every new
// head — bypassing the anchor filter entirely.
describe("pendingVerifications — a resolution is an event, not a standing state", () => {
  const resolution = event({ kind: "thread-resolution", resolved: true, authorIsBot: undefined });

  it("queues a resolution the first time it is seen", () => {
    const queue = pendingVerifications(input({ events: [resolution] }));

    expect(queue[0]?.trigger).toBe("thread-resolution");
  });

  // Already acted on at an earlier head: a repeated snapshot says nothing new.
  it("ignores a repeated resolution snapshot at a later head", () => {
    const queue = pendingVerifications(input({
      events: [resolution],
      resolvedThreads: new Set(["t1"]),
    }));

    expect(queue).toEqual([]);
  });

  // A human REPLY is new information whatever happened before.
  it("still queues a reply after a resolution was already acted on", () => {
    const queue = pendingVerifications(input({
      events: [event()],
      outcomes: [{ findingId: ledger().id, headSha: OLD, trigger: "thread-resolution" }],
    }));

    expect(queue[0]?.trigger).toBe("thread-comment");
  });
});

// PR #73 round two: a multi-line finding is anchored to a RANGE, and checking
// only its last line misses a commit that changes the start or middle — so an
// addressed finding is never re-examined.
describe("pendingVerifications — a multi-line anchor is a range", () => {
  const ranged = ledger({ placement: { path: "src/a.ts", line: 12, startLine: 10, side: "RIGHT" } });

  it("queues when the start of the range changed", () => {
    const queue = pendingVerifications(input({
      findings: [ranged],
      events: [],
      changedLines: new Map([["src/a.ts", new Set([10])]]),
    }));

    expect(queue[0]?.trigger).toBe("head-change");
  });

  it("queues when the middle of the range changed", () => {
    const queue = pendingVerifications(input({
      findings: [ranged],
      events: [],
      changedLines: new Map([["src/a.ts", new Set([11])]]),
    }));

    expect(queue).toHaveLength(1);
  });

  it("still ignores a change outside the range", () => {
    const queue = pendingVerifications(input({
      findings: [ranged],
      events: [],
      changedLines: new Map([["src/a.ts", new Set([99])]]),
    }));

    expect(queue).toEqual([]);
  });
});

// PR #73 round two: suppressing a repeated resolution snapshot must not
// suppress a GENUINE second resolution. Both adapters emit `resolved: false`
// when a thread is reopened, so reopen-then-resolve is a real transition a
// maintainer may make without commenting or touching the code.
describe("pendingVerifications — a reopened thread can be resolved again", () => {
  const resolved = event({ kind: "thread-resolution", resolved: true, authorIsBot: undefined });
  const reopened = event({ kind: "thread-resolution", resolved: false, authorIsBot: undefined });
  const alreadyActed = [{ findingId: ledger().id, headSha: OLD, trigger: "thread-resolution" as const }];

  it("queues again when the thread was reopened in between", () => {
    const queue = pendingVerifications(input({
      events: [reopened, resolved],
      outcomes: alreadyActed,
    }));

    expect(queue[0]?.trigger).toBe("thread-resolution");
  });

  it("still ignores a repeat with no reopen", () => {
    const queue = pendingVerifications(input({
      events: [resolved],
      resolvedThreads: new Set(["t1"]),
    }));

    expect(queue).toEqual([]);
  });

  // #90: the bug this replaced. Suppression used to be read from the outcome
  // CHECKPOINT, which keeps only the most recent records — so once enough newer
  // outcomes accumulated, a still-resolved thread verified again at the next
  // head. Durable observed state has no such window: no outcomes at all, and
  // the repeat is still suppressed.
  it("suppresses a repeat with no outcome record whatsoever", () => {
    const queue = pendingVerifications(input({
      events: [resolved],
      outcomes: [],
      resolvedThreads: new Set(["t1"]),
    }));

    expect(queue).toEqual([]);
  });

  // The #73 residual: a reopen and its re-resolution no longer have to arrive
  // in the same poll, because what was observed is remembered between them.
  it("queues again when the reopen was seen in an EARLIER poll", () => {
    // The earlier poll saw the reopen, so the thread is no longer observed
    // resolved. This poll sees only the re-resolution.
    const queue = pendingVerifications(input({
      events: [resolved],
      outcomes: [],
      resolvedThreads: new Set(),
    }));

    expect(queue[0]?.trigger).toBe("thread-resolution");
  });

  // PR #94 review: a caller that caps this set needs the tail to be the
  // LAST-observed threads. `Set.add` is a no-op for a member already present,
  // so re-observing left insertion order at first-observed — and a cap would
  // then evict threads it had just seen, re-read them as transitions, and cycle
  // duplicate verifications on every push.
  it("moves a re-observed thread to the end, so a cap evicts the stalest", () => {
    const seen = (threadId: string, resolved: boolean) => ({
      kind: "thread-resolution" as const, threadId, resolved, authorIsBot: undefined,
    });

    const first = observeResolvedThreads(new Set(), [seen("a", true), seen("b", true)]);
    expect([...first.resolved]).toEqual(["a", "b"]);

    // "a" is re-emitted, as an adapter does on every later push.
    const second = observeResolvedThreads(first.resolved, [seen("a", true), seen("c", true)]);
    expect([...second.resolved]).toEqual(["b", "a", "c"]);
    // Re-observing is not a transition: nothing changed about "a".
    expect([...second.transitioned]).toEqual(["c"]);
  });

  // The caller CAPS what it stores, so what fills the cap matters. A thread no
  // finding is bound to can never produce a verification, and letting those
  // occupy the cap would evict the threads that can.
  it("remembers only the threads it is told are worth remembering", () => {
    const seen = (threadId: string) => ({
      kind: "thread-resolution" as const, threadId, resolved: true, authorIsBot: undefined,
    });

    const observed = observeResolvedThreads(
      new Set(["stale"]), [seen("bound"), seen("unbound")], new Set(["bound", "stale"]),
    );

    expect([...observed.resolved]).toEqual(["stale", "bound"]);
    // An unbound thread is not a transition either: nothing will act on it.
    expect([...observed.transitioned]).toEqual(["bound"]);
  });

  // A reopen on its own is not a request to re-verify.
  it("does not queue on a reopen alone", () => {
    const queue = pendingVerifications(input({ events: [reopened], outcomes: [] }));

    expect(queue).toEqual([]);
  });
});
