// Sanity check for resolvePiSubagentsExtensionPath — not one of Task 5's
// numbered ACs (AC-5.1 through AC-5.4 all live in dispatch.test.ts, per
// TASKS.md Task 5's "Files Likely Touched"), but this function underpins
// AC-5.1 and is cheap to verify directly against the real installed
// pi-subagents package.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPiExtensionEntry,
  resolvePiSubagentsExtensionPath,
  resolveRpivAdvisorExtensionPath,
} from "../../../src/review/extensions.js";

describe("resolvePiSubagentsExtensionPath", () => {
  it("resolves to pi-subagents' real extension entry point on disk", () => {
    const resolved = resolvePiSubagentsExtensionPath();

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("pi-subagents", "src", "extension", "index.ts"))).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });
});

// Sanity check for resolveRpivAdvisorExtensionPath — not one of Task 6's
// numbered ACs (AC-6.1 through AC-6.3 all live in dispatch.test.ts, per
// TASKS.md Task 6's "Files Likely Touched"), but this function underpins
// AC-6.1 and is cheap to verify directly against the real installed
// @juicesharp/rpiv-advisor package.
describe("resolveRpivAdvisorExtensionPath", () => {
  it("resolves to rpiv-advisor's real extension entry point on disk", () => {
    const resolved = resolveRpivAdvisorExtensionPath();

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("@juicesharp", "rpiv-advisor", "index.ts"))).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });
});

// Test coverage fix (DEBT.md): the malformed-manifest throw path was
// previously only reachable via a real installed package's package.json,
// making it untestable in practice. extractPiExtensionEntry is the pure,
// exported extraction step (no file I/O) so a fake parsed manifest can
// exercise the throw directly.
describe("extractPiExtensionEntry", () => {
  it("throws a clear error when the parsed package.json has no `pi` field at all", () => {
    expect(() => extractPiExtensionEntry("fake-package", "/fake/path/package.json", {})).toThrow(
      'fake-package package.json (/fake/path/package.json) is missing a "pi.extensions[0]" entry',
    );
  });

  it("throws when `pi.extensions` is present but empty", () => {
    expect(() =>
      extractPiExtensionEntry("fake-package", "/fake/path/package.json", {
        pi: { extensions: [] },
      }),
    ).toThrow('fake-package package.json (/fake/path/package.json) is missing a "pi.extensions[0]" entry');
  });

  it("returns the first entry when `pi.extensions[0]` is present", () => {
    const entry = extractPiExtensionEntry("fake-package", "/fake/path/package.json", {
      pi: { extensions: ["./index.ts", "./other.ts"] },
    });

    expect(entry).toBe("./index.ts");
  });
});
