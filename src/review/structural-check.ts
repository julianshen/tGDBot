// Issue #75: check a finding's structural claim against the trusted base tree.
//
// A reviewer that says "this function is never called" is asserting something
// about code it cannot see. `#58`'s context pack helps it reason — a distance
// 0/1 neighbourhood of the changed files — but nothing checks the assertion
// afterwards, and the assertion is exactly the one that produces the confident
// false positive: a changed function reported as unused because its only caller
// sits outside the diff.
//
// This module answers that one question mechanically. The host parses the BASE
// worktree with ast-grep and counts references to the named symbol. The result
// is a host-established fact — a parser over a tree the host controls — which
// is why it belongs on the trusted side of the boundary #68 drew, and why the
// model's own claim never becomes one.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It never suppresses a finding. A contradicted claim is reported next to the
// finding so a human can weigh both; silently dropping a finding because a
// mechanical check disagreed would trade one confident wrong answer for
// another.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Lang, parseAsync } from "@ast-grep/napi";
import type { RemovedLines } from "./diff-anchors.js";
import { createSymbolResolver, type SymbolResolver } from "./symbol-resolution.js";
import type { Finding } from "./types.js";

/**
 * A structural assertion a finding rests on, supplied by the reviewer as a
 * structured field so the host can check it.
 *
 * Deliberately not inferred from prose. "Never called", "no other caller" and
 * "nothing else implements this" are the same claim in three phrasings, and a
 * regex over `message` would both miss real ones and invent others — the sort
 * of guessing this check exists to replace. A field the reviewer fills in is
 * either present and precise or absent, and absent is a safe default.
 */
export interface StructuralClaim {
  /** Only one kind in v1; the union is the extension point. */
  readonly kind: "no-other-references";
  /** The symbol the claim is about, as it appears in the source. */
  readonly symbol: string;
}

/**
 * One place the symbol's NAME occurs as an identifier. Not a resolved reference.
 *
 * ast-grep matches syntax. It has no notion of which declaration a name binds
 * to, so an unrelated class with a method of the same name, an object key, or
 * another module's own `budget` all look identical to the real callers. For a
 * common identifier — `run`, `get`, `id`, `value` — that is not an edge case
 * but the normal result (Codex review, round 4: a three-line fixture with no
 * relationship to the symbol produced three matches).
 *
 * Resolving names to declarations needs a type checker, which is a materially
 * larger piece of work than this issue scoped. Until then the honest thing is
 * to report what was actually computed and let the reader judge, rather than
 * dress a lexical hit as a resolved contradiction.
 */
export interface SymbolReference {
  /** Repository-relative, POSIX-separated. */
  readonly file: string;
  /** One-based, as an editor counts. */
  readonly line: number;
}

/**
 * A check reports a CONTRADICTION or it reports nothing. There is deliberately
 * no "clean" verdict.
 *
 * The first three review rounds on this PR each found another way a clean
 * result could be wrong — an exhausted file budget, an oversized file, a parse
 * failure, a skipped directory, a finding in a language this cannot parse, and
 * finally the base/head gap: the search reads the base commit while the finding
 * is about the head, so a pull request that deletes the last caller leaves that
 * caller present in the tree being searched. Each was fixed and the next round
 * found a sibling.
 *
 * That is not a run of unlucky bugs; it is the shape of the claim. "No
 * reference exists" is an assertion of ABSENCE, and absence is only sound with
 * total coverage — which is unreachable here. Dynamic references, reflection,
 * generated code, other repositories and every language outside the table are
 * permanently invisible, and no amount of skip-counting changes that.
 *
 * A contradiction has the opposite character. It is positive evidence: the host
 * parsed a file and found the symbol. No gap elsewhere can make that untrue, so
 * it stays sound however incomplete the rest of the search was.
 *
 * So the check keeps the half that is robust and drops the half that cannot be
 * made so. That removes the entire class of "an incomplete search reported
 * clean" rather than its current instance, and it costs little: the value of
 * this feature is catching a finding that is WRONG, and a reader who sees no
 * host check simply reads the finding on its own merits, as they did before.
 */
export type StructuralCheck =
  /**
   * The symbol's name occurs, as an identifier, in a file other than the
   * finding's own.
   *
   * NOT "these are references to that symbol" — see `SymbolReference`. ast-grep
   * matches syntax, not meaning, so this is a lexical result and the wording
   * everywhere says so.
   */
  | {
    readonly status: "lexical-matches";
    readonly references: readonly SymbolReference[];
    readonly filesSearched: number;
    /**
     * The EXACT number of external occurrences, counted as each match is
     * found (issue #83). `references` is a bounded display sample — enough
     * for every renderer — so the published count must NOT be read from
     * `references.length`; a capped list would publish a number the host
     * cannot stand behind. Absent on legacy results whose check predates
     * inline reconciliation, and on results from an injected check; those
     * are reconciled post-hoc by `reconcileWithDiff`, whose count stays
     * `references.length` because nothing was discarded before the filter.
     */
    readonly occurrences?: number;
  }
  /**
   * The checker RESOLVED occurrences of the name to the symbol the finding's
   * own file declares (issue #77): the TypeScript compiler bound each match
   * to that declaration, directly or through an import alias. This is the
   * evidence a lexical match cannot be — a same-named member of an unrelated
   * type does not resolve.
   *
   * The result is a union of three counts, because honesty here means saying
   * what became of every occurrence the walk found:
   *
   * - `references`/`occurrences` — resolved references. The accusation.
   * - `unresolved`/`unresolvedOccurrences` — same-named occurrences in
   *   type-checked files that bound to OTHER symbols (or could not be
   *   attributed at all, e.g. an import whose package the base tree does not
   *   vendor). Not an accusation in either direction, but published so the
   *   wording can account for the full census rather than silently dropping
   *   the noise it filtered.
   * - `lexicalFallback`/`lexicalFallbackOccurrences` — occurrences in files
   *   the checker does not type-check (a file outside the tsconfig program).
   *   For those, the lexical answer is all there is, and the wording says so
   *   — this is the coexistence the issue asks for: a file the checker
   *   cannot resolve still gets the lexical answer rather than nothing.
   *
   * Zero resolved occurrences never becomes a clean verdict — see the
   * `not-checked` block below for why absence stays unsound even here.
   */
  | {
    readonly status: "resolved";
    readonly references: readonly SymbolReference[];
    readonly occurrences: number;
    readonly unresolved: readonly SymbolReference[];
    readonly unresolvedOccurrences: number;
    readonly lexicalFallback?: {
      readonly references: readonly SymbolReference[];
      readonly occurrences: number;
    };
    readonly filesSearched: number;
    readonly filesResolved: number;
    /**
     * The per-claim deadline stopped the walk partway through the program
     * (issue #77; Codex review of PR #104). The counts are exact for the
     * files the checker reached — `filesResolved` IS that reached count, not
     * the program's — and the renderer must say the walk was cut short
     * rather than render a complete-scan number.
     */
    readonly partial?: true;
  }
  /** Nothing was established. Always carries why, and never means "no callers exist". */
  | { readonly status: "not-checked"; readonly reason: string };

