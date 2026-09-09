// Issue #139, `security:secrets`. The tests are ordered by how much the
// property matters, not by how the code is laid out.
import { describe, expect, it } from "vitest";
import {
  detectCommittedSecrets,
  SECRETS_POLICY,
  SECRETS_RULE_NAME,
} from "../../../src/review/security/secrets.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function diffAdding(file: string, ...lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${1 + lines.length} @@`,
    " keep",
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

describe("detectCommittedSecrets", () => {
  // THE property. A review comment is world-readable on a public repository,
  // so echoing the value would take a credential exposed to everyone with
  // repository access and expose it to everyone at all.
  it("never publishes the credential it found", () => {
    const findings = detectCommittedSecrets(diffAdding("src/a.ts", `const key = "${AWS_KEY}";`));

    expect(findings).toHaveLength(1);
    const published = JSON.stringify(findings[0]);
    expect(published).not.toContain(AWS_KEY);
    // Not even a fragment: a distinctive prefix plus a few characters is
    // enough to make the rest guessable in a way a full value is not.
    expect(published).not.toContain(AWS_KEY.slice(0, 12));
  });

  it("says enough to find it without quoting it", () => {
    const [finding] = detectCommittedSecrets(diffAdding("src/a.ts", `const key = "${AWS_KEY}";`));

    expect(finding).toMatchObject({
      file: "src/a.ts",
      line: 2,
      severity: "blocking",
      ruleName: SECRETS_RULE_NAME,
      category: "security",
    });
    expect(finding?.message).toMatch(/revoke and rotate/i);
    // The disclosure is not undone by deleting the line later, and a reader
    // who does not know that will do the wrong thing with this finding.
    expect(finding?.message).toMatch(/history/i);
  });

  it("reports only lines this pull request ADDED", () => {
    // A secret already at the base was not introduced here. Reporting it on
    // every unrelated change that touches the file is the alarm fatigue this
    // pass exists to avoid — a real problem, but not this review's finding.
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      ` const existing = "${AWS_KEY}";`,
      "-const old = 1;",
      "+const next = 2;",
    ].join("\n");

    expect(detectCommittedSecrets(diff)).toEqual([]);
  });

  it("does not report a removed credential", () => {
    // Deleting one is the fix, not the defect.
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,1 @@",
      ` const keep = 1;`,
      `-const key = "${AWS_KEY}";`,
    ].join("\n");

    expect(detectCommittedSecrets(diff)).toEqual([]);
  });

  it("stays silent on a credential-shaped literal it cannot identify", () => {
    // Uncertainty is expressed by saying nothing, never by reporting at a
    // lower severity: `suggestion` asserts the code is correct as written, and
    // a fired detector has by construction found something that is not.
    const findings = detectCommittedSecrets(diffAdding(
      "src/a.ts",
      'const token = "s3cr3t-looking-value-of-some-length";',
      'const password = "hunter2";',
    ));

    expect(findings).toEqual([]);
  });

  it.each([
    ["an AWS access key id", `const k = "${AWS_KEY}";`],
    ["a Stripe live secret key", 'const k = "sk_live_51H8xQ2eZvKYlo2C";'],
    ["a GitHub personal access token", `const k = "ghp_${"a".repeat(36)}";`],
    ["a Google API key", `const k = "AIza${"B".repeat(35)}";`],
    ["a Slack token", 'const k = "xoxb-123456789012-abcdef";'],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("recognises %s", (label, line) => {
    const [finding] = detectCommittedSecrets(diffAdding("src/a.ts", line));
    expect(finding?.title).toContain(label);
  });

  it.each([
    ["a temporary AWS access key id (ASIA)", 'const k = "ASIAIOSFODNN7EXAMPLE";'],
    ["a Google API key ending in a hyphen", `const k = "AIza${"B".repeat(34)}-";`],
    ["an encrypted PKCS#8 private key", "-----BEGIN ENCRYPTED PRIVATE KEY-----"],
    ["a GitHub OAuth token (gho_)", `const k = "gho_${"a".repeat(36)}";`],
    ["a GitHub user-to-server token (ghu_)", `const k = "ghu_${"a".repeat(36)}";`],
    ["a GitHub server-to-server token (ghs_)", `const k = "ghs_${"a".repeat(36)}";`],
    // Refresh tokens run well past thirty-six characters, so a fixed-length
    // body followed by `\b` could not match one however many prefixes it listed.
    ["a GitHub refresh token (ghr_, long)", `const k = "ghr_${"a".repeat(76)}";`],
    ["an OpenPGP secret key block", "-----BEGIN PGP PRIVATE KEY BLOCK-----"],
    ["a Slack app-level token", 'const k = "xapp-1-A012345678-1234567890123-abcdef0123";'],
  ])("recognises %s", (_label, line) => {
    // Each of these read as CLEAN before review: an STS key the advertised
    // "AWS access key" check silently passed, a legal suffix that `\b` could
    // not terminate, and the standard encrypted header missing from the
    // alternatives. A pattern gap in a secrets detector fails silently and
    // looks like a clean review (Codex review of PR #147).
    expect(detectCommittedSecrets(diffAdding("src/a.ts", line))).toHaveLength(1);
  });

  it("marks its findings so no published surface quotes the source line", () => {
    // The message omitting the credential is not enough. `orchestrate` attaches
    // a hunk snippet the summary fallback renders in full, and the
    // conversation path sends the hunk to a model that may quote it back.
    const [finding] = detectCommittedSecrets(diffAdding("src/a.ts", `const k = "${AWS_KEY}";`));
    expect(finding?.redactSource).toBe(true);
  });

  it("does not report a Stripe TEST key", () => {
    // Not a credential worth waking anyone for, and reporting it would train
    // readers that this detector cries wolf.
    expect(detectCommittedSecrets(diffAdding("src/a.ts", 'const k = "sk_test_51H8xQ2eZvKYlo2C";')))
      .toEqual([]);
  });

  it("reports one finding for a line matching two formats", () => {
    // One mistake. Two findings would make the count say otherwise.
    const findings = detectCommittedSecrets(diffAdding(
      "src/a.ts",
      `const a = "${AWS_KEY}"; const b = "ghp_${"a".repeat(36)}";`,
    ));
    expect(findings).toHaveLength(1);
  });

  it("attributes a finding to the head path of a renamed file", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,1 +1,2 @@",
      " keep",
      `+const k = "${AWS_KEY}";`,
    ].join("\n");

    // An added line only ever belongs to the head path; recording it under the
    // pre-rename name would report the secret in a file the head lacks.
    expect(detectCommittedSecrets(diff)[0]?.file).toBe("new.ts");
  });
});

describe("SECRETS_POLICY", () => {
  it("is a host-owned rule the loader never dispatches", () => {
    expect(SECRETS_POLICY.name).toBe(SECRETS_RULE_NAME);
    expect(SECRETS_POLICY.sourcePath).toMatch(/^<host:/u);
  });

  it("forbids inventing evidence, because there is none to recover", () => {
    // The finding is a computation, not a reviewer's reasoning, and an
    // explanation must not imply otherwise.
    expect(SECRETS_POLICY.body).toMatch(/do not invent/i);
    expect(SECRETS_POLICY.body).toMatch(/do not quote/i);
  });
});
