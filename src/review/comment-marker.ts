export interface ParsedBotMarker {
  readonly lastReviewedSha: string;
  readonly reviewedConfig: string;
}

const BOT_MARKER_PREFIX_RE = /<!-- tgd-review-agent:sha=/u;
const BOT_MARKER_RE =
  /<!-- tgd-review-agent:sha=([0-9a-f]{7,40})(?: cfg=([0-9a-z]+))? -->\s*$/u;

export function parseBotMarker(body: string): ParsedBotMarker | null {
  if (!BOT_MARKER_PREFIX_RE.test(body)) return null;
  const match = BOT_MARKER_RE.exec(body);
  return {
    lastReviewedSha: match?.[1] ?? "",
    reviewedConfig: match?.[2] ?? "",
  };
}