/**
 * The node kinds that carry a reference to a symbol, per language.
 *
 * This table is the correctness core of the whole check, and it was built by
 * measurement rather than intuition. In TypeScript, `foo.budget(2)`,
 * `{ budget: 1 }`, `obj?.budget`, `class C { budget() {} }` and
 * `type T = { budget: string }` all put the name in a `property_identifier`,
 * NOT an `identifier` — five of seven reference forms in a small sample. A
 * check that searched `identifier` alone would have found two of them and
 * reported "no other references", CONFIRMING a false finding. That is worse
 * than no check at all, which is why an unlisted language is refused outright
 * rather than searched with a plausible-looking default.
 */
const REFERENCE_KINDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["ts", ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "type_identifier"]],
  ["tsx", ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "type_identifier"]],
  ["js", ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]],
  ["jsx", ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]],
]);

const LANG_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"], [".mts", "ts"], [".cts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"], [".mjs", "js"], [".cjs", "js"],
  [".jsx", "jsx"],
]);

/**
 * Language key -> the `Lang` MEMBER NAME, deliberately not the value.
 *
 * Reading `Lang.TypeScript` here would evaluate the native binding at module
 * load, and `cli.ts` imports this module unconditionally — so on any platform
 * `@ast-grep/napi` ships no prebuilt binary for (Linux ppc64/s390x, FreeBSD,
 * and anywhere its nine optional packages do not cover), EVERY command would
 * die at startup over a feature that defaults to off (Codex review, round 8).
 * A flag nobody enabled must not be able to break `--help`.
 */
const AST_LANG: ReadonlyMap<string, "TypeScript" | "Tsx" | "JavaScript"> = new Map([
  ["ts", "TypeScript"],
  ["tsx", "Tsx"],
  ["js", "JavaScript"],
  ["jsx", "JavaScript"],
]);

/** The native parser, loaded on first use and remembered — including a failure. */
let parserModule: Promise<{ Lang: typeof Lang; parseAsync: typeof parseAsync }> | undefined;
function loadParser(): Promise<{ Lang: typeof Lang; parseAsync: typeof parseAsync }> {
  parserModule ??= import("@ast-grep/napi");
  return parserModule;
}

/** Directories never worth walking, and expensive to walk by mistake. */
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".turbo", "vendor", "target",
]);

/**
 * A symbol must look like an identifier before it is searched for.
 *
 * The value is compared with `===` against node text, so it is not an
 * injection vector the way a regex or a shell argument would be. This rejects
 * it anyway: a "symbol" carrying spaces, dots or newlines is not a symbol, and
 * quietly searching for one would produce a confident "no references" about a
 * question that was never coherent.
 */
const SYMBOL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** Bounds, so a large repository cannot turn one finding into a long scan. */
export const DEFAULT_FILE_BUDGET = 4000;
export const DEFAULT_TIME_BUDGET_MS = 10_000;
/** Beyond this a file is skipped: a minified bundle is not review material. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface StructuralCheckOptions {
  readonly fileBudget?: number;
  readonly timeBudgetMs?: number;
  /** Overridable so a test can exercise the oversized-file skip without a 2 MiB fixture. */
  readonly maxFileBytes?: number;
  readonly now?: () => number;
  /**
   * Lines this diff removes, keyed by base file (issue #83). Supplied so
   * reconciliation can happen DURING collection — each match is counted or
   * discarded at the moment it is found, which is what lets the published
   * count stay exact while the retained sample is bounded. When absent,
   * nothing is suppressed and `occurrences` counts every external match.
   */
  readonly removedLinesByFile?: ReadonlyMap<string, RemovedLines>;
  /**
   * The type-checker resolver (issue #77), created once per review by
   * `runStructuralChecks` and shared by every claim. Absent — direct calls,
   * injected checks — the check stays lexical, which is the standing
   * degradation path, not a special case.
   */
  readonly resolver?: SymbolResolver;
}

/**
 * Parses a reviewer-supplied claim, or returns undefined.
 *
 * Strict by construction: an unknown `kind`, a missing symbol, or a symbol that
 * is not identifier-shaped yields nothing rather than a claim the check would
 * then answer meaninglessly.
 */
export function parseStructuralClaim(value: unknown): StructuralClaim | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "no-other-references") return undefined;
  const symbol = candidate.symbol;
  if (typeof symbol !== "string" || !SYMBOL_PATTERN.test(symbol)) return undefined;
  return { kind: "no-other-references", symbol };
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * One canonical repo-relative spelling, so two names for one file compare equal.
 *
 * The scan reports `path.relative(baseRoot, file)` — always `src/a.ts`. A
 * finding's path comes from reviewer output, which `normalizeUnknownFinding`
 * accepts as any string, so an equivalent spelling like `./src/a.ts` or
 * `src//a.ts` reached the comparison unchanged and did not match. The symbol's
 * OWN declaration was then published as an external lexical match, even with
 * nothing else in the repository using the name — a false accusation produced
 * by a cosmetic difference (Codex review, round 12).
 *
 * Leading `./` and `/` are stripped after normalising, so an absolute or
 * dot-relative spelling of a repo-relative path lands on the same key. A path
 * that escapes the root (`../x`) is left as-is: it matches nothing the scan can
 * report, which is the correct outcome rather than a silent reinterpretation.
 */
