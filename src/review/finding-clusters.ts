// Grouping findings by ROOT CAUSE rather than by exact text.
//
// Every rule reviews the same diff, so a defect that several rules can each
// recognise gets reported once per rule, in each rule's own words. Exact
// file+line+message dedup cannot see through the rewording: on PR #281 one
// Set/Get race was reported five times across four rules, and a reader had to
// work out by hand that fourteen entries were about eight problems.
//
// PRESENTATION ONLY — this never drops a finding. A cluster retains every
// member, so the worst an over-eager merge can do is NEST a finding under a
// sibling's headline instead of listing it separately. That property is what
// lets the thresholds below be tuned for recall: a missed merge leaves the old
// noisy behaviour, a wrong merge stays fully readable.
//
// Pure and synchronous — no I/O, no LLM call. Deliberately: this runs after the
// review has already been paid for, and a grouping pass that could fail, cost
// money, or return something different on a retry is not worth the tidier list.
import type { Finding } from "./types.js";

export interface FindingCluster {
  /** The member a reader should see first: highest severity, then most detailed. */
  readonly representative: Finding;
  /** Every member, representative included, ordered by severity then first-seen. */
  readonly members: readonly Finding[];
  /** Contributing rule names, deduped, in first-seen order. */
  readonly rules: readonly string[];
  /** Distinct lines the members point at, ascending. Empty when none carry a line. */
  readonly lines: readonly number[];
}

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

// Two findings on the SAME line of the same file are still two findings — a
// window is needed because rules disagree about which line of a construct to
// blame (the `if`, the call inside it, or the closing brace). Ten lines is about
// the height of a function body being described, and beyond it co-location stops
// being evidence of anything.
const NEARBY_LINES = 10;

// Similarity needed to merge findings that are NOT co-located. High enough that
// it effectively means "the same claim, maybe reworded".
const IDENTICAL_CLAIM = 0.6;

// Similarity needed when the findings are already within NEARBY_LINES. Lower,
// because proximity is itself corroborating evidence.
const RELATED_CLAIM = 0.25;

// A ratio computed over two- or three-token claims is noise, not evidence:
// "Issue A" and "Issue B" both reduce to {issue} and score a perfect 1.0, and
// "first finding"/"second finding" clear the co-located threshold on the word
// "finding" alone. Requiring a floor of genuinely shared vocabulary means short
// claims must actually agree rather than merely be short. (Caught by AC-7.1,
// which asserts that findings differing only by a single letter stay distinct.)
const MIN_SHARED_TOKENS = 3;

// Words that carry no signal about WHICH defect is being described. Removing
// them stops two unrelated findings scoring on shared English scaffolding.
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "can", "could", "will", "would", "may", "might", "must", "should",
  "do", "does", "did", "not", "no", "nor", "its", "it", "this", "that",
  "these", "those", "of", "in", "on", "at", "to", "for", "by", "with",
  "from", "into", "and", "or", "but", "as", "if", "when", "then", "than",
  "so", "up", "out", "off", "over", "under", "still", "all", "any", "one",
  "here", "there", "which", "while", "also", "only", "just", "same", "such",
  "both", "each", "other", "another", "some", "every", "has", "have", "had",
]);

// Deliberately crude suffix folding — enough to make "atomically"/"atomic" and
// "rotations"/"rotation" the same token without pulling in a stemmer. Applied
// longest-suffix-first, and never below three characters (so "does"/"was" are
// not mangled into noise).
const SUFFIXES = ["ically", "ally", "ing", "ely", "ly", "es", "ed", "s"];

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      return suffix === "ically" ? `${base}ic` : base;
    }
  }
  return word;
}

/**
 * The text that identifies WHICH defect a finding is about.
 *
 * An authored `title` (ADR-008) is the rule's own one-line statement of the
 * claim, so it is the better signal when present; otherwise the message's first
 * sentence plays that role, since reviewers lead with the claim and follow with
 * the evidence.
 */
function claimText(finding: Finding): string {
  if (finding.title?.trim()) return finding.title;
  const firstSentence = /^(.*?[.!?])(?:\s|$)/su.exec(finding.message.trim())?.[1];
  return firstSentence ?? finding.message;
}

function claimTokens(finding: Finding): Set<string> {
  const words = claimText(finding)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);
  return new Set(words);
}

