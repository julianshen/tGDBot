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
import type { StructuralCheck } from "./structural-check.js";
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
 * A symbol a finding names: its own name, plus the receiver it was named on.
 *
 * Both halves matter, and they were learned one at a time (PR #53 review).
 * Matching on the whole dotted string missed that `readL2` and `Cache.readL2`
 * are one method. Matching on the terminal alone then missed that
 * `UserCache.loadEntry` and `ConfigCache.loadEntry` are two.
 */
interface NamedSymbol {
  readonly name: string;
  /** The immediate receiver, or undefined when the finding named it bare. */
  readonly receiver?: string;
}

/**
 * True when two references could name the same thing.
 *
 * Deliberately asymmetric about missing information: a bare mention is
 * compatible with any qualification, because the reviewer simply did not say
 * which receiver — but two references that BOTH name a receiver have to agree.
 */
function sameSymbol(left: NamedSymbol, right: NamedSymbol): boolean {
  if (left.name !== right.name) return false;
  if (left.receiver === undefined || right.receiver === undefined) return true;
  return left.receiver === right.receiver;
}

/**
 * The distinct code symbols a finding names.
 *
 * Identifiers are a better signal than prose precisely because they are NOT the
 * rule's words: they come from the source, so two rules describing one defect
 * name the same symbols however differently they phrase the claim.
 *
 * Two sources, because findings name code both ways: spans in backticks (how a
 * reviewer quotes a symbol) and bare words that LOOK like code — an internal
 * capital or an underscore. Plain English is never harvested from prose, or
 * every finding would "share" its whole sentence.
 *
 * References compatible with each other collapse into one entry, so repetition
 * is free: a finding naming its symbol in the title and again in the message
 * contributes one symbol, not two, which matters because the threshold means
 * "two independently named symbols" and not "two mentions". A bare mention
 * absorbs its qualified form; two different receivers stay separate.
 */
/** Exported for the issue #128 linear-scan regression tests. */
export function identifierSymbols(finding: Finding): NamedSymbol[] {
  const text = `${finding.title ?? ""} ${finding.message}`;
  const found: NamedSymbol[] = [];
  const add = (parts: readonly string[]): void => {
    const name = parts.at(-1)?.toLowerCase();
    if (name === undefined || name.length < MIN_IDENTIFIER_LENGTH) return;
    if (UBIQUITOUS_IDENTIFIERS.has(name)) return;
    const receiver = parts.length > 1 ? parts.at(-2)?.toLowerCase() : undefined;
    const candidate: NamedSymbol = receiver === undefined ? { name } : { name, receiver };
    const existing = found.findIndex((symbol) => sameSymbol(symbol, candidate));
    if (existing < 0) {
      found.push(candidate);
      return;
    }
    // A bare mention is the more general form, so it wins: once the finding has
    // said the name unqualified, a receiver adds nothing to what it claims.
    if (candidate.receiver === undefined) found[existing] = candidate;
  };
  for (const match of text.matchAll(/`([^`\n]{1,200})`/gu)) {
    add((match[1] ?? "").split(/[^A-Za-z0-9_]+/u).filter(Boolean));
  }
  // Quoted spans are removed before the bare scan, or a camelCase name INSIDE
  // one would be counted a second time.
  const unquoted = text.replace(/`[^`\n]{1,200}`/gu, " ");
  // Candidate words are extracted with a LINEAR token regex and then filtered
  // by a linear scan (see isMultiPartIdentifier): the previous single regex
  // nested an ambiguous alternation inside a `+` loop and backtracked
  // exponentially on same-letter runs (CodeQL js/redos x2, issue #128).
  for (const match of unquoted.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\b/gu)) {
    if (isMultiPartIdentifier(match[0])) add([match[0]]);
  }
  return found;
}

