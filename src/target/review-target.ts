import type { ReviewTarget } from "./types.js";

const EXPECTED_FORMAT = "expected https://github.com/OWNER/REPO/pull/NUMBER";

function invalidTarget(reason: string): Error {
  return new Error(`Invalid GitHub PR URL: ${reason} (${EXPECTED_FORMAT})`);
}

/**
 * Parse the preferred location-independent review target.
 *
 * Uses Node's WHATWG URL implementation rather than the deprecated legacy API:
 * https://nodejs.org/download/release/latest-v22.x/docs/api/url.html#the-whatwg-url-api
 */
export function parseReviewTarget(input: string): ReviewTarget {
  if (input.trim() !== input) {
    throw invalidTarget("leading or trailing whitespace is not allowed");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw invalidTarget("the value is not an absolute URL");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidTarget("credentials are not allowed");
  }
  if (parsed.protocol !== "https:") {
    throw invalidTarget("the scheme must be HTTPS");
  }
  if (parsed.hostname !== "github.com" || parsed.port !== "") {
    throw invalidTarget("the host must be github.com without a custom port");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw invalidTarget("queries and fragments are not allowed");
  }
  if (/%[0-9a-f]{2}/i.test(parsed.pathname)) {
    throw invalidTarget("percent-encoded path data is not allowed");
  }

  const pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  const segments = pathname.split("/");
  if (segments.length !== 5 || segments[0] !== "" || segments[3] !== "pull") {
    throw invalidTarget("the path must contain owner, repository, pull, and number");
  }

  const [, owner, repo, , pullNumberText] = segments;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) {
    throw invalidTarget("the owner segment is missing or invalid");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") {
    throw invalidTarget("the repository segment is missing or invalid");
  }
  if (!/^[1-9]\d*$/.test(pullNumberText)) {
    throw invalidTarget("the pull-request number must be a positive integer");
  }

  const pullNumber = Number(pullNumberText);
  if (!Number.isSafeInteger(pullNumber)) {
    throw invalidTarget("the pull-request number is too large");
  }

  return {
    provider: "github",
    host: "github.com",
    owner,
    repo,
    pullNumber,
    canonicalUrl: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
  };
}
