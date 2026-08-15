// Credential masking for diagnostics.
//
// Provider CLIs quote the request they attempted when it fails, so a `gh` or
// `glab` error can carry the token that was used to make it. Those messages end
// up in local diagnostics, which people paste into issues and support threads.
//
// The patterns here are deliberately specific rather than entropy-based: this
// system is full of long hex strings that are NOT secrets — content digests,
// repository digests, markers, cursors — and masking those would leave the
// diagnostics useless for the failures they exist to explain.

const PATTERNS: readonly RegExp[] = [
  // Anything after an auth scheme, to the end of the header value.
  /\b(?:Authorization|Proxy-Authorization)\s*:\s*\S+(?:\s+\S+)?/gi,
  /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Credentials embedded in a URL's userinfo.
  /\/\/[^/\s:@]+:[^/\s@]+@/g,
  // Provider token shapes.
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bgho_[A-Za-z0-9]{16,}/g,
  /\bghu_[A-Za-z0-9]{16,}/g,
  /\bghs_[A-Za-z0-9]{16,}/g,
  /\bghr_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bglptt-[A-Za-z0-9_-]{16,}/g,
  // Model provider keys.
  /\bsk-[A-Za-z0-9-]{2,}-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
];

/**
 * Returns the message with anything that looks like a credential replaced by
 * `[redacted]`. Never throws: a diagnostic that cannot be produced is worse
 * than one that is partly masked.
 */
export function redactSecrets(message: string): string {
  let result = message;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, (match) => (
      // Keep the URL delimiters so the remaining text still reads as a URL.
      match.startsWith("//") ? "//[redacted]@" : "[redacted]"
    ));
  }
  return result;
}

/** Convenience for the common `catch (error)` diagnostic path. */
export function redactedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message);
}
