// Issue #142 / Codex review of PR #143 round three: a MALFORMED grammar
// library must not take the review down. Measured: napi does not throw on a
// bad grammar path — registration PANICS in Rust (napi_lang.rs:169) and the
// abort kills the whole process — so registration pre-validates every library
// (ELF/Mach-O magic) and garbage files never reach napi. This file pins that:
// a text file named tree_sitter_python.so degrades the Python check to
// not-checked with the process alive. It lives in its own file because the
// registration attempt is once-per-process (a per-file vitest worker), and the
// environment is set before the first check runs.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const libDir = mkdtempSync(path.join(os.tmpdir(), "tgd-bad-grammar-"));
writeFileSync(path.join(libDir, "tree_sitter_python.so"), "this is not a shared library, whatever its name says");
process.env.TGD_TREE_SITTER_LIB_DIR = libDir;

const { checkStructuralClaim } = await import("../../../src/review/structural-check.js");

afterEach(() => {
  // Restore the ambient environment: vitest workers run several files.
  delete process.env.TGD_TREE_SITTER_LIB_DIR;
});

describe("structural checks survive a malformed grammar library (issue #142)", () => {
  it("degrades the Python finding to not-checked instead of aborting", async () => {
    const root = await mkdtempSync(path.join(os.tmpdir(), "tgd-py-"));
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(root, "wallet.py"), "def budget(amount):\n    return amount\n"));

    const result = await checkStructuralClaim(
      { kind: "no-other-references" as const, symbol: "budget" },
      { baseRoot: root, findingFile: "wallet.py" },
    );

    // Still alive, still honest: the garbage library was excluded from
    // registration, so the claim degrades with the fixable reason.
    expect(result.status).toBe("not-checked");
    if (result.status !== "not-checked") throw new Error("unreachable");
    expect(result.reason).toContain("TGD_TREE_SITTER_LIB_DIR");
  });
});
