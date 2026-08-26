import { createHash } from "node:crypto";
import type { ContextPackResult } from "../context/context-pack.js";
import type { DependencyFact } from "./dependency-facts.js";

// Issue #50: reviewing a dependency bump needs facts the checkout does not
// contain — whether a version is current, withdrawn, deprecated, or carries a
// known advisory.
//
// WHY THIS IS SAFE, and the property every change here must preserve: the HOST
// derives the queries from structured manifest data, and the reviewing agent
// never gains a fetch tool. A diff is attacker-controlled by definition, so an
// agent that chose what to fetch while reading one would assemble the
// conditions for exfiltration — private data (it can `read` the checkout),
// untrusted content, and external communication. See #49.
//
// Here the diff supplies only package NAMES, validated against the registry's
// own naming rules and encoded into a fixed host. It never supplies a URL.
//
// Pure and synchronous: no I/O lives in this module at all. Fetching is the
// caller's job, which is what keeps every test in this suite off the network.

/** A dependency this diff moves to a version worth asking about. */
export interface DependencyChange {
  readonly name: string;
  /** The NEW version. A removal has nothing to ask about and is skipped. */
  readonly version: string;
  /** The manifest it changed in, for attributing a finding. */
  readonly manifest: string;
  /**
   * Whether the manifest names this EXACT release, with no range operator.
   *
   * `^1.2.3` installs whatever 1.x the resolver picks, so the registry's answer
   * about 1.2.3 specifically says nothing about what the build will get — and
   * reporting a deprecated or absent lower bound as the installed version
   * produced a confidently false claim (PR #54 review, round five). Only a pin
   * earns a per-version fact.
   */
  readonly pinned: boolean;
  /**
   * The spec as the manifest writes it: `^1.2.3`, not `1.2.3`.
   *
   * `version` is the stripped lower bound, which is the right key for a
   * registry lookup and the WRONG thing to show a reader — rendering `^1.2.3`
   * as `pkg@1.2.3` invited exactly the currency claim the `pinned` flag was
   * added to prevent (PR #54 review, round six).
   */
  readonly spec: string;
  /**
   * Whether the host ESTABLISHED that this line sits in a dependency map,
   * rather than inferring it from indentation.
   *
   * git emits only nearby context, so an ordinary bump in a long list has no
   * `"dependencies": {` in its hunk and the section is genuinely unknown.
   * Dropping those loses most real changes; presenting them as parsed facts
   * asserts something unproven, and a denylist of non-dependency keys was the
   * wrong shape — a custom object full of package-shaped entries walks past any
   * such list (PR #54 review, round five). So the uncertainty is RECORDED: it
   * orders the budget and it is stated in the pack.
   */
  readonly inDependencySection: boolean;
}

/** The one host queried. Not configurable: an allowlist of exactly one. */
const REGISTRY_ORIGIN = "https://registry.npmjs.org";

/**
 * npm's own naming rules, as a whitelist rather than a blocklist.
 *
 * Length, character set and scope shape are all constrained, so a name cannot
 * carry a path separator, a query, a fragment, or whitespace into a URL. A
 * blocklist would have to anticipate every such character; this admits only
 * what the registry itself accepts.
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_NAME_MAX = 214;

/**
 * An EXACT release: `1.2.3`, with the usual prerelease/build tail.
 *
 * The registry keys its `versions` map by exactly this, so only a version of
 * this shape can be looked up for publication. `1` and `1.2` are ranges wearing
 * a version's clothes (PR #54 review).
 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;

/** True for a version the registry could publish under that exact key. */
export function isExactVersion(version: string): boolean {
  return EXACT_VERSION_RE.test(version);
}

