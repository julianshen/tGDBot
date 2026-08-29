// Turns "review this PR" into "here is the trusted-base context for it": the
// one place that walks workspace -> cache -> mapping -> context pack. Every
// piece below this was already built and tested; nothing called them, so a
// dispatched reviewer had never seen the repository it was reviewing.
//
// Two invariants this module exists to hold:
//
//  1. **Mapping only ever runs against the PR's BASE commit.** The mapper runs
//     a pi session with bash/edit/write (see `tgd-mapper.ts`) — the tools
//     ADR-003 deliberately removed from review subagents. Pointing that at a
//     PR's own checkout would hand arbitrary code execution to anyone who can
//     open a pull request. This is the same trust decision already made for
//     rule files ("Rule files are sourced from the base branch").
//  2. **Context is best-effort.** Mapping is a long, model-driven step that
//     will time out and will meet repositories it cannot handle. Under the
//     default `auto` mode every failure degrades to a review WITHOUT context
//     and a stated reason — never a failed review. Only `require` turns an
//     unavailable context into an error, for callers who would rather not
//     review at all than review blind.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { buildContextPacks, type ContextPackResult } from "./context-pack.js";
import { declareMappedArtifacts } from "./artifact-paths.js";
import {
  ContextCache,
  ContextCacheConflictError,
  ContextCachePublicationInProgressError,
} from "./cache.js";
import { contextCacheKeyForRepository, type ContextCacheKey, type ContextManifest } from "./types.js";
import { withPreparedWorkspace as realPrepareWorkspace } from "../workspace/manager.js";
import { assertNoSymlinkedAncestors, protectManagedRoot } from "../workspace/protect.js";
import type { ContextMapper } from "./mapper.js";
import type { RepositoryRef } from "../target/types.js";

/**
 * Bumped when the shape of a published context entry changes. It is part of
 * the cache key, so a bump invalidates every cached entry rather than reading
 * an old one under new assumptions.
 */
export const CONTEXT_SCHEMA_VERSION = 1;

/**
 * Identifies the mapper that produced an entry. Changing mapper — or upgrading
 * one whose output differs — must not reuse the previous mapper's graphs, and
 * this is the field that stops it.
 */
export const CONTEXT_MAPPER_VERSION = "tgd-pi-mapper@1";

/** Bumped when selection/rendering policy changes what a pack says. */
export const CONTEXT_POLICY_VERSION = "1";

export type ContextMode = "off" | "auto" | "require";

export class ContextRequiredError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(
      `--context require was set but no trusted-base context could be prepared: ${
        reasons.length === 0 ? "unknown reason" : reasons.join("; ")
      }`,
    );
    this.name = "ContextRequiredError";
    this.reasons = reasons;
  }
}

export interface ContextPreparationRequest {
  readonly mode: ContextMode;
  readonly repository: RepositoryRef;
  readonly baseSha: string;
  /** Only ever compared against, never mapped. See invariant 1 above. */
  readonly headSha: string;
  readonly changedFiles: readonly string[];
  readonly ruleNames: readonly string[];
  readonly maxChars?: number;
  readonly allowDegraded: boolean;
  readonly workspaceRoot: string;
  readonly cacheRoot: string;
}

export type ContextPreparation =
  | { readonly status: "off" }
  | {
    readonly status: "ready";
    readonly packs: Readonly<Record<string, ContextPackResult>>;
    readonly manifestHash: string;
    /** Empty on a healthy entry; a reused degraded entry states what is missing. */
    readonly degradedReasons: readonly string[];
    readonly cacheHit: boolean;
  }
  | { readonly status: "unavailable"; readonly reasons: readonly string[] };

export interface PrepareContextDependencies {
  /**
   * Runs the mapping INSIDE the repository lock. It was `prepareWorkspace`,
   * which releases the lock before returning, so the mapper read a tree
   * another job could be resetting underneath it (#78).
   */
  readonly prepareWorkspace?: typeof realPrepareWorkspace;
  /** Constructed lazily so a run with `--context off` never loads the pi SDK. */
  readonly createMapper?: () => Promise<ContextMapper> | ContextMapper;
  readonly createCache?: (root: string) => ContextCache;
  readonly now?: () => string;
  readonly onProgress?: (event: { stage: "lookup" | "workspace" | "map" | "publish" | "pack"; status: "started" | "completed" | "failed" }) => void;
}

