// Issue #50: the facts a reviewer needs about a dependency bump and cannot get
// from the checkout — whether a version is current, published, or deprecated.
//
// The fetcher is INJECTED. No HTTP lives here, which keeps the whole suite off
// the network and leaves timeouts, proxies and retries to the caller that owns
// them. It also means this module cannot be talked into reaching somewhere
// unexpected: it only ever asks for a URL that `registryUrlFor` built.
//
// Every failure becomes an explicit `unknown` rather than an absence. A review
// that could not check something must say so — implying it checked and found
// nothing is the silent-degradation failure this project rejects elsewhere
// (see the large-diff completeness work, #33/#35).
import { isValidPackageName, registryUrlFor } from "./dependency-changes.js";
import type { DependencyChange } from "./dependency-changes.js";

/** What the host could establish about one changed dependency. */
export interface DependencyFact {
  readonly name: string;
  /** The version the pull request moves to. */
  readonly version: string;
  /** The registry's current `latest`, when it could be read. */
  readonly latest?: string;
  /** Whether the registry publishes this exact version. */
  readonly published?: boolean;
  /** The registry's deprecation notice for this version, if any. */
  readonly deprecated?: string;
  /** Why nothing could be established. Present iff the lookup failed. */
  readonly unknown?: string;
}

/** Parsed JSON, or a throw. Anything network-shaped belongs to the caller. */
export type FetchJson = (url: string) => Promise<unknown>;

/**
 * How many lookups run at once.
 *
 * Matches the related-work resolver's bound. A pull request can change many
 * dependencies, and a review is not entitled to open an unbounded number of
 * connections on the operator's behalf.
 */
const CONCURRENCY = 3;

function readRegistryDocument(
  change: DependencyChange,
  body: unknown,
): DependencyFact {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { name: change.name, version: change.version, unknown: "the registry returned no usable document" };
  }
  const document = body as Record<string, unknown>;
  const versions = document.versions;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
    return { name: change.name, version: change.version, unknown: "the registry document listed no versions" };
  }
  const distTags = document["dist-tags"];
  const latest =
    typeof distTags === "object" && distTags !== null && !Array.isArray(distTags)
      ? (distTags as Record<string, unknown>).latest
      : undefined;
  const entry = (versions as Record<string, unknown>)[change.version];
  const published = Object.hasOwn(versions as Record<string, unknown>, change.version);
  const deprecated =
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).deprecated
      : undefined;
  return {
    name: change.name,
    version: change.version,
    published,
    ...(typeof latest === "string" ? { latest } : {}),
    ...(typeof deprecated === "string" ? { deprecated } : {}),
  };
}

/**
 * Looks up each changed dependency, once per package.
 *
 * Deduplicated by name and version: a monorepo names the same dependency in
 * several manifests, and that is one question, not several.
 */
export async function fetchDependencyFacts(
  changes: readonly DependencyChange[],
  fetchJson: FetchJson,
): Promise<DependencyFact[]> {
  const unique = new Map<string, DependencyChange>();
  for (const change of changes) {
    const key = `${change.name}@${change.version}`;
    if (!unique.has(key)) unique.set(key, change);
  }
  const queue = [...unique.values()];
  const facts: DependencyFact[] = new Array(queue.length);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const index = next++;
      const change = queue[index]!;
      // Defence in depth: the parser cannot emit an invalid name, so this is
      // reachable only by a caller that skipped it. Never let one through to a
      // request.
      if (!isValidPackageName(change.name)) {
        facts[index] = {
          name: change.name,
          version: change.version,
          unknown: "the package name is not one the registry would accept",
        };
        continue;
      }
      try {
        facts[index] = readRegistryDocument(change, await fetchJson(registryUrlFor(change.name)));
      } catch (error) {
        // One dead lookup must not cost the others, and must not read as "we
        // checked and it was fine".
        facts[index] = {
          name: change.name,
          version: change.version,
          unknown: `the registry could not be reached (${(error as Error).message})`,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return facts;
}
