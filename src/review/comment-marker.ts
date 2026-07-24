export interface ParsedBotMarker {
  readonly lastReviewedSha: string;
  readonly reviewedConfig: string;
  readonly pendingState?: PendingReviewState;
}

export interface PendingReviewState {
  readonly phase: "publishing" | "ready";
  readonly headSha: string;
  readonly configHash: string;
  readonly noteId?: string;
}

const BOT_MARKER_PREFIX_RE = /<!-- tgd-review-agent:(?:sha=|pending)/u;
const BOT_MARKER_RE =
  /<!-- tgd-review-agent:sha=([0-9a-f]{7,40})(?: cfg=([0-9a-z]+))? -->\s*$/u;
const BOT_PENDING_MARKER_RE = /<!-- tgd-review-agent:pending -->\s*$/u;
const BOT_RECOVERY_MARKER_RE =
  /<!-- tgd-review-agent:pending phase=(publishing|ready) sha=([0-9a-f]{7,40}) cfg=([0-9a-z]+)(?: note=([A-Za-z0-9._~-]+))? -->\s*$/u;
const BOT_ANY_PENDING_MARKER_RE =
  /<!-- tgd-review-agent:pending(?: phase=(?:publishing|ready) sha=[0-9a-f]{7,40} cfg=[0-9a-z]+(?: note=[A-Za-z0-9._~-]+)?)? -->\s*$/u;

export const BOT_PENDING_MARKER = "<!-- tgd-review-agent:pending -->";

export function formatPendingMarker(state: {
  phase: PendingReviewState["phase"];
  headSha: string;
  configHash: string;
  noteId?: string;
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
  return `<!-- tgd-review-agent:pending phase=${state.phase} sha=${state.headSha} ` +
    `cfg=${state.configHash}${state.noteId === undefined ? "" : ` note=${state.noteId}`} -->`;
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
    return {
      lastReviewedSha: "",
      reviewedConfig: "",
      pendingState: {
        phase: recovery[1] as PendingReviewState["phase"],
        headSha: recovery[2]!,
        configHash: recovery[3]!,
        ...(recovery[4] === undefined ? {} : { noteId: recovery[4] }),
      },
    };
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
