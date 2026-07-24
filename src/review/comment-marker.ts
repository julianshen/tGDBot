export interface ParsedBotMarker {
  readonly lastReviewedSha: string;
  readonly reviewedConfig: string;
  readonly pendingState?: PendingReviewState;
  readonly invalidPendingState?: true;
}

export interface PendingReviewState {
  readonly phase: "publishing" | "ready";
  readonly headSha: string;
  readonly configHash: string;
  readonly noteId?: string;
  readonly terminalResult?: TerminalReviewResult;
}

export interface TerminalReviewResult {
  readonly status: "posted" | "partial";
  readonly findingsCount: number;
  readonly rulesRun: string[];
  readonly rulesFailed: string[];
  readonly exitCode: 0 | 2;
}

const BOT_MARKER_PREFIX_RE = /<!-- tgd-review-agent:(?:sha=|pending)/u;
const BOT_MARKER_RE =
  /<!-- tgd-review-agent:sha=([0-9a-f]{7,40})(?: cfg=([0-9a-z]+))? -->\s*$/u;
const BOT_PENDING_MARKER_RE = /<!-- tgd-review-agent:pending -->\s*$/u;
const BOT_RECOVERY_MARKER_RE =
  /<!-- tgd-review-agent:pending phase=(publishing|ready) sha=([0-9a-f]{7,40}) cfg=([0-9a-z]+)(?: note=([A-Za-z0-9._~-]+))?(?: result=(v1\.[A-Za-z0-9_-]+))? -->\s*$/u;
const BOT_ANY_PENDING_MARKER_RE =
  /<!-- tgd-review-agent:pending(?: phase=(?:publishing|ready) sha=[0-9a-f]{7,40} cfg=[0-9a-z]+(?: note=[A-Za-z0-9._~-]+)?(?: result=v1\.[A-Za-z0-9_-]+)?)? -->\s*$/u;
const MAX_TERMINAL_RESULT_CHARS = 32_768;

export const BOT_PENDING_MARKER = "<!-- tgd-review-agent:pending -->";

export function formatPendingMarker(state: {
  phase: PendingReviewState["phase"];
  headSha: string;
  configHash: string;
  noteId?: string;
  terminalResult?: TerminalReviewResult;
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
  const encodedResult = state.terminalResult === undefined
    ? ""
    : ` result=${encodeTerminalResult(state.terminalResult)}`;
  return `<!-- tgd-review-agent:pending phase=${state.phase} sha=${state.headSha} ` +
    `cfg=${state.configHash}${state.noteId === undefined ? "" : ` note=${state.noteId}`}` +
    `${encodedResult} -->`;
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
    if (terminalResult === null) return invalidPendingMarker();
    if (
      (phase === "ready" && (recovery[4] === undefined || terminalResult === undefined)) ||
      (phase === "publishing" && recovery[5] !== undefined)
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

function validateTerminalResult(value: unknown): TerminalReviewResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !==
      "exitCode,findingsCount,rulesFailed,rulesRun,status" ||
    (candidate.status !== "posted" && candidate.status !== "partial") ||
    !Number.isSafeInteger(candidate.findingsCount) ||
    (candidate.findingsCount as number) < 0 ||
    (candidate.findingsCount as number) > 1_000_000 ||
    !validRuleNames(candidate.rulesRun) ||
    !validRuleNames(candidate.rulesFailed) ||
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
