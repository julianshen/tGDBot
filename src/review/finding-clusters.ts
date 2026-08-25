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
// Issue #37: prose similarity is the wrong instrument when each rule is
// deliberately pushed into its own domain vocabulary. On hmchangw/newchat#188
// one revocation-propagation defect was reported as a consistency problem, a
// security problem, an ordering problem and an idempotency problem, sharing
// almost no words between them.
//
// Identifiers are a better signal precisely because they are NOT the rule's
// words: they come from the source, so two rules describing one defect name the
// same symbols however differently they phrase the claim.
//
// Two, not one. Half the findings in a file will name the function the file is
// about, so a single shared symbol is co-occurrence rather than corroboration.
const SHARED_IDENTIFIERS = 2;

// Short names (`err`, `ctx`, `id`) appear everywhere and identify nothing.
const MIN_IDENTIFIER_LENGTH = 4;

// Names common enough that sharing them says nothing about WHICH defect is
// meant. Deliberately short: the length floor above already removes most noise,
// and an over-long list would start suppressing real signal.
const UBIQUITOUS_IDENTIFIERS = new Set([
  "error", "errors", "context", "nil", "null", "true", "false", "void",
  "string", "number", "value", "values", "data", "result", "results",
  "client", "config", "options", "option", "request", "response",
  "handler", "func", "function", "return", "struct", "interface", "type",
  "test", "tests", "name", "names", "list", "item", "items",
]);

/**
 * The distinct code symbols a finding names, as a set of identities.
 *
 * A reference's identity is its LAST component: `Cache.readL2` and a bare
 * `readL2` are one method, while `Cache.readL2` and `Cache.writeL2` are two
 * that merely share a receiver (PR #53 review). Taking the terminal component
 * also makes repetition free — a finding naming its symbol in both the title
 * and the message contributes one identity, not two, which matters because the
 * threshold means "two independently named symbols" and not "two mentions".
 *
 * Identifiers are a better signal than prose precisely because they are NOT the
 * rule's words: they come from the source, so two rules describing one defect
 * name the same symbols however differently they phrase the claim.
 *
 * Two sources, because findings name code both ways: spans in backticks (how a
 * reviewer quotes a symbol) and bare words that LOOK like code — an internal
 * capital or an underscore. Plain English is never harvested from prose, or
 * every finding would "share" its whole sentence.
 */
function identifierSymbols(finding: Finding): Set<string> {
  const text = `${finding.title ?? ""} ${finding.message}`;
  const symbols = new Set<string>();
  const add = (parts: readonly string[]): void => {
    // The terminal component names the thing; earlier ones qualify it.
    const terminal = parts.at(-1);
    if (terminal === undefined) return;
    const token = terminal.toLowerCase();
    if (token.length < MIN_IDENTIFIER_LENGTH) return;
    if (UBIQUITOUS_IDENTIFIERS.has(token)) return;
    symbols.add(token);
  };
  for (const match of text.matchAll(/`([^`\n]{1,200})`/gu)) {
    add((match[1] ?? "").split(/[^A-Za-z0-9_]+/u).filter(Boolean));
  }
  // Quoted spans are removed before the bare scan, or a camelCase name INSIDE
  // one would be counted a second time.
  const unquoted = text.replace(/`[^`\n]{1,200}`/gu, " ");
  for (const match of unquoted.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*|_[A-Za-z0-9]+)+\b/gu)) {
    add([match[0]]);
  }
  return symbols;
}

/** How many distinct symbols the two findings both name. */
function sharedIdentifierCount(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const symbol of left) if (right.has(symbol)) shared += 1;
  return shared;
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
  leftIdentifiers: Set<string>,
  rightIdentifiers: Set<string>,
): boolean {
  // The cross-file gate is deliberately NOT relaxed by the identifier signal.
  // Only a cluster's representative receives an inline comment (orchestrate.ts),
  // so merging across files would move a finding's comment off the file it is
  // about — trading one presentation problem for a worse one.
  if (left.file !== right.file) return false;
  // Naming the same code is evidence the prose can miss entirely.
  if (sharedIdentifierCount(leftIdentifiers, rightIdentifiers) >= SHARED_IDENTIFIERS) return true;
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
  const identifiers = unique.map(identifierSymbols);

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
      if (sameRootCause(unique[i]!, unique[j]!, tokens[i]!, tokens[j]!, identifiers[i]!, identifiers[j]!)) union(i, j);
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


/**
 * Groups that describe ONE defect spread across several files (issue #48).
 *
 * Presentation only, and deliberately separate from `clusterFindings`: this
 * never chooses a representative for placement and never affects where an
 * inline comment goes. Only a cluster's representative receives an inline
 * comment, so merging across files in the inline path would move a finding's
 * comment off the file it is about. Describing the relationship in the summary
 * costs nothing, because nothing moves.
 *
 * The signal is identifiers ONLY — never prose. Same-file clustering can lean
 * on proximity as corroboration; across files there is none, and similarity
 * between two rules' vocabularies is exactly the weak evidence that let one
 * revocation defect be reported six ways on hmchangw/newchat#188. Identifiers
 * come from the source rather than the rule's words, so they survive that.
 *
 * A group confined to one file is dropped: it is already collapsed into a
 * single inline comment, and repeating it here would be noise.
 */
export function crossFileGroups(findings: readonly Finding[]): FindingCluster[] {
  const identifiers = findings.map(identifierSymbols);
  const parent = findings.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      if (sharedIdentifierCount(identifiers[i]!, identifiers[j]!) < SHARED_IDENTIFIERS) continue;
      const left = find(i);
      const right = find(j);
      if (left !== right) parent[Math.max(left, right)] = Math.min(left, right);
    }
  }

  const byRoot = new Map<number, Finding[]>();
  for (const [index, finding] of findings.entries()) {
    const root = find(index);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(finding);
    else byRoot.set(root, [finding]);
  }

  return [...byRoot.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, members]) => {
      if (members.length < 2) return [];
      if (new Set(members.map((member) => member.file)).size < 2) return [];
      const ordered = [...members].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          b.message.length - a.message.length,
      );
      const lines = [
        ...new Set(members.map((m) => m.line).filter((line): line is number => typeof line === "number")),
      ].sort((a, b) => a - b);
      return [{
        representative: ordered[0]!,
        members: ordered,
        rules: [...new Set(members.map((member) => member.ruleName))],
        lines,
      }];
    });
}
