// Issue #50, the advisory half: does a changed dependency carry a known
// vulnerability? The registry half answers currency, deprecation and
// publication; this answers the question a reviewer actually loses sleep over.
//
// STRUCTURED FIELDS ONLY. An advisory record carries `summary` and `details`,
// written by whoever filed it, and PR #54's review rounds three through five
// were almost entirely about prose reaching TRUSTED_CONTEXT — a publisher's
// deprecation notice, a `dist-tags` value, a transport error message — each
// fixed by EXCLUDING the text rather than escaping it. #50's own threat model
// said to prefer structured fields over narrative. This module takes the
// advisory id, a severity from a closed vocabulary, and a fixed version that
// parses as one. Nothing else crosses.
//
// The fetcher is injected, so the suite never touches the network and this
// module cannot be talked into reaching somewhere unexpected: it only ever
// asks for one fixed URL.
import { isExactVersion, isValidPackageName } from "./dependency-changes.js";
import type { DependencyChange } from "./dependency-changes.js";
import type { DependencyFactOptions, FetchJson } from "./dependency-facts.js";

/** The one advisory host queried. Not configurable: an allowlist of exactly one. */
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

/** OSV's name for the npm ecosystem. */
const ECOSYSTEM = "npm";

/**
 * Severities worth repeating, as a closed set.
 *
 * A value outside it is dropped rather than rendered: the field is
 * `database_specific`, which is exactly as free-form as it sounds.
 */
const SEVERITIES = new Set(["LOW", "MODERATE", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * An advisory identifier, and nothing else.
 *
 * `GHSA-jf85-cpcp-j695`, `CVE-2021-23337`, `PYSEC-2020-1`. Bounded and inert:
 * it is interpolated into the pack's TRUSTED half, so it must not be able to
 * form a sentence.
 */
const ADVISORY_ID_RE = /^[A-Z][A-Z0-9]{1,15}(?:-[A-Za-z0-9]{1,16}){1,6}$/u;

/** How many advisories are reported for one package before the rest are counted. */
const MAX_ADVISORIES_PER_PACKAGE = 10;

/** What the host established about one dependency's known vulnerabilities. */
export interface DependencyAdvisory {
  readonly id: string;
  readonly severity?: string;
  /** The first release that fixes it, when the record names one. */
  readonly fixed?: string;
}

export interface DependencyAdvisoryFact {
  readonly name: string;
  readonly version: string;
  readonly spec: string;
  /** Present iff the lookup succeeded. Empty means asked and told nothing. */
  readonly advisories?: readonly DependencyAdvisory[];
  /** How many were found beyond those reported. */
  readonly furtherAdvisories?: number;
  /** Why nothing could be established. Present iff no lookup answer. */
  readonly unknown?: string;
}

const CONCURRENCY = 3;
const DEFAULT_DEADLINE_MS = 60_000;

function readAdvisory(value: unknown, name: string, version: string): DependencyAdvisory | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const vuln = value as Record<string, unknown>;
  const id = vuln.id;
  // An id that is not an id is not something to repeat into trusted context.
  if (typeof id !== "string" || !ADVISORY_ID_RE.test(id)) return undefined;

  const specific = vuln.database_specific;
  const rawSeverity = typeof specific === "object" && specific !== null && !Array.isArray(specific)
    ? (specific as Record<string, unknown>).severity
    : undefined;
  const severity = typeof rawSeverity === "string" && SEVERITIES.has(rawSeverity.toUpperCase())
    ? rawSeverity.toUpperCase()
    : undefined;

  const fixed = readFixed(vuln.affected, name, version);
  return {
    id,
    ...(severity === undefined ? {} : { severity }),
    ...(fixed === undefined ? {} : { fixed }),
  };
}

/**
 * Orders two exact versions numerically, component by component.
 *
 * Enough for OSV's SEMVER ranges, which carry plain released versions. A
 * prerelease tail sorts BELOW the same release, which is semver's own rule and
 * the conservative direction here: it keeps `2.0.0-rc.1` inside the interval
 * that `2.0.0` opens rather than out of it.
 */
function compareVersions(left: string, right: string): number {
  const parts = (value: string): { numbers: number[]; prerelease: boolean } => {
    const [core = "", tail] = value.split("-", 2);
    return {
      numbers: core.split(".").map((piece) => Number.parseInt(piece, 10) || 0),
      prerelease: tail !== undefined,
    };
  };
  const a = parts(left);
  const b = parts(right);
  const width = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

/**
 * The release that fixes THIS advisory for THIS package at THIS version.
 *
 * OSV allows several `affected` entries in one record — for different packages,
 * and for the same package with different fix paths — and each carries its own
 * ranges. Taking the first semver-shaped `fixed` anywhere in the record named a
 * version that might fix a different package, or an earlier interval this
 * version is not in (PR #70 review, found by both reviewers). A wrong
 * "fixed in X" is worse than none: it tells a reader to ship something still
 * vulnerable.
 *
 * So: entries for this package in this ecosystem, SEMVER ranges only, and the
 * `fixed` belonging to the interval that actually contains the queried version.
 * Outside every interval, the record names no fix that applies here.
 */
function readFixed(affected: unknown, name: string, version: string): string | undefined {
  if (!Array.isArray(affected)) return undefined;
  for (const entry of affected) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const pkg = record.package;
    if (typeof pkg !== "object" || pkg === null) continue;
    const meta = pkg as Record<string, unknown>;
    if (meta.name !== name || meta.ecosystem !== ECOSYSTEM) continue;

    const ranges = record.ranges;
    if (!Array.isArray(ranges)) continue;
    for (const range of ranges) {
      if (typeof range !== "object" || range === null) continue;
      const rangeRecord = range as Record<string, unknown>;
      // Only SEMVER intervals are comparable as versions. A GIT range's events
      // are commits.
      if (rangeRecord.type !== "SEMVER") continue;
      const events = rangeRecord.events;
      if (!Array.isArray(events)) continue;

      // Events come in order: an `introduced` opens an interval and the next
      // `fixed` closes it.
      let openedAt: string | undefined;
      for (const event of events) {
        if (typeof event !== "object" || event === null) continue;
        const eventRecord = event as Record<string, unknown>;
        const introduced = eventRecord.introduced;
        if (typeof introduced === "string") {
          // OSV writes "0" for "from the beginning".
          openedAt = introduced === "0" ? "0.0.0" : introduced;
          continue;
        }
        const fixed = eventRecord.fixed;
        if (typeof fixed !== "string" || !isExactVersion(fixed)) continue;
        if (openedAt === undefined) continue;
        const atOrAfterStart = compareVersions(version, openedAt) >= 0;
        const beforeFix = compareVersions(version, fixed) < 0;
        if (atOrAfterStart && beforeFix) return fixed;
        openedAt = undefined;
      }
    }
  }
  return undefined;
}

function readResponse(
  change: DependencyChange,
  body: unknown,
): DependencyAdvisoryFact {
  const base = { name: change.name, version: change.version, spec: change.spec };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ...base, unknown: "the advisory database returned no usable document" };
  }
  const vulns = (body as Record<string, unknown>).vulns;
  // OSV omits `vulns` entirely when there is nothing, which is an ANSWER.
  if (vulns === undefined) return { ...base, advisories: [] };
  if (!Array.isArray(vulns)) {
    return { ...base, unknown: "the advisory database returned no usable document" };
  }
  const all = vulns
    .map((vuln) => readAdvisory(vuln, change.name, change.version))
    .filter((advisory): advisory is DependencyAdvisory => advisory !== undefined);
  const advisories = all.slice(0, MAX_ADVISORIES_PER_PACKAGE);
  const further = all.length - advisories.length;
  return { ...base, advisories, ...(further > 0 ? { furtherAdvisories: further } : {}) };
}