function canonicalRelative(value: string): string {
  const normalized = path.posix.normalize(toPosix(value));
  return normalized.replace(/^\.\//u, "").replace(/^\/+/u, "");
}

/**
 * Every source file under `root` this check knows how to parse, and whether the
 * walk stopped early.
 *
 * Bounded by both a file cap and the shared deadline, because the walk itself
 * can be long in a repository full of files this cannot parse. Stopping early
 * costs only completeness, and completeness is no longer load-bearing: the one
 * verdict this check issues is a contradiction, which a file left unvisited
 * cannot make untrue. See `StructuralCheck`.
 */
async function collectSourceFiles(
  root: string,
  budget: number,
  expired: () => boolean,
): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && found.length < budget && !expired()) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Per ENTRY, not per directory. The outer `while` alone left one
      // directory of unsupported files running past the deadline, because
      // nothing there increments `found` — and I had already told a reviewer
      // this was "checked on every iteration of the walk", which it was not
      // (Codex review, round 14).
      if (found.length >= budget || expired()) break;
      const full = path.join(directory, entry.name);
      // Never follow a symlink out of the tree: the answer must be about the
      // worktree that was checked out, not about wherever a link points.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (LANG_BY_EXTENSION.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  }
  return found;
}

/**
 * Counts references to `claim.symbol` in the base worktree.
 *
 * `findingFile` is the file the finding is anchored to, and its only role is to
 * decide whether there is anything to report at all: a reference in ANOTHER
 * file is evidence against "no other references", while a same-file reference
 * cannot be told apart from the definition itself. The finding's line number is
 * deliberately not used — it counts lines in the PR head, and this searches the
 * base, so the two do not correspond.
 *
 * `findingFileAtBase` exists because that path asymmetry has a second edge. When
 * the pull request RENAMES the file, `findingFile` is the head path and the base
 * tree holds the same code under the old one — so the symbol's own declaration
 * looks like a reference from another file, and the check publishes a
 * contradiction that is purely an artefact of the rename. The caller passes the
 * base-side path when it knows one, and both are treated as the finding's own.
 */
