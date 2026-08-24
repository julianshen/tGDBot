import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConversationCommand } from "../../../src/conversation/command-parser.js";
import { toFindingSnapshot } from "../../../src/review/review-publication.js";
import { validatePendingSnapshot } from "../../../src/conversation/state-schema.js";
import {
  associateClarificationEvent,
  createPreparedClarification,
  encodeClarificationPublicId,
  mayBeClarificationAnswer,
  parseAnswerSyntax,
  selectClarification,
  toClarificationFindingSnapshot,
  transitionClarification,
} from "../../../src/conversation/clarification.js";
import {
  clarificationQuestionIdentity,
  executePublication,
  publishClarificationQuestion,
} from "../../../src/conversation/publication-manifest.js";
import { computeRepositoryDigest } from "../../../src/conversation/markers.js";
import { createConversationStateStore } from "../../../src/conversation/state-store.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import type { Finding } from "../../../src/review/types.js";
import type { ConversationItemIdentity } from "../../../src/conversation/types.js";
import type { ReviewActivityEvent, ReviewThreadSnapshot } from "../../../src/vcs/conversation-adapter.js";

function finding(overrides: Partial<Finding> & Pick<Finding, "message">): Finding {
  return {
    file: "src/a.ts",
    line: 4,
    severity: "warning",
    category: "correctness",
    ruleName: "rule-a",
    decision: "needs-clarification",
    question: overrides.message,
    ...overrides,
  };
}

