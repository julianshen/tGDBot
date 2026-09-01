import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeUnknownFinding } from "./dispatch-results.js";
import type { Finding, ScanCoverage } from "./types.js";
import type { RuleDefinition } from "../rules/types.js";

export const MAX_CODEX_SCAN_BYTES = 5 * 1024 * 1024;
export const MAX_CODEX_SCAN_FINDINGS = 500;
export const MAX_CODEX_SCAN_TEXT_CHARS = 500_000;
const DEFERRED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_LOGGED_DEFERRED_REASONS = 20;

/** Host-owned policy used by conversation lookups; it is never dispatched. */
export const CODEX_SECURITY_POLICY: RuleDefinition = Object.freeze({
  name: "codex-security",
  dependsOn: Object.freeze([]),
  body: "This finding was imported from a separately produced Codex Security artifact. Explain it using the recorded finding and current code; do not invent scanner evidence.",
  sourcePath: "<host:codex-security>",
});

export interface CodexScanIngest {
  readonly findings: Finding[];
  readonly coverage: ScanCoverage;
  readonly digest: string;
}

export class CodexScanIngestError extends Error {
  constructor(
    readonly kind: "missing" | "read" | "too-large" | "invalid",
    message?: string,
    readonly artifactDigest?: string,
  ) {
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
  const title = typeof raw.title === "string" && raw.title.length <= 80 && !/[\r\n]/u.test(raw.title)
    ? raw.title
    : undefined;
  return normalizeUnknownFinding({
    file: location.path,
    line: Number.isInteger(location.startLine) ? location.startLine : undefined,
    severity,
    category: "security",
    message,
    ...(title === undefined ? {} : { title }),
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
  let failed = false;
  try {
    handle = await open(file, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    const artifactHash = createHash("sha256");
    for (;;) {
      // Read one byte beyond the limit so the cap is enforced by the read,
      // rather than trusting mutable stat metadata (the artifact is untrusted).
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_CODEX_SCAN_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      artifactHash.update(chunk.subarray(0, bytesRead));
      if (total > MAX_CODEX_SCAN_BYTES) {
        throw new CodexScanIngestError("too-large", undefined, artifactHash.digest("hex"));
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const buffer = Buffer.concat(chunks, total);
    const digest = artifactHash.digest("hex");
    const text = buffer.toString("utf8");
    let document: unknown;
    try { document = JSON.parse(text); } catch (error) {
      throw new CodexScanIngestError("invalid", String(error), digest);
    }
    if (!document || typeof document !== "object") {
      throw new CodexScanIngestError("invalid", undefined, digest);
    }
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
    const scannerCoverage = root.coverage && typeof root.coverage === "object"
      ? root.coverage as Record<string, unknown>
      : root;
    const rawDeferred = Array.isArray(scannerCoverage.deferred) ? scannerCoverage.deferred : [];
    const deferred = rawDeferred.flatMap((item) => {
      const id = typeof item === "string" ? item
        : item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
      return typeof id === "string" && DEFERRED_ID_RE.test(id) ? [id] : [];
    });
    for (const item of rawDeferred.slice(0, MAX_LOGGED_DEFERRED_REASONS)) {
      if (!item || typeof item !== "object") continue;
      const deferredItem = item as Record<string, unknown>;
      if (typeof deferredItem.reason !== "string") continue;
      const id = typeof deferredItem.id === "string" && DEFERRED_ID_RE.test(deferredItem.id)
        ? deferredItem.id
        : "unmapped";
      const reason = deferredItem.reason
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .slice(0, 500);
      console.warn(`tgd-review-agent: Codex Security deferred ${id}: ${reason}`);
    }
    if (rawDeferred.length > MAX_LOGGED_DEFERRED_REASONS) {
      console.warn(
        `tgd-review-agent: ${rawDeferred.length - MAX_LOGGED_DEFERRED_REASONS} further Codex Security deferral reason(s) omitted from logs`,
      );
    }
    const reported = scannerCoverage.completeness;
    const completeness = droppedFindings > 0 ? "partial"
      : reported === "complete" || reported === "partial" ? reported : "unknown";
    return {
      findings,
      coverage: { completeness, deferred, deferredCount: rawDeferred.length, droppedFindings },
      digest,
    };
  } catch (error) {
    failed = true;
    if (error instanceof CodexScanIngestError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new CodexScanIngestError("missing", String(error));
    }
    throw new CodexScanIngestError("read", String(error));
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      if (!failed) throw new CodexScanIngestError("read", String(error));
      // Preserve the primary classified failure. Close diagnostics belong only
      // in private logs and must not replace an oversized/invalid classification.
      console.warn(`tgd-review-agent: closing Codex Security results failed (${String(error)})`);
    }
  }
}

export function codexScanFailureReason(error: unknown): string {
  if (!(error instanceof CodexScanIngestError)) return "the scan results could not be ingested";
  if (error.kind === "missing") return "no scan results at that path";
  if (error.kind === "too-large") return "the scan results were too large";
  if (error.kind === "read") return "the scan results could not be read";
  return "the scan results could not be ingested";
}

export function codexScanArtifactDigest(error: unknown): string | undefined {
  return error instanceof CodexScanIngestError ? error.artifactDigest : undefined;
}
