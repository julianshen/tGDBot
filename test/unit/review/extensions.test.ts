// Sanity check for resolvePiSubagentsExtensionPath — not one of Task 5's
// numbered ACs (AC-5.1 through AC-5.4 all live in dispatch.test.ts, per
// TASKS.md Task 5's "Files Likely Touched"), but this function underpins
// AC-5.1 and is cheap to verify directly against the real installed
// pi-subagents package.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiSubagentsExtensionPath } from "../../../src/review/extensions.js";

describe("resolvePiSubagentsExtensionPath", () => {
  it("resolves to pi-subagents' real extension entry point on disk", () => {
    const resolved = resolvePiSubagentsExtensionPath();

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("pi-subagents", "src", "extension", "index.ts"))).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });
});
