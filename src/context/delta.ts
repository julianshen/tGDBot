// Issue #60: a cached graph is only strictly true of the commit it was built
// from, so reusing it across base SHAs needs a MEASURE of how far the base
// moved. This module turns `git` in the managed mirror into that measure: the
// changed/added/deleted path sets, the commit count, and an ancestry check
// whose failure means the old commit is not even an ancestor of the new one —
// the force-push case, where no incremental statement is possible and the
// only correct answer is a full re-map.
//
// The classification is deliberately conservative (the thresholds are issue
// #60's v1 numbers): any doubt resolves to "full remap", which is the
// behaviour the cache had before this module existed. A wrong "full" costs
// the mapping time #60 exists to save; a wrong "incremental" publishes a
// patched graph that silently omits part of the delta.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How many changed paths one incremental publication may patch. */
export const MAX_INCREMENTAL_FILES = 25;

/** How many commits between the cached base and the review base one patch may span. */
export const MAX_INCREMENTAL_COMMITS = 10;

export interface BaseDelta {
  /** The commit the cached graphs were built from. */
  readonly fromSha: string;
  /** The commit under review. */
  readonly toSha: string;
  /** Commits reachable from `toSha` but not `fromSha`. */
  readonly commitCount: number;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

export interface ClassifiedBaseDelta {
  readonly delta: BaseDelta;
  readonly kind: "incremental" | "full";
  /** Why the delta was classified full. Absent when incremental. */
  readonly reason?: string;
}

export interface GitRunResult {
  readonly stdout: string;
}

export type GitRunner = (
  args: readonly string[],
) => Promise<GitRunResult>;

/** Production runner: `git` in the managed mirror, bounded and env-scrubbed by its caller. */
export function mirrorGitRunner(mirrorPath: string): GitRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("git", ["-C", mirrorPath, ...args], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout };
  };
}

interface NameStatusRow {
  readonly status: string;
  readonly paths: readonly string[];
}

function parseNameStatus(stdout: string): NameStatusRow[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const columns = line.split("\t");
      const status = columns[0] ?? "";
      const paths = columns.slice(1);
      return { status, paths };
    });
}

/**
 * Parses `git diff --name-status -M` output into path sets.
 *
 * A rename carries BOTH paths, and both belong in the delta: the old path's
 * graph nodes describe a file that no longer exists (treat as deleted), and
 * the new path needs mapping (treat as added).
 */
export function parseBaseDelta(fromSha: string, toSha: string, nameStatus: string, commitCount: number): BaseDelta {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const { status, paths } of parseNameStatus(nameStatus)) {
    const first = paths[0];
    if (first === undefined) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = paths[1];
      if (second === undefined) continue;
      if (status.startsWith("R")) deleted.add(first);
      added.add(second);
      continue;
    }
    if (status === "A") added.add(first);
    else if (status === "D") deleted.add(first);
    else changed.add(first);
  }
  return {
    fromSha,
    toSha,
    commitCount,
    added: [...added].sort(),
    changed: [...changed].sort(),
    deleted: [...deleted].sort(),
  };
}

export function classifyBaseDelta(
  delta: BaseDelta,
  /** Paths named as flow steps by the cached domain graph. */
  domainStepPaths: ReadonlySet<string>,
): ClassifiedBaseDelta {
  const touchedPaths = [...delta.added, ...delta.changed, ...delta.deleted];
  if (touchedPaths.length > MAX_INCREMENTAL_FILES) {
    return { delta, kind: "full", reason: `${touchedPaths.length} files changed exceeds the incremental ceiling of ${MAX_INCREMENTAL_FILES}` };
  }
  if (delta.commitCount > MAX_INCREMENTAL_COMMITS) {
    return { delta, kind: "full", reason: `${delta.commitCount} commits exceed the incremental ceiling of ${MAX_INCREMENTAL_COMMITS}` };
  }
  const domainTouched = touchedPaths.filter((filePath) => domainStepPaths.has(filePath));
  if (domainTouched.length > 0) {
    return { delta, kind: "full", reason: "a file named by a domain-graph flow step changed" };
  }
  return { delta, kind: "incremental" };
}

/**
 * Measures the delta between the cached graph's commit and the review base,
 * and classifies whether an incremental publication is allowed.
 *
 * Ancestry first: `A` that is not an ancestor of `B` (rewritten history) gets
 * no merge-base statement at all, so there is no delta to state — full remap.
 * Errors from the git calls are THROWN, not absorbed: the caller decides
 * whether a broken mirror degrades to a full map, and a caller that cannot
 * run git at all must hear about it rather than silently re-mapping.
 */
export async function computeBaseDelta(
  runGit: GitRunner,
  fromSha: string,
  toSha: string,
  domainStepPaths: ReadonlySet<string>,
): Promise<ClassifiedBaseDelta> {
  let ancestryFailed = false;
  try {
    await runGit(["merge-base", "--is-ancestor", fromSha, toSha]);
  } catch (error) {
    // `merge-base --is-ancestor` exits 1 for "not an ancestor"; anything else
    // is a broken mirror or a missing commit and must not read as a
    // classification. Distinguish by exit code.
    const code = (error as { code?: unknown }).code;
    // execFile reports the child's exit status numerically; be liberal in what
    // a wrapped runner may hand us.
    if (code === 1 || code === "1") ancestryFailed = true;
    else throw error;
  }
  if (ancestryFailed) {
    return {
      delta: { fromSha, toSha, commitCount: Number.MAX_SAFE_INTEGER, added: [], changed: [], deleted: [] },
      kind: "full",
      reason: "the cached base commit is not an ancestor of the review base (rewritten history)",
    };
  }
  const [nameStatus, commitCount] = await Promise.all([
    runGit(["diff", "--name-status", "-M", fromSha, toSha]),
    runGit(["rev-list", "--count", `${fromSha}..${toSha}`]),
  ]);
  const parsedCount = Number.parseInt(commitCount.stdout.trim(), 10);
  const delta = parseBaseDelta(
    fromSha,
    toSha,
    nameStatus.stdout,
    Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : Number.MAX_SAFE_INTEGER,
  );
  return classifyBaseDelta(delta, domainStepPaths);
}