const BINDING = {
  repositoryDigest: "a".repeat(64),
  reviewNumber: 7,
  headSha: "c".repeat(40),
};
const REPO = parseRepositoryRef("acme/app", "github");
const publicDigest = computeRepositoryDigest("github", REPO.canonicalUrl);
const bot = { provider: "github" as const, login: "tgdbot", mention: "@tgdbot" };
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const temporaryDirectories: string[] = [];
const testProcessInspector = {
  current: async () => ({ pid: 100, hostname: "unit-test-host", startIdentity: "unit-test-start" }),
  inspect: async () => ({ status: "unknown" as const }),
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function stateRoot(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-clarification-")));
  temporaryDirectories.push(directory);
  return path.join(directory, "state");
}

function storeFor(root: string) {
  return createConversationStateStore({
    root,
    repository: REPO,
    dependencies: { processInspector: testProcessInspector },
  });
}

function selectedId(findings: readonly Finding[], extras: Partial<typeof BINDING> = {}): string {
  const selected = selectClarification({ ...BINDING, ...extras, findings });
  if (selected.selected === undefined) throw new Error("expected a selected clarification");
  return selected.selected.id;
}

function commentEvent(
  extras: Partial<ReviewActivityEvent> & Pick<ReviewActivityEvent, "eventId" | "body">,
): ReviewActivityEvent {
  return {
    kind: extras.kind ?? "general-comment",
    provider: "github",
    repositoryDigest: extras.repositoryDigest ?? publicDigest,
    reviewNumber: extras.reviewNumber ?? 7,
    eventId: extras.eventId,
    revisionId: extras.revisionId ?? `${extras.eventId}:1`,
    orderKey: extras.orderKey ?? `2026-08-14T00:00:00.000Z|${extras.eventId}`,
    authorLogin: extras.authorLogin ?? "alice",
    authorIsBot: extras.authorIsBot ?? false,
    createdAt: extras.createdAt ?? "2026-08-14T00:00:00.000Z",
    updatedAt: extras.updatedAt ?? "2026-08-14T00:00:00.000Z",
    body: extras.body,
    url: extras.url ?? `https://github.com/acme/app/pull/7#issuecomment-${extras.eventId}`,
    commentId: extras.commentId ?? extras.eventId,
    ...extras,
  };
}

function publishedPending(id: string, extras: {
  readonly threadId?: string;
  readonly headSha?: string;
  readonly reviewNumber?: number;
} = {}) {
  const prepared = createPreparedClarification({
    id,
    reviewNumber: extras.reviewNumber ?? 7,
    headSha: extras.headSha ?? BINDING.headSha,
    question: "Is the fallback path intentional?",
    createdAt: "2026-08-14T00:00:00.000Z",
    finding: finding({ message: "unclear", question: "Is the fallback path intentional?" }),
  });
  return transitionClarification(prepared, "published", {
    identity: {
      provider: "github",
      commentId: "question-1",
      url: "https://github.com/acme/app/pull/7#discussion_rquestion-1",
      ...(extras.threadId === undefined ? {} : { threadId: extras.threadId }),
    },
  });
}

describe("selectClarification", () => {
  it("selects nothing when there is no clarification candidate", () => {
    expect(selectClarification({
      ...BINDING,
      findings: [finding({ message: "bug", decision: "new", question: undefined })],
    })).toEqual({ deferredCount: 0 });
  });

  it("selects by workflow/rule order, then original finding order", () => {
    const findings = [
      finding({ ruleName: "later", message: "later first", question: "Later first?" }),
      finding({ ruleName: "earlier", message: "earlier second", question: "Earlier second?" }),
      finding({ ruleName: "earlier", message: "earlier first", question: "Earlier first?" }),
      finding({ ruleName: "later", message: "later second", question: "Later second?" }),
    ];

    const selected = selectClarification({
      ...BINDING,
      findings,
      ruleOrder: ["earlier", "later"],
    });

    expect(selected.selected?.question).toBe("Earlier second?");
    expect(selected.selected?.finding.message).toBe("earlier second");
    expect(selected.deferredCount).toBe(3);
  });

  it("creates a deterministic clar_ id that the answer parser accepts", () => {
    const candidate = finding({ question: "Is this intended?", message: "unclear" });
    const first = selectClarification({ ...BINDING, findings: [candidate] });
    const again = selectClarification({ ...BINDING, findings: [candidate] });
    const otherHead = selectClarification({
      ...BINDING,
      headSha: "d".repeat(40),
      findings: [candidate],
    });

    expect(first.selected?.id).toMatch(new RegExp(`^clar_[${ALPHABET}]{12,32}$`, "u"));
    expect(first.selected?.id).not.toMatch(/^clar_[0-9a-f]{32}$/u);
    expect(again.selected?.id).toBe(first.selected?.id);
    expect(otherHead.selected?.id).not.toBe(first.selected?.id);
    expect(first.deferredCount).toBe(0);
    expect(parseConversationCommand({
      authorIsBot: false,
      botIdentity: bot,
      body: `@tgdbot answer ${first.selected!.id}: yes it is`,
    })).toMatchObject({
      kind: "command",
      command: { kind: "answer", pendingId: first.selected!.id, answer: "yes it is" },
    });
  });

  it("encodes the digest in the command-parser base32 alphabet", () => {
    const digest = createHash("sha256").update("tgd:clarification-id-fixture", "utf8").digest();
    const id = encodeClarificationPublicId(digest);
    expect(id.startsWith("clar_")).toBe(true);
    expect([...id.slice(5)].every((character) => ALPHABET.includes(character))).toBe(true);
    expect(id.slice(5).length).toBeGreaterThanOrEqual(12);
    expect(id.slice(5).length).toBeLessThanOrEqual(32);
    expect(encodeClarificationPublicId(digest)).toBe(id);
    expect(encodeClarificationPublicId(digest.toString("hex"))).toBe(id);
  });

  it("enforces one active clarification and returns only a deferred count", () => {
    const result = selectClarification({
      ...BINDING,
      findings: [
        finding({ question: "First?", message: "first" }),
        finding({ question: "Second?", message: "second" }),
      ],
    });

    expect(result.selected?.question).toBe("First?");
    expect(result.deferredCount).toBe(1);
    expect(result).not.toHaveProperty("deferred");
    expect(result).not.toHaveProperty("candidates");
  });

  it("selects a later same-head next candidate after excluding a terminal id", () => {
    const findings = [
      finding({ question: "First?", message: "first" }),
      finding({ question: "Second?", message: "second" }),
    ];
    const first = selectClarification({ ...BINDING, findings });
    const next = selectClarification({
      ...BINDING,
      findings,
      excludeIds: [first.selected!.id],
    });
    expect(next.selected?.question).toBe("Second?");
    expect(next.selected?.id).not.toBe(first.selected?.id);
    expect(next.deferredCount).toBe(0);
  });
});

describe("clarification lifecycle transitions", () => {
  it("advances prepared → published → answer-observed → terminal", () => {
    const id = selectedId([finding({ question: "Is this intended?", message: "unclear" })]);
    const prepared = createPreparedClarification({
      id,
      reviewNumber: 7,
      headSha: BINDING.headSha,
      question: "Is this intended?",
      createdAt: "2026-08-14T00:00:00.000Z",
      finding: finding({ question: "Is this intended?", message: "unclear" }),
    });
    expect(prepared.state).toBe("prepared");
    expect(prepared.identity).toBeUndefined();

    const published = transitionClarification(prepared, "published", {
      identity: {
        provider: "github",
        commentId: "q1",
        url: "https://github.com/acme/app/pull/7#issuecomment-q1",
      },
    });
    expect(published.state).toBe("published");
    expect(published.identity?.commentId).toBe("q1");

    const observed = transitionClarification(published, "answer-observed", {
      answerIdentity: {
        provider: "github",
        commentId: "a1",
        url: "https://github.com/acme/app/pull/7#issuecomment-a1",
      },
      answerText: "Yes, keep the fallback.",
      answerEventId: "a1",
    });
    expect(observed.state).toBe("answer-observed");
    expect(observed.answerText).toBe("Yes, keep the fallback.");
    expect(observed.answerIdentity?.commentId).toBe("a1");

    const terminal = transitionClarification(observed, "terminal", { terminalOutcome: "confirmed" });
    expect(terminal.state).toBe("terminal");
    expect(terminal.terminalOutcome).toBe("confirmed");
  });

  it("rejects skipped or reversed lifecycle transitions", () => {
    const id = selectedId([finding({ question: "Skip?", message: "skip" })]);
    const prepared = createPreparedClarification({
      id,
      reviewNumber: 7,
      headSha: BINDING.headSha,
      question: "Skip?",
      createdAt: "2026-08-14T00:00:00.000Z",
      finding: finding({ question: "Skip?", message: "skip" }),
    });
    expect(() => transitionClarification(prepared, "answer-observed")).toThrow(/transition/i);
    expect(() => transitionClarification(prepared, "terminal")).toThrow(/transition/i);
    const published = transitionClarification(prepared, "published", {
      identity: { provider: "github", commentId: "q1", url: "https://github.com/acme/app/pull/7#issuecomment-q1" },
    });
    expect(() => transitionClarification(published, "prepared")).toThrow(/transition/i);
    expect(() => transitionClarification(published, "terminal")).toThrow(/transition/i);
    const observed = transitionClarification(published, "answer-observed", {
      answerIdentity: { provider: "github", commentId: "a1", url: "https://github.com/acme/app/pull/7#issuecomment-a1" },
      answerText: "no",
    });
    const terminal = transitionClarification(observed, "terminal", { terminalOutcome: "withdrawn" });
    expect(() => transitionClarification(terminal, "published")).toThrow(/transition/i);
    expect(() => transitionClarification(terminal, "answer-observed")).toThrow(/transition/i);
  });
});

describe("clarification answer association", () => {
  it("treats the first human reply on the question thread as the answer without a mention", () => {
    const id = selectedId([finding({ question: "Keep it?", message: "keep" })]);
    const pending = publishedPending(id, { threadId: "Q1" });
    const event = commentEvent({
      kind: "thread-comment",
      eventId: "reply-1",
      body: "Yes, keep the compatibility path.",
      threadId: "Q1",
      parentCommentId: "question-1",
    });
    const thread: ReviewThreadSnapshot = {
      provider: "github",
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      threadId: "Q1",
      rootCommentId: "question-1",
      url: "https://github.com/acme/app/pull/7#discussion_rquestion-1",
      resolved: false,
      outdated: false,
      updatedAt: "2026-08-14T00:00:01.000Z",
      orderKey: "Q1",
      events: [
        commentEvent({
          kind: "thread-comment",
          eventId: "question-1",
          body: "Is the fallback path intentional?",
          threadId: "Q1",
          authorLogin: "tgdbot",
          authorIsBot: true,
        }),
        event,
      ],
    };

    expect(associateClarificationEvent({
      event,
      pending: [pending],
      thread,
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      headSha: BINDING.headSha,
    })).toMatchObject({
      kind: "answer",
      pending: { id },
      answerText: "Yes, keep the compatibility path.",
    });
  });

  it("accepts an unthreaded answer clar_id: as the only mentionless free-form path", () => {
    const id = selectedId([finding({ question: "Keep it?", message: "keep" })]);
    const pending = publishedPending(id);
    expect(parseAnswerSyntax(`answer ${id}: it is required for rollback`)).toEqual({
      pendingId: id,
      answer: "it is required for rollback",
    });
    expect(associateClarificationEvent({
      event: commentEvent({ eventId: "ans", body: `answer ${id}: it is required for rollback` }),
      pending: [pending],
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      headSha: BINDING.headSha,
    })).toMatchObject({
      kind: "answer",
      pending: { id },
      answerText: "it is required for rollback",
    });
  });

  it("ignores a mentionless general comment that is not answer clar_id:", () => {
    const id = selectedId([finding({ question: "Keep it?", message: "keep" })]);
    const pending = publishedPending(id);
    const event = commentEvent({ eventId: "noise", body: "looks good to me" });
    expect(mayBeClarificationAnswer({ event, pending: [pending] })).toBe(false);
    expect(associateClarificationEvent({
      event,
      pending: [pending],
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      headSha: BINDING.headSha,
    })).toEqual({ kind: "ignore" });
  });

  it("does not disclose a question for the wrong repository, review, or head binding", () => {
    const id = selectedId([finding({ question: "Keep it?", message: "keep" })]);
    const pending = publishedPending(id);
    const attempts = [
      commentEvent({ eventId: "other-repo", body: `answer ${id}: yes`, repositoryDigest: "b".repeat(64) }),
      commentEvent({ eventId: "other-review", body: `answer ${id}: yes`, reviewNumber: 99 }),
    ];
    for (const event of attempts) {
      const result = associateClarificationEvent({
        event,
        pending: [pending],
        repositoryDigest: publicDigest,
        reviewNumber: 7,
        headSha: BINDING.headSha,
      });
      expect(result).toEqual({ kind: "ignore" });
      expect(JSON.stringify(result)).not.toMatch(/pending|question|clar_/i);
    }
  });

  it("marks a published-head answer stale when the current head has moved", () => {
    const id = selectedId([finding({ question: "Keep it?", message: "keep" })]);
    const pending = publishedPending(id, { headSha: "c".repeat(40) });
    expect(associateClarificationEvent({
      event: commentEvent({ eventId: "stale", body: `answer ${id}: still needed` }),
      pending: [pending],
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      headSha: "d".repeat(40),
    })).toMatchObject({
      kind: "stale",
      pending: { id },
      answerText: "still needed",
    });
  });

  it("stays silent after a terminal result until a new mention", () => {
    const id = selectedId([finding({ question: "Keep it?", message: "keep" })]);
    const terminal = transitionClarification(
      transitionClarification(publishedPending(id, { threadId: "Q1" }), "answer-observed", {
        answerIdentity: { provider: "github", commentId: "a1", url: "https://github.com/acme/app/pull/7#issuecomment-a1" },
        answerText: "yes",
      }),
      "terminal",
      { terminalOutcome: "withdrawn" },
    );
    const reply = commentEvent({
      kind: "thread-comment",
      eventId: "later",
      body: "one more thought",
      threadId: "Q1",
    });
    const answer = commentEvent({ eventId: "again", body: `answer ${id}: wait no` });
    expect(associateClarificationEvent({
      event: reply,
      pending: [terminal],
      thread: {
        provider: "github",
        repositoryDigest: publicDigest,
        reviewNumber: 7,
        threadId: "Q1",
        rootCommentId: "question-1",
        url: "https://github.com/acme/app/pull/7#discussion_rquestion-1",
        resolved: false,
        outdated: false,
        updatedAt: "2026-08-14T00:00:02.000Z",
        orderKey: "Q1",
        events: [reply],
      },
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      headSha: BINDING.headSha,
    })).toEqual({ kind: "ignore" });
    expect(associateClarificationEvent({
      event: answer,
      pending: [terminal],
      repositoryDigest: publicDigest,
      reviewNumber: 7,
      headSha: BINDING.headSha,
    })).toEqual({ kind: "ignore" });
  });
});

describe("question publication crash recovery", () => {
  const candidate = finding({ question: "Is the timeout intentional?", message: "timeout" });

  async function preparedQuestion(root: string) {
    const store = storeFor(root);
    await store.transact((tx) => tx.initializeIfAbsent());
    const selected = selectClarification({ ...BINDING, findings: [candidate] });
    const pending = createPreparedClarification({
      id: selected.selected!.id,
      reviewNumber: 7,
      headSha: BINDING.headSha,
      question: selected.selected!.question,
      createdAt: "2026-08-14T00:00:00.000Z",
      finding: candidate,
    });
    return { store, pending, selected };
  }

  function recoveringWriter(log: string[], posted: Map<string, ConversationItemIdentity>, mode: "write" | "accept-then-fail" = "write") {
    return {
      async lookupChild(child: { marker: string }) {
        return posted.get(child.marker) ?? null;
      },
      async writeChild(child: { marker: string; body: string }) {
        const identity: ConversationItemIdentity = {
          provider: "github",
          commentId: `q-${log.length + 1}`,
          url: `https://github.com/acme/app/pull/7#issuecomment-q-${log.length + 1}`,
        };
        log.push(child.marker);
        posted.set(child.marker, identity);
        if (mode === "accept-then-fail") {
          throw Object.assign(new Error("transport failed after accepted write"), { publicationHalt: true });
        }
        return { status: "posted" as const, identity };
      },
    };
  }

  it("recovers a crash before write into one tracked question", async () => {
    const { store, pending } = await preparedQuestion(await stateRoot());
    const log: string[] = [];
    const posted = new Map<string, ConversationItemIdentity>();
    await expect(publishClarificationQuestion({
      store,
      pending,
      repository: store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: recoveringWriter(log, posted),
      hooks: { beforeChildWrite: async () => { throw new Error("crash before write"); } },
    })).rejects.toThrow(/crash before write/);
    expect(log).toEqual([]);
    expect((await store.readContextSnapshot()).pending.clarifications).toHaveLength(1);
    expect((await store.readContextSnapshot()).pending.clarifications[0]?.state).toBe("prepared");

    const recovered = await publishClarificationQuestion({
      store,
      pending,
      repository: store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: recoveringWriter(log, posted),
    });
    expect(log).toHaveLength(1);
    expect(recovered.pending.state).toBe("published");
    expect(recovered.pending.identity?.commentId).toBe("q-1");
    expect((await store.readContextSnapshot()).pending.clarifications).toHaveLength(1);
  });

  it("recovers an accepted ambiguous write via the marker without a second post", async () => {
    const { store, pending } = await preparedQuestion(await stateRoot());
    const log: string[] = [];
    const posted = new Map<string, ConversationItemIdentity>();
    await expect(publishClarificationQuestion({
      store,
      pending,
      repository: store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: recoveringWriter(log, posted, "accept-then-fail"),
    })).rejects.toThrow(/accepted write/);
    expect(log).toHaveLength(1);

    const recovered = await publishClarificationQuestion({
      store,
      pending,
      repository: store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: recoveringWriter(log, posted),
    });
    expect(log).toHaveLength(1);
    expect(recovered.pending.state).toBe("published");
    expect(recovered.action.children[0]?.identity?.commentId).toBe("q-1");
    expect((await store.readContextSnapshot()).pending.clarifications).toHaveLength(1);
  });

  it("recovers a crash before local published into one tracked question", async () => {
    const { store, pending } = await preparedQuestion(await stateRoot());
    const log: string[] = [];
    const posted = new Map<string, ConversationItemIdentity>();
    await expect(publishClarificationQuestion({
      store,
      pending,
      repository: store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: recoveringWriter(log, posted),
      hooks: { afterChildWrite: async () => { throw new Error("crash before local published"); } },
    })).rejects.toThrow(/crash before local published/);
    expect(log).toHaveLength(1);
    const mid = await store.readContextSnapshot();
    expect(mid.pending.clarifications[0]?.state === "published" ? mid.pending.clarifications[0]?.identity : undefined)
      .toBeUndefined();

    const recovered = await publishClarificationQuestion({
      store,
      pending,
      repository: store.repositoryBinding,
      publicRepositoryDigest: publicDigest,
      writer: recoveringWriter(log, posted),
    });
    expect(log).toHaveLength(1);
    expect(recovered.pending.state).toBe("published");
    expect((await store.readContextSnapshot()).pending.clarifications).toHaveLength(1);
    expect((await store.readContextSnapshot()).pending.clarifications[0]?.identity?.commentId).toBe("q-1");
  });

  it("publishes once when two callers share one state root", async () => {
    const root = await stateRoot();
    const first = await preparedQuestion(root);
    const second = storeFor(root);
    const log: string[] = [];
    const posted = new Map<string, ConversationItemIdentity>();
    const release = Promise.withResolvers<void>();
    const ready: Array<PromiseWithResolvers<void>> = [];
    const pause = async () => {
      const gate = Promise.withResolvers<void>();
      ready.push(gate);
      gate.resolve();
      await release.promise;
    };
    const runs = Promise.all([
      publishClarificationQuestion({
        store: first.store,
        pending: first.pending,
        repository: first.store.repositoryBinding,
        publicRepositoryDigest: publicDigest,
        writer: recoveringWriter(log, posted),
        hooks: { beforePublication: pause },
      }),
      publishClarificationQuestion({
        store: second,
        pending: first.pending,
        repository: second.repositoryBinding,
        publicRepositoryDigest: publicDigest,
        writer: recoveringWriter(log, posted),
        hooks: { beforePublication: pause },
      }),
    ]);
    await vi.waitFor(() => expect(ready).toHaveLength(2), { timeout: 10_000 });
    release.resolve();
    await runs;
    expect(log).toHaveLength(1);
    const snapshot = await first.store.readContextSnapshot();
    expect(snapshot.pending.clarifications).toHaveLength(1);
    expect(snapshot.pending.clarifications[0]?.state).toBe("published");
    expect(snapshot.pending.clarifications[0]?.identity).toBeDefined();
    expect(clarificationQuestionIdentity({
      repository: first.store.repositoryBinding,
      reviewNumber: 7,
      headSha: BINDING.headSha,
      clarificationId: first.pending.id,
    }).actionId).toMatch(/^action_[0-9a-f]{32}$/u);
    expect(typeof executePublication).toBe("function");
  });
});

describe("confirmed clarification finding graph", () => {
  it("builds inline and fallback children and ledgers the confirmed finding", async () => {
    const { prepareReviewFindingPublication } = await import("../../../src/review/review-publication.js");
    const { orchestrate } = await import("../../../src/review/orchestrate.js");
    const { reviewPublicationIdentity } = await import("../../../src/conversation/publication-manifest.js");
    const confirmed = finding({
      file: "src/a.ts",
      line: 2,
      message: "Tokens must not be logged after the answer.",
      decision: "still-valid",
      question: undefined,
      title: "Do not log tokens",
    });
    const orchestration = orchestrate({
      findings: [confirmed],
      rulesRun: ["rule-a"],
      rulesFailed: [],
    }, [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " context",
      "+added",
      " keep",
    ].join("\n"), { inline: true });
    expect(orchestration.inlineComments).toHaveLength(1);
    const identity = reviewPublicationIdentity({
      repository: { provider: "github", repositoryDigest: publicDigest },
      reviewNumber: 7,
      headSha: BINDING.headSha,
      configHash: "abc123",
    });
    const prepared = prepareReviewFindingPublication({
      publicationIdentity: identity,
      orchestration,
      storeBinding: { provider: "github", repositoryDigest: publicDigest },
      reviewNumber: 7,
      reviewId: "PR_7",
      baseSha: "b".repeat(40),
      headSha: BINDING.headSha,
      rules: [{ name: "rule-a", body: "rule body" }],
      reviewOptions: {
        advisor: "on",
        suggestions: "off",
        disableBuiltinRule: false,
        trustLocalRules: false,
        rulesDir: ".review/rules",
        dispatch: "direct",
      },
      now: "2026-08-14T00:00:00.000Z",
      publicRepositoryDigest: publicDigest,
      configHash: "abc123",
      summaryBody: orchestration.commentBody,
    });
    expect(prepared.children.some((child) => child.kind === "inline")).toBe(true);
    expect(prepared.children.some((child) => child.kind === "fallback")).toBe(true);
    expect(prepared.preparedFindings).toHaveLength(1);
    expect(prepared.preparedFindings[0]?.finding.decision).toBe("still-valid");
    expect(prepared.preparedFindings[0]?.finding.decision).not.toBe("needs-clarification");
    expect(prepared.preparedFindings[0]?.finding.message).toBe(confirmed.message);
  });
});

// Issue #38 / PR #39 review: a finding that goes through the ledger comes back
// out to be rendered, so any field the snapshot cannot represent is silently
// lost between asking a clarifying question and publishing the confirmed
// finding. `effort` was the only field on Finding without a counterpart here.
describe("effort survives persistence", () => {
  it("keeps the estimate through the clarification snapshot", () => {
    const snapshot = toClarificationFindingSnapshot(
      finding({ message: "unclear", effort: "heavy" }),
    );

    expect(snapshot.effort).toBe("heavy");
  });

  it("keeps the estimate through the publication snapshot", () => {
    expect(toFindingSnapshot(finding({ message: "unclear", effort: "quick" })).effort).toBe("quick");
  });

  it("leaves a finding without an estimate untouched", () => {
    expect(toClarificationFindingSnapshot(finding({ message: "unclear" }))).not.toHaveProperty("effort");
    expect(toFindingSnapshot(finding({ message: "unclear" }))).not.toHaveProperty("effort");
  });

  // The persisted form is validated strictly on read-back: an unknown key is an
  // integrity failure, so the schema has to KNOW about effort, not merely
  // tolerate it.
  it("round-trips the estimate through the strict pending schema", () => {
    const prepared = createPreparedClarification({
      id: encodeClarificationPublicId(createHash("sha256").update("effort-a").digest()),
      reviewNumber: 7,
      headSha: BINDING.headSha,
      question: "Is this intended?",
      createdAt: "2026-08-14T00:00:00.000Z",
      finding: finding({ message: "unclear", effort: "heavy" }),
    });
    const repository = { provider: "github" as const, repositoryDigest: BINDING.repositoryDigest };
    const pending = { version: 1, repository, clarifications: [prepared], directions: [] };

    const validated = validatePendingSnapshot(pending, repository);

    expect(validated.clarifications[0]?.finding.effort).toBe("heavy");
  });

  // Unlike reviewer OUTPUT — where an unrecognized value is dropped so the
  // finding still posts — state we wrote ourselves is strictly validated. A
  // bad value here means the ledger is corrupt, not that a model was sloppy.
  it("rejects a persisted estimate outside the contract", () => {
    const prepared = createPreparedClarification({
      id: encodeClarificationPublicId(createHash("sha256").update("effort-b").digest()),
      reviewNumber: 7,
      headSha: BINDING.headSha,
      question: "Is this intended?",
      createdAt: "2026-08-14T00:00:00.000Z",
      finding: finding({ message: "unclear" }),
    });
    const repository = { provider: "github" as const, repositoryDigest: BINDING.repositoryDigest };
    const corrupt = {
      version: 1,
      repository,
      clarifications: [{ ...prepared, finding: { ...prepared.finding, effort: "medium" } }],
      directions: [],
    };

    expect(() => validatePendingSnapshot(corrupt, repository)).toThrow(/effort/i);
  });
});


// Issue #43: `text()` requires trimmed values, which is right for a title or a
// category and wrong for a suggestion — a suggestion carries the file's
// indentation, and rejecting it here would make a suggestion that PARSES fail
// to persist. The relaxation is scoped to that one field.
describe("persisted suggestions keep their indentation", () => {
  const repository = { provider: "github" as const, repositoryDigest: "a".repeat(64) };

  const persist = (overrides: Partial<Finding>) => {
    const prepared = createPreparedClarification({
      id: encodeClarificationPublicId(createHash("sha256").update("indent").digest()),
      reviewNumber: 7,
      headSha: BINDING.headSha,
      question: "Is this intended?",
      createdAt: "2026-08-24T00:00:00.000Z",
      finding: finding({ message: "unclear", ...overrides }),
    });
    return () => validatePendingSnapshot(
      { version: 1, repository, clarifications: [prepared], directions: [] },
      repository,
    );
  };

  it("round-trips an indented suggestion", () => {
    const suggestion = "\tif stale(entry) {\n\t\treturn revalidate(ctx)\n\t}";

    expect(persist({ suggestion })().clarifications[0]?.finding.suggestion).toBe(suggestion);
  });

  // The scope of the change: everything else still has to be trimmed, or an
  // untrimmed title would render with stray whitespace in the comment body.
  it("still requires a trimmed title", () => {
    expect(persist({ title: "  Off by one." })).toThrow(/normalized/i);
  });

  it("still requires a trimmed message", () => {
    expect(persist({ message: "Off by one.  " })).toThrow(/normalized/i);
  });
});
