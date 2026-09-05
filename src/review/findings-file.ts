// Issue #138 phase 1: the structured findings contract for the direct engine.
//
// Reviewers are read-only over the repository (ADR-003) — but their OUTPUT is
// host-mediated: a per-rule `submit_findings` tool whose write path is baked
// into the tool closure (the model cannot choose it), whose content is
// validated with the same never-throws parser the text path uses, and whose
// file lands in host-created staging. The model supplies arguments; the host
// does everything else. The findings are then read from the FILE, not from
// the assistant's final prose — attribution by construction, one directory
// per task.
//
// The final JSON response remains REQUIRED in the task text. The file is the
// primary channel and the text is the fallback: if the tool was never called
// (older model behavior, or a stub session), the host parses the assistant
// text exactly as before, so the contract is additive, never a cliff.
//
// The file lives OUTSIDE the sessions' hermetic cwd deliberately: the cwd is
// readable by every rule's session, and a findings file inside it would let
// one rule's session read another rule's findings through the read tool. A
// separate per-rule directory under the run's staging root keeps tasks
// isolated from each other.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeUnknownFinding } from "./dispatch-results.js";
import type { Finding } from "./types.js";

/** The file every dispatched reviewer submits its findings through. */
export const FINDINGS_FILENAME = "findings.json";

/**
 * Filesystem-safe, collision-resistant directory name for one rule's task.
 * Raw rule names may contain spaces or slashes; the hash suffix keeps two
 * names that sanitize identically apart.
 */
export function ruleDirName(ruleName: string): string {
  const safe = ruleName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(ruleName, "utf8").digest("hex").slice(0, 12);
  return `${safe}-${digest}`;
}

/**
 * Builds the `submit_findings` tool for one dispatched rule.
 *
 * The write path is `outputDir` — baked into the closure, never chosen by the
 * model. Findings are validated with the same parser the text path uses, so
 * the file can only ever contain findings that survived the allowlist rules
 * (citations, bounded arrays). Invalid entries are dropped and counted, never
 * fatal: a finding the parser rejects is exactly as if the model had not
 * emitted it. Calling the tool again REPLACES the recorded set — last
 * submission wins.
 */
const SUBMIT_FINDINGS_SCHEMA = Type.Object({
  findings: Type.Array(Type.Unknown(), {
    description: "The complete findings array, matching the JSON contract.",
  }),
});

export function createSubmitFindingsTool(options: {
  readonly outputDir: string;
  readonly ruleName: string;
  readonly allowedReferences?: ReadonlySet<string>;
}): ToolDefinition<typeof SUBMIT_FINDINGS_SCHEMA> {
  const findingsPath = path.join(options.outputDir, FINDINGS_FILENAME);
  return {
    name: "submit_findings",
    label: "Submit findings",
    description:
      "Record your final findings durably. Call this exactly once with the complete findings array " +
      "(the same array the final JSON response contains). Calling it again replaces the recorded set.",
    parameters: SUBMIT_FINDINGS_SCHEMA,
    async execute(_toolCallId, params) {
      const rawFindings = Array.isArray(params.findings) ? params.findings : [];
      let accepted = 0;
      let dropped = 0;
      const findings: Finding[] = [];
      for (const raw of rawFindings) {
        const finding = normalizeUnknownFinding(raw, options.ruleName, options.allowedReferences);
        if (finding === undefined) {
          dropped += 1;
          continue;
        }
        findings.push(finding);
        accepted += 1;
      }
      await mkdir(options.outputDir, { recursive: true });
      await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
      const text =
        `Recorded ${accepted} finding(s) from rule "${options.ruleName}". ` +
        (dropped > 0 ? `${dropped} malformed entr(y/ies) dropped.` : "");
      return { content: [{ type: "text", text }], details: { accepted, dropped } };
    },
  };
}

/**
 * Reads a rule's submitted findings. Returns the validated findings, or
 * `undefined` when the tool was never called (or the file is unreadable or
 * not a findings array) — `undefined` means "fall back to the assistant
 * text path", never an error. Findings are re-validated on read: the file is
 * host-written, but defense in depth is cheap and keeps the parser the only
 * authority on what a finding is.
 */
export async function readSubmittedFindings(options: {
  readonly outputDir: string;
  readonly ruleName: string;
  readonly allowedReferences?: ReadonlySet<string>;
}): Promise<Finding[] | undefined> {
  let contents: string;
  try {
    contents = await readFile(path.join(options.outputDir, FINDINGS_FILENAME), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const findings: Finding[] = [];
  for (const raw of parsed) {
    const finding = normalizeUnknownFinding(raw, options.ruleName, options.allowedReferences);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}
