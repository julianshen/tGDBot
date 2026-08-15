import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export interface ParsedBotMarker {
  readonly lastReviewedSha: string;
  readonly reviewedConfig: string;
  readonly pendingState?: PendingReviewState;
  readonly invalidPendingState?: true;
}

export interface PendingReviewState {
  readonly phase: "publishing" | "ready" | "ambiguous";
  readonly headSha: string;
  readonly configHash: string;
  readonly noteId?: string;
  readonly terminalResult?: TerminalReviewResult;
  readonly inlineRecovery?: InlineRecoveryState;
}

export interface InlineRecoveryState {
  readonly children: readonly InlineRecoveryChild[];
  readonly noFallbackBody: string;
}

export interface InlineRecoveryChild {
  readonly clientId: string;
  readonly kind: "finding";
  readonly parentId: string;
  readonly childId: string;
  readonly repositoryDigest: string;
  readonly reviewNumber: number;
  readonly contentDigest: string;
  readonly headSha: string;
  readonly placementDigest: string;
  readonly marker: string;
}

export function deriveInlineChildId(
  parentId: string,
  clientId: string,
  contentDigest: string,
  placementDigest: string,
): string {
  if (!/^act_[0-9a-f]{32}$/u.test(parentId) || !/^finding-[0-9]+$/u.test(clientId) || !/^[0-9a-f]{64}$/u.test(contentDigest) || !/^[0-9a-f]{64}$/u.test(placementDigest)) {
    throw new Error("Invalid inline child derivation binding");
  }
  return `finding_${createHash("sha256").update(`tgd:inline-child:v3\0${parentId}\0${clientId}\0${contentDigest}\0${placementDigest}`, "utf8").digest("hex").slice(0, 32)}`;
}

export function formatInlineRecoveryMarker(child: Omit<InlineRecoveryChild, "clientId" | "marker">): string {
  return `<!-- tgd-inline-child:v=3;kind=finding;parent=${child.parentId};child=${child.childId};repo=${child.repositoryDigest};review=${child.reviewNumber};content=${child.contentDigest};head=${child.headSha};placement=${child.placementDigest} -->`;
}

/**
 * Structurally identical to state-schema's PublicationTerminalResult, which is
 * what the manifest hands back; the arrays are readonly on both sides so a
 * validated-from-JSON result stays assignable here. Callers build these from
 * local mutable arrays, which remain assignable to readonly ones.
 */
export interface TerminalReviewResult {
  readonly status: "posted" | "partial";
  readonly findingsCount: number;
  readonly rulesRun: readonly string[];
  readonly rulesFailed: readonly string[];
  readonly loadErrors?: readonly string[];
  readonly exitCode: 0 | 2;
}

const BOT_MARKER_PREFIX_RE = /<!-- tgd-review-agent:(?:sha=|pending)/u;
const BOT_MARKER_RE =
  /<!-- tgd-review-agent:sha=([0-9a-f]{7,40})(?: cfg=([0-9a-z]+))? -->\s*$/u;
const BOT_PENDING_MARKER_RE = /<!-- tgd-review-agent:pending -->\s*$/u;
const BOT_RECOVERY_MARKER_RE =
  /<!-- tgd-review-agent:pending phase=(publishing|ready|ambiguous) sha=([0-9a-f]{7,40}) cfg=([0-9a-z]+)(?: note=([A-Za-z0-9._~-]+))?(?: result=(v1\.[A-Za-z0-9_-]+))?(?: recovery=(v1\.[A-Za-z0-9_-]+))? -->\s*$/u;
const BOT_ANY_PENDING_MARKER_RE =
  /<!-- tgd-review-agent:pending(?: phase=(?:publishing|ready|ambiguous) sha=[0-9a-f]{7,40} cfg=[0-9a-z]+(?: note=[A-Za-z0-9._~-]+)?(?: result=v1\.[A-Za-z0-9_-]+)?(?: recovery=v1\.[A-Za-z0-9_-]+)?)? -->\s*$/u;
const MAX_TERMINAL_RESULT_CHARS = 32_768;

export const BOT_PENDING_MARKER = "<!-- tgd-review-agent:pending -->";

