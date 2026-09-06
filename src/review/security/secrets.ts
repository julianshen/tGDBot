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
  { label: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  // Stripe's own live prefix. The test-mode `sk_test_` twin is deliberately
  // absent: it is not a credential worth waking anyone for.
  { label: "a Stripe live secret key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/u },
  { label: "a GitHub personal access token", pattern: /\bghp_[A-Za-z0-9]{36}\b/u },
  { label: "a GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/u },
  { label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { label: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  // The header alone is decisive: nothing else writes this line.
  {
    label: "a private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/u,
  },
];

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
      for (const { label, pattern } of PATTERNS) {
        if (!pattern.test(text)) continue;
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
        });
        // One finding per line: a line matching two formats is one mistake, and
        // reporting it twice would make the count say otherwise.
        break;
      }
    }
  }
  return findings;
}
