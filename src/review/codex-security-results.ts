import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeUnknownFinding } from "./dispatch-results.js";
import type { Finding, ScanCoverage } from "./types.js";

export const MAX_CODEX_SCAN_BYTES = 5 * 1024 * 1024;
export const MAX_CODEX_SCAN_FINDINGS = 500;
export const MAX_CODEX_SCAN_TEXT_CHARS = 500_000;
const DEFERRED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface CodexScanIngest {
  readonly findings: Finding[];
  readonly coverage: ScanCoverage;
  readonly digest: string;
}

export class CodexScanIngestError extends Error {
  constructor(readonly kind: "missing" | "read" | "too-large" | "invalid", message?: string) {
    super(message ?? kind);
    this.name = "CodexScanIngestError";
  }
}

function severityOf(value: unknown): Finding["severity"] | undefined {
  if (typeof value !== "string") return undefined;
  const level = value.toLowerCase();
  if (["critical", "high", "blocking"].includes(level)) return "blocking";
  if (["medium", "moderate", "warning"].includes(level)) return "warning";
  if (["low", "suggestion"].includes(level)) return "suggestion";
  return undefined;
}

function mapFinding(value: unknown): Finding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const severityObject = raw.severity && typeof raw.severity === "object"
    ? raw.severity as Record<string, unknown>
    : undefined;
  const severity = severityOf(severityObject?.level ?? raw.severity);
  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  const location = locations[0] && typeof locations[0] === "object"
    ? locations[0] as Record<string, unknown>
    : undefined;
  const message = typeof raw.body === "string" ? raw.body
    : typeof raw.message === "string" ? raw.message : undefined;
  if (severity === undefined || typeof location?.path !== "string" || message === undefined) {
    return undefined;
  }
  return normalizeUnknownFinding({
    file: location.path,
    line: Number.isInteger(location.startLine) ? location.startLine : undefined,
    severity,
    category: "security",
    message,
    title: typeof raw.title === "string" ? raw.title : undefined,
    ruleName: "codex-security",
  });
}

async function artifactFile(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return (await stat(resolved)).isDirectory() ? path.join(resolved, "findings.json") : resolved;
  } catch (error) {
    throw new CodexScanIngestError("missing", String(error));
  }
}

export async function ingestCodexSecurityResults(inputPath: string): Promise<CodexScanIngest> {
  const file = await artifactFile(inputPath);
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (info.size > MAX_CODEX_SCAN_BYTES) throw new CodexScanIngestError("too-large");
    const buffer = Buffer.alloc(Number(info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new CodexScanIngestError("read", "short read");
    const text = buffer.toString("utf8");
    let document: unknown;
    try { document = JSON.parse(text); } catch (error) {
      throw new CodexScanIngestError("invalid", String(error));
    }
    if (!document || typeof document !== "object") throw new CodexScanIngestError("invalid");
    const root = document as Record<string, unknown>;
    const rawFindings = Array.isArray(root.findings) ? root.findings : [];
    const findings: Finding[] = [];
    let droppedFindings = Math.max(0, rawFindings.length - MAX_CODEX_SCAN_FINDINGS);
    let textChars = 0;
    for (const raw of rawFindings.slice(0, MAX_CODEX_SCAN_FINDINGS)) {
      const finding = mapFinding(raw);
      if (finding === undefined || textChars + finding.message.length + (finding.title?.length ?? 0) > MAX_CODEX_SCAN_TEXT_CHARS) {
        droppedFindings += 1;
      } else {
        textChars += finding.message.length + (finding.title?.length ?? 0);
        findings.push(finding);
      }
    }
    const rawDeferred = Array.isArray(root.deferred) ? root.deferred : [];
    const deferred = rawDeferred.flatMap((item) => {
      const id = typeof item === "string" ? item
        : item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
      return typeof id === "string" && DEFERRED_ID_RE.test(id) ? [id] : [];
    });
    const reported = root.completeness;
    const completeness = droppedFindings > 0 ? "partial"
      : reported === "complete" || reported === "partial" ? reported : "unknown";
    return {
      findings,
      coverage: { completeness, deferred, deferredCount: rawDeferred.length, droppedFindings },
      digest: createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    if (error instanceof CodexScanIngestError) throw error;
    throw new CodexScanIngestError("read", String(error));
  } finally {
    await handle?.close();
  }
}

export function codexScanFailureReason(error: unknown): string {
  if (!(error instanceof CodexScanIngestError)) return "the scan results could not be ingested";
  if (error.kind === "missing") return "no scan results at that path";
  if (error.kind === "too-large") return "the scan results were too large";
  if (error.kind === "read") return "the scan results could not be read";
  return "the scan results could not be ingested";
}