export async function checkStructuralClaim(
  claim: StructuralClaim,
  input: {
    readonly baseRoot: string;
    readonly findingFile: string;
    /** The same file's path at the base commit, when the PR renamed it. */
    readonly findingFileAtBase?: string;
    /**
     * The finding's anchored line (head side), used ONLY by the type checker
     * (issue #77) to pick which same-named declaration in the finding's own
     * file the claim is about — never as a search coordinate, for the same
     * head/base reason the walk above states.
     */
    readonly findingLine?: number;
  },
  options: StructuralCheckOptions = {},
): Promise<StructuralCheck> {
  const now = options.now ?? (() => Date.now());
  const fileBudget = options.fileBudget ?? DEFAULT_FILE_BUDGET;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const removedLinesByFile = options.removedLinesByFile;
  const started = now();

  if (!path.isAbsolute(input.baseRoot)) {
    return { status: "not-checked", reason: "the base worktree path is not absolute" };
  }
  try {
    if (!(await stat(input.baseRoot)).isDirectory()) {
      return { status: "not-checked", reason: "the base worktree is not a directory" };
    }
  } catch {
    return { status: "not-checked", reason: "the base worktree is unavailable" };
  }

  // The finding's OWN language decides whether this search is even about the
  // right thing. A claim on a Go file in a mixed repository would otherwise
  // walk the TypeScript files, find nothing, and report on a language where
  // neither the symbol nor its callers live (Codex review, round 3).
  if (!LANG_BY_EXTENSION.has(path.extname(input.findingFile).toLowerCase())) {
    return {
      status: "not-checked",
      reason: `this check reads TypeScript and JavaScript only, and the finding is in ${path.extname(input.findingFile) || "a file with no extension"}`,
    };
  }

  // Loaded HERE rather than at module scope: see `AST_LANG`. A platform with no
  // prebuilt binary degrades to an unperformed check instead of taking the CLI
  // down with it.
  let parser;
  try {
    parser = await loadParser();
  } catch {
    return {
      status: "not-checked",
      reason: "the structural parser is not available on this platform",
    };
  }

  const expired = (): boolean => now() - started > timeBudgetMs;
  const files = await collectSourceFiles(input.baseRoot, fileBudget, expired);
  if (files.length === 0) {
    return {
      status: "not-checked",
      reason: "no files in a language this check supports were found in the base branch",
    };
  }

  const ownFiles = new Set([
    canonicalRelative(input.findingFile),
    ...(input.findingFileAtBase === undefined ? [] : [canonicalRelative(input.findingFileAtBase)]),
  ]);
  // Bounded by MAX_RETAINED_REFERENCES: a display sample, not the census.
  // Issue #83 — a generated file dense with one identifier used to push one
  // {file, line} pair per match into this list, on the order of 10⁵ entries
  // for a 2 MiB file, all retained before any counting happened.
  const references: SymbolReference[] = [];
  // The census. Counted at the moment each match is found, together with the
  // reconciliation decision for THAT match — so the published count survives
  // the retention cap exactly, and reconciliation no longer needs the
  // discarded matches' coordinates.
  let occurrences = 0;
  let suppressedOccurrences = 0;
  let filesSearched = 0;
  // Exact census PER FILE (issue #77): resolution needs to know how many
  // occurrences sit in files the type checker does not cover, and the
  // retained reference sample cannot answer that — it is capped.
  const occurrencesByFile = new Map<string, number>();
  // Whether the walk stopped early on the clock. A PARTIAL scan cannot make
  // the complete-scan claim below — see the `occurrences === 0` branch.
  let walkExpired = false;

  walk: for (const file of files) {
    // Stop, but evaluate what was already found rather than discarding it: a
    // reference read before the deadline is still a reference.
    if (expired()) {
      walkExpired = true;
      break;
    }
    const language = LANG_BY_EXTENSION.get(path.extname(file).toLowerCase());
    const kinds = language === undefined ? undefined : REFERENCE_KINDS.get(language);
    const astLangName = language === undefined ? undefined : AST_LANG.get(language);
    const astLang = astLangName === undefined ? undefined : parser.Lang[astLangName];
    if (kinds === undefined || astLang === undefined) continue;

    let source: string;
    try {
      const info = await stat(file);
      // A minified bundle is not review material, but it is still a file this
      // search did not read.
      if (info.size > maxFileBytes) continue;
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }

    let root;
    try {
      root = (await parser.parseAsync(astLang, source)).root();
    } catch {
      continue;
    }
    filesSearched += 1;

    const relative = canonicalRelative(path.relative(input.baseRoot, file));
    for (const kind of kinds) {
      // Never START a discovery after the deadline (CodeRabbit review of
      // PR #93): the overshoot is then bounded by one kind's discovery in one
      // file. `findAll` itself is atomic — it materializes every match of one
      // kind in Rust before JS sees the first node, and napi 0.45.2 offers no
      // streaming or cancellation API (SgNode.findAll → Array; there is no
      // iterator). Measured on the pathological file from issue #83 (2 MiB,
      // ~190k matches): discovery ≈ 200ms, which the budget absorbs; the
      // 2 MiB parse BEFORE it is also atomic and three-halves the cost, so a
      // manual `children()` walk — thousands of FFI calls per ordinary file —
      // could not make the per-file cost deadline-aware anyway. Everything
      // JS-side below IS per-node deadline-bounded.
      if (expired()) {
        walkExpired = true;
        break walk;
      }
      for (const node of root.findAll({ rule: { kind } })) {
        // Issue #83: the deadline is consulted MID-FILE, not only between
        // files. One dense file could otherwise run the whole budget after
        // the last file boundary. Stopping here yields a PARTIAL count, and
        // undercounting is the safe direction — the same trade the per-file
        // break above already made.
        if (expired()) {
          walkExpired = true;
          break walk;
        }
        if (node.text() !== claim.symbol) continue;
        // The finding's own files are filtered HERE rather than after the
        // walk: reconciliation and the census are per-match decisions, and a
        // discarded match must be discarded before it costs memory.
        if (ownFiles.has(relative)) continue;
        const reference: SymbolReference = { file: relative, line: node.range().start.line + 1 };
        // Reconcile DURING collection (issue #83): a match the diff may
        // already have deleted is counted as suppressed and discarded NOW,
        // at the moment it is found. This is the rework the issue called
        // for — a cap bolted onto the old shape would have made the published
        // count wrong, because reconciliation subtracts from the retained
        // list, and with the list capped the post-reconciliation count is
        // unknowable.
        if (suppressedByDiff(claim.symbol, reference, removedLinesByFile)) {
          suppressedOccurrences += 1;
          continue;
        }
        occurrences += 1;
        occurrencesByFile.set(relative, (occurrencesByFile.get(relative) ?? 0) + 1);
        if (references.length < MAX_RETAINED_REFERENCES) references.push(reference);
      }
    }
  }

  // The every-file-removed claim is a statement about the WHOLE walk, so it
  // must never fire on a partial one (CodeRabbit review of PR #93): the
  // deadline may have stopped the scan after the last suppressed match but
  // before an unread survivor, and publishing "removes lines mentioning it
  // from every file" over a half-read tree would be the host asserting more
  // than it read. A partial scan falls back to the ordinary not-checked
  // reason, which overclaims nothing. A partial scan that DID find survivors
  // still publishes them — undercounting is the safe direction.
  if (occurrences === 0 && suppressedOccurrences > 0 && !walkExpired) {
    return { status: "not-checked", reason: REMOVED_EVERYWHERE_REASON };
  }
  if (occurrences === 0) {
    return {
      status: "not-checked",
      reason: `the name did not occur outside its own file in ${filesSearched} file(s) of the base branch, which is not evidence that no reference exists`,
    };
  }

  references.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file));
  const lexical: StructuralCheck = {
    status: "lexical-matches",
    references,
    // Exact even when the sample is capped: the count was taken at
    // collection, not read off the retained list.
    occurrences,
    filesSearched,
  };

  // Issue #77: with a resolver available, upgrade the lexical answer to a
  // resolved one. Resolution runs ONLY on a non-empty walk — the zero cases
  // above already carry their own honest wording, and a program cannot
  // sharpen "the name did not occur" into anything sounder (absence stays
  // unsound either way).
  const resolver = options.resolver;
  if (resolver === undefined) return lexical;
  let resolution;
  try {
    resolution = await resolver.resolve({
      claim,
      findingFile: input.findingFile,
      ...(input.findingFileAtBase === undefined ? {} : { findingFileAtBase: input.findingFileAtBase }),
      ...(input.findingLine === undefined ? {} : { findingLine: input.findingLine }),
      // The resolver walks the base tree independently of the lexical walk
      // above, and without this its resolved census would resurrect callers
      // the diff may already be deleting — the exact reconciliation the walk
      // applies during collection (Codex review of PR #104). One predicate,
      // the shared one below, so both passes answer identically.
      ...(removedLinesByFile === undefined ? {} : {
        isRemoved: (file: string, line: number): boolean =>
          suppressedByDiff(claim.symbol, { file, line }, removedLinesByFile),
      }),
    }, {
      // The walk runs inside the SAME wall-clock bound the lexical walk just
      // respected: what remains of this check's budget. Stopping early costs
      // attribution (unresolved), never soundness — a resolved reference
      // found before the deadline is still one.
      timeBudgetMs: Math.max(0, timeBudgetMs - (now() - started)),
      now,
    });
  } catch {
    // HOST-AUTHORED wording lives in the caller's rendering of the lexical
    // result; resolution failing is the standing degradation, not an error
    // to surface.
    return lexical;
  }
  if (!resolution.available) return lexical;

  // The lexical fallback: occurrences in files the program does not cover,
  // from the per-file census — exact, not read off the capped sample.
  let fallbackOccurrences = 0;
  const fallbackReferences: SymbolReference[] = [];
  for (const [file, count] of occurrencesByFile) {
    if (resolver.covers(file)) continue;
    fallbackOccurrences += count;
  }
  for (const reference of references) {
    if (!resolver.covers(reference.file)) fallbackReferences.push(reference);
  }

  // Zero resolved references is SUPPORT for the claim, never proof of it —
  // the same invariant the lexical walk holds. Dynamic references, string
  // access, generated code and uncovered files stay invisible, so the check
  // still refuses the clean verdict; the reason reports what was actually
  // computed, which is materially more than the lexical refusal could say.
  // When the only surviving occurrences are in files the checker cannot
  // attribute, the lexical answer is the whole visible answer, and the
  // published result is exactly the pre-#77 one rather than a resolution
  // result whose resolved half is empty.
  if (resolution.resolvedOccurrences === 0) {
    if (fallbackOccurrences > 0) return lexical;
    return {
      status: "not-checked",
      reason: resolution.unresolvedOccurrences > 0
        ? `the type checker resolved ${resolution.unresolvedOccurrences} occurrence(s) of the name in ${resolution.filesResolved} type-checked file(s) and every one binds to a different symbol, which is not evidence that no reference exists — dynamic references and files outside the type check stay invisible`
        : `no occurrence of the name in ${resolution.filesResolved} type-checked file(s) resolved to this symbol, which is not evidence that no reference exists`,
    };
  }

  const lexicalFallback = fallbackOccurrences === 0 ? undefined : {
    references: fallbackReferences,
    occurrences: fallbackOccurrences,
  };
  return {
    status: "resolved",
    references: resolution.resolved,
    occurrences: resolution.resolvedOccurrences,
    unresolved: resolution.unresolved,
    unresolvedOccurrences: resolution.unresolvedOccurrences,
    ...(lexicalFallback === undefined ? {} : { lexicalFallback }),
    filesSearched,
    filesResolved: resolution.filesResolved,
    ...(resolution.partial ? { partial: true as const } : {}),
  };
}

