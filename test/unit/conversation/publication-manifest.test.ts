import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completePublication,
  executePublication,
  freezePublication,
  loadPublicationAction,
  observePublication,
  preparePublication,
  startPublication,
  supersedePublication,
  supersedeWithSuccessor,
  updatePublicationChild,
  type PublicationAction,
  type PublicationChild,
  type PublicationWriter,
} from "../../../src/conversation/publication-manifest.js";
import { computeContentDigest } from "../../../src/conversation/markers.js";
import {
  createConversationStateStore,
  type ConversationStateStore,
} from "../../../src/conversation/state-store.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import type { ConversationItemIdentity } from "../../../src/conversation/types.js";

const HEX32 = "1".repeat(32);
const ACTION_ID = `action_${HEX32}`;
const IDENTITY = "a".repeat(64);
const BINDING = { provider: "github" as const, repositoryDigest: "b".repeat(64) };
const REPO = parseRepositoryRef("acme/app", "github");
const temporaryDirectories: string[] = [];
const testProcessInspector = {
  current: async () => ({ pid: 100, hostname: "unit-test-host", startIdentity: "unit-test-start" }),
  inspect: async () => ({ status: "unknown" as const }),
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function digestOf(body: string): string {
  return computeContentDigest(body);
}

function child(overrides: Partial<PublicationChild> & Pick<PublicationChild, "id" | "kind">): PublicationChild {
  const body = overrides.body ?? `${overrides.kind} body ${overrides.id}`;
  return {
    body,
    bodyDigest: overrides.bodyDigest ?? digestOf(body),
    marker: overrides.marker ?? `<!-- tgd-pub:${overrides.id} -->`,
    placement: overrides.placement ?? (
      overrides.kind === "inline"
        ? { kind: "inline", file: "src/a.ts", line: 2, clientId: overrides.id }
        : overrides.kind === "fallback"
          ? { kind: "fallback" }
          : overrides.kind === "group-reply"
            ? { kind: "group-reply" }
            : overrides.kind === "general-question"
              ? { kind: "general-question" }
              : { kind: "summary" }
    ),
    status: overrides.status ?? "pending",
    ...overrides,
    body,
    bodyDigest: overrides.bodyDigest ?? digestOf(overrides.body ?? `${overrides.kind} body ${overrides.id}`),
  };
}

function graph(): PublicationChild[] {
  const inlines = [0, 1, 2].map((index) => child({
    id: `finding_${index.toString(16).padStart(32, "0")}`,
    kind: "inline",
    body: `inline ${index}`,
    placement: { kind: "inline", file: "src/a.ts", line: index + 1, clientId: `finding-${index}` },
  }));
  return [
    child({ id: `output_${"0".repeat(32)}`, kind: "summary", body: "summary grouping" }),
    ...inlines,
    ...inlines.map((inline, index) => child({
      id: `output_${(index + 1).toString(16).padStart(32, "0")}`,
      kind: "fallback",
      body: `fallback ${index}`,
      replacesId: inline.id,
      placement: { kind: "fallback" },
    })),
  ];
}

function action(state: PublicationAction["state"], children: readonly PublicationChild[] = []): PublicationAction {
  return {
    actionId: ACTION_ID,
    identityDigest: IDENTITY,
    reviewNumber: 42,
    repository: BINDING,
    state,
    successorActionId: null,
    children,
  };
}

describe("publication manifest state machine", () => {
  test("advances observed → prepared → manifest-ready → published → completed", () => {
    const observed = observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    });
    expect(observed.state).toBe("observed");
    expect(observed.children).toEqual([]);

    const prepared = preparePublication(observed);
    expect(prepared.state).toBe("prepared");
    expect(prepared.children).toEqual([]);

    const frozen = freezePublication(prepared, graph());
    expect(frozen.state).toBe("manifest-ready");
    expect(frozen.children).toHaveLength(7);
    expect(frozen.children.every((entry) => entry.status === "pending")).toBe(true);

    const published = startPublication(frozen);
    expect(published.state).toBe("published");

    let current = published;
    for (const entry of published.children) {
      if (entry.kind === "fallback") {
        current = updatePublicationChild(current, entry.id, { status: "failed" });
      } else {
        current = updatePublicationChild(current, entry.id, {
          status: "posted",
          identity: {
            provider: "github",
            commentId: entry.id.slice(0, 16),
            url: `https://github.com/acme/app/pull/42#issuecomment-${entry.id.slice(0, 16)}`,
          },
        });
      }
    }
    const completed = completePublication(current);
    expect(completed.state).toBe("completed");
    expect(completed.children.filter((entry) => entry.kind !== "fallback").every((entry) => entry.status === "posted")).toBe(true);
  });

  test("allows prepared → superseded with a successor action", () => {
    const prepared = preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    }));
    const successorId = `action_${"2".repeat(32)}`;
    const superseded = supersedePublication(prepared, successorId);
    expect(superseded.state).toBe("superseded");
    expect(superseded.successorActionId).toBe(successorId);
    expect(superseded.children).toEqual([]);
  });

  test("creates a prepared successor bound to a new identity", () => {
    const prepared = preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    }));
    const pair = supersedeWithSuccessor(prepared, {
      actionId: `action_${"2".repeat(32)}`,
      identityDigest: IDENTITY,
    });
    expect(pair.superseded.state).toBe("superseded");
    expect(pair.superseded.successorActionId).toBe(pair.successor.actionId);
    expect(pair.successor.state).toBe("prepared");
    expect(pair.successor.actionId).not.toBe(prepared.actionId);
    expect(pair.successor.identityDigest).toBe(IDENTITY);
    expect(pair.successor.children).toEqual([]);
  });

  test("rejects skipped states", () => {
    const observed = observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    });
    expect(() => freezePublication(observed, graph())).toThrow(/transition/i);
    expect(() => startPublication(observed)).toThrow(/transition/i);
    expect(() => completePublication(observed)).toThrow(/transition/i);
    expect(() => startPublication(preparePublication(observed))).toThrow(/transition/i);
    expect(() => completePublication(freezePublication(preparePublication(observed), graph()))).toThrow(/transition/i);
  });

  test("rejects body changes after freeze", () => {
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), graph());
    const published = startPublication(frozen);
    expect(() => updatePublicationChild(published, frozen.children[0]!.id, {
      status: "posted",
      body: "changed after freeze",
    } as never)).toThrow(/body|immutable|freeze/i);
    expect(() => completePublication({
      ...published,
      children: published.children.map((entry, index) => ({
        ...entry,
        status: index === 0 ? "posted" : entry.status,
        ...(index === 0 ? { body: "mutated summary" } : {}),
      })),
    })).toThrow(/body|immutable|freeze|digest/i);
  });

  test("rejects duplicate child IDs and markers at freeze", () => {
    const prepared = preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    }));
    const first = child({ id: `output_${"3".repeat(32)}`, kind: "summary" });
    expect(() => freezePublication(prepared, [first, { ...first, kind: "fallback", placement: { kind: "fallback" } }]))
      .toThrow(/duplicate/i);
    expect(() => freezePublication(prepared, [
      first,
      child({ id: `output_${"4".repeat(32)}`, kind: "inline", marker: first.marker }),
    ])).toThrow(/duplicate/i);
  });

  test("rejects a provider identity mismatch", () => {
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), graph());
    expect(() => updatePublicationChild(startPublication(frozen), frozen.children[0]!.id, {
      status: "posted",
      identity: {
        provider: "gitlab",
        commentId: "note-1",
        url: "https://gitlab.com/acme/app/-/merge_requests/42#note_1",
      },
    })).toThrow(/provider|identity/i);
  });

  test("rejects completion while a child lacks terminal posted/fallback state", () => {
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), graph());
    const published = startPublication(frozen);
    expect(() => completePublication(published)).toThrow(/terminal|pending|fallback/i);
    const onlySummary = updatePublicationChild(published, frozen.children[0]!.id, {
      status: "posted",
      identity: {
        provider: "github",
        commentId: "summary-1",
        url: "https://github.com/acme/app/pull/42#issuecomment-summary-1",
      },
    });
    expect(() => completePublication(onlySummary)).toThrow(/terminal|pending|fallback/i);
  });
});

