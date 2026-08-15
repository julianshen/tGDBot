import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../src/conversation/redact.js";

describe("redactSecrets", () => {
  // `gh` and `glab` failures quote the request they attempted, so a provider
  // error can carry the credential that was used to make it. These land in
  // local diagnostics, which people paste into issues.
  it.each([
    ["GitHub personal token", "failed: ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained token", "failed: github_pat_11ABCDE0Y0abcdefghijkl_9zyxwvutsrq"],
    ["GitHub OAuth token", "bad credentials for gho_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitLab PAT", "401 using glpat-abcdefghij1234567890"],
    ["bearer header", "sent Authorization: Bearer sk-ant-api03-abcdefghijklmnop"],
    ["URL userinfo", "GET https://oauth2:glpat-abcdefghij1234567890@gitlab.example.com/api/v4/x"],
  ])("removes a %s from a provider error", (_label, message) => {
    const redacted = redactSecrets(message);

    expect(redacted).not.toMatch(/ghp_|github_pat_|gho_|glpat-|sk-ant-/);
    expect(redacted).toContain("[redacted]");
  });

  it("keeps the part of the message that explains the failure", () => {
    const redacted = redactSecrets("HTTP 429 rate limit exceeded for ghp_abcdefghijklmnopqrstuvwxyz0123456789");

    expect(redacted).toContain("429");
    expect(redacted).toContain("rate limit exceeded");
  });

  // Digests are not secrets, and masking them would gut the diagnostics: every
  // marker, cursor, and content digest in this system is a long hex string.
  it("leaves a sha-256 digest alone", () => {
    const digest = "a".repeat(64);

    expect(redactSecrets(`content digest ${digest} did not match`)).toContain(digest);
  });
});