/** Conservative: digits and dots, with the usual pre-release/build tail. */
const VERSION_RE = /^\d+(?:\.\d+)*(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;

/**
 * Manifests the host knows how to read.
 *
 * Deliberately a closed set. A changed source file that happens to contain a
 * quoted pair is not a dependency change, and treating it as one would let a
 * diff invent queries — the exact thing this design exists to prevent.
 */
const MANIFEST_BASENAMES = new Set(["package.json"]);

/**
 * Path characters, and nothing else.
 *
 * The path is copied from the diff into text a rule reads as TRUSTED_CONTEXT,
 * and parsing proves only that it sits in a file header — not that its contents
 * are trustworthy (PR #54 review). Checking the basename alone let a DIRECTORY
 * carry prose across that boundary: `IGNORE ALL PREVIOUS INSTRUCTIONS/…` has a
 * perfectly ordinary basename. Restricting the whole path to an inert charset
 * means no interpolated value can form a sentence.
 *
 * `@` is admitted: scoped workspaces live at `packages/@acme/widget/package.json`
 * and every dependency change in one was being dropped silently (PR #54 review,
 * final round). It is a path character, not a word character, so it cannot make
 * the path read as prose — which is the whole point of the allowlist. What the
 * allowlist excludes is SPACE.
 */
const MANIFEST_PATH_RE = /^[A-Za-z0-9._@\/-]{1,512}$/u;

/**
 * Keys that live in a manifest's RUNTIME sections, never in a dependency map.
 *
 * With the section unknown, indentation is the only signal, and an `engines`
 * block long enough to push its own opening brace out of git's three-line
 * context window would otherwise contribute `node` as a package (PR #54 review,
 * round two). These are the keys that actually appear there — and every one of
 * them is also a real name on the registry, so a lookup would come back
 * plausible rather than obviously wrong.
 *
 * Narrow on purpose: it costs a genuine bump of a package by one of these names
 * ONLY in the unknown-section case, where nothing was proven anyway. It is a
 * heuristic backstop for a heuristic, not a boundary — the boundary is name
 * validation and URL encoding, which every entry still passes through.
 */
const RUNTIME_KEYS = new Set(["node", "npm", "yarn", "pnpm", "bun", "deno", "vscode"]);

/**
 * How many packages one diff may ask about.
 *
 * A lockfile churn can touch thousands. Without a ceiling, one pull request
 * could turn into thousands of outbound requests — a bounded review budget
 * matters more than perfect coverage of an enormous bump.
 */
const MAX_PACKAGES_PER_DIFF = 200;

/**
 * How many UNESTABLISHED entries are kept while scanning.
 *
 * A single cap on everything only moved the cutoff: a guessed block large
 * enough to reach it stopped the scan before any later confirmed hunk was read,
 * and the ordering fix cannot order what was never seen (PR #54 review, round
 * six). Guesses are bounded on their own so they can never end the scan, while
 * confirmed entries keep being collected to the ceiling.
 */
const MAX_GUESSED_PACKAGES = 200;

/** True for a name the registry itself would accept. */
export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= PACKAGE_NAME_MAX && PACKAGE_NAME_RE.test(name);
}

/**
 * The registry URL for a package.
 *
 * The name is encoded rather than interpolated: a scope contains `@` and `/`,
 * which are legal in a name and structural in a path. Validation runs again
 * here even though the parser already rejects a bad name — this is the last
 * point before a request, and defence in depth belongs at the boundary.
 */
export function registryUrlFor(name: string): string {
  if (!isValidPackageName(name)) {
    throw new Error(`Refusing to build a registry URL for an invalid package name: ${name}`);
  }
  return `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}`;
}

/** `^1.2.3`, `~1.2.3`, `>=1.2.3` → `1.2.3`. */
function stripRange(raw: string): string {
  return raw.replace(/^[\^~><= ]+/u, "").trim();
}

/** True when the spec names one release outright, with no range operator. */
function isPinnedSpec(raw: string): boolean {
  return isExactVersion(raw.trim());
}

/**
 * The dependency maps whose entries are packages. Anything else in a manifest
 * — `version`, `engines`, `scripts` — is not, and treating every string pair as
 * a dependency produced queries for packages called "version" and "node"
 * (PR #54 review).
 */
