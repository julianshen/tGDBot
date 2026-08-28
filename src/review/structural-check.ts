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
      if (found.length >= budget) break;
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
    toPosix(input.findingFile),
    ...(input.findingFileAtBase === undefined ? [] : [toPosix(input.findingFileAtBase)]),
  ]);
  const references: SymbolReference[] = [];
  let filesSearched = 0;

  for (const file of files) {
    // Stop, but evaluate what was already found rather than discarding it: a
    // reference read before the deadline is still a reference.
    if (expired()) break;
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

  const external = references.filter((reference) => !ownFiles.has(reference.file));
  if (external.length > 0) {
    // Survives every gap above: a file left unread cannot unmake an occurrence
    // that was read. What it does NOT survive is name collision, which is why
    // the status and its wording claim only a lexical match.
    return { status: "lexical-matches", references: external, filesSearched };
  }
  return {
    status: "not-checked",
    reason: `the name did not occur outside its own file in ${filesSearched} file(s) of the base branch, which is not evidence that no reference exists`,
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
  const scope = `${check.filesSearched} file(s) of the base branch`;
  const shown = check.references.slice(0, 5);
  const rendered = shown.map((reference) => `\`${escape(`${reference.file}:${reference.line}`)}\``).join(", ");
  const more = check.references.length > shown.length
    ? `, and ${check.references.length - shown.length} more`
    : "";
  return `Host check: the name \`${escape(claim.symbol)}\` occurs ${check.references.length} time(s) outside this file, across ${scope} — ${rendered}${more}. These are LEXICAL matches: the host did not resolve whether they refer to this \`${escape(claim.symbol)}\`, and a same-named member of an unrelated type looks identical here. Worth checking before relying on the claim above.`;
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
  const asIdentifier = identifierMatcher(claim.symbol);
  const surviving = result.references.filter((reference) => {
    const removed = removedLinesByFile.get(reference.file);
    if (removed === undefined) return true;
    if (!removed.positioned) return !asIdentifier.test(removed.text);
    const line = removed.byLine.get(reference.line);
    return line === undefined || !asIdentifier.test(line);
  });
  if (surviving.length === result.references.length) return result;
  if (surviving.length === 0) {
    return {
      status: "not-checked",
      reason: `the name occurs at the base commit, but this pull request removes lines mentioning it from every file where it was found — the check reads the base, so it cannot tell whether those are the occurrences being deleted`,
    };
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
  /** Wall-clock budget shared by every check in this review. */
  readonly reviewTimeBudgetMs?: number;
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

  const claimed = input.findings
    .map((finding, index) => ({ finding, index }))
    .filter((entry) => entry.finding.claim !== undefined && reachesAReader(entry.finding))
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
    const key = claimKey(entry.finding.file, claim);
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
      const findingFileAtBase = input.renamedFrom?.get(entry.finding.file);
      const result = await check(claim, {
        baseRoot: input.baseRoot,
        findingFile: entry.finding.file,
        ...(findingFileAtBase === undefined ? {} : { findingFileAtBase }),
      }, {
        // Never more than what the review has left, so the per-check bound
        // cannot multiply itself by the claim budget.
        timeBudgetMs: Math.min(DEFAULT_TIME_BUDGET_MS, remainingMs),
        now,
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
  const first = check.references[0];
  const where = first === undefined ? "" : `, e.g. ${escape(`${first.file}:${first.line}`)}`;
  return `Host check: the name occurs ${check.references.length} time(s) elsewhere${where} — unresolved lexical matches`;
}