async function stateRoot(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-publication-")));
  temporaryDirectories.push(directory);
  return path.join(directory, "state");
}

function createStore(root: string): ConversationStateStore {
  return createConversationStateStore({
    root,
    repository: REPO,
    dependencies: { processInspector: testProcessInspector },
  });
}

function postedIdentity(child: PublicationChild, commentId: string): ConversationItemIdentity {
  return {
    provider: "github",
    commentId,
    url: `https://github.com/acme/app/pull/42#issuecomment-${commentId}`,
  };
}

function sequentialWriter(log: string[], posted: Map<string, ConversationItemIdentity>): PublicationWriter {
  return {
    async lookupChild(entry) {
      return posted.get(entry.marker) ?? null;
    },
    async writeChild(entry) {
      log.push(entry.marker);
      const identity = postedIdentity(entry, createHash("sha256").update(entry.marker).digest("hex").slice(0, 12));
      posted.set(entry.marker, identity);
      return { status: "posted", identity };
    },
  };
}

describe("publication crash-matrix recovery", () => {
  test("rebuilds from a frozen graph without a model callback and writes only missing children", async () => {
    const children = graph().slice(0, 4);
    const model = vi.fn(() => children);
    const prepared = preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    }));
    const frozen = freezePublication(prepared, model());
    expect(model).toHaveBeenCalledTimes(1);

    const crashPoints = [0, 1, 2, 3, 4];
    for (const crashAfter of crashPoints) {
      const store = createStore(await stateRoot());
      const written: string[] = [];
      const posted = new Map<string, ConversationItemIdentity>();
      const writer = sequentialWriter(written, posted);
      if (crashAfter === 0) {
        await expect(executePublication({
          store,
          action: frozen,
          writer,
          hooks: { beforeChildWrite: async () => { throw new Error("crash before first write"); } },
        })).rejects.toThrow(/crash before first write/);
        expect(written).toEqual([]);
      } else {
        let seen = 0;
        await expect(executePublication({
          store,
          action: frozen,
          writer,
          hooks: {
            afterChildWrite: async () => {
              seen += 1;
              if (seen === crashAfter) throw new Error(`crash after child ${crashAfter}`);
            },
          },
        })).rejects.toThrow(new RegExp(`crash after child ${crashAfter}`));
        expect(written).toHaveLength(crashAfter);
      }

      const recoveredWrites: string[] = [];
      const recovered = sequentialWriter(recoveredWrites, posted);
      const modelOnRecovery = vi.fn();
      const result = await executePublication({
        store,
        action: frozen,
        writer: recovered,
        hooks: { onModelWork: modelOnRecovery },
      });
      expect(modelOnRecovery).not.toHaveBeenCalled();
      expect(recoveredWrites).toEqual(children.slice(crashAfter).map((entry) => entry.marker));
      expect(result.state).toBe("completed");
      expect(result.children.every((entry) => entry.status === "posted")).toBe(true);
      expect(result.children.every((entry) => entry.identity !== undefined)).toBe(true);
    }
  });

  // The matrix above stops at the inline children. A real multi-output review
  // also freezes a fallback per inline, and those are the children most likely
  // to be mid-flight when something dies: they are written last, after the
  // inline they replace has already failed. Crash at every point in the write
  // sequence, for both providers' strategies.
  test.each(["github-atomic", "gitlab-selective"] as const)(
    "recovers a full group/inline/fallback graph after a crash at any child (%s)",
    async (strategy) => {
      const children = graph();
      const frozen = freezePublication(preparePublication(observePublication({
        actionId: ACTION_ID,
        identityDigest: IDENTITY,
        reviewNumber: 42,
        repository: BINDING,
      })), children);

      // Every inline fails, so every fallback is genuinely exercised.
      // The crash comes from a hook, not the writer: a writer that throws is
      // reported as a failed child, which is a different scenario entirely.
      const writerFor = (written: string[]) => ({
        async lookupChild() { return null; },
        async writeChild(entry: PublicationChild): Promise<PublicationWriteResult> {
          written.push(entry.id);
          if (entry.kind === "inline") return { status: "failed" as const };
          if (entry.kind === "fallback") return { status: "fallback-selected" as const };
          return { status: "posted" as const, identity: postedIdentity(entry, entry.id.slice(0, 12)) };
        },
      });
      const crashAt = (crashAfter: number) => {
        let seen = 0;
        return async () => {
          seen += 1;
          if (seen === crashAfter) throw new Error(`crash after child ${crashAfter}`);
        };
      };

      // The strategies batch differently — one writes its inlines as a single
      // atomic call — so the number of interruptible points is a property of
      // the strategy, not of the graph. Measure it, then crash at each one.
      let checkpoints = 0;
      const baseline = await executePublication({
        store: createStore(await stateRoot()),
        action: frozen,
        strategy,
        writer: writerFor([]),
        hooks: { afterChildWrite: async () => { checkpoints += 1; } },
      });
      expect(baseline.state).toBe("completed");
      expect(checkpoints).toBeGreaterThan(1);

      for (let crashAfter = 1; crashAfter <= checkpoints; crashAfter += 1) {
        const store = createStore(await stateRoot());
        await expect(executePublication({
          store,
          action: frozen,
          strategy,
          writer: writerFor([]),
          hooks: { afterChildWrite: crashAt(crashAfter) },
        })).rejects.toThrow(new RegExp(`crash after child ${crashAfter}`));

        const modelOnRecovery = vi.fn();
        const result = await executePublication({
          store,
          action: frozen,
          strategy,
          writer: writerFor([]),
          hooks: { onModelWork: modelOnRecovery },
        });

        // Recovery replays the frozen graph exactly: no regeneration, every
        // body byte-identical, and every child terminal so it can complete.
        expect(modelOnRecovery).not.toHaveBeenCalled();
        expect(result.state).toBe("completed");
        expect(result.children.map((entry) => entry.id)).toEqual(children.map((entry) => entry.id));
        expect(result.children.map((entry) => entry.body)).toEqual(children.map((entry) => entry.body));
        expect(result.children.filter((entry) => entry.kind === "fallback")
          .every((entry) => entry.status === "fallback-selected")).toBe(true);
      }
    },
  );

  test("GitHub atomic-inline fallback selects every fallback without rewriting posted markers", async () => {
    const store = createStore(await stateRoot());
    const children = graph();
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), children);
    const writes: string[] = [];
    const result = await executePublication({
      store,
      action: frozen,
      strategy: "github-atomic",
      writer: {
        async lookupChild() { return null; },
        async writeChild(entry) {
          writes.push(`${entry.kind}:${entry.id}`);
          if (entry.kind === "inline") throw new Error("atomic inline rejected");
          return {
            status: entry.kind === "fallback" ? "fallback-selected" : "posted",
            identity: entry.kind === "summary"
              ? postedIdentity(entry, "summary")
              : undefined,
          };
        },
      },
    });
    expect(writes.some((entry) => entry.startsWith("inline:"))).toBe(true);
    expect(result.children.filter((entry) => entry.kind === "inline").every((entry) => entry.status === "failed")).toBe(true);
    expect(result.children.filter((entry) => entry.kind === "fallback").every((entry) => entry.status === "fallback-selected")).toBe(true);
    expect(result.children.find((entry) => entry.kind === "summary")?.status).toBe("posted");
    expect(result.state).toBe("completed");
  });

  test("GitLab selective fallback writes only failed inlines into the summary", async () => {
    const store = createStore(await stateRoot());
    const children = graph();
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), children);
    const result = await executePublication({
      store,
      action: frozen,
      strategy: "gitlab-selective",
      writer: {
        async lookupChild() { return null; },
        async writeChild(entry) {
          if (entry.kind === "inline" && entry.placement.kind === "inline" && entry.placement.clientId === "finding-1") {
            return { status: "failed" };
          }
          return {
            status: entry.kind === "fallback" ? "fallback-selected" : "posted",
            identity: entry.kind === "fallback" ? undefined : postedIdentity(entry, entry.id.slice(0, 12)),
          };
        },
      },
    });
    const inlines = result.children.filter((entry) => entry.kind === "inline");
    expect(inlines.map((entry) => entry.status)).toEqual(["posted", "failed", "posted"]);
    const fallbacks = result.children.filter((entry) => entry.kind === "fallback");
    expect(fallbacks.map((entry) => entry.status)).toEqual(["failed", "fallback-selected", "failed"]);
    expect(result.state).toBe("completed");
  });

  test("keeps the frozen graph after a crash between complete persist and summary finalize", async () => {
    const store = createStore(await stateRoot());
    const children = graph();
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), children);
    const written: string[] = [];
    const posted = new Map<string, ConversationItemIdentity>();
    await expect(executePublication({
      store,
      action: frozen,
      strategy: "gitlab-selective",
      writer: {
        async lookupChild(entry) {
          return posted.get(entry.marker) ?? null;
        },
        async writeChild(entry) {
          written.push(entry.marker);
          if (entry.kind === "inline" && entry.placement.kind === "inline" && entry.placement.clientId === "finding-1") {
            return { status: "failed" };
          }
          const identity = postedIdentity(entry, createHash("sha256").update(entry.marker).digest("hex").slice(0, 12));
          posted.set(entry.marker, identity);
          return { status: "posted", identity };
        },
      },
      hooks: {
        afterPublication: async () => {
          throw new Error("crash after complete persist before summary rewrite");
        },
      },
    })).rejects.toThrow(/crash after complete persist before summary rewrite/);

    const snapshot = await store.readContextSnapshot();
    const retained = loadPublicationAction(snapshot.events, {
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
    });
    expect(retained?.state).toBe("published");
    expect(retained?.children).toHaveLength(children.length);
    expect(retained?.children.every((entry) => entry.status !== "pending")).toBe(true);
    expect(retained?.children.filter((entry) => entry.kind === "inline").map((entry) => entry.status))
      .toEqual(["posted", "failed", "posted"]);
    expect(retained?.children.filter((entry) => entry.kind === "fallback").map((entry) => entry.status))
      .toEqual(["failed", "fallback-selected", "failed"]);
    expect(await store.findTerminalAction({ actionId: ACTION_ID, identityDigest: IDENTITY }))
      .toBeUndefined();

    const recoveredWrites: string[] = [];
    const modelOnRecovery = vi.fn();
    const result = await executePublication({
      store,
      action: frozen,
      strategy: "gitlab-selective",
      writer: {
        async lookupChild(entry) {
          return posted.get(entry.marker) ?? null;
        },
        async writeChild(entry) {
          recoveredWrites.push(entry.marker);
          throw new Error(`duplicate write of ${entry.kind}`);
        },
      },
      hooks: { onModelWork: modelOnRecovery },
    });
    expect(modelOnRecovery).not.toHaveBeenCalled();
    expect(recoveredWrites).toEqual([]);
    expect(result.state).toBe("completed");
    expect(result.children.filter((entry) => entry.kind === "inline").map((entry) => entry.status))
      .toEqual(["posted", "failed", "posted"]);
    expect(result.children.filter((entry) => entry.kind === "fallback").map((entry) => entry.status))
      .toEqual(["failed", "fallback-selected", "failed"]);
  });
});

