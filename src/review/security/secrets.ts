// Issue #139, `security:secrets`. A HOST detector: it computes findings rather
// than annotating a reviewer's, because a pull request whose only defect is a
// committed credential produces no finding to annotate.
//
// Two properties decide everything else here.
//
// It reports only what it can DECIDE. Every pattern below is a provider's own
// distinctive prefix at that provider's own length — `AKIA` plus twenty, a PEM
// header, `ghp_` plus thirty-six. A credential-shaped literal with no
// recognised format is not reported at all: uncertainty is expressed by saying
// nothing, never by reporting at a lower severity, because `suggestion` asserts
// the code is correct as written and a fired detector has found something that
// is not (spec, "Host detectors must synthesize findings").
//
// And it NEVER PUBLISHES THE SECRET. The finding names the provider, the file
// and the line; the matched text is not interpolated into `message`, `title`,
// or anything else that reaches a comment. A review comment is world-readable
// on a public repository, so echoing the value back would take a credential
// exposed to everyone with repository access and expose it to everyone at all.
import { addedLinesByFile } from "../diff-anchors.js";
import type { Finding } from "../types.js";
import type { RuleDefinition } from "../../rules/types.js";

/** The reserved rule name these findings carry. */
export const SECRETS_RULE_NAME = "security:secrets";

/**
 * The policy `poll.ts` resolves for a conversation command on one of these.
 *
 * Without it `explain` answers "the trusted rule is no longer active" about a
 * finding the host produced moments earlier, because the lookup searches the
 * loaded rules and this name is never dispatched. Same shape and same reason as
 * `CODEX_SECURITY_POLICY` (#120).
 *
 * The text forbids inventing evidence for the same reason that one does: there
 * is no reviewer reasoning to recover here, the finding is a computation, and
 * an explanation must not imply otherwise.
 */
export const SECRETS_POLICY: RuleDefinition = Object.freeze({
  name: SECRETS_RULE_NAME,
  dependsOn: Object.freeze([]),
  body:
    "This finding was computed by the host: a line added by this pull request matches a " +
    "known credential format. Explain what the format is and why committing one matters, " +
    "using the recorded finding and the current code. Do not quote the credential, do not " +
    "guess whether it is live, and do not invent scanner evidence — the host matched a " +
    "pattern and nothing more.",
  sourcePath: "<host:security-secrets>",
});

/**
 * One recognisable credential format.
 *
 * `label` names the provider in the published finding. `pattern` is anchored to
 * the provider's documented shape; a looser pattern would report more and
 * decide less, which is the trade this detector exists to refuse.
 */
interface SecretPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  // Distinctive four-character prefix and a fixed sixteen-character body.
  // ASIA is the STS/session form. Recognising only AKIA advertised an "AWS
  // access key" check that silently passed temporary credentials.
  { label: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  // Stripe's own live prefix. The test-mode `sk_test_` twin is deliberately
  // absent: it is not a credential worth waking anyone for.
  { label: "a Stripe live secret key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/u },
  { label: "a GitHub personal access token", pattern: /\bghp_[A-Za-z0-9]{36}\b/u },
  // `gho_` (OAuth), `ghu_`/`ghs_` (user- and server-to-server app tokens) and
  // `ghr_` (refresh) are the same credential class and grant the same access.
  // Recognising only `ghp_` reported a CLEAN result for a live GitHub token,
  // under a check the README advertises as covering GitHub tokens. Open-ended
  // length because a refresh token runs far past thirty-six characters, and a
  // `{36}` body followed by `\b` cannot match one.
  { label: "a GitHub OAuth or app token", pattern: /\bgh[our]_[A-Za-z0-9]{36,}\b/u },
  // `ghs_` is separate because its shape diverged: GitHub's stateless
  // installation tokens are `ghs_APPID_JWT`, ~520 characters with dots
  // separating the JWT segments. An alphanumeric-only body stops at the first
  // dot and then fails `\b`, so a live installation token read as clean. No
  // `\b` terminator for the same reason the Google key has none: a token
  // ending in `.` or `-` has no word/non-word transition to close on.
  { label: "a GitHub installation token", pattern: /\bghs_[A-Za-z0-9._-]{36,}/u },
  { label: "a GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/u },
  // A trailing `-` is legal in the suffix, and `\b` needs a word/non-word
  // transition — so a key ending in `-` inside quotes matched nothing at all.
  { label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/u },
  { label: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  // App-level tokens are a separate family with its own prefix, not another
  // `xox` letter — a check advertised as covering Slack tokens passed them.
  { label: "a Slack app-level token", pattern: /\bxapp-\d-[A-Za-z0-9-]{10,}\b/u },
  // The header alone is decisive: nothing else writes this line.
  {
    label: "a private key",
    // ENCRYPTED is the standard PKCS#8 header and was not among the
    // alternatives, so an encrypted private key read as clean — its base64
    // body carries no other recognisable prefix.
    // Two shapes, not one prefix list. OpenPGP writes
    // `PGP PRIVATE KEY BLOCK`, so folding `PGP ` into the prefix alternation
    // demanded `PRIVATE KEY-----` immediately after it and matched nothing an
    // OpenPGP export actually contains.
    pattern:
      /-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/u,
  },
];

/**
 * "a, b and c" — the labels already read as noun phrases ("an AWS access key
 * id"), so they only need joining.
 */
function formatList(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1] as string}`;
}

/**
 * Credentials introduced by this pull request.
 *
 * ADDED lines only. A secret already present at the base was not introduced
 * here, and reporting it on every unrelated pull request that touches the file
 * is the alarm fatigue this pass is meant to avoid — it is a real problem, but
 * it is not this review's finding to make.
 *
 * Never throws: a detector that cannot run must not take the review with it.
 * The caller reports the failure through `rulesFailed`.
 */
export function detectCommittedSecrets(diff: string): Finding[] {
  const findings: Finding[] = [];
  for (const [file, lines] of addedLinesByFile(diff)) {
    for (const [line, text] of lines) {
      // EVERY matching format, not the first. One finding per line is still
      // right — a line is one mistake — but naming only the first meant a line
      // carrying an AWS key and a GitHub token told the author to rotate one
      // of them, and which one depended on the order of this array.
      const matched = PATTERNS.filter(({ pattern }) => pattern.test(text)).map((p) => p.label);
      if (matched.length > 0) {
        const label = formatList(matched);
        findings.push({
          file,
          line,
          severity: "blocking",
          category: "security",
          ruleName: SECRETS_RULE_NAME,
          title: `This change commits ${label}`,
          // The value is deliberately absent. Naming the format and the line is
          // enough for the author to find it, and is all that can be said
          // without republishing the credential somewhere more public than the
          // place it already leaked to.
          message:
            `A line added here matches the format of ${label}. Anyone who can read this ` +
            `repository can read the credential, so it should be treated as disclosed: ` +
            `revoke and rotate it, then move the value to configuration the repository ` +
            `does not contain. Removing the line in a later commit does not undo the ` +
            `disclosure, because the value stays in the history.`,
          decision: "new",
          // Keeps the credential out of the diff excerpt the summary fallback
          // renders, and out of the hunk the conversation path would send to a
          // model. The message omitting it is not sufficient on its own.
          redactSource: true,
        });
      }
    }
  }
  return findings;
}