const DEPENDENCY_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * Which manifest each line belongs to, and whether it sits in a dependency map.
 *
 * `+++ b/…` is a file header ONLY outside a hunk. Inside one it is content: an
 * added line whose text is `++ b/package.json` renders as `+++ b/package.json`,
 * byte for byte. Without hunk state a diff could forge a manifest header for
 * any file and walk straight through the closed allowlist this module rests on
 * (PR #54 review) — so headers are tied to real `diff --git` boundaries, the
 * same discipline `review/diff-anchors` uses for the same reason.
 */
function manifestContextByLine(diff: string): Map<number, { manifest: string; confirmed: boolean }> {
  const byLine = new Map<number, { manifest: string; confirmed: boolean }>();
  let manifest: string | undefined;
  let inHunk = false;
  let section: "dependency" | "other" | "unknown" = "unknown";
  for (const [index, line] of diff.split("\n").entries()) {
    if (line.startsWith("diff --git ")) {
      manifest = undefined;
      inHunk = false;
      section = "unknown";
      continue;
    }
    if (!inHunk) {
      const header = /^\+\+\+ b\/(.+)$/u.exec(line);
      if (header) {
        const path = header[1] ?? "";
        const basename = path.slice(path.lastIndexOf("/") + 1);
        manifest = MANIFEST_BASENAMES.has(basename) && MANIFEST_PATH_RE.test(path)
          ? path
          : undefined;
        continue;
      }
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      // Git's own hunk context often names the enclosing key — use it when it
      // is there. Otherwise the section is UNKNOWN rather than absent: git
      // emits only nearby lines, so an ordinary bump in a long dependency list
      // has no header in its hunk at all, and requiring one omitted most real
      // changes (PR #54 review).
      const context = /@@[^@]*@@\s*"?([A-Za-z]+)"?\s*:/u.exec(line);
      section = context ? (DEPENDENCY_SECTIONS.has(context[1] ?? "") ? "dependency" : "other") : "unknown";
      continue;
    }
    if (manifest === undefined || !inHunk) continue;
    // Section tracking reads context lines as well as added ones: the opening
    // `"dependencies": {` is usually unchanged context above the bump.
    const content = line.slice(1);
    const opening = /^\s*"([A-Za-z]+)"\s*:\s*\{/u.exec(content);
    if (opening) {
      section = DEPENDENCY_SECTIONS.has(opening[1] ?? "") ? "dependency" : "other";
      continue;
    }
    if (/^\s*\}/u.test(content)) {
      section = "unknown";
      continue;
    }
    if (section === "other") continue;
    // With the section unknown, depth decides: a dependency entry is nested
    // inside a top-level object, so it is indented further than a top-level
    // field like "version". Not proof, but the alternative — dropping every
    // bump whose header git did not include — misses most real ones.
    if (section === "unknown") {
      if (!/^\s{4,}"/u.test(content)) continue;
      const key = /^\s*"([^"]+)"\s*:/u.exec(content)?.[1];
      if (key !== undefined && RUNTIME_KEYS.has(key)) continue;
    }
    byLine.set(index, { manifest, confirmed: section === "dependency" });
  }
  return byLine;
}

/**
 * The dependency changes a diff introduces.
 *
 * Only ADDED lines are read: a removal leaves nothing to ask about, and the
 * new version is what a reviewer needs facts for. Anything whose name or
 * version does not validate is dropped silently rather than rejected — a
 * malformed entry is not worth failing a review over, and it must never become
 * a request.
 */
export function dependencyChangesFromDiff(diff: string): DependencyChange[] {
  const manifests = manifestContextByLine(diff);
  const lines = diff.split("\n");
  const seen = new Set<string>();
  const changes: DependencyChange[] = [];
  const guessed: DependencyChange[] = [];
  const guessedKeys = new Set<string>();
  for (const [index, line] of lines.entries()) {
    // The scan ends only when the CONFIRMED entries fill the ceiling. Guesses
    // are collected separately and capped separately, so no amount of them can
    // stop a real dependency hunk further down from being read.
    if (changes.length >= MAX_PACKAGES_PER_DIFF) break;
    const context = manifests.get(index);
    if (context === undefined || !line.startsWith("+")) continue;
    const manifest = context.manifest;
    const entry = /^\+\s*"([^"]+)"\s*:\s*"([^"]+)"/u.exec(line);
    if (!entry) continue;
    const name = entry[1] ?? "";
    const spec = entry[2] ?? "";
    const version = stripRange(spec);
    if (!isValidPackageName(name) || !VERSION_RE.test(version)) continue;
    // Keyed by the SPEC, not the stripped version: `^1.2.3` and `1.2.3` ask
    // different questions of the registry, and collapsing them dropped the pin
    // — the only one of the two that can be checked (round six).
    const key = `${name}@${spec}`;
    const change: DependencyChange = {
      name,
      version,
      spec,
      manifest,
      pinned: isPinnedSpec(spec),
      inDependencySection: context.confirmed,
    };
    // Deduplicated WITHIN each class, not across them. A single seen-set let a
    // guess claim the key first, so the confirmed occurrence of the same
    // package was dropped and the entry kept the wrong manifest and the "may
    // not be a dependency" label (PR #54 review, final round).
    if (change.inDependencySection) {
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push(change);
    } else if (guessed.length < MAX_GUESSED_PACKAGES && !guessedKeys.has(key)) {
      guessedKeys.add(key);
      guessed.push(change);
    }
  }
  // A guess is dropped entirely once a confirmed entry describes the same
  // change: the confirmed one carries the real manifest and no caveat.
  const confirmedKeys = new Set(changes.map((change) => `${change.name}@${change.spec}`));
  // Established entries first, order otherwise preserved, then the ceiling.
  // A guess must never displace something the host actually parsed.
  return [
    ...changes,
    ...guessed.filter((change) => !confirmedKeys.has(`${change.name}@${change.spec}`)),
  ].slice(0, MAX_PACKAGES_PER_DIFF);
}