export function formatPendingMarker(state: {
  phase: PendingReviewState["phase"];
  headSha: string;
  configHash: string;
  noteId?: string;
  terminalResult?: TerminalReviewResult;
  inlineRecovery?: InlineRecoveryState;
}): string {
  if (!/^[0-9a-f]{7,40}$/u.test(state.headSha)) {
    throw new Error("Invalid pending review head SHA");
  }
  if (!/^[0-9a-z]+$/u.test(state.configHash)) {
    throw new Error("Invalid pending review config hash");
  }
  if (
    state.noteId !== undefined &&
    !/^[A-Za-z0-9._~-]+$/u.test(state.noteId)
  ) {
    throw new Error("Invalid pending review note identity");
  }
  if (state.phase === "ready" && (state.noteId === undefined || state.terminalResult === undefined)) {
    throw new Error("Ready pending reviews require note identity and terminal result");
  }
  if (state.phase === "publishing" && state.terminalResult !== undefined) {
    throw new Error("Publishing pending reviews cannot contain a terminal result");
  }
  if (state.phase === "ambiguous" && (state.noteId === undefined || state.terminalResult === undefined || state.inlineRecovery === undefined)) {
    throw new Error("Ambiguous pending reviews require recovery metadata");
  }
  const inlineRecovery = state.inlineRecovery === undefined ? undefined : validateInlineRecoveryState(state.inlineRecovery);
  const encodedResult = state.terminalResult === undefined
    ? ""
    : ` result=${encodeTerminalResult(state.terminalResult)}`;
  const encodedRecovery = inlineRecovery === undefined ? "" : ` recovery=v1.${gzipSync(Buffer.from(JSON.stringify(inlineRecovery), "utf8")).toString("base64url")}`;
  return `<!-- tgd-review-agent:pending phase=${state.phase} sha=${state.headSha} ` +
    `cfg=${state.configHash}${state.noteId === undefined ? "" : ` note=${state.noteId}`}` +
    `${encodedResult}${encodedRecovery} -->`;
}

export function replacePendingMarker(body: string, completeMarker: string): string {
  if (!BOT_ANY_PENDING_MARKER_RE.test(body)) {
    throw new Error("Review summary does not end in a valid pending marker");
  }
  return body.replace(BOT_ANY_PENDING_MARKER_RE, completeMarker);
}

export function parseBotMarker(body: string): ParsedBotMarker | null {
  if (!BOT_MARKER_PREFIX_RE.test(body)) return null;
  const recovery = BOT_RECOVERY_MARKER_RE.exec(body);
  if (recovery) {
    const phase = recovery[1] as PendingReviewState["phase"];
    const terminalResult = recovery[5] === undefined
      ? undefined
      : decodeTerminalResult(recovery[5]);
    const inlineRecovery = recovery[6] === undefined ? undefined : decodeInlineRecovery(recovery[6]);
    if (terminalResult === null || inlineRecovery === null) return invalidPendingMarker();
    if (
      (phase === "ready" && (recovery[4] === undefined || terminalResult === undefined)) ||
      (phase === "publishing" && recovery[5] !== undefined) ||
      (phase === "ambiguous" && (recovery[4] === undefined || terminalResult === undefined || inlineRecovery === undefined))
    ) {
      return invalidPendingMarker();
    }
    return {
      lastReviewedSha: "",
      reviewedConfig: "",
      pendingState: {
        phase,
        headSha: recovery[2]!,
        configHash: recovery[3]!,
        ...(recovery[4] === undefined ? {} : { noteId: recovery[4] }),
        ...(terminalResult === undefined ? {} : { terminalResult }),
        ...(inlineRecovery === undefined ? {} : { inlineRecovery }),
      },
    };
  }
  if (/<!-- tgd-review-agent:pending[^>]*\bresult=/u.test(body)) {
    return invalidPendingMarker();
  }
  if (BOT_PENDING_MARKER_RE.test(body)) {
    return { lastReviewedSha: "", reviewedConfig: "" };
  }
  const match = BOT_MARKER_RE.exec(body);
  return {
    lastReviewedSha: match?.[1] ?? "",
    reviewedConfig: match?.[2] ?? "",
  };
}

export function validateInlineRecoveryState(value: unknown): InlineRecoveryState {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join(",") !== "children,noFallbackBody" ||
    !Array.isArray((value as InlineRecoveryState).children) || (value as InlineRecoveryState).children.length === 0 || (value as InlineRecoveryState).children.length > 1_000 ||
    (value as InlineRecoveryState).children.some((child) => !validInlineRecoveryChild(child)) || typeof (value as InlineRecoveryState).noFallbackBody !== "string" || (value as InlineRecoveryState).noFallbackBody.length > 60_000) {
    throw new Error("Invalid inline recovery metadata");
  }
  const recovery = value as InlineRecoveryState;
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  const semantic = recovery.children.map((child) => [child.parentId, child.kind, child.repositoryDigest, child.reviewNumber, child.contentDigest, child.headSha, child.placementDigest].join("\0"));
  if (!unique(recovery.children.map((child) => child.clientId)) || !unique(recovery.children.map((child) => child.childId)) || !unique(recovery.children.map((child) => child.marker)) || !unique(semantic)) {
    throw new Error("Invalid inline recovery metadata: duplicate child binding");
  }
  return {
    noFallbackBody: recovery.noFallbackBody,
    children: recovery.children.map((child) => ({
      clientId: child.clientId,
      kind: child.kind,
      parentId: child.parentId,
      childId: child.childId,
      repositoryDigest: child.repositoryDigest,
      reviewNumber: child.reviewNumber,
      contentDigest: child.contentDigest,
      headSha: child.headSha,
      placementDigest: child.placementDigest,
      marker: child.marker,
    })),
  };
}

