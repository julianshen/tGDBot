// Issue #50. The security property that makes this safe is that the HOST
// derives every query from structured manifest data — the diff never picks a
// URL, and the reviewing agent never gains a fetch tool. These tests pin that
// property, because it is the whole reason the feature can exist.
import { describe, expect, it } from "vitest";
import {
  dependencyChangesFromDiff,
  registryUrlFor,
} from "../../../src/review/dependency-changes.js";

const diffOf = (file: string, body: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`;

describe("dependencyChangesFromDiff", () => {
  it("extracts a bumped dependency from a package.json diff", () => {
    const diff = diffOf(
      "package.json",
      '@@ -3,3 +3,3 @@\n   "dependencies": {\n-    "left-pad": "1.2.0",\n+    "left-pad": "1.3.1",',
    );

    expect(dependencyChangesFromDiff(diff)).toEqual([
      { name: "left-pad", version: "1.3.1", manifest: "package.json" },
    ]);
  });

  it("reports an added dependency", () => {
    const diff = diffOf("package.json", '@@ -3,2 +3,3 @@\n   "dependencies": {\n+    "lodash": "4.17.21",');

    expect(dependencyChangesFromDiff(diff)).toEqual([
      { name: "lodash", version: "4.17.21", manifest: "package.json" },
    ]);
  });

  // A removal has no version to ask the registry about.
  it("ignores a removed dependency", () => {
    const diff = diffOf("package.json", '@@ -3,3 +3,2 @@\n   "dependencies": {\n-    "left-pad": "1.2.0",');

    expect(dependencyChangesFromDiff(diff)).toEqual([]);
  });

  it("keeps a scoped package intact", () => {
    const diff = diffOf("package.json", '@@ -3,2 +3,3 @@\n+    "@scope/pkg": "2.0.0",');

    expect(dependencyChangesFromDiff(diff)[0]?.name).toBe("@scope/pkg");
  });

  // Only manifests the host knows how to parse. A changed source file that
  // happens to contain a quoted pair is not a dependency change.
  it("ignores files that are not dependency manifests", () => {
    const diff = diffOf("src/config.ts", '@@ -1 +1 @@\n+    "left-pad": "1.3.1",');

    expect(dependencyChangesFromDiff(diff)).toEqual([]);
  });

  it("finds manifests in subdirectories", () => {
    const diff = diffOf("packages/api/package.json", '@@ -1 +1,2 @@\n+    "lodash": "4.17.21",');

    expect(dependencyChangesFromDiff(diff)[0]?.manifest).toBe("packages/api/package.json");
  });

  it("deduplicates a package that appears in several manifests at one version", () => {
    const diff = [
      diffOf("package.json", '@@ -1 +1,2 @@\n+    "lodash": "4.17.21",'),
      diffOf("web/package.json", '@@ -1 +1,2 @@\n+    "lodash": "4.17.21",'),
    ].join("\n");

    expect(dependencyChangesFromDiff(diff)).toHaveLength(1);
  });

  // Ranges are what a manifest usually carries; the caret is not part of the
  // version the registry knows.
  it("strips a range prefix from the version", () => {
    const diff = diffOf("package.json", '@@ -1 +1,2 @@\n+    "lodash": "^4.17.21",');

    expect(dependencyChangesFromDiff(diff)[0]?.version).toBe("4.17.21");
  });

  // THE case that matters: a package name is attacker-controlled text from the
  // diff. Anything that could escape a URL path must never become a query.
  it("refuses a name that could escape the registry path", () => {
    for (const name of ["../../etc/passwd", "a/../b", "pkg?x=1", "pkg#frag", "pkg name", "PKG"]) {
      const diff = diffOf("package.json", `@@ -1 +1,2 @@\n+    "${name}": "1.0.0",`);

      expect(dependencyChangesFromDiff(diff), `${name} was accepted`).toEqual([]);
    }
  });

  it("refuses a name longer than the registry allows", () => {
    const diff = diffOf("package.json", `@@ -1 +1,2 @@\n+    "${"a".repeat(215)}": "1.0.0",`);

    expect(dependencyChangesFromDiff(diff)).toEqual([]);
  });

  it("refuses a version that is not a version", () => {
    for (const version of ["../x", "1.0.0 && curl evil", "latest?x=1"]) {
      const diff = diffOf("package.json", `@@ -1 +1,2 @@\n+    "pkg": "${version}",`);

      expect(dependencyChangesFromDiff(diff), `${version} was accepted`).toEqual([]);
    }
  });

  it("bounds how many packages one diff can ask about", () => {
    const body = Array.from({ length: 500 }, (_unused, index) => `+    "pkg-${index}": "1.0.0",`).join("\n");

    expect(dependencyChangesFromDiff(diffOf("package.json", `@@ -1 +1,500 @@\n${body}`)).length)
      .toBeLessThanOrEqual(200);
  });
});

describe("registryUrlFor", () => {
  it("builds a URL on the fixed registry host", () => {
    expect(registryUrlFor("left-pad")).toBe("https://registry.npmjs.org/left-pad");
  });

  // A scope contains a character that is legal in a name and structural in a
  // path, so it has to be encoded rather than interpolated.
  it("encodes a scoped name instead of interpolating it", () => {
    expect(registryUrlFor("@scope/pkg")).toBe("https://registry.npmjs.org/%40scope%2Fpkg");
  });

  it("refuses to build a URL for a name it would not accept", () => {
    for (const name of ["../etc", "a/b/c", ""]) {
      expect(() => registryUrlFor(name), `${name} was accepted`).toThrow(/package name/i);
    }
  });

  // Defence in depth: the parser already rejects these, so this can only be
  // reached by a caller passing an unvalidated name.
  it("stays on the registry host whatever it is given", () => {
    expect(registryUrlFor("pkg").startsWith("https://registry.npmjs.org/")).toBe(true);
  });
});
