// Issue #139 stage 3's execution: the bounded attack-path pass.
//
// Runs AFTER discovery, over security findings only, and asks one model call
// per eligible candidate for the six facts. Then stage 4 overwrites the two
// fields the host can establish, and stage 5 rates severity from the result.
//
// Three things bound the cost, because a second model pass is real spend:
//
//   - only `category: "security"` findings are eligible at all;
//   - only the first `MAX_ANALYZED_CANDIDATES` of them, worst-severity first,
//     so a diff that trips fifty detectors does not buy fifty model calls;
//   - the pass does not run at all when there are no candidates, the way #80
//     gates the structural clone.
//
// Everything beyond the budget gets `not-analyzed` with a reason that says so.
// That is the whole point of `not-analyzed` being a result rather than an
// absence: a reader must be able to tell "we looked and could not say" from
// "we never looked", and "there were more candidates than we rate" from both.
import type { Finding } from "../types.js";
import {
  parseAttackPathFacts,
  rateSeverity,
  type AttackPathFacts,
  type AttackPathResult,
} from "./attack-path.js";
import { establishReachability } from "./reachability.js";
import { RESERVED_HOST_RULE_NAMES } from "./host-detectors.js";
import { redactedMessage } from "../../conversation/redact.js";

/**
 * How many findings one review will pay an analysis call for.
 *
 * Small on purpose. The candidates are sorted worst-first, so the budget
 * spends itself on the findings whose severity matters most to get right, and
 * the rest say plainly that they were not rated.
 */
export const MAX_ANALYZED_CANDIDATES = 10;

/** Asks one model for one finding's facts. Injected so tests never touch a provider. */
export type AttackPathAnalyzer = (finding: Finding) => Promise<unknown>;

/** Reads a file at the HEAD revision. `undefined` when it cannot be read. */
export type HeadFileReader = (file: string) => Promise<string | undefined>;

export interface AnalyzeInput {
  readonly findings: readonly Finding[];
  readonly analyze: AttackPathAnalyzer;
  readonly readHeadFile: HeadFileReader;
}

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

/**
 * A publishable reason for a failed analysis.
 *
 * Bounded and CLASSIFIED rather than the provider's own words. The timeout is
 * named because the host wrote that message and it tells a reader something
 * actionable; everything else collapses to one phrase, because a provider
 * error can carry request identifiers, model names, prompt fragments and
 * account details, and a review comment is world-readable.
 */
function classifyAnalysisFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message)) {
    return "the attack-path analysis timed out before it could answer";
  }
  return "the attack-path analysis did not complete; the reason is in this run's logs";
}

/**
 * Security findings from DISCOVERY, worst first, so a small budget is spent
 * where it matters.
 *
 * Host-detector findings are excluded, and that exclusion is load-bearing
 * rather than an optimisation. Their severity is computed, not judged: a
 * committed credential is `blocking` because the host matched a provider's own
 * format, and there is nothing for a model to weigh. Letting the pass re-rate
 * them would let a reviewer's guess about reachability downgrade a live
 * credential to `suggestion` — a level this project reserves for code that is
 * CORRECT — and would spend a model call to do it.
 *
 * The attack-path question is also the wrong question for them. "Can an
 * attacker reach this line?" does not describe the exposure of a secret that
 * is already published to everyone with repository access.
 */
export function eligibleCandidates(findings: readonly Finding[]): readonly Finding[] {
  return findings
    .filter((finding) =>
      finding.category === "security" && !RESERVED_HOST_RULE_NAMES.has(finding.ruleName))
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Runs the attack-path pass and returns the findings with `attackPath` and a
 * re-rated `severity` attached.
 *
 * Order is deliberate and load-bearing:
 *
 *   1. the reviewer answers all six facts, every one stamped `reviewer`;
 *   2. the host OVERWRITES `vector` and `authScope` with what it can
 *      establish — including with `unknown`, because an unmatched pattern must
 *      not leave a reviewer's guess driving severity;
 *   3. severity is rated from the result.
 *
 * Step 2 overwriting unconditionally is the correction from spec review. An
 * earlier draft kept the reviewer's value when no pattern matched, which —
 * since the supported list is short — would have let model text drive severity
 * on almost every review.
 *
 * Never throws. A failed analysis leaves the finding exactly as discovery
 * produced it, with `not-analyzed` recording why.
 */
export async function analyzeAttackPaths(input: AnalyzeInput): Promise<Finding[]> {
  const candidates = eligibleCandidates(input.findings);
  if (candidates.length === 0) return [...input.findings];

  const analyzed = new Map<Finding, AttackPathResult>();
  const budgeted = candidates.slice(0, MAX_ANALYZED_CANDIDATES);

  for (const finding of candidates.slice(MAX_ANALYZED_CANDIDATES)) {
    analyzed.set(finding, {
      status: "not-analyzed",
      reason:
        `this review had ${candidates.length} security findings and rates the ` +
        `${MAX_ANALYZED_CANDIDATES} most severe; this one was outside that budget`,
    });
  }

  for (const finding of budgeted) {
    let facts: AttackPathFacts;
    try {
      facts = parseAttackPathFacts(await input.analyze(finding));
    } catch (error) {
      // The reason is PUBLISHED — `renderAttackPath` puts it in the inline
      // comment — so it must not be the raw provider message. Provider and SDK
      // errors echo request details, and this comment is world-readable on a
      // public repository. Same stance `ruleFailureReasons` already takes: a
      // classified phrase reaches the reader, the raw error reaches stderr
      // (Codex review of PR #151).
      console.warn(
        `analyzeAttackPaths: the analysis of a finding in ${finding.file} failed ` +
          `(${redactedMessage(error)})`,
      );
      analyzed.set(finding, { status: "not-analyzed", reason: classifyAnalysisFailure(error) });
      continue;
    }

    // Stage 4. Unconditional overwrite — see the doc comment.
    let headText: string | undefined;
    try {
      headText = await input.readHeadFile(finding.file);
    } catch {
      headText = undefined;
    }
    const established = establishReachability({ file: finding.file, headText });
    analyzed.set(finding, {
      status: "analyzed",
      facts: { ...facts, vector: established.vector, authScope: established.authScope },
    });
  }

  return input.findings.map((finding) => {
    const result = analyzed.get(finding);
    if (result === undefined) return finding;
    if (result.status !== "analyzed") return { ...finding, attackPath: result };
    return {
      ...finding,
      attackPath: result,
      severity: rateSeverity(finding.severity, result.facts),
    };
  });
}