/**
 * How long to wait for a concurrent publisher that holds the claim. Bounded,
 * because this blocks a review and losing the wait costs this run only its
 * context, never correctness — but bounded at THIRTY seconds rather than the
 * two it used to be. The claim is held for the whole of `promoteContext`:
 * hashing every mapped artifact and then renaming the staging directory into
 * place. On a large repository that is comfortably more than two seconds, and
 * giving up inside it meant reviewing without context — or, under
 * `--context require`, exiting 1 — on a perfectly valid review whose context
 * had already been built and was moments from landing. Thirty seconds is still
 * negligible beside the mapping run this wait exists to avoid duplicating.
 */
const PUBLICATION_WAIT_ATTEMPTS = 60;
const PUBLICATION_WAIT_INTERVAL_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The cache identity for one repository at one base commit. Stamped with the
 * schema, mapper and policy versions so that changing any of them makes every
 * existing entry a miss rather than a stale hit — there is no in-place
 * migration, and reading an old entry under new rules is the failure this
 * prevents.
 */
export function contextCacheKey(request: {
  readonly repository: RepositoryRef;
  readonly baseSha: string;
}): ContextCacheKey {
  return contextCacheKeyForRepository(request.repository, {
    baseSha: request.baseSha,
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    tgdVersion: CONTEXT_MAPPER_VERSION,
    policyVersion: CONTEXT_POLICY_VERSION,
  });
}

/**
 * The context contribution to the review's config hash, computed BEFORE any
 * mapping so it can participate in the dedup decision that determines whether
 * mapping is worth doing at all.
 *
 * It deliberately fingerprints the cache key IDENTITY rather than the produced
 * manifest hash. Everything that decides which context a review gets — the
 * repository, the base commit, the schema, the mapper, the policy, the size
 * budget — is in the key and known up front. Hashing the manifest instead
 * would mean a re-map that produced a byte-different graph for the same base
 * commit re-triggered a review of every open PR, which is churn, not accuracy.
 *
 * Consequence worth knowing: a review posted while mapping was transiently
 * failing is not re-run by a later success at the same head and base, because
 * nothing in the fingerprint changed. The summary says the context was
 * unavailable, and `@tgdbot review force:` re-runs it.
 *
 * `maxChars` here is the OPERATOR'S ceiling, not the byte budget the repository
 * pack is finally rendered against. The CLI reserves the dependency section's
 * length out of that ceiling first (see `repositoryContextBudget`), so the
 * effective budget is smaller whenever `--dependency-facts on` produced a
 * section, and its exact size moves with what the registry answered. That
 * length cannot be hashed here without fetching it before the dedup decision,
 * which is the network call dedup exists to avoid. What this field pins is
 * therefore the operator's intent — changing `--context-max-chars` invalidates
 * a prior review, as it should — and the flag that governs the reservation
 * (`--dependency-facts`) is hashed separately by `computeReviewConfigHash`.
 * Registry ANSWERS are not covered by the config hash at all, here or for the
 * dependency section itself.
 */
