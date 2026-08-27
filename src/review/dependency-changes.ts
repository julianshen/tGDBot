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
   * Which dependency map it lives in, read from the parsed manifest.
   *
   * Not inferred. Issue #56 replaced six rounds of guessing — hunk headers,
   * indentation depth, a runtime-key denylist, a separate budget for guesses —
   * with the answer the file gives directly.
   */
  readonly section: string;
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
 * How many packages one diff may ask about.
 *
 * A lockfile churn can touch thousands. Without a ceiling, one pull request
 * could turn into thousands of outbound requests — a bounded review budget
 * matters more than perfect coverage of an enormous bump.
 */
const MAX_PACKAGES_PER_DIFF = 200;

/** How many manifest paths the pack will name before summarising the rest. */
const MAX_LISTED_MANIFESTS = 20;

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

/**
 * True when the spec names one release outright.
 *
 * `=1.2.3` counts: `=` is npm's EXACT comparator, so it resolves to exactly one
 * version, and treating it as a range suppressed the publication and
 * deprecation checks it can perfectly well answer (PR #54 review, final round).
 * Every other operator — `^ ~ > < >=` — genuinely admits more than one release.
 */
function isPinnedSpec(raw: string): boolean {
  return isExactVersion(raw.trim().replace(/^=/u, ""));
}


/**
 * The manifests a diff touches, from the FILE SECTIONS rather than the hunks.
 *
 * `+++ b/…` is a file header ONLY outside a hunk. Inside one it is content: an
 * added line whose text is `++ b/package.json` renders as `+++ b/package.json`,
 * byte for byte. Without hunk state a diff could forge a manifest header for
 * any file and walk straight through the closed allowlist this module rests on
 * (PR #54 review) — so headers are tied to real `diff --git` boundaries, the
 * same discipline `review/diff-anchors` uses for the same reason. That matters
 * more since #56, not less: the path recognised here is the path fetched.
 *
 * Recorded when the SECTION ends, not when a hunk begins. A manifest git emits
 * as a binary diff, or a pure rename, has no `@@` at all, and requiring one
 * meant the file was never listed, never fetched, and never reported — silently
 * omitted (PR #67 review, round four).
 */
function collectManifests(diff: string): ChangedManifest[] {
  const found: ChangedManifest[] = [];
  let path: string | undefined;
  let basePath: string | undefined;
  let inHunk = false;

  const flush = (): void => {
    if (path !== undefined) found.push({ path, basePath });
    path = undefined;
    basePath = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHunk = false;
      // The section header names both sides, which is the only place a binary
      // or rename-only section says what changed.
      const both = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      if (both) {
        const from = both[1] ?? "";
        const to = both[2] ?? "";
        if (isManifestPath(to)) {
          path = to;
          basePath = isManifestPath(from) ? from : undefined;
        }
      }
      continue;
    }
    if (inHunk) continue;
    // An explicit `---`/`+++` pair overrides the section header, which is what
    // distinguishes an ADDED manifest (`--- /dev/null`) from a modified one.
    const from = /^--- (?:a\/(.+)|\/dev\/null)$/u.exec(line);
    if (from) {
      const old = from[1];
      basePath = old !== undefined && isManifestPath(old) ? old : undefined;
      continue;
    }
    const to = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (to) {
      const next = to[1] ?? "";
      path = isManifestPath(next) ? next : undefined;
      continue;
    }
    if (line.startsWith("@@")) inHunk = true;
  }
  flush();
  return found;
}

/** A repository path this module is willing to name and fetch. */
function isManifestPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return MANIFEST_BASENAMES.has(basename) && MANIFEST_PATH_RE.test(path);
}

/**
 * A manifest this diff touches, at both ends.
 *
 * `basePath` differs from `path` when the file was RENAMED, and is undefined
 * when the pull request adds it. Reading the base side at the new path returned
 * nothing, which read as "this manifest is new", so every dependency in a
 * renamed file was reported and queried rather than the one that moved
 * (PR #67 review, round two).
 */
export interface ChangedManifest {
  readonly path: string;
  readonly basePath: string | undefined;
}

/** The manifest files this diff touches, for the host to fetch and parse. */
export function changedManifests(diff: string): ChangedManifest[] {
  const byPath = new Map<string, ChangedManifest>();
  for (const manifest of collectManifests(diff)) {
    if (!byPath.has(manifest.path)) byPath.set(manifest.path, manifest);
  }
  return [...byPath.values()];
}

/** One manifest's contents at the head ref, or undefined if it could not be read. */
export type ManifestSource = ReadonlyMap<string, string | undefined>;

/** The dependency maps whose entries are packages. */
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Every dependency a manifest declares, by name, with its section and spec.
 *
 * `undefined` means the text is not a usable manifest — unparseable, not an
 * object, an array. Distinct from "declares nothing": one is an answer and the
 * other is a failure, and the pack says different things about them.
 */
/** `section` and `name` together: one package may be declared in several. */
function declarationKey(section: string, name: string): string {
  return `${section}\u0000${name}`;
}

function declaredDependencies(
  text: string,
): Map<string, { section: string; name: string; spec: string }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const manifest = parsed as Record<string, unknown>;
  const declared = new Map<string, { section: string; name: string; spec: string }>();
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = manifest[section];
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) continue;
    for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
      // Every declaration is kept, keyed by SECTION AND NAME. Collapsing onto
      // the name discarded the second one, so a library declaring `react` in
      // both devDependencies and peerDependencies lost the peer entry, and a
      // change to only the peer range compared equal and vanished (PR #67
      // review, round three).
      if (typeof spec === "string") declared.set(declarationKey(section, name), { section, name, spec });
    }
  }
  return declared;
}