const isAlphanumeric = (ch: string): boolean =>
  (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");

// No real identifier approaches this; the cap keeps the part-scanner's
// worst case (re-scanning the tail per split point) trivially bounded even
// on adversarial single-token inputs.
const MAX_IDENTIFIER_TOKEN_LENGTH = 200;

/**
 * Whether an extracted word is a MULTI-PART identifier — camelCase humps or
 * internal underscores — the words the clusterer deduplicates on. Mirrors the
 * part grammar of the regex it replaced
 * (`[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*|_[A-Za-z0-9]+)+`): a letter-led
 * alnum prefix, then one or more parts, each an uppercase-led or
 * underscore-led alnum run, consuming the word to its end. The prefix split
 * point is tried from shortest to longest because the original regex's
 * backtracking could stop the prefix early to let an uppercase start a part.
 */
function isMultiPartIdentifier(word: string): boolean {
  if (word.length > MAX_IDENTIFIER_TOKEN_LENGTH) return false;
  let runEnd = 1; // extraction guarantees word[0] is a letter
  while (runEnd < word.length && isAlphanumeric(word[runEnd]!)) runEnd += 1;
  for (let split = 1; split <= runEnd; split += 1) {
    let i = split;
    let parts = 0;
    let failed = false;
    while (i < word.length) {
      const ch = word[i]!;
      if (ch === "_") {
        i += 1;
        const runStart = i;
        while (i < word.length && isAlphanumeric(word[i]!)) i += 1;
        if (i === runStart) { failed = true; break; } // `_[A-Za-z0-9]+` needs at least one
      } else if (ch >= "A" && ch <= "Z") {
        i += 1;
        while (i < word.length && isAlphanumeric(word[i]!)) i += 1;
      } else {
        failed = true; break;
      }
      parts += 1;
    }
    if (!failed && i === word.length && parts >= 1) return true;
  }
  return false;
}

/**
 * How many distinct symbols the two findings both name.
 *
 * Counted on each side and reduced to the smaller, so one finding naming a
 * method twice under different receivers cannot inflate the count on its own.
 */
function sharedIdentifierCount(left: readonly NamedSymbol[], right: readonly NamedSymbol[]): number {
  const matched = (from: readonly NamedSymbol[], against: readonly NamedSymbol[]): number =>
    from.filter((symbol) => against.some((other) => sameSymbol(symbol, other))).length;
  return Math.min(matched(left, right), matched(right, left));
}

/**
 * The text that identifies WHICH defect a finding is about.
 *
 * An authored `title` (ADR-008) is the rule's own one-line statement of the
 * claim, so it is the better signal when present; otherwise the message's first
 * sentence plays that role, since reviewers lead with the claim and follow with
 * the evidence.
 */
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
  leftIdentifiers: readonly NamedSymbol[],
  rightIdentifiers: readonly NamedSymbol[],
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
/**
 * How much a host check is worth keeping when two duplicates disagree.
 *
 * An ESTABLISHED result beats "not performed", which beats nothing at all.
 * Everything this check emits is either an occurrence it actually read or an
 * admission that it did not look, and an admission never carries information
 * the reader could not get from the finding alone — so preferring the answer
 * loses nothing and gains the search.
 */
function checkRank(check: StructuralCheck | undefined): number {
  if (check === undefined) return 2;
  return check.status === "not-checked" ? 1 : 0;
}

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
  // Issue #75 (Codex review, round 2): the winner above is chosen by SEVERITY
  // alone, so a finding the host had checked could be discarded in favour of a
  // byte-identical twin that carried no claim — taking a computed result with
  // it and republishing the assertion unqualified. These are the same sentence
  // at the same location by definition of `exactKey`, so a check that applied
  // to one applies to the other; carry it rather than lose it.
  //
  // Round 11: carrying it only onto a winner that had NO check was not enough.
  // Duplicates can now genuinely differ — a claim budget can run out between
  // them, and a failed check is deliberately not shared with its retry — so the
  // winner may hold `not-checked` while a twin holds a real answer. Keeping the
  // winner's told readers "the check was not performed" about a search that had
  // found matches, which is worse than either input.
  for (const finding of findings) {
    if (finding.claim === undefined || finding.hostCheck === undefined) continue;
    const key = exactKey(finding);
    const winner = bestByKey.get(key);
    if (winner === undefined || winner === finding) continue;
    if (checkRank(winner.hostCheck) <= checkRank(finding.hostCheck)) continue;
    bestByKey.set(key, { ...winner, claim: finding.claim, hostCheck: finding.hostCheck });
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