describe("concurrent publication lock", () => {
  test("two executors paused before publication write one child per marker", async () => {
    const store = createStore(await stateRoot());
    const children = graph().slice(0, 4);
    const frozen = freezePublication(preparePublication(observePublication({
      actionId: ACTION_ID,
      identityDigest: IDENTITY,
      reviewNumber: 42,
      repository: BINDING,
    })), children);
    const release = Promise.withResolvers<void>();
    const entered: Array<PromiseWithResolvers<void>> = [];
    const writes: string[] = [];
    const posted = new Map<string, ConversationItemIdentity>();

    const run = async () => executePublication({
      store,
      action: frozen,
      writer: {
        async lookupChild(entry) {
          return posted.get(entry.marker) ?? null;
        },
        async writeChild(entry) {
          writes.push(entry.marker);
          const identity = postedIdentity(entry, createHash("sha256").update(entry.marker).digest("hex").slice(0, 12));
          posted.set(entry.marker, identity);
          return { status: "posted", identity };
        },
      },
      hooks: {
        beforePublication: async () => {
          const gate = Promise.withResolvers<void>();
          entered.push(gate);
          gate.resolve();
          await release.promise;
        },
      },
    });

    const first = run();
    const second = run();
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    release.resolve();
    const [left, right] = await Promise.all([first, second]);
    expect(new Set(writes).size).toBe(children.length);
    expect(writes).toHaveLength(children.length);
    expect(left.state).toBe("completed");
    expect(right.state).toBe("completed");
    expect(left.children.map((entry) => entry.marker)).toEqual(right.children.map((entry) => entry.marker));
  });
});
