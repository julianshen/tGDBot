// Issue #69: is a changed dependency's name one keystroke from another name
// the same manifest already declares?
//
// Pure and synchronous. No network, no popularity list — the corpus is names
// the host already parsed out of the file. A match is two identifiers and a
// distance of 1, classified by the edit. The identifiers stay out of this
// module's callers' trusted text; only the distance and the kind are host
// judgement.

export type TyposquatKind = "insertion" | "deletion" | "substitution" | "transposition";

export interface TyposquatMatch {
  readonly existing: string;
  readonly distance: 1;
  readonly kind: TyposquatKind;
}

interface SplitName {
  readonly scope: string | undefined;
  readonly local: string;
}

function splitName(name: string): SplitName {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash > 1) {
      return { scope: name.slice(1, slash), local: name.slice(slash + 1) };
    }
  }
  return { scope: undefined, local: name };
}

/**
 * Index of the one extra character in `longer`, or undefined if the strings
 * are not a single insertion apart.
 */
function extraIndex(longer: string, shorter: string): number | undefined {
  if (longer.length !== shorter.length + 1) return undefined;
  let skipped = false;
  let at = 0;
  let i = 0;
  let j = 0;
  while (i < longer.length) {
    if (j < shorter.length && longer[i] === shorter[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return undefined;
    skipped = true;
    at = i;
    i += 1;
  }
  return j === shorter.length ? at : undefined;
}

/**
 * A one-keystroke edit from `existing` to `candidate`, or undefined.
 *
 * Every single edit flags here — truncations that drop a repeated letter
 * (`expres`/`express`), doubled letters (`chalkk`/`chalk`), and affix edits
 * alike (`lodas`, `lodashs`, `xlodash` vs `lodash`). A blanket affix exemption
 * was tried and was wrong: it suppressed those real typosquats along with the
 * legitimate pairs. The legitimate pairs (`preact`/`react`, `vuex`/`vue`)
 * are a closed list checked by the caller instead.
 */
function classify(candidate: string, existing: string): TyposquatKind | undefined {
  if (candidate === existing) return undefined;
  const delta = candidate.length - existing.length;
  if (delta > 1 || delta < -1) return undefined;

  if (delta === 0) {
    const diffs: number[] = [];
    for (let i = 0; i < candidate.length; i += 1) {
      if (candidate[i] !== existing[i]) diffs.push(i);
      if (diffs.length > 2) return undefined;
    }
    if (diffs.length === 1) return "substitution";
    const first = diffs[0];
    const second = diffs[1];
    if (
      diffs.length === 2 &&
      first !== undefined &&
      second === first + 1 &&
      candidate[first] === existing[second] &&
      candidate[second] === existing[first]
    ) {
      return "transposition";
    }
    return undefined;
  }

  const longer = delta === 1 ? candidate : existing;
  const shorter = delta === 1 ? existing : candidate;
  return extraIndex(longer, shorter) === undefined ? undefined : delta === 1 ? "insertion" : "deletion";
}

/**
 * Near-neighbour pairs that are real, distinct packages, not typosquats.
 *
 * The closed list the issue names. Without a popularity corpus there is no way
 * to tell `preact` from `lodas` locally, so the exemption has to enumerate the
 * pairs it means rather than guess from the shape of the edit (PR #102 review).
 */
const LEGITIMATE_NEIGHBOURS = new Set(
  [["react", "preact"], ["vue", "vuex"]].flatMap(([a, b]) => [`${a}\u0000${b}`, `${b}\u0000${a}`]),
);

function isLegitimatePair(a: string, b: string): boolean {
  return LEGITIMATE_NEIGHBOURS.has(`${a}\u0000${b}`);
}

function pairKind(candidate: string, existing: string): TyposquatKind | undefined {
  if (candidate === existing) return undefined;
  const left = splitName(candidate);
  const right = splitName(existing);
  if (left.local === right.local) {
    // `@types/node` vs `node`, `@angular/core` vs `core`: same project, two
    // install names. A one-keystroke scope, though, is a typo (`@anuglar/core`).
    if (left.scope !== undefined && right.scope !== undefined) {
      return classify(left.scope, right.scope);
    }
    return undefined;
  }
  const kind = classify(left.local, right.local) ?? classify(candidate, existing);
  if (kind === undefined) return undefined;
  if (isLegitimatePair(left.local, right.local) || isLegitimatePair(candidate, existing)) {
    return undefined;
  }
  return kind;
}

/** Matches of `candidate` against other names already declared. */
export function typosquatMatches(
  candidate: string,
  corpus: readonly string[],
): TyposquatMatch[] {
  const matches: TyposquatMatch[] = [];
  for (const existing of corpus) {
    const kind = pairKind(candidate, existing);
    if (kind === undefined) continue;
    matches.push({ existing, distance: 1, kind });
  }
  return matches;
}

export interface TyposquatFact {
  readonly candidateName: string;
  readonly manifest: string;
  readonly matches: readonly TyposquatMatch[];
  /** Present iff there was no other declared name in this manifest to compare. */
  readonly skipped?: "no-other-names";
}

/**
 * One result per changed dependency, against names declared in the SAME
 * manifest (HEAD ∪ base). Cross-manifest pairs are a later corpus, not this one.
 */
export function typosquatFacts(
  changes: readonly { readonly name: string; readonly manifest: string }[],
  namesByManifest: ReadonlyMap<string, readonly string[]>,
): TyposquatFact[] {
  return changes.map((change) => {
    const declared = namesByManifest.get(change.manifest) ?? [];
    const others: string[] = [];
    const seen = new Set<string>();
    for (const name of declared) {
      if (name === change.name || seen.has(name)) continue;
      seen.add(name);
      others.push(name);
    }
    if (others.length === 0) {
      return {
        candidateName: change.name,
        manifest: change.manifest,
        matches: [],
        skipped: "no-other-names",
      };
    }
    return {
      candidateName: change.name,
      manifest: change.manifest,
      matches: typosquatMatches(change.name, others),
    };
  });
}