/**
 * Looks up known advisories for each changed dependency, once per name and
 * version.
 *
 * Only a PIN is asked about. A range resolves to whatever the installer picks,
 * so an advisory against its lower bound says nothing about what the build
 * gets — the same reasoning that stopped `published` being asserted for a range
 * (PR #67 review). Saying so is honest; guessing would produce a confident and
 * possibly false blocking finding.
 */
export async function fetchDependencyAdvisories(
  changes: readonly DependencyChange[],
  fetchJson: FetchJson,
  options: DependencyAdvisoryOptions = {},
): Promise<DependencyAdvisoryFact[]> {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const unique = new Map<string, DependencyChange>();
  for (const change of changes) {
    const key = `${change.name}@${change.spec}`;
    if (!unique.has(key)) unique.set(key, change);
  }
  const queue = [...unique.values()];
  const facts: DependencyAdvisoryFact[] = new Array(queue.length);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const index = next++;
      const change = queue[index]!;
      const base = { name: change.name, version: change.version, spec: change.spec };
      if (now() >= deadline) {
        facts[index] = {
          ...base,
          unknown: "the lookup budget for this review ran out before this package was checked",
        };
        continue;
      }
      if (!change.pinned || !isExactVersion(change.version)) {
        facts[index] = {
          ...base,
          unknown: "this is a range, so which release installs — and which advisories apply — is not known here",
        };
        continue;
      }
      // Defence in depth: the parser cannot emit an invalid name.
      if (!isValidPackageName(change.name)) {
        facts[index] = { ...base, unknown: "the package name is not one the registry would accept" };
        continue;
      }
      try {
        const body = await fetchJson(OSV_QUERY_URL, {
          body: { package: { name: change.name, ecosystem: ECOSYSTEM }, version: change.version },
        });
        facts[index] = readResponse(change, body);
      } catch {
        // HOST-AUTHORED. The thrown message can carry response text, and this
        // string is rendered into trusted context (PR #54 review, final round).
        facts[index] = { ...base, unknown: "the advisory database could not be reached" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return facts;
}

/** Injectable so the suite can exercise the deadline without waiting on it. */
export type DependencyAdvisoryOptions = DependencyFactOptions;
