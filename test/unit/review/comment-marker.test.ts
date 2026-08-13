import { describe, expect, it } from "vitest";
import {
  deriveInlineChildId,
  formatPendingMarker,
  parseBotMarker,
  replacePendingMarker,
} from "../../../src/review/comment-marker.js";

describe("parseBotMarker", () => {
  it("parses a trailing marker with SHA and config", () => {
    expect(parseBotMarker("<!-- tgd-review-agent:sha=abc1234 cfg=deadbeef -->"))
      .toEqual({ lastReviewedSha: "abc1234", reviewedConfig: "deadbeef" });
  });

  it("recognizes an explicit pending marker without treating it as complete", () => {
    expect(parseBotMarker("summary\n\n<!-- tgd-review-agent:pending -->"))
      .toEqual({ lastReviewedSha: "", reviewedConfig: "" });
  });

  it("round-trips a ready recovery marker bound to SHA, config, and note identity", () => {
    const marker = formatPendingMarker({
      phase: "ready",
      headSha: "abc1234",
      configHash: "deadbeef",
      noteId: "note-777",
      terminalResult: {
        status: "partial",
        findingsCount: 3,
        rulesRun: ["rule-a"],
        rulesFailed: ["rule-b"],
        loadErrors: ["/rules/bad.md: missing model"],
        exitCode: 2,
      },
    });
    expect(parseBotMarker(`summary\n\n${marker}`)).toEqual({
      lastReviewedSha: "",
      reviewedConfig: "",
      pendingState: {
        phase: "ready",
        headSha: "abc1234",
        configHash: "deadbeef",
        noteId: "note-777",
        terminalResult: {
          status: "partial",
          findingsCount: 3,
          rulesRun: ["rule-a"],
          rulesFailed: ["rule-b"],
          loadErrors: ["/rules/bad.md: missing model"],
          exitCode: 2,
        },
      },
    });
    expect(replacePendingMarker(`summary\n\n${marker}`, "<!-- complete -->"))
      .toBe("summary\n\n<!-- complete -->");
  });

  it("round-trips exact child recovery bindings and rejects unknown child properties", () => {
    const parentId = `act_${"a".repeat(32)}`;
    const contentDigest = "d".repeat(64);
    const placementDigest = "f".repeat(64);
    const childBase = { clientId: "finding-0", kind: "finding" as const, parentId,
      childId: deriveInlineChildId(parentId, "finding-0", contentDigest, placementDigest), repositoryDigest: "c".repeat(64), reviewNumber: 42,
      contentDigest, headSha: "e".repeat(40), placementDigest };
    const child = { ...childBase, marker: `<!-- tgd-inline-child:v=3;kind=finding;parent=${childBase.parentId};child=${childBase.childId};repo=${childBase.repositoryDigest};review=42;content=${childBase.contentDigest};head=${childBase.headSha};placement=${childBase.placementDigest} -->` };
    const state = { phase: "ambiguous" as const, headSha: "e".repeat(40), configHash: "cfg", noteId: "note-1",
      terminalResult: { status: "posted" as const, findingsCount: 1, rulesRun: ["rule"], rulesFailed: [], exitCode: 0 as const },
      inlineRecovery: { children: [child], noFallbackBody: "summary" } };
    expect(parseBotMarker(formatPendingMarker(state))?.pendingState?.inlineRecovery).toEqual(state.inlineRecovery);
    expect(() => formatPendingMarker({ ...state, inlineRecovery: { children: [{ ...child, extra: true }], noFallbackBody: "summary" } } as never)).toThrow(/recovery/i);
  });

  it("rejects tampered derived child IDs and duplicate semantic marker bindings", () => {
    const parentId = `act_${"a".repeat(32)}`;
    const contentDigest = "d".repeat(64);
    const placementDigest = "f".repeat(64);
    const make = (clientId: string) => {
      const childId = deriveInlineChildId(parentId, clientId, contentDigest, placementDigest);
      const base = { clientId, kind: "finding" as const, parentId, childId, repositoryDigest: "c".repeat(64), reviewNumber: 42, contentDigest, headSha: "e".repeat(40), placementDigest };
      return { ...base, marker: `<!-- tgd-inline-child:v=3;kind=finding;parent=${parentId};child=${childId};repo=${base.repositoryDigest};review=42;content=${contentDigest};head=${base.headSha};placement=${placementDigest} -->` };
    };
    const terminalResult = { status: "posted" as const, findingsCount: 2, rulesRun: ["rule"], rulesFailed: [], exitCode: 0 as const };
    const state = (children: unknown[]) => ({ phase: "ambiguous" as const, headSha: "e".repeat(40), configHash: "cfg", noteId: "note", terminalResult,
      inlineRecovery: { children, noFallbackBody: "summary" } });
    expect(() => formatPendingMarker(state([{ ...make("finding-0"), childId: `finding_${"0".repeat(32)}` }]) as never)).toThrow(/recovery/i);
    const first = make("finding-0");
    expect(() => formatPendingMarker(state([first, { ...make("finding-1"), childId: first.childId, marker: first.marker }]) as never)).toThrow(/recovery/i);
    expect(() => formatPendingMarker(state([first, { ...make("finding-1"), marker: first.marker }]) as never)).toThrow(/recovery/i);
    expect(() => formatPendingMarker(state([first, make("finding-1")]) as never)).toThrow(/duplicate child binding/i);
  });

  it("accepts 65 rules and rule names longer than 128 characters", () => {
    const longRule = "long-rule-" + "x".repeat(256);
    const rulesRun = Array.from({ length: 65 }, (_, index) => `rule-${index}`);
    rulesRun.push(longRule);
    const marker = formatPendingMarker({
      phase: "ready",
      headSha: "abc1234",
      configHash: "deadbeef",
      noteId: "note-777",
      terminalResult: {
        status: "posted",
        findingsCount: 0,
        rulesRun,
        rulesFailed: [],
        exitCode: 0,
      },
    });

    expect(parseBotMarker(marker)?.pendingState?.terminalResult?.rulesRun)
      .toEqual(rulesRun);
  });

  it("accepts the 32 KiB encoded boundary and rejects the next larger encoding", () => {
    const encodedLength = (name: string) =>
      Buffer.from(JSON.stringify({
        status: "posted",
        findingsCount: 0,
        rulesRun: [name],
        rulesFailed: [],
        exitCode: 0,
      }), "utf8").toString("base64url").length;
    let low = 1;
    let high = 32_768;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (encodedLength("x".repeat(middle)) < 32_768) low = middle + 1;
      else high = middle;
    }
    const boundaryName = "x".repeat(low);
    expect(encodedLength(boundaryName)).toBe(32_768);
    let oversizedName = boundaryName + "x";
    while (encodedLength(oversizedName) <= 32_768) oversizedName += "x";

    const makeMarker = (ruleName: string) => formatPendingMarker({
      phase: "ready",
      headSha: "abc1234",
      configHash: "deadbeef",
      noteId: "note-777",
      terminalResult: {
        status: "posted",
        findingsCount: 0,
        rulesRun: [ruleName],
        rulesFailed: [],
        exitCode: 0,
      },
    });

    expect(() => makeMarker(boundaryName)).not.toThrow();
    expect(() => makeMarker(oversizedName)).toThrow(/too large/i);
  });

  it.each([
    ["unknown version", "v2.eyJzdGF0dXMiOiJwb3N0ZWQifQ"],
    ["malformed payload", "v1.not-base64!"],
    ["oversized payload", `v1.${"a".repeat(32_769)}`],
  ])("rejects %s terminal result encoding", (_label, result) => {
    const body = "summary\n\n" +
      `<!-- tgd-review-agent:pending phase=ready sha=abc1234 cfg=deadbeef note=note-777 result=${result} -->`;
    expect(parseBotMarker(body)).toEqual({
      lastReviewedSha: "",
      reviewedConfig: "",
      invalidPendingState: true,
    });
  });

  it("distinguishes an own malformed trailing marker from no marker", () => {
    expect(parseBotMarker("<!-- tgd-review-agent:sha=malformed -->"))
      .toEqual({ lastReviewedSha: "", reviewedConfig: "" });
  });

  it("does not accept a non-trailing marker", () => {
    expect(parseBotMarker("prefix <!-- tgd-review-agent:sha=abc1234 --> trailing"))
      .toEqual({ lastReviewedSha: "", reviewedConfig: "" });
  });

  it("returns null for an ordinary note", () => {
    expect(parseBotMarker("ordinary human note")).toBeNull();
  });
});
