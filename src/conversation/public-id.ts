// Public IDs are the only identifiers a human ever types back at tGDBot, so
// they use the command grammar's lowercase base32 alphabet rather than the hex
// of the internal ledger keys: no case folding to get wrong, no characters that
// Markdown or a shell would mangle. Encoding is one-way and content-free — an
// ID reveals nothing about the memory or clarification it names.
import { COMMAND_ID_BASE32_ALPHABET } from "./command-parser.js";

/**
 * Base32-encodes a digest to exactly `length` characters, padding with the
 * alphabet's first character when the input is shorter than the request. The
 * grammar's floor is 12 characters, so shorter output is padded up to it.
 */
export function encodePublicId(prefix: string, digest: Uint8Array | string, length: number): string {
  const bytes = typeof digest === "string" ? Buffer.from(digest, "hex") : digest;
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += COMMAND_ID_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (output.length < length && bits > 0) {
    output += COMMAND_ID_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  while (output.length < 12) {
    output += COMMAND_ID_BASE32_ALPHABET[0];
  }
  return `${prefix}_${output.slice(0, length)}`;
}