/**
 * One line of prose for a check result, for rendering beside the finding.
 *
 * Two things it must never say, both learned the hard way on this PR. It never
 * reports an absence as proof — a dynamic call, an unparsed language, generated
 * code or a caller in another repository is invisible to this search. And it
 * never calls a match a reference: ast-grep matches syntax, so an unrelated
 * type's same-named member is indistinguishable from a real caller here, and
 * presenting one as a resolved contradiction would be the trusted-fact problem
 * this whole design exists to avoid.
 */
export function describeCheck(
  claim: StructuralClaim,
  check: StructuralCheck,
  /**
   * Escapes a value before it is interpolated into a code span.
   *
   * Defaulted to identity so the wording is testable on its own, and supplied
   * by the renderer in production. The paths come from the base worktree's
   * filesystem, and a filename may legally contain a backtick — which git
   * writes bare, and which closes the span it lands in (#63). The symbol is
   * already identifier-constrained by `parseStructuralClaim`, so this is
   * defence in depth there and a real requirement for the paths.
   */
  escape: (value: string) => string = (value) => value,
): string {
  if (check.status === "not-checked") {
    return `Host check: not performed — ${escape(check.reason)}.`;
  }
  if (check.status === "resolved") {
    // The one status allowed to sound confident, because it IS one: the
    // compiler bound these occurrences to the declaration in the finding's
    // own file. Everything else the walk saw is still accounted for — the
    // same-named noise (unresolved) and the files the checker could not
    // type-check (lexical fallback) — because a host line that silently
    // dropped part of its own census would be overclaiming from the other
    // direction.
    const total = check.occurrences;
    const shown = check.references.slice(0, 5);
    const rendered = shown.map((reference) => `\`${escape(`${reference.file}:${reference.line}`)}\``).join(", ");
    const more = total > shown.length ? `, and ${total - shown.length} more` : "";
    const parts = [
      `Host check: the name \`${escape(claim.symbol)}\` resolves to ${total} reference(s) outside this file, across ${check.filesResolved} type-checked file(s) of the base branch — ${rendered}${more}.`,
      `These are RESOLVED references: the type checker matched them to the declaration of \`${escape(claim.symbol)}\` in this file.`,
    ];
    if (check.unresolvedOccurrences > 0) {
      const unresolvedShown = check.unresolved.slice(0, 3);
      const unresolvedRendered = unresolvedShown
        .map((reference) => `\`${escape(`${reference.file}:${reference.line}`)}\``)
        .join(", ");
      const unresolvedMore = check.unresolvedOccurrences > unresolvedShown.length
        ? `, and ${check.unresolvedOccurrences - unresolvedShown.length} more`
        : "";
      parts.push(
        `${check.unresolvedOccurrences} other occurrence(s) of the name in those files do NOT resolve to this \`${escape(claim.symbol)}\` (${unresolvedRendered}${unresolvedMore}) — different symbols that share the spelling.`,
      );
    }
    if (check.partial === true) {
      parts.push(
        `The deadline stopped the walk after ${check.filesResolved} file(s) — the counts cover what the checker reached, and a later poll may find more.`,
      );
    }
    if (check.lexicalFallback !== undefined) {
      const fallback = check.lexicalFallback;
      const fallbackShown = fallback.references.slice(0, 3);
      const fallbackRendered = fallbackShown
        .map((reference) => `\`${escape(`${reference.file}:${reference.line}`)}\``)
        .join(", ");
      const fallbackMore = fallback.occurrences > fallbackShown.length
        ? `, and ${fallback.occurrences - fallbackShown.length} more`
        : "";
      parts.push(
        `Plus ${fallback.occurrences} occurrence(s) in file(s) the type checker does not cover (${fallbackRendered}${fallbackMore}) — LEXICAL matches only, unresolved by the host.`,
      );
    }
    return parts.join(" ");
  }
  const scope = `${check.filesSearched} file(s) of the base branch`;
  // `occurrences` is the exact census (issue #83); legacy and injected results
  // predate it, and for them `references.length` is still the whole truth.
  const total = check.occurrences ?? check.references.length;
  const shown = check.references.slice(0, 5);
  const rendered = shown.map((reference) => `\`${escape(`${reference.file}:${reference.line}`)}\``).join(", ");
  const more = total > shown.length
    ? `, and ${total - shown.length} more`
    : "";
  return `Host check: the name \`${escape(claim.symbol)}\` occurs ${total} time(s) outside this file, across ${scope} — ${rendered}${more}. These are LEXICAL matches: the host did not resolve whether they refer to this \`${escape(claim.symbol)}\`, and a same-named member of an unrelated type looks identical here. Worth checking before relying on the claim above.`;
}

/**
 * The most claims one review will check.
 *
 * Each claim is a full walk of the base tree, so an unbounded loop over a
 * finding-heavy review is a real cost. Blocking findings are checked first
 * because they are the ones a reader acts on soonest, and a wrong "never
 * called" is most expensive there.
 */
