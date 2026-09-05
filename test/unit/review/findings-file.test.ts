// Issue #138 phase 1: the structured findings contract for the direct engine.
// A per-rule submit_findings tool writes a validated findings.json to
// host-created staging; the host reads the FILE as the primary channel and
// falls back to the assistant text only when the tool was never called.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSubmitFindingsTool,
  readSubmittedFindings,
  ruleDirName,
  FINDINGS_FILENAME,
} from "../../../src/review/findings-file.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ruleName = "grok-review";
const refs = undefined;

describe("createSubmitFindingsTool", () => {
  it("writes schema-valid findings to findings.json and drops malformed entries", async () => {
    const outputDir = await tempDir("submit-ok-");
    const tool = createSubmitFindingsTool({ outputDir, ruleName, allowedReferences: refs });

    const result = await tool.execute(
      "call-1",
      {
        findings: [
          { file: "src/a.ts", line: 11, severity: "warning", category: "c", message: "real" },
          { severity: "not-a-severity", category: "c", message: "malformed" },
          "not even an object",
        ],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(String((result.content[0] as { text: string }).text)).toContain("Recorded 1 finding(s)");
    expect(String((result.content[0] as { text: string }).text)).toContain("2 malformed");

    const written = JSON.parse(await readFile(path.join(outputDir, FINDINGS_FILENAME), "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ file: "src/a.ts", message: "real" });
  });

  it("replaces the recorded set when called again (last submission wins)", async () => {
    const outputDir = await tempDir("submit-replace-");
    const tool = createSubmitFindingsTool({ outputDir, ruleName, allowedReferences: refs });

    await tool.execute("call-1", { findings: [{ file: "a.ts", severity: "warning", category: "c", message: "one" }] }, undefined, undefined, {} as never);
    await tool.execute("call-2", { findings: [] }, undefined, undefined, {} as never);

    const written = JSON.parse(await readFile(path.join(outputDir, FINDINGS_FILENAME), "utf8"));
    expect(written).toEqual([]);
  });

  it("writes an empty array for a genuinely empty review (a success, not a failure)", async () => {
    const outputDir = await tempDir("submit-empty-");
    const tool = createSubmitFindingsTool({ outputDir, ruleName, allowedReferences: refs });
    await tool.execute("call-1", { findings: [] }, undefined, undefined, {} as never);

    const read = await readSubmittedFindings({ outputDir, ruleName, allowedReferences: refs });
    expect(read).toEqual([]);
  });
});

describe("readSubmittedFindings", () => {
  it("returns undefined when the tool was never called", async () => {
    const outputDir = await tempDir("read-absent-");
    expect(await readSubmittedFindings({ outputDir, ruleName, allowedReferences: refs })).toBeUndefined();
  });

  it("returns undefined for a corrupt or non-array file (host-written file, but defense in depth)", async () => {
    const outputDir = await tempDir("read-corrupt-");
    const tool = createSubmitFindingsTool({ outputDir, ruleName, allowedReferences: refs });
    await tool.execute("call-1", { findings: [] }, undefined, undefined, {} as never);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(outputDir, FINDINGS_FILENAME), "{not json", "utf8");
    expect(await readSubmittedFindings({ outputDir, ruleName, allowedReferences: refs })).toBeUndefined();

    await writeFile(path.join(outputDir, FINDINGS_FILENAME), JSON.stringify({ not: "an array" }), "utf8");
    expect(await readSubmittedFindings({ outputDir, ruleName, allowedReferences: refs })).toBeUndefined();
  });

  it("re-validates entries on read, dropping anything the parser rejects", async () => {
    const outputDir = await tempDir("read-revalidate-");
    const tool = createSubmitFindingsTool({ outputDir, ruleName, allowedReferences: refs });
    await tool.execute("call-1", { findings: [{ file: "a.ts", severity: "warning", category: "c", message: "ok" }] }, undefined, undefined, {} as never);
    // Tamper post-write: the read must not trust the file blindly.
    const { writeFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(path.join(outputDir, FINDINGS_FILENAME), "utf8"));
    parsed.push({ severity: "bogus" });
    await writeFile(path.join(outputDir, FINDINGS_FILENAME), JSON.stringify(parsed), "utf8");

    const read = await readSubmittedFindings({ outputDir, ruleName, allowedReferences: refs });
    expect(read).toHaveLength(1);
  });
});

describe("ruleDirName", () => {
  it("sanitizes hostile names and keeps distinct names distinct", () => {
    expect(ruleDirName("a/b\\c")).toMatch(/^[a-zA-Z0-9_-]+-[0-9a-f]{12}$/);
    expect(ruleDirName("a/b\\c")).not.toBe(ruleDirName("a b c"));
    expect(ruleDirName("grok-review")).toBe(ruleDirName("grok-review"));
  });
});