/**
 * The dependency changes, rendered as trusted context for a rule.
 *
 * Delivered through the existing context-pack seam, which places the text in a
 * TRUSTED_CONTEXT section — deliberately apart from UNTRUSTED_DIFF, because the
 * HOST derived these facts by parsing the manifest, and the diff did not supply
 * them. That distinction is the same one the whole design rests on.
 *
 * Undefined when nothing changed, so an ordinary review is untouched: a pack
 * must be supplied for EVERY rule or for none, and adding an empty section to
 * every rule's task on every pull request would be pure noise.
 *
 * States plainly that nothing has been checked against a registry. Until the
 * fetch layer lands there is no currency or advisory data, and text that merely
 * listed versions could invite a rule to claim one is current when nothing
 * looked.
 */
export function dependencyContextPack(
  changes: readonly DependencyChange[],
  facts: readonly DependencyFact[] = [],
): ContextPackResult | undefined {
  if (changes.length === 0) return undefined;
  // Keyed by SPEC: a pin and a range share a stripped version, so name@version
  // handed both changes whichever fact was written last (round six).
  const factFor = new Map(facts.map((fact) => [`${fact.name}@${fact.spec}`, fact]));
  const lines = changes.map((change) => {
    // An unestablished entry is labelled as one. git's context often omits the
    // enclosing key, so indentation was the only signal — that is a guess, and
    // presenting a guess as a parsed fact is the thing this pack must not do
    // (PR #54 review, round five).
    const provenance = change.inDependencySection
      ? ""
      : " — the host could not confirm this line sits in a dependency map; it may not be a dependency at all";
    const head = `- ${change.name}@${change.spec} (${change.manifest})${provenance}`;
    const fact = factFor.get(`${change.name}@${change.spec}`);
    if (fact === undefined) return head;
    const notes: string[] = [];
    // An unchecked package must read as unchecked, never as clean.
    // `unknown` is host-authored by construction — see fetchDependencyFacts,
    // which logs the remote detail rather than putting it here.
    if (fact.unknown !== undefined) notes.push(`lookup failed — ${fact.unknown}`);
    if (fact.published === false) notes.push("this version is NOT published by the registry");
    // The FLAG only, never the publisher's words.
    //
    // Round three flattened and capped the notice and left it in place. That
    // defends the document's structure and does nothing about its meaning: an
    // instruction addressed to the reviewing model survives flattening intact,
    // and labelling a code span "untrusted" is not a trust boundary a model
    // enforces (PR #54 review, round four). A pull-request author can publish a
    // package and write its deprecation text, so this is diff-controlled prose
    // arriving in the section that means "the host established this".
    //
    // The deprecation FLAG is host-established and is what a rule acts on. The
    // guidance in the notice is a real loss, and a small one against an
    // injection channel that cannot be closed while the text is here.
    if (fact.deprecated !== undefined) {
      notes.push("the registry marks this version deprecated (see the registry for the publisher's guidance)");
    }
    // `dist-tags.latest` is a value from a document the publisher controls, so
    // it is rendered only when it IS a version. Anything else is not a latest
    // tag worth repeating, and validating beats escaping (round four).
    const latest = fact.latest !== undefined && isExactVersion(fact.latest) ? fact.latest : undefined;
    if (latest !== undefined) {
      if (!change.pinned) {
        // A range may ALREADY resolve to the latest release, so stating a gap
        // would invent one. The tag is still worth having; the comparison is
        // not ours to make without resolving the range (round six).
        notes.push(
          `the registry's newest release is ${latest}, but this is a range — the resolver may already be installing it, so nothing here says the dependency is behind`,
        );
      } else if (latest !== change.version) {
        notes.push(`latest is ${latest}`);
      } else {
        notes.push("this is the latest");
      }
    }
    return notes.length === 0 ? head : `${head}\n${notes.map((note) => `  - ${note}`).join("\n")}`;
  });
  const checked = facts.some((fact) => fact.unknown === undefined);
  const closing = checked
    ? [
        "Anything not stated above was not established. A package with no note",
        "beyond its version was not checked, or the registry said nothing about",
        "it — do not read silence as approval.",
      ]
    : [
        "These versions have NOT been checked against a registry or advisory",
        "database: whether each is current, deprecated, withdrawn, or affected by",
        "a known advisory is unknown here. Do not assert otherwise.",
      ];
  const text = [
    "## Dependency changes in this pull request",
    "",
    "Parsed from the changed manifests by the review host, not by a rule.",
    "",
    ...lines,
    "",
    ...closing,
  ].join("\n");
  return {
    text,
    manifestHash: createHash("sha256").update(text, "utf8").digest("hex"),
    truncated: false,
    sources: [],
  };
}
