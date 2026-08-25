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

function manifestPathsInDiff(diff: string): Map<number, string> {
  const byLine = new Map<number, string>();
  const lines = diff.split("\n");
  let current: string | undefined;
  for (const [index, line] of lines.entries()) {
    const header = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (header) {
      const path = header[1] ?? "";
      const basename = path.slice(path.lastIndexOf("/") + 1);
      current = MANIFEST_BASENAMES.has(basename) ? path : undefined;
      continue;
    }
    if (current !== undefined) byLine.set(index, current);
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
  const manifests = manifestPathsInDiff(diff);
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