/**
 * The parser — and, since #77, the type checker — this check's answers came
 * from, for the review-config hash.
 *
 * A published host check is a parse by a specific ast-grep version, and (when
 * resolution was available) a symbol resolution by a specific typescript
 * version. Upgrade either and the same claim can get a different answer — but
 * the dedup marker is keyed on head SHA plus config hash, so without this an
 * already-reviewed head is skipped and the stale answer stands. Same reasoning
 * as `dispatch`, and the same modest price: one re-review per open pull
 * request per upgrade.
 *
 * Kept as a constant rather than read from `package.json` at runtime, because
 * that file sits outside `rootDir` and importing it would complicate the build
 * for a value that changes once a year. `structural-check-engine.test.ts`
 * asserts it matches the dependency pin, so the two cannot drift silently.
 */
export const STRUCTURAL_CHECK_ENGINE = "ast-grep@0.45.2+typescript@5.9.3";

export const DEFAULT_CLAIM_BUDGET = 10;

/**
 * The most wall-clock time ALL of a review's checks may take, together.
 *
 * `DEFAULT_TIME_BUDGET_MS` bounds one check, and was being restarted for each
 * claim — so the advertised 10 seconds was really 10 seconds times the claim
 * budget, up to about 100 (CodeRabbit review). Each claim re-walks and
 * re-parses the whole base tree, so that is a real cost, and it arrives on a
 * feature whose entire pitch is that it is bounded.
 *
 * The shared deadline is what makes the number honest. A claim that finds the
 * budget already spent is `not-checked` with a reason, which costs coverage
 * and cannot cost correctness — the same trade as every other bound here.
 */
export const DEFAULT_REVIEW_TIME_BUDGET_MS = 30_000;

/**
 * Decisions whose findings can still reach a reader.
 *
 * `orchestrate` publishes the actionable findings plus the disputed ones, and
 * drops `addressed` and `needs-clarification` entirely. Checking those spends
 * a full tree walk — and a slot in a budget of ten — on a result nobody will
 * ever see, and can push a finding that IS published into `not-checked`
 * (Codex review, round 6).
 *
 * `disputed` is deliberately included: those findings do reach a reader,
 * through their own summary section.
 */
function reachesAReader(finding: Finding): boolean {
  const decision = finding.decision ?? "new";
  return decision === "new" || decision === "still-valid" || decision === "disputed";
}

/**
 * Whether this finding carries a claim the production check could actually
 * answer (issue #80).
 *
 * Exported so the CLI can decide whether preparing the base worktree — the
 * feature's largest single cost, a full clone on a cold workspace — is worth
 * anything at all, WITHOUT duplicating the eligibility rules there. "Has a
 * claim" is much weaker than "can be checked": a claim on a Go file, or one
 * whose finding is `addressed`/`needs-clarification`/suppressed, resolves to
 * nothing, and the clone would buy nothing.
 *
 * The language half mirrors the refusal at the top of `checkStructuralClaim`
 * — same map, same predicate, one definition. It is deliberately NOT applied
 * by `runStructuralChecks`' own filter: an injected check (a test seam) may
 * support more languages, and filtering those would change what injected
 * tests see; in production the same refusal fires inside the real check
 * anyway, so the prediction here is exact for the code that runs.
 */
export function hasCheckableClaim(
  finding: Finding,
  isSuppressed?: (finding: Finding) => boolean,
): boolean {
  return finding.claim !== undefined
    && reachesAReader(finding)
    && !(isSuppressed?.(finding) ?? false)
    && LANG_BY_EXTENSION.has(path.extname(finding.file).toLowerCase());
}

/**
 * Matches `symbol` as a whole JavaScript identifier.
 *
 * NOT `\b`, which is wrong here in two directions and was (Codex review,
 * round 7). `$` is legal in an identifier and `SYMBOL_PATTERN` admits it, but
 * it is a regex ANCHOR, so `\b$budget\b` never matched anything — a pull
 * request deleting the last call to `$budget` had that deletion ignored and
 * the stale base occurrence published against a correct finding. Escaping the
 * `$` is not enough either: `\b` needs a WORD character adjacent, and `$` is
 * not one, so `\b\$budget` fails on `x = $budget(1)` as well. Both verified.
 *
 * Explicit lookaround over the JavaScript identifier set is right in the other
 * direction too: it still refuses `rebudget` for `budget`, and now also
 * refuses `budget$x`, which `\b` would have accepted.
 */
function identifierMatcher(symbol: string): RegExp {
  // Defence in depth: `parseStructuralClaim` already forbids everything a
  // regular expression would read as syntax, `$` included.
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "u");
}

/**
 * How many surviving occurrences are RETAINED for display (issue #83).
 *
 * Every renderer shows at most five locations, so five would do; the margin
 * absorbs a renderer change without a second rework of the collection loop.
 * The point of the bound is that the count is NOT carried by this list —
 * `occurrences` is — so the cap costs display detail only, never truth.
 */
const MAX_RETAINED_REFERENCES = 8;

/**
 * Whether the diff removes the line this occurrence sits on.
 *
 * The ONE reconciliation predicate, shared by the collection loop (which
 * counts as it discards, issue #83) and by `reconcileWithDiff` (which filters
 * results whose check predates inline reconciliation, including every
 * injected check). Two predicate definitions would eventually disagree — the
 * word-boundary rule below was itself a round-4 fix, and a drift here would
 * silently resurrect it.
 *
 * An occurrence becomes doubtful when the pull request removes the line it
 * sits on. Base line numbers and the diff's old-side numbers are the same
 * coordinates by construction — both count the file at the base commit. Where
 * the diff's hunk headers could not be parsed, the positions are not
 * trustworthy and it falls back to the whole file. Over-suppressing is the
 * safe direction for a check whose only output is an accusation.
 */
function suppressedByDiff(
  symbol: string,
  reference: SymbolReference,
  removedLinesByFile: ReadonlyMap<string, RemovedLines> | undefined,
): boolean {
  if (removedLinesByFile === undefined) return false;
  const removed = removedLinesByFile.get(reference.file);
  if (removed === undefined) return false;
  if (!removed.positioned) return identifierMatcher(symbol).test(removed.text);
  const line = removed.byLine.get(reference.line);
  return line !== undefined && identifierMatcher(symbol).test(line);
}

/**
 * The not-checked reason for a claim whose every base occurrence the diff
 * may already have deleted. Shared verbatim by `reconcileWithDiff` and the
 * inline reconciliation in `checkStructuralClaim` — the same answer must
 * carry the same wording whichever path produced it.
 */
