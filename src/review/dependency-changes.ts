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

/** Conservative: digits and dots, with the usual pre-release/build tail. */
const VERSION_RE = /^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/u;

/**
 * Manifests the host knows how to read.
 *
 * Deliberately a closed set. A changed source file that happens to contain a
 * quoted pair is not a dependency change, and treating it as one would let a
 * diff invent queries — the exact thing this design exists to prevent.
 */
const MANIFEST_BASENAMES = new Set(["package.json"]);

/**
 * How many packages one diff may ask about.
 *
 * A lockfile churn can touch thousands. Without a ceiling, one pull request
 * could turn into thousands of outbound requests — a bounded review budget
 * matters more than perfect coverage of an enormous bump.
 */
const MAX_PACKAGES_PER_DIFF = 200;

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
function manifestContextByLine(diff: string): Map<number, string> {
  const byLine = new Map<number, string>();
  let manifest: string | undefined;
  let inHunk = false;
  let inDependencySection = false;
  for (const [index, line] of diff.split("\n").entries()) {
    if (line.startsWith("diff --git ")) {
      manifest = undefined;
      inHunk = false;
      inDependencySection = false;
      continue;
    }
    if (!inHunk) {
      const header = /^\+\+\+ b\/(.+)$/u.exec(line);
      if (header) {
        const path = header[1] ?? "";
        const basename = path.slice(path.lastIndexOf("/") + 1);
        manifest = MANIFEST_BASENAMES.has(basename) ? path : undefined;
        continue;
      }
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      // A hunk starts somewhere unknown in the file, so no section is assumed.
      inDependencySection = false;
      continue;
    }
    if (manifest === undefined || !inHunk) continue;
    // Section tracking reads context lines as well as added ones: the opening
    // `"dependencies": {` is usually unchanged context above the bump.
    const content = line.slice(1);
    const opening = /^\s*"([A-Za-z]+)"\s*:\s*\{/u.exec(content);
    if (opening) {
      inDependencySection = DEPENDENCY_SECTIONS.has(opening[1] ?? "");
      continue;
    }
    if (/^\s*\}/u.test(content)) {
      inDependencySection = false;
      continue;
    }
    if (inDependencySection) byLine.set(index, manifest);
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
  for (const [index, line] of lines.entries()) {
    if (changes.length >= MAX_PACKAGES_PER_DIFF) break;
    const manifest = manifests.get(index);
    if (manifest === undefined || !line.startsWith("+")) continue;
    const entry = /^\+\s*"([^"]+)"\s*:\s*"([^"]+)"/u.exec(line);
    if (!entry) continue;
    const name = entry[1] ?? "";
    const version = stripRange(entry[2] ?? "");
    if (!isValidPackageName(name) || !VERSION_RE.test(version)) continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({ name, version, manifest });
  }
  return changes;
}