function validInlineRecoveryChild(value: unknown): value is InlineRecoveryChild {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const child = value as Record<string, unknown>;
  if (Object.keys(child).sort().join(",") !== "childId,clientId,contentDigest,headSha,kind,marker,parentId,placementDigest,repositoryDigest,reviewNumber") return false;
  const fieldsValid = typeof child.clientId === "string" && /^finding-[0-9]+$/u.test(child.clientId) && child.kind === "finding" &&
    typeof child.parentId === "string" && /^act_[0-9a-f]{32}$/u.test(child.parentId) &&
    typeof child.childId === "string" && /^finding_[0-9a-f]{32}$/u.test(child.childId) &&
    typeof child.repositoryDigest === "string" && /^[0-9a-f]{64}$/u.test(child.repositoryDigest) &&
    Number.isSafeInteger(child.reviewNumber) && (child.reviewNumber as number) > 0 &&
    typeof child.contentDigest === "string" && /^[0-9a-f]{64}$/u.test(child.contentDigest) &&
    typeof child.headSha === "string" && /^[0-9a-f]{7,64}$/u.test(child.headSha) &&
    typeof child.placementDigest === "string" && /^[0-9a-f]{64}$/u.test(child.placementDigest) &&
    typeof child.marker === "string" && child.marker.length <= 2_048;
  if (!fieldsValid) return false;
  if (child.childId !== deriveInlineChildId(child.parentId as string, child.clientId as string, child.contentDigest as string, child.placementDigest as string)) return false;
  return child.marker === formatInlineRecoveryMarker(child as unknown as InlineRecoveryChild);
}

function decodeInlineRecovery(encoded: string): InlineRecoveryState | null {
  try {
    if (!encoded.startsWith("v1.")) return null;
    const value = JSON.parse(gunzipSync(Buffer.from(encoded.slice(3), "base64url"), { maxOutputLength: 64 * 1024 }).toString("utf8")) as InlineRecoveryState;
    validateInlineRecoveryState(value);
    return value;
  } catch { return null; }
}

function invalidPendingMarker(): ParsedBotMarker {
  return {
    lastReviewedSha: "",
    reviewedConfig: "",
    invalidPendingState: true,
  };
}

function validRuleNames(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((name) => typeof name === "string");
}

function validOptionalStrings(value: unknown): value is string[] | undefined {
  return value === undefined || validRuleNames(value);
}

function validateTerminalResult(value: unknown): TerminalReviewResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    ![
      "exitCode,findingsCount,rulesFailed,rulesRun,status",
      "exitCode,findingsCount,loadErrors,rulesFailed,rulesRun,status",
    ].includes(Object.keys(candidate).sort().join(",")) ||
    (candidate.status !== "posted" && candidate.status !== "partial") ||
    !Number.isSafeInteger(candidate.findingsCount) ||
    (candidate.findingsCount as number) < 0 ||
    (candidate.findingsCount as number) > 1_000_000 ||
    !validRuleNames(candidate.rulesRun) ||
    !validRuleNames(candidate.rulesFailed) ||
    !validOptionalStrings(candidate.loadErrors) ||
    (candidate.exitCode !== 0 && candidate.exitCode !== 2) ||
    (candidate.status === "posted" && candidate.exitCode !== 0) ||
    (candidate.status === "partial" && candidate.exitCode !== 2)
  ) {
    return null;
  }
  return candidate as unknown as TerminalReviewResult;
}

function encodeTerminalResult(result: TerminalReviewResult): string {
  if (validateTerminalResult(result) === null) {
    throw new Error("Invalid terminal review result");
  }
  const encoded = Buffer.from(JSON.stringify(result), "utf8").toString("base64url");
  if (encoded.length > MAX_TERMINAL_RESULT_CHARS) {
    throw new Error("Terminal review result is too large");
  }
  return `v1.${encoded}`;
}

function decodeTerminalResult(encoded: string): TerminalReviewResult | null {
  if (!encoded.startsWith("v1.")) return null;
  const payload = encoded.slice(3);
  if (
    payload.length === 0 ||
    payload.length > MAX_TERMINAL_RESULT_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(payload)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const canonical = Buffer.from(decoded, "utf8").toString("base64url");
    if (canonical !== payload) return null;
    return validateTerminalResult(JSON.parse(decoded));
  } catch {
    return null;
  }
}