const REMOVED_EVERYWHERE_REASON =
  "the name occurs at the base commit, but this pull request removes lines mentioning it from every file where it was found — the check reads the base, so it cannot tell whether those are the occurrences being deleted";

/**
 * Drops occurrences the diff may already have deleted, and reports what is left.
 *
 * An occurrence becomes doubtful when the pull request removes the line it sits
 * on. Base line numbers and the diff's old-side numbers are the same
 * coordinates by construction — both count the file at the base commit — so a
 * file that loses one call site and keeps another now keeps the second. Whole-
 * file granularity discarded both (Codex review, round 7); that was a
 * deliberate over-suppression, and it turns out to cost exactly the case the
 * check is most often about.
 *
 * Where the diff's hunk headers could not be parsed, the positions are not
 * trustworthy and it falls back to the whole file. Over-suppressing is the safe
 * direction for a check whose only output is an accusation.
 */
function reconcileWithDiff(
  claim: StructuralClaim,
  result: StructuralCheck,
  removedLinesByFile: ReadonlyMap<string, RemovedLines> | undefined,
): StructuralCheck {
  if (result.status !== "lexical-matches" || removedLinesByFile === undefined) return result;
  // A result carrying `occurrences` was reconciled DURING collection
  // (issue #83): every match was counted or discarded at the moment it was
  // found, so there is nothing left to filter and the count is already the
  // exact post-reconciliation figure. Filtering the bounded sample again
  // would be pointless — and could not reconstruct what was discarded anyway.
  // Results without `occurrences` come from an injected check (or predate the
  // rework): they retained EVERYTHING, so the post-hoc filter is exact.
  if (result.occurrences !== undefined) return result;
  const surviving = result.references.filter((reference) =>
    !suppressedByDiff(claim.symbol, reference, removedLinesByFile));
  if (surviving.length === result.references.length) return result;
  if (surviving.length === 0) {
    return { status: "not-checked", reason: REMOVED_EVERYWHERE_REASON };
  }
  return { ...result, references: surviving };
}

const SEVERITY_ORDER: Readonly<Record<string, number>> = {
  blocking: 0,
  warning: 1,
  suggestion: 2,
};

export interface RunStructuralChecksInput {
  readonly findings: readonly Finding[];
  readonly baseRoot: string;
  readonly claimBudget?: number;
  /** Head path -> base path for files this PR renames. See `checkStructuralClaim`. */
  readonly renamedFrom?: ReadonlyMap<string, string>;
  /**
   * Lines this diff REMOVES, keyed by the file they were removed from.
   *
   * The search reads the base commit while the finding is about the head, so a
   * pull request that deletes the last caller leaves that caller present in the
   * tree being searched (Codex review, round 3).
   *
   * Reconciled PER FILE and on a word boundary, because the first version of
   * this was a substring test over the whole diff and discarded a valid result
   * whenever the PR merely edited the claimed function's own body — the removed
   * version of that line contains the symbol too — and also matched
   * `rebudget` (round 4). Only an occurrence in a file whose removed lines
   * mention the name is dropped, so an untouched external caller survives.
   */
  readonly removedLinesByFile?: ReadonlyMap<string, RemovedLines>;
  readonly check?: typeof checkStructuralClaim;
  /**
   * Findings the orchestrator will drop even though their own decision looks
   * publishable — today, an actionable copy of an `addressed` finding.
   *
   * INJECTED rather than recomputed, because the rule belongs to `orchestrate`:
   * it suppresses a `new` finding whose dedup key matches an `addressed` one,
   * and a second definition here would be free to drift from it. Without this,
   * ten suppressed higher-severity copies could spend the whole claim budget
   * and leave a finding that IS published unchecked — the round-6 starvation
   * bug through the one route that filter did not cover (Codex, round 12).
   */
  readonly isSuppressed?: (finding: Finding) => boolean;
  /** Wall-clock budget shared by every check in this review. */
  readonly reviewTimeBudgetMs?: number;
  /**
   * Wall-clock budget for the type checker's program construction (issue
   * #77), which is seconds against the lexical walk's milliseconds. Kept
   * SEPARATE from `reviewTimeBudgetMs` on purpose: the shared review budget
   * was sized for bounded walks, and one program build would consume it
   * whole — the issue's own "would need revisiting" note. An exhausted
   * resolution budget degrades every claim to the lexical answer.
   */
  readonly resolutionTimeBudgetMs?: number;
  /** Injectable clock, so the shared deadline is testable without waiting. */
  readonly now?: () => number;
}

/**
 * Attaches a host check to every finding that carries a claim, within budget.
 *
 * Returns a new array; the input findings are not mutated. A finding without a
 * claim is passed through untouched, so a review where no rule uses the field
 * is byte-identical to one where this never ran.
 *
 * Never throws and never drops a finding. A check that fails becomes
 * `not-checked` with the reason attached — the finding is still published,
 * because a finding is worth posting whether or not its metadata resolved.
 */