export function contextFingerprint(request: {
  readonly mode: ContextMode;
  readonly baseSha: string;
  readonly maxChars?: number;
  readonly allowDegraded: boolean;
}): string | undefined {
  // `off` contributes nothing, and returns nothing. A review that asks for no
  // context has exactly the inputs it had before this feature existed, so its
  // config hash should be exactly what it was: opting out costs no re-review.
  if (request.mode === "off") return undefined;
  // The repository is deliberately absent: a config hash is already scoped to
  // one review on one repository (its marker lives on that pull request), so
  // including the repository identity would add nothing and make the hash
  // impossible to compute without resolving a canonical repository ref. The
  // base commit IS included — a base branch that advances changes which
  // context this review would get, and that is worth re-reviewing for.
  const canonical = JSON.stringify([
    request.mode,
    request.baseSha,
    CONTEXT_SCHEMA_VERSION,
    CONTEXT_MAPPER_VERSION,
    CONTEXT_POLICY_VERSION,
    request.maxChars ?? null,
    request.allowDegraded,
  ]);
  return createHash("sha256").update(`tgd:context:v1\0${canonical}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * The outcome of publishing a freshly mapped staging directory. `ours`
 * distinguishes an entry THIS run promoted from one a concurrent run had
 * already published: only the former may be discarded if it turns out to be
 * unrenderable, because discarding another run's entry would destroy work this
 * run did not do and cannot redo any better.
 */
interface PublishedMapping {
  readonly manifest: ContextManifest;
  readonly ours: boolean;
}

/**
 * Publishes a freshly mapped staging directory, tolerating the two concurrent
 * publication outcomes the cache defines: another run that published the same
 * content (reuse it) and another run mid-publication (re-look-up, and take
 * what it published if it landed).
 */
async function publishMapping(
  cache: ContextCache,
  stagingPath: string,
  key: ContextCacheKey,
  artifactPaths: readonly string[],
  degradedReasons: readonly string[],
  createdAt: string,
  /**
   * Whether an abandoned claim may still be reclaimed. Cleared on the single
   * retry below so a claim that keeps reappearing cannot loop.
   */
  mayReclaim = true,
): Promise<PublishedMapping | undefined> {
  try {
    const manifest = await cache.promoteContext(stagingPath, {
      key,
      createdAt,
      artifacts: declareMappedArtifacts(artifactPaths),
      degradedReasons: [...degradedReasons],
    });
    return { manifest, ours: true };
  } catch (error) {
    if (error instanceof ContextCacheConflictError) {
      // A concurrent run already published a complete entry. It is as good as
      // ours would have been — same base commit, same mapper — so read it
      // rather than failing.
      const manifest = await cache.lookupContext(key);
      return manifest === undefined ? undefined : { manifest, ours: false };
    }
    if (error instanceof ContextCachePublicationInProgressError) {
      // A claim can be held by a live publisher OR left behind by one that
      // died. The dead case is checked FIRST, and deliberately before the wait:
      // nothing will ever land, so polling for it burns the full wait on every
      // review of that base commit and then fails anyway. `reclaimStaleClaim`
      // only touches a claim old enough that no live publication could still be
      // holding it, so the ordering costs the live case nothing.
      //
      // Our own staging is untouched here — the claim already existed, so
      // `promoteContext` never moved it — which is what makes retrying with the
      // same staging directory sound.
      if (mayReclaim && await cache.reclaimStaleClaim(key)) {
        return await publishMapping(
          cache,
          stagingPath,
          key,
          artifactPaths,
          degradedReasons,
          createdAt,
          false,
        );
      }
      // A live publisher, then. It may still be hashing or renaming, so a
      // single immediate lookup can miss an entry that appears moments later —
      // and treating that as final would review without context (or, under
      // `require`, fail) for no reason. Poll briefly for it to land.
      for (let attempt = 0; attempt < PUBLICATION_WAIT_ATTEMPTS; attempt += 1) {
        await delay(PUBLICATION_WAIT_INTERVAL_MS);
        const landed = await cache.lookupContext(key);
        if (landed !== undefined) return { manifest: landed, ours: false };
      }
      return undefined;
    }
    throw error;
  }
}

/**
 * Walks the whole context chain for one review: cache lookup → base worktree →
 * map on a miss → publish → one pack per rule. The single place that does so,
 * and injectable through `ReviewDependencies` so a review test never builds a
 * worktree or starts a mapper.
 *
 * Two invariants govern everything here.
 *
 * **Mapping only ever runs against the PR's BASE commit.** The mapper runs a pi
 * session holding `bash`/`edit`/`write` — the tools ADR-003 removed from review
 * subagents — so pointing it at a pull request's own checkout would hand code
 * execution to anyone able to open one. `prepareWorkspace` refuses a worktree
 * that is not at the requested base, and the returned SHA is checked again here.
 *
 * **Context is best-effort.** Under `auto` every failure returns
 * `{ status: "unavailable", reasons }` and the review proceeds on the diff
 * alone; only `require` turns that into a throw. Reasons are for the operator's
 * stderr, not the published comment — a mapper diagnostic can name local
 * filesystem paths, so the comment carries a label instead.
 *
 * Never returns a partially-built result: a pack is produced for every rule
 * name or for none, because `validateDispatchContext` rejects partial coverage.
 */
export async function prepareReviewContext(
  request: ContextPreparationRequest,
  dependencies: PrepareContextDependencies = {},
): Promise<ContextPreparation> {
  if (request.mode === "off") return { status: "off" };

  const onProgress = dependencies.onProgress ?? (() => undefined);
  const createCache = dependencies.createCache ?? ((root: string) => new ContextCache(root));
  const workspace = dependencies.prepareWorkspace ?? realPrepareWorkspace;
  const now = dependencies.now ?? (() => new Date().toISOString());

  const unavailable = (reasons: readonly string[]): ContextPreparation => {
    if (request.mode === "require") throw new ContextRequiredError(reasons);
    return { status: "unavailable", reasons };
  };

  let cache: ContextCache;
  let key: ContextCacheKey;
  try {
    // Before ANY entry under this root is read: `lookupContext` verifies that
    // an entry's artifacts match the hashes in its own manifest, but a
    // manifest is self-describing and says nothing about who wrote it. On a
    // shared writable root — which `--context-dir` and TGD_REVIEW_CONTEXT_DIR
    // can both point at — another local user can pre-create the deterministic
    // entry with a perfectly self-consistent manifest, and its text is then
    // handed to the reviewing model inside `[TRUSTED_CONTEXT]`. Hash integrity
    // is not provenance; ownership of the directory is what supplies it. Same
    // guard the managed git workspace already applies to its own root.
    await mkdir(request.cacheRoot, { recursive: true, mode: 0o700 });
    // Resolve to the PHYSICAL path first. `protectManagedRoot` walks ancestors
    // with `stat`, which follows symlinks, so it inspects a link target's mode
    // rather than noticing the link — leaving room to point an ancestor at a
    // victim-owned directory until the checks pass and retarget it afterwards.
    // `realpath` removes every symlink component by construction, and
    // everything below then operates on the resolved path, so a later retarget
    // cannot redirect it. Same reason `prepareWorkspace` resolves its own root
    // (`physicalWorkspaceRoot`) before protecting it.
    const physicalCacheRoot = await realpath(request.cacheRoot);
    await protectManagedRoot(physicalCacheRoot, "Context cache", { rejectPreviouslyShared: true });
    cache = createCache(physicalCacheRoot);
    key = contextCacheKey(request);
    // Re-checked close to use, the way the managed workspace re-checks its own
    // root before it acts on it. `protectManagedRoot` walked the ancestors ONCE;
    // this establishes that neither the root nor the path down to this run's
    // entry and staging area has become a symlink since. The ancestors above
    // the root need no second look here: the walk above refuses any ancestor
    // owned by another user, so nobody who could swap the root out from under
    // this check survived it.
    await assertNoSymlinkedAncestors(
      physicalCacheRoot,
      [cache.entryPath(key), path.join(physicalCacheRoot, "staging")],
      "Context cache",
    );
  } catch (error) {
    return unavailable([`context cache is unusable: ${errorMessage(error)}`]);
  }

  /**
   * `discardOnFailure` is set only for an entry THIS run just promoted. The
   * cache key covers the base commit, the schema, the mapper and the policy —
   * but nothing about the rules or the pack renderer, so an entry that
   * publishes cleanly and then cannot render is not self-correcting: every
   * later run at that base finds it, re-pays the same failing build, and
   * degrades (or, under `require`, exits 1) until `CONTEXT_SCHEMA_VERSION`
   * moves. Discarding our own unrenderable entry makes the next run re-map
   * instead. Deliberately NOT done for an entry a concurrent run published:
   * that would destroy work this run did not do, on the strength of a failure
   * that may be local to this process.
   */
  const pack = async (
    manifest: ContextManifest,
    cacheHit: boolean,
    discardOnFailure = false,
  ): Promise<ContextPreparation> => {
    onProgress({ stage: "pack", status: "started" });
    try {
      const packs = await buildContextPacks({
        contextRoot: cache.entryPath(key),
        manifest,
        changedFiles: [...request.changedFiles],
        ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
      }, request.ruleNames);
      onProgress({ stage: "pack", status: "completed" });
      return {
        status: "ready",
        packs,
        manifestHash: manifest.manifestHash,
        degradedReasons: manifest.degradedReasons,
        cacheHit,
      };
    } catch (error) {
      onProgress({ stage: "pack", status: "failed" });
      // A manifest that cannot produce a pack is not a usable context, even
      // though it published: the commonest cause is a degraded entry with no
      // knowledge graph, which `buildContextPacks` refuses by design.
      const reasons = [`context pack could not be built: ${errorMessage(error)}`];
      if (discardOnFailure) {
        // Best-effort by design: this is a cleanup, and failing to clean up
        // must not change what the caller is told about the pack failure that
        // prompted it. The path is beneath the cache root this run already
        // resolved and locked down to 0700, so nothing outside it is reachable
        // from here. A concurrent reader mid-lookup is unharmed — `lookupContext`
        // treats a vanished or changed entry as a miss by construction.
        const discarded = await rm(cache.entryPath(key), { recursive: true, force: true })
          .then(() => true)
          .catch(() => false);
        reasons.push(
          discarded
            ? "the unrenderable cache entry was discarded; the next run will re-map"
            : "the unrenderable cache entry could not be discarded and will be retried as-is",
        );
      }
      return unavailable(reasons);
    }
  };

  // `pack()` is called OUTSIDE this try on purpose. Under `--context require`
  // `unavailable()` throws `ContextRequiredError`, so a `pack()` failure inside
  // the lookup's try would be caught by the lookup's own catch and re-wrapped as
  // "context cache lookup failed: … context pack could not be built: …" — the
  // wrong stage, with the real reasons demoted to a nested string. Same hazard
  // the map/publish block below is structured to avoid.
  let cached: ContextManifest | undefined;
  try {
    onProgress({ stage: "lookup", status: "started" });
    cached = await cache.lookupContext(key);
    onProgress({ stage: "lookup", status: "completed" });
  } catch (error) {
    onProgress({ stage: "lookup", status: "failed" });
    return unavailable([`context cache lookup failed: ${errorMessage(error)}`]);
  }
  if (cached !== undefined) return await pack(cached, true);

  if (request.ruleNames.length === 0) {
    // Nothing would read the result. Mapping is the most expensive step in a
    // review; never pay for it to build packs no rule will be given.
    return unavailable(["no rules to build context for"]);
  }

  // Everything below reads the shared base worktree, so it runs INSIDE the
  // repository lock. `prepareWorkspace` releases the lock before returning, so
  // the mapper walked a tree another job could be resetting and cleaning
  // underneath it (#78). The cost is deliberate: a long mapping now serialises
  // other jobs on the same repository and base, which is what the lock is for.
  try {
    onProgress({ stage: "workspace", status: "started" });
    return await workspace({
      root: request.workspaceRoot,
      repo: request.repository,
      baseSha: request.baseSha,
      // Mapping RUNS out of this worktree, and `git worktree add` executes the
      // mirror's `hooks/post-checkout`. A root another user could previously
      // write may already hold a bare mirror with the expected origin and an
      // attacker's hook in it, which chmod 0700 would lock in rather than shut
      // out — so refuse such a root instead of adopting it.
      rejectPreviouslySharedRoot: true,
    }, async (prepared) => {
    // Invariant 1, checked rather than assumed. `prepareWorkspace` already
    // refuses a worktree whose HEAD is not the requested base SHA; this is the
    // second lock on the same door, because the cost of it being wrong is
    // executing a PR author's code.
    if (prepared.baseSha !== request.baseSha) {
      throw new Error("Prepared worktree does not sit at the requested base commit");
    }
    const sourceRoot = prepared.baseWorktreePath;
    onProgress({ stage: "workspace", status: "completed" });

    // Checked AGAIN, now that the lock is held. Two reviews of the same base
    // can both miss the cache before either publishes; without this the second
    // waits out the first and then pays for an identical mapping, which is the
    // most expensive step in a review (PR #99 review). The first has published
    // by the time the lock is released, so the second finds it here.
    //
    // A failure is NOT fatal: the pre-lock lookup already succeeded, so this is
    // an optimisation and mapping remains the correct fallback.
    const alreadyPublished = await cache.lookupContext(key).catch(() => undefined);
    if (alreadyPublished !== undefined) return await pack(alreadyPublished, true);

  // Staging must live beneath the cache root — `promoteContext` refuses to
  // publish from anywhere else — and outside the source worktree, which
  // `ContextMapper.map` refuses to violate.
  let stagingPath: string;
  try {
    const stagingRoot = path.join(cache.root, "staging");
    await mkdir(stagingRoot, { recursive: true });
    stagingPath = await mkdtemp(path.join(stagingRoot, `${randomUUID()}-`));
  } catch (error) {
    return unavailable([`context staging directory could not be created: ${errorMessage(error)}`]);
  }

  let published: PublishedMapping | undefined;
  // Collected rather than returned from inside the `try`. Under `require`,
  // `unavailable()` THROWS — so calling it in there would have the catch below
  // swallow its own ContextRequiredError and wrap it in a second one, handing
  // the caller a nested message and a single concatenated string in place of
  // the mapper's actual reasons. Recording the reasons and deciding after the
  // block removes that hazard instead of catching it.
  let failureReasons: string[] | undefined;
  // Which stage a thrown error belongs to. Reporting a mapper crash as a
  // publish failure would send anyone reading progress events to the wrong
  // half of the pipeline.
  let stage: "map" | "publish" = "map";
  try {
    const mapper = await (dependencies.createMapper ?? defaultMapperFactory)();
    onProgress({ stage: "map", status: "started" });
    const mapped = await mapper.map({
      sourceRoot,
      outputRoot: stagingPath,
      baseSha: request.baseSha,
      repository: request.repository,
      ...(request.allowDegraded ? { allowDegradedContext: true } : {}),
    });
    if (mapped.status === "failed") {
      onProgress({ stage: "map", status: "failed" });
      failureReasons = [mapped.failure?.message ?? "mapping failed"];
    } else if (mapped.status === "degraded") {
      onProgress({ stage: "map", status: "completed" });
      // A degraded map has a CONTEXT.md but no usable graph, and a pack
      // without a knowledge graph is not something a rule can reason over.
      // Report precisely what was missing instead of publishing an entry that
      // could never produce a pack.
      failureReasons = mapped.degradedReasons.length === 0
        ? ["mapping degraded"]
        : [...mapped.degradedReasons];
    } else {
      onProgress({ stage: "map", status: "completed" });
      stage = "publish";
      onProgress({ stage: "publish", status: "started" });
      published = await publishMapping(
        cache,
        stagingPath,
        key,
        mapped.artifactPaths,
        mapped.degradedReasons,
        now(),
      );
      onProgress({ stage: "publish", status: published === undefined ? "failed" : "completed" });
    }
  } catch (error) {
    onProgress({ stage, status: "failed" });
    failureReasons = [`context ${stage === "map" ? "mapping" : "publication"} failed: ${errorMessage(error)}`];
  } finally {
    // A successful promotion renames the staging directory away, so this only
    // ever removes what promotion left behind.
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failureReasons !== undefined) return unavailable(failureReasons);
  if (published === undefined) {
    return unavailable(["context could not be published and no concurrent entry was found"]);
  }
  return await pack(published.manifest, false, published.ours);
    });
  } catch (error) {
    // `unavailable` THROWS under `require`, and everything inside the callback
    // may call it. Re-thrown rather than relabelled, or a mapping failure would
    // be reported as a workspace one and its reasons replaced by this message.
    if (error instanceof ContextRequiredError) throw error;
    onProgress({ stage: "workspace", status: "failed" });
    return unavailable([`base worktree could not be prepared: ${errorMessage(error)}`]);
  }
}

/**
 * Imported lazily so `--context off`, and any run that hits a warm cache
 * before reaching this point, never pays to load the pi SDK.
 */
async function defaultMapperFactory(): Promise<ContextMapper> {
  const { TgdPiMapper } = await import("./tgd-mapper.js");
  return new TgdPiMapper();
}
