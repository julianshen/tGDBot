export interface ParsedBotMarker {
  readonly lastReviewedSha: string;
  readonly reviewedConfig: string;
}

const BOT_MARKER_PREFIX_RE = /<!-- tgd-review-agent:(?:sha=|pending)/u;
const BOT_MARKER_RE =
  /<!-- tgd-review-agent:sha=([0-9a-f]{7,40})(?: cfg=([0-9a-z]+))? -->\s*$/u;
const BOT_PENDING_MARKER_RE = /<!-- tgd-review-agent:pending -->\s*$/u;

export const BOT_PENDING_MARKER = "<!-- tgd-review-agent:pending -->";

export function parseBotMarker(body: string): ParsedBotMarker | null {
  if (!BOT_MARKER_PREFIX_RE.test(body)) return null;
  if (BOT_PENDING_MARKER_RE.test(body)) {
    return { lastReviewedSha: "", reviewedConfig: "" };
  }
  const match = BOT_MARKER_RE.exec(body);
  return {
    lastReviewedSha: match?.[1] ?? "",
    reviewedConfig: match?.[2] ?? "",
  };
}