/** What extraction established, and what it could not. */
export interface DependencyExtraction {
  readonly changes: DependencyChange[];
  /**
   * Manifests that changed but could not be examined.
   *
   * Reported rather than dropped. A manifest that parsed as rubbish produced no
   * entries and no notice, so the pack either vanished or implied every fetched
   * manifest had been examined — the silent degradation the whole feature is
   * written against (PR #67 review).
   */
  readonly unreadable: string[];
}

/**
 * The dependency changes a pull request introduces.
 *
 * Established by comparing the dependency maps of each changed manifest at BASE
 * and at HEAD. Not by reading the diff's added lines: an added line carries no
 * structural location, so an entry added under `overrides` whose name and spec
 * happen to match an existing `dependencies` entry was reported as a change to
 * that dependency (PR #67 review). Two maps answer "what actually changed"
 * exactly, and the added-line matching is gone rather than patched.
 *
 * A manifest absent at base is NEW, so everything it declares is a change. A
 * manifest that cannot be parsed at either end is unreadable: with a corrupt
 * base there is no way to say what changed, and guessing "all of it" would
 * flood the review with dependencies nobody touched.
 */
export function dependencyChanges(
  manifests: readonly ChangedManifest[],
  head: ManifestSource,
  base: ManifestSource = new Map(),
): DependencyExtraction {
  const changes: DependencyChange[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();

  for (const { path, basePath } of manifests) {
    const headText = head.get(path);
    if (headText === undefined) {
      unreadable.push(path);
      continue;
    }
    const headDeps = declaredDependencies(headText);
    if (headDeps === undefined) {
      unreadable.push(path);
      continue;
    }
    // No base side at all is a NEW manifest, which is an answer. A base side
    // that EXISTS but could not be read is a failure: treating it as an empty
    // manifest made every dependency look newly added and sent the lot to the
    // registry (PR #67 review, round three). Read at the OLD path, since a
    // rename changes it.
    let baseDeps = new Map<string, { section: string; name: string; spec: string }>();
    if (basePath !== undefined) {
      const baseText = base.get(basePath);
      if (baseText === undefined) {
        unreadable.push(path);
        continue;
      }
      const parsedBase = declaredDependencies(baseText);
      if (parsedBase === undefined) {
        unreadable.push(path);
        continue;
      }
      baseDeps = parsedBase;
    }

    for (const [key, { section, name, spec }] of headDeps) {
      if (changes.length >= MAX_PACKAGES_PER_DIFF) break;
      // Unchanged is not a change. This is the whole comparison — and SECTION
      // counts as much as spec: a package moving from devDependencies to
      // dependencies at the same version enters the production tree, which is
      // a change worth reviewing and one the pack claims to describe (PR #67
      // review, round two).
      const before = baseDeps.get(key);
      if (before !== undefined && before.spec === spec && before.section === section) continue;
      const version = stripRange(spec);
      if (!isValidPackageName(name) || !VERSION_RE.test(version)) continue;
      const identity = `${section}\u0000${name}@${spec}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      changes.push({ name, version, spec, manifest: path, pinned: isPinnedSpec(spec), section });
    }
  }
  return { changes, unreadable };
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
  unreadableManifests: readonly string[] = [],
): ContextPackResult | undefined {
  if (changes.length === 0 && unreadableManifests.length === 0) return undefined;
  // Keyed by SPEC: a pin and a range share a stripped version, so name@version
  // handed both changes whichever fact was written last (round six).
  const factFor = new Map(facts.map((fact) => [`${fact.name}@${fact.spec}`, fact]));
  const lines = changes.map((change) => {
    const head = `- ${change.name}@${change.spec} (${change.manifest}, ${change.section})`;
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
  // A manifest the host could not read is stated, never omitted. Its
  // dependencies were not examined, and an absent section would read as an
  // examined one that found nothing — the silent-degradation failure this
  // project rejects everywhere else (#33/#35, and issue #56).
  // Bounded. When merge-base resolution fails, EVERY changed manifest lands
  // here, and a generated monorepo diff carries thousands of paths of up to 512
  // characters — enough to blow the model's context and fail every dispatch
  // (PR #67 review, round four). The COUNT is what a rule acts on, so it
  // survives even when the paths do not.
  const shownUnreadable = unreadableManifests.slice(0, MAX_LISTED_MANIFESTS);
  const hiddenUnreadable = unreadableManifests.length - shownUnreadable.length;
  const unreadable = unreadableManifests.length === 0
    ? []
    : [
        "",
        `These ${unreadableManifests.length} manifest(s) changed but could NOT be read, so no`,
        "dependency change in them was examined at all:",
        ...shownUnreadable.map((path) => `- ${path}`),
        ...(hiddenUnreadable > 0 ? [`- ...and ${hiddenUnreadable} more, not listed here`] : []),
      ];
  const text = [
    "## Dependency changes in this pull request",
    "",
    "Parsed from the changed manifests by the review host, not by a rule.",
    "",
    ...lines,
    ...unreadable,
    "",
    ...closing,
  ].join("\n");
  return {
    text,
    manifestHash: createHash("sha256").update(text, "utf8").digest("hex"),
    truncated: hiddenUnreadable > 0,
    sources: [],
  };
}
