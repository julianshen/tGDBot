import { describe, expect, it } from "vitest";
import { checkStructuralClaim } from "../../../src/review/structural-check.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("dbg", () => {
  it("python claim with grammars", async () => {
    console.error("ENV:", process.env.TGD_TREE_SITTER_LIB_DIR);
    const root = await mkdtemp(path.join(os.tmpdir(), "dbg-"));
    await writeFile(path.join(root, "wallet.py"), "def budget(amount):\n    return amount\n");
    const result = await checkStructuralClaim(
      { kind: "no-other-references" as const, symbol: "budget" },
      { baseRoot: root, findingFile: "wallet.py" },
    );
    console.error("RESULT:", JSON.stringify(result).slice(0, 300));
    expect(result).toBeDefined();
  });
});
