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
import { Lang, parseAsync } from "@ast-grep/napi";
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

export interface SymbolReference {
  /** Repository-relative, POSIX-separated. */
  readonly file: string;
  /** One-based, as an editor counts. */
  readonly line: number;
}

export type StructuralCheck =
  /** References exist in a file other than the finding's own. */
  | {
    readonly status: "contradicted";
    readonly references: readonly SymbolReference[];
    readonly filesSearched: number;
  }
  /** No reference outside the finding's own file. NOT "there are no callers" — see `describeCheck`. */
  | {
    readonly status: "consistent";
    readonly references: readonly SymbolReference[];
    readonly filesSearched: number;
  }
  /** The check did not run. Always carries why. */
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

const AST_LANG: ReadonlyMap<string, Lang> = new Map([
  ["ts", Lang.TypeScript],
  ["tsx", Lang.Tsx],
  ["js", Lang.JavaScript],
  ["jsx", Lang.JavaScript],
]);

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
 * Every source file under `root` this check knows how to parse, and whether the
 * walk stopped early.
 *
 * `truncated` is not bookkeeping. A walk that stops at the budget has not seen
 * the whole tree, so "no reference found" would be a statement about the files
 * it happened to reach — and if the only external reference sits in a file past
 * the cap, a truncated walk reports `consistent` and CONFIRMS a false finding.
 * The time budget already refuses for this reason; the file budget must too.
 */
async function collectSourceFiles(
  root: string,
  budget: number,
): Promise<{ files: string[]; truncated: boolean; unreadableDirectories: number }> {
  const found: string[] = [];
  const queue: string[] = [root];
  let truncated = false;
  let unreadableDirectories = 0;
  while (queue.length > 0 && found.length < budget) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // A gap in coverage, counted rather than shrugged off: see `skipped`.
      unreadableDirectories += 1;
      continue;
    }
    for (const entry of entries) {
      if (found.length >= budget) {
        truncated = true;
        break;
      }
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
  // The loop can also exit with directories still queued, which is the same
  // incompleteness by a different route.
  return { files: found, truncated: truncated || queue.length > 0, unreadableDirectories };
}

/**
 * Counts references to `claim.symbol` in the base worktree.
 *
 * `findingFile` is the file the finding is anchored to, and its only role is to
 * decide `contradicted` vs `consistent`: a reference in ANOTHER file
 * unambiguously contradicts "no other references", while a same-file reference
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
  },
  options: StructuralCheckOptions = {},
): Promise<StructuralCheck> {
  const now = options.now ?? (() => Date.now());
  const fileBudget = options.fileBudget ?? DEFAULT_FILE_BUDGET;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
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

  const { files, truncated, unreadableDirectories } = await collectSourceFiles(
    input.baseRoot,
    fileBudget,
  );
  if (files.length === 0) {
    return {
      status: "not-checked",
      reason: "no files in a language this check supports (TypeScript and JavaScript only)",
    };
  }
  if (truncated) {
    return {
      status: "not-checked",
      reason: `the base tree has more than ${fileBudget} supported source files, so a search of it would be incomplete`,
    };
  }

  const ownFiles = new Set([
    toPosix(input.findingFile),
    ...(input.findingFileAtBase === undefined ? [] : [toPosix(input.findingFileAtBase)]),
  ]);
  const references: SymbolReference[] = [];
  let filesSearched = 0;
  /**
   * Supported files this search did not actually read.
   *
   * Counted at EVERY skip rather than enumerated case by case, because the
   * property that matters is not which reason applied — it is whether the
   * search saw the whole tree. Codex found the oversized-file skip; the
   * unreadable-file and parse-failure skips beside it had the identical
   * hazard, and a future one would inherit it too unless the counter sits at
   * the `continue`.
   *
   * A skip invalidates only a NEGATIVE result. Finding a reference elsewhere is
   * positive evidence that no gap can undo, so `contradicted` still stands;
   * "I found nothing" is the claim that depends on having read everything.
   */
  let skipped = unreadableDirectories;

  for (const file of files) {
    if (now() - started > timeBudgetMs) {
      return {
        status: "not-checked",
        reason: `the search budget of ${timeBudgetMs}ms was reached after ${filesSearched} file(s), so the result would be incomplete`,
      };
    }
    const language = LANG_BY_EXTENSION.get(path.extname(file).toLowerCase());
    const kinds = language === undefined ? undefined : REFERENCE_KINDS.get(language);
    const astLang = language === undefined ? undefined : AST_LANG.get(language);
    if (kinds === undefined || astLang === undefined) {
      skipped += 1;
      continue;
    }

    let source: string;
    try {
      const info = await stat(file);
      // A minified bundle is not review material, but it is still a file this
      // search did not read.
      if (info.size > maxFileBytes) {
        skipped += 1;
        continue;
      }
      source = await readFile(file, "utf8");
    } catch {
      skipped += 1;
      continue;
    }

    let root;
    try {
      root = (await parseAsync(astLang, source)).root();
    } catch {
      skipped += 1;
      continue;
    }
    filesSearched += 1;

    const relative = toPosix(path.relative(input.baseRoot, file));
    for (const kind of kinds) {
      for (const node of root.findAll({ rule: { kind } })) {
        if (node.text() !== claim.symbol) continue;
        references.push({ file: relative, line: node.range().start.line + 1 });
      }
    }
  }

  references.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file));

  const elsewhere = references.some((reference) => !ownFiles.has(reference.file));
  if (elsewhere) return { status: "contradicted", references, filesSearched };
  // Only now does the gap matter. See `skipped`.
  if (skipped > 0) {
    return {
      status: "not-checked",
      reason: `${skipped} supported file(s) could not be read or parsed, so a clean result would not be trustworthy`,
    };
  }
  return { status: "consistent", references, filesSearched };
}

