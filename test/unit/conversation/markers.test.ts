import { describe, expect, it } from "vitest";
import {
  CHILD_MARKER_GRAMMAR,
  CHILD_MARKER_VERSION,
  STABLE_CONVERSATION_ID_GRAMMAR,
  computeContentDigest,
  computeRepositoryDigest,
  formatChildMarker,
  parseChildMarker,
  verifyChildMarkerBinding,
} from "../../../src/conversation/markers.js";

const HEX_ID = "1".repeat(32);
const markerInput = {
  kind: "action" as const,
  parentId: `act_${HEX_ID}`,
  childId: `out_${"2".repeat(32)}`,
  repositoryDigest: "a".repeat(64),
  reviewNumber: 42,
  contentDigest: "b".repeat(64),
};

describe("conversation child markers", () => {
  it("round trips a canonical marker exactly", () => {
    const marker = formatChildMarker(markerInput);

    expect(marker).toBe(`<!-- tgd-child:v=1;kind=action;parent=act_${HEX_ID};child=out_${"2".repeat(32)};repo=${"a".repeat(64)};review=42;content=${"b".repeat(64)} -->`);
    expect(parseChildMarker(marker)).toEqual({ version: 1, ...markerInput });
    expect(parseChildMarker(marker)?.childId).toBe(`out_${"2".repeat(32)}`);
    expect(formatChildMarker(parseChildMarker(marker)!)).toBe(marker);
  });

  it("publishes the exact version and stable ID/marker grammar", () => {
    expect(CHILD_MARKER_VERSION).toBe(1);
    expect(STABLE_CONVERSATION_ID_GRAMMAR).toBe(
      "parent: act_<32 lowercase hex>; children: out_|finding_|clar_<32 lowercase hex>",
    );
    expect(CHILD_MARKER_GRAMMAR).toBe(
      "<!-- tgd-child:v=1;kind=<action|finding|clarification>;parent=<act_ID>;child=<kind-compatible_ID>;repo=<64 lowercase hex>;review=<positive safe integer>;content=<64 lowercase hex> -->",
    );
  });

  it("rejects unsupported versions and non-canonical or duplicate fields", () => {
    const marker = formatChildMarker(markerInput);

    expect(parseChildMarker(marker.replace("v=1", "v=2"))).toBeNull();
    expect(parseChildMarker(marker.replace(";kind=", ";v=1;kind="))).toBeNull();
    expect(parseChildMarker(marker.replace(";kind=", ";unknown=x;kind="))).toBeNull();
    expect(parseChildMarker(marker.replace(";kind=", ";KIND="))).toBeNull();
  });

  it.each([
    ["missing prefix", HEX_ID],
    ["too short", `act_${"1".repeat(31)}`],
    ["too long", `act_${"1".repeat(33)}`],
    ["uppercase", `act_${"A".repeat(32)}`],
    ["non-hex", `act_${"z".repeat(32)}`],
    ["wrong parent kind", `out_${HEX_ID}`],
  ])("rejects malformed parent IDs: %s", (_name, parentId) => {
    expect(() => formatChildMarker({ ...markerInput, parentId })).toThrow(/parentId/i);
  });

  it("enforces exact child ID prefixes for every marker kind", () => {
    expect(() => formatChildMarker({ ...markerInput, childId: `finding_${HEX_ID}` })).toThrow(/childId/i);
    expect(() => formatChildMarker({ ...markerInput, kind: "finding", childId: `out_${HEX_ID}` })).toThrow(/childId/i);
    expect(() => formatChildMarker({ ...markerInput, kind: "clarification", childId: `finding_${HEX_ID}` })).toThrow(/childId/i);
    expect(formatChildMarker({ ...markerInput, kind: "finding", childId: `finding_${HEX_ID}` })).toContain("kind=finding");
    expect(formatChildMarker({ ...markerInput, kind: "clarification", childId: `clar_${HEX_ID}` })).toContain("kind=clarification");
  });

  it("rejects malformed digests and non-positive or unsafe review numbers", () => {
    expect(() => formatChildMarker({ ...markerInput, repositoryDigest: "a".repeat(63) })).toThrow(/repositoryDigest/i);
    expect(() => formatChildMarker({ ...markerInput, contentDigest: "A".repeat(64) })).toThrow(/contentDigest/i);
    for (const reviewNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatChildMarker({ ...markerInput, reviewNumber })).toThrow(/reviewNumber/i);
    }
  });

  it("does not recognize spoofed raw text, surrounding text, whitespace, newlines, or controls", () => {
    const marker = formatChildMarker(markerInput);
    for (const raw of [
      `prefix${marker}`,
      `${marker}suffix`,
      ` ${marker}`,
      `${marker}\n`,
      marker.replace(";kind=", "\n;kind="),
      marker.replace(";kind=", "\u0000;kind="),
      marker.replace("<!--", "&lt;!--"),
    ]) {
      expect(parseChildMarker(raw)).toBeNull();
    }
  });

  it("verifies repository, review, kind, parent, child, and content bindings", () => {
    const marker = formatChildMarker(markerInput);
    expect(verifyChildMarkerBinding(marker, markerInput)).toBe(true);
    expect(verifyChildMarkerBinding(marker, { repositoryDigest: "c".repeat(64) })).toBe(false);
    expect(verifyChildMarkerBinding(marker, { reviewNumber: 43 })).toBe(false);
    expect(verifyChildMarkerBinding(marker, { kind: "finding" })).toBe(false);
    expect(verifyChildMarkerBinding(marker, { parentId: `act_${"3".repeat(32)}` })).toBe(false);
    expect(verifyChildMarkerBinding(marker, { childId: `out_${"4".repeat(32)}` })).toBe(false);
    expect(verifyChildMarkerBinding(marker, { contentDigest: "d".repeat(64) })).toBe(false);
    expect(verifyChildMarkerBinding("not a marker", markerInput)).toBe(false);
  });

  it("uses domain-separated SHA-256 digests", () => {
    expect(computeRepositoryDigest("github", "github.com/Owner/Repo")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRepositoryDigest("github", "github.com/Owner/Repo")).not.toBe(
      computeRepositoryDigest("gitlab", "github.com/Owner/Repo"),
    );
    expect(computeContentDigest("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentDigest("hello")).not.toBe(computeRepositoryDigest("github", "hello"));
  });
});