export async function runStructuralChecks(
  input: RunStructuralChecksInput,
): Promise<Finding[]> {
  const check = input.check ?? checkStructuralClaim;
  const budget = input.claimBudget ?? DEFAULT_CLAIM_BUDGET;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const reviewBudgetMs = input.reviewTimeBudgetMs ?? DEFAULT_REVIEW_TIME_BUDGET_MS;

  // One resolver per review, created on the first claim that will actually
  // be checked and shared by every claim after it. Program construction is
  // the expensive part of resolution (seconds); building it per claim would
  // multiply that by the claim budget. A review with no claims — or one where
  // the resolver is unavailable — never pays for it, and an unavailable
  // resolver degrades every claim to the lexical answer rather than failing.
  let resolver: SymbolResolver | undefined;
  let resolverFailed = false;
  const ensureResolver = async (): Promise<SymbolResolver | undefined> => {
    if (resolver !== undefined || resolverFailed) return resolver;
    try {
      resolver = await createSymbolResolver(input.baseRoot, {
        now,
        ...(input.resolutionTimeBudgetMs === undefined
          ? {}
          : { resolutionTimeBudgetMs: input.resolutionTimeBudgetMs }),
      });
    } catch {
      resolverFailed = true;
    }
    return resolver;
  };

  const claimed = input.findings
    .map((finding, index) => ({ finding, index }))
    .filter((entry) => entry.finding.claim !== undefined
      && reachesAReader(entry.finding)
      && !(input.isSuppressed?.(entry.finding) ?? false))
    .sort((left, right) => {
      const bySeverity = (SEVERITY_ORDER[left.finding.severity] ?? 3)
        - (SEVERITY_ORDER[right.finding.severity] ?? 3);
      // Ties keep the reviewer's own order, so the result is deterministic.
      return bySeverity !== 0 ? bySeverity : left.index - right.index;
    });

  const checks = new Map<number, StructuralCheck>();
  // One result per DISTINCT claim, not per finding.
  //
  // Several rules routinely land on the same defect, and `clusterFindings`
  // collapses the exact duplicates into one finding a reader sees. Charging
  // each copy a budget slot meant ten duplicates could exhaust a budget of ten
  // and leave the next DISTINCT claim `not-checked` — a real answer replaced by
  // "not checked" because of copies the reader never sees (Codex review, round
  // 10). Each duplicate also repeated the whole base-tree walk.
  //
  // Sharing is sound because the result does not depend on the finding: the
  // check reads the base tree by file and symbol, and reconciliation keys off
  // the RESULT's own line numbers, not the finding's. So two findings with the
  // same file and symbol have, by construction, the same answer.
  const byClaim = new Map<string, StructuralCheck>();
  // `\u0000` cannot occur in a path or an identifier, so the key is unambiguous.
  const claimKey = (file: string, claim: StructuralClaim): string =>
    `${file}\u0000${claim.kind}\u0000${claim.symbol}`;
  let spent = 0;

  for (const entry of claimed) {
    const claim = entry.finding.claim;
    if (claim === undefined) continue;
    const key = claimKey(canonicalRelative(entry.finding.file), claim);
    const shared = byClaim.get(key);
    if (shared !== undefined) {
      checks.set(entry.index, shared);
      continue;
    }
    if (spent >= budget) {
      checks.set(entry.index, {
        status: "not-checked",
        reason: `this review's limit of ${budget} structural check(s) was already reached`,
      });
      continue;
    }
    const remainingMs = reviewBudgetMs - (now() - startedAt);
    if (remainingMs <= 0) {
      checks.set(entry.index, {
        status: "not-checked",
        reason: `this review's ${reviewBudgetMs}ms budget for structural checks was already spent`,
      });
      continue;
    }
    try {
      // Canonical on BOTH sides: the map is keyed by diff paths, and a
      // finding's path is reviewer output that may be spelled differently.
      const findingFileAtBase = input.renamedFrom?.get(canonicalRelative(entry.finding.file));
      const result = await check(claim, {
        baseRoot: input.baseRoot,
        findingFile: entry.finding.file,
        ...(findingFileAtBase === undefined ? {} : { findingFileAtBase }),
        ...(entry.finding.line === undefined ? {} : { findingLine: entry.finding.line }),
      }, {
        // Never more than what the review has left, so the per-check bound
        // cannot multiply itself by the claim budget.
        timeBudgetMs: Math.min(DEFAULT_TIME_BUDGET_MS, remainingMs),
        now,
        // The diff travels INTO the check so reconciliation can happen during
        // collection (issue #83): counting each match as it is found is what
        // keeps the published count exact while retention is bounded. The
        // post-hoc `reconcileWithDiff` below remains for injected checks,
        // which retain everything and skip it via the `occurrences` marker.
        ...(input.removedLinesByFile === undefined ? {} : { removedLinesByFile: input.removedLinesByFile }),
        ...(await ensureResolver() === undefined ? {} : { resolver: resolver! }),
      });
      // The base/head reconciliation lives here because this is the only layer
      // that can see the diff; `checkStructuralClaim` knows one tree.
      spent += 1;
      const reconciled = reconcileWithDiff(claim, result, input.removedLinesByFile);
      // Only a real answer is shared. A budget or failure outcome is
      // circumstantial, and caching one would freeze a transient condition
      // onto every later copy of the claim.
      byClaim.set(key, reconciled);
      checks.set(entry.index, reconciled);
    } catch {
      // HOST-AUTHORED, not the caught error, for the same reason the worktree
      // failure in `cli.ts` is: this reason is rendered into a review comment,
      // which is world-readable on a public repository, and a filesystem error
      // quotes the absolute path it failed on.
      checks.set(entry.index, { status: "not-checked", reason: "the check failed" });
    }
  }

  const results = input.findings.map((finding, index) => {
    const result = checks.get(index);
    return result === undefined ? finding : { ...finding, hostCheck: result };
  });
  resolver?.dispose();
  return results;
}

/**
 * A one-line host check for the size-constrained renderers.
 *
 * Compact summaries and merged cluster members cannot carry the full sentence,
 * and dropping it there was the same defect as dropping it from the relocated
 * path: a claim published without the answer the host had already computed.
 * It keeps a count and one location — enough for a reader to see the assertion
 * is disputed and where to look — and the word `unresolved`, which is the part
 * that must not be dropped for length: a compact rendering that read as a
 * resolved reference would be a stronger claim than the full one makes.
 */
export function describeCheckCompact(
  check: StructuralCheck,
  escape: (value: string) => string = (value) => value,
): string {
  if (check.status === "not-checked") return "Host check: not performed";
  if (check.status === "resolved") {
    const first = check.references[0];
    const where = first === undefined ? "" : `, e.g. ${escape(`${first.file}:${first.line}`)}`;
    const unresolved = check.unresolvedOccurrences > 0
      ? `, ${check.unresolvedOccurrences} same-named but unresolved`
      : "";
    // The word "resolved" is the part that must not be dropped for length —
    // the same rule the lexical branch's "unresolved" follows.
    return `Host check: the name resolves to ${check.occurrences} reference(s) elsewhere${where}${unresolved} — resolved references`;
  }
  // Same census rule as `describeCheck`: with retention capped, the count
  // lives in `occurrences`, never in the length of the display sample.
  const total = check.occurrences ?? check.references.length;
  const first = check.references[0];
  const where = first === undefined ? "" : `, e.g. ${escape(`${first.file}:${first.line}`)}`;
  return `Host check: the name occurs ${total} time(s) elsewhere${where} — unresolved lexical matches`;
}
