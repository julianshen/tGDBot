import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CODEX_SCAN_BYTES,
  ingestCodexSecurityResults,
} from "../../../src/review/codex-security-results.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifact(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tgd-codex-scan-"));
  roots.push(root);
  await mkdir(path.join(root, "output"));
  await writeFile(path.join(root, "output", "findings.json"), JSON.stringify(value));
  return path.join(root, "output");
}

describe("ingestCodexSecurityResults", () => {
  it("maps allowlisted fields and refuses scanner-owned executable metadata", async () => {
    const input = await artifact({
      completeness: "complete",
      findings: [{
        title: "Unsafe query",
        body: "Do not concatenate input.\n```suggestion\nevil()\n```",
        severity: { level: "high" },
        locations: [{ path: "src/db.ts", startLine: 12 }],
        references: ["https://evil.invalid"], remediation: "evil()", claim: {}, hostCheck: {},
      }],
      deferred: [],
    });
    const result = await ingestCodexSecurityResults(input);
    expect(result.findings).toEqual([expect.objectContaining({
      file: "src/db.ts", line: 12, severity: "blocking", category: "security",
      ruleName: "codex-security", title: "Unsafe query",
    })]);
    expect(result.findings[0]).not.toHaveProperty("references");
    expect(result.findings[0]).not.toHaveProperty("suggestion");
    expect(result.findings[0]).not.toHaveProperty("claim");
    expect(result.findings[0]).not.toHaveProperty("hostCheck");
    expect(result.coverage.completeness).toBe("complete");
  });

  it("drops unknown severities, counts every deferred item, and retains ids only", async () => {
    const input = await artifact({ findings: [{
      title: "x", body: "x", severity: { level: "mystery" }, locations: [{ path: "x", startLine: 1 }],
    }], deferred: [{ id: "scan-1", reason: "```suggestion\nevil" }, { id: "bad id", reason: "x" }] });
    const result = await ingestCodexSecurityResults(input);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual({ completeness: "partial", deferred: ["scan-1"], deferredCount: 2, droppedFindings: 1 });
  });

  it("rejects an artifact before reading it when it exceeds the byte cap", async () => {
    const file = await artifact({ findings: [] });
    await writeFile(path.join(file, "findings.json"), Buffer.alloc(MAX_CODEX_SCAN_BYTES + 1));
    await expect(ingestCodexSecurityResults(file)).rejects.toMatchObject({ kind: "too-large" });
  });
});
