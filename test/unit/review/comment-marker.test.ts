import { describe, expect, it } from "vitest";
import {
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
          exitCode: 2,
        },
      },
    });
    expect(replacePendingMarker(`summary\n\n${marker}`, "<!-- complete -->"))
      .toBe("summary\n\n<!-- complete -->");
  });

  it.each([
    "v2.eyJzdGF0dXMiOiJwb3N0ZWQifQ",
    "v1.not-base64!",
    `v1.${"a".repeat(3000)}`,
  ])("rejects unknown, malformed, or oversized terminal result encoding %s", (result) => {
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