function sharedTokens(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

function jaccard(a: Set<string>, b: Set<string>, shared: number): number {
  if (a.size === 0 || b.size === 0) return 0;
  return shared / (a.size + b.size - shared);
}

function sameRootCause(
  left: Finding,
  right: Finding,
  leftTokens: Set<string>,
  rightTokens: Set<string>,
): boolean {
  if (left.file !== right.file) return false;
  const shared = sharedTokens(leftTokens, rightTokens);
  if (shared < MIN_SHARED_TOKENS) return false;
  const score = jaccard(leftTokens, rightTokens, shared);
  if (score >= IDENTICAL_CLAIM) return true;
  // Proximity only counts when BOTH findings actually claim a line; an
  // unanchored finding has no position to be near.
  const colocated =
    typeof left.line === "number" &&
    typeof right.line === "number" &&
    Math.abs(left.line - right.line) <= NEARBY_LINES;
  return colocated && score >= RELATED_CLAIM;
}

function normalizeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ");
}

// See orchestrate.ts: JSON.stringify of the field tuple is a delimiter-free,
// collision-free key encoding.
function exactKey(finding: Finding): string {
  return JSON.stringify([finding.file, finding.line ?? null, normalizeMessage(finding.message)]);
}

/**
 * Collapses byte-identical restatements first — two rules emitting the very same
 * sentence at the very same line is not a judgement call, and resolving it here
 * keeps the similarity pass from having to reason about exact ties.
 */
function collapseExactDuplicates(
  findings: readonly Finding[],
): { unique: Finding[]; rulesByFinding: Map<Finding, string[]> } {
  const bestByKey = new Map<string, Finding>();
  // Collapsing happens before clustering, so without this the SECOND rule to
  // report an identical sentence lost its name — and independent corroboration
  // is precisely what the rules metadata is for.
  const rulesByKey = new Map<string, string[]>();
  for (const finding of findings) {
    const key = exactKey(finding);
    const rules = rulesByKey.get(key) ?? [];
    if (!rules.includes(finding.ruleName)) rules.push(finding.ruleName);
    rulesByKey.set(key, rules);
    const existing = bestByKey.get(key);
    if (!existing || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) {
      bestByKey.set(key, finding);
    }
  }
  const rulesByFinding = new Map<Finding, string[]>();
  for (const [key, finding] of bestByKey) rulesByFinding.set(finding, rulesByKey.get(key) ?? [finding.ruleName]);
  return { unique: [...bestByKey.values()], rulesByFinding };
}

/**
 * Groups findings that describe one underlying defect.
 *
 * Single-linkage: A joins B's cluster if it matches ANY member. Rules describe
 * the same defect from their own angle, so the chain "atomicity" → "fallback
 * atomicity" → "fallback fans out wrong bytes" holds together even though its
 * two ends share almost no vocabulary. Transitivity is the intended behaviour,
 * not a tolerated side effect.
 *
 * Clusters come back in first-seen order, and so do members within a cluster
 * once severity has been applied — deterministic output for a deterministic
 * comment body.
 */
export function clusterFindings(findings: readonly Finding[]): FindingCluster[] {
  const { unique, rulesByFinding } = collapseExactDuplicates(findings);
  const tokens = unique.map(claimTokens);

  // Union-find over finding indices.
  const parent = unique.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    for (let walk = index; parent[walk] !== root; ) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    // Keep the EARLIER index as the root so cluster order follows first sight.
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      if (sameRootCause(unique[i]!, unique[j]!, tokens[i]!, tokens[j]!)) union(i, j);
    }
  }

  const byRoot = new Map<number, Finding[]>();
  for (const [index, finding] of unique.entries()) {
    const root = find(index);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(finding);
    else byRoot.set(root, [finding]);
  }

  return [...byRoot.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, members]) => {
      // Severity first, then the most detailed statement of the claim: a reader
      // scanning one headline per cluster should get the worst and best-argued
      // version of it. `sort` is stable, so equal members keep first-seen order.
      const ordered = [...members].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          b.message.length - a.message.length,
      );
      const lines = [
        ...new Set(
          members
            .map((member) => member.line)
            .filter((line): line is number => typeof line === "number"),
        ),
      ].sort((a, b) => a - b);
      return {
        representative: ordered[0]!,
        members: ordered,
        rules: [...new Set(members.flatMap((member) => rulesByFinding.get(member) ?? [member.ruleName]))],
        lines,
      };
    });
}