/**
 * One line of prose for a check result, for rendering beside the finding.
 *
 * The wording of the `consistent` case is the whole point of the exercise. It
 * says what the host DID — searched N files and found nothing elsewhere — and
 * never says "there are no callers". A dynamic call, a file in a language this
 * check does not parse, a build artifact, reflection, or a caller in another
 * repository are all invisible here, and a reviewer who reads a gap as proof
 * has been misled by the check rather than helped by it.
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
  const scope = `${check.filesSearched} file(s) of the base branch`;
  if (check.status === "contradicted") {
    const shown = check.references.slice(0, 5);
    const rendered = shown.map((reference) => `\`${escape(`${reference.file}:${reference.line}`)}\``).join(", ");
    const more = check.references.length > shown.length
      ? `, and ${check.references.length - shown.length} more`
      : "";
    return `Host check: \`${escape(claim.symbol)}\` appears ${check.references.length} time(s) across ${scope} — ${rendered}${more}. This contradicts the claim above.`;
  }
  return `Host check: searched ${scope} and found no reference to \`${escape(claim.symbol)}\` outside its own file. This is what the search covered, not proof that none exists — dynamic references, unparsed languages and callers outside this repository are invisible to it.`;
}

/**
 * The most claims one review will check.
 *
 * Each claim is a full walk of the base tree, so an unbounded loop over a
 * finding-heavy review is a real cost. Blocking findings are checked first
 * because they are the ones a reader acts on soonest, and a wrong "never
 * called" is most expensive there.
 */
export const DEFAULT_CLAIM_BUDGET = 10;

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
  readonly check?: typeof checkStructuralClaim;
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

  const claimed = input.findings
    .map((finding, index) => ({ finding, index }))
    .filter((entry) => entry.finding.claim !== undefined)
    .sort((left, right) => {
      const bySeverity = (SEVERITY_ORDER[left.finding.severity] ?? 3)
        - (SEVERITY_ORDER[right.finding.severity] ?? 3);
      // Ties keep the reviewer's own order, so the result is deterministic.
      return bySeverity !== 0 ? bySeverity : left.index - right.index;
    });

  const checks = new Map<number, StructuralCheck>();
  for (const [position, entry] of claimed.entries()) {
    const claim = entry.finding.claim;
    if (claim === undefined) continue;
    if (position >= budget) {
      checks.set(entry.index, {
        status: "not-checked",
        reason: `this review's limit of ${budget} structural check(s) was already reached`,
      });
      continue;
    }
    try {
      const findingFileAtBase = input.renamedFrom?.get(entry.finding.file);
      checks.set(
        entry.index,
        await check(claim, {
          baseRoot: input.baseRoot,
          findingFile: entry.finding.file,
          ...(findingFileAtBase === undefined ? {} : { findingFileAtBase }),
        }),
      );
    } catch (error) {
      checks.set(entry.index, {
        status: "not-checked",
        reason: `the check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return input.findings.map((finding, index) => {
    const result = checks.get(index);
    return result === undefined ? finding : { ...finding, hostCheck: result };
  });
}

/**
 * A one-line host check for the size-constrained renderers.
 *
 * Compact summaries and merged cluster members cannot carry the full sentence,
 * and dropping it there was the same defect as dropping it from the relocated
 * path: a claim published without the answer the host had already computed.
 * The `contradicted` case keeps a count and one location — enough for a reader
 * to see the assertion is disputed and where to look — and the `consistent`
 * case still refuses to say no callers exist.
 */
export function describeCheckCompact(
  check: StructuralCheck,
  escape: (value: string) => string = (value) => value,
): string {
  if (check.status === "not-checked") return "Host check: not performed";
  if (check.status === "contradicted") {
    const first = check.references[0];
    const where = first === undefined ? "" : `, e.g. ${escape(`${first.file}:${first.line}`)}`;
    return `Host check: CONTRADICTED — ${check.references.length} reference(s) found${where}`;
  }
  return `Host check: no reference found outside its own file in ${check.filesSearched} file(s) searched`;
}
