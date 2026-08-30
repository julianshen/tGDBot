// Issue #77: resolve symbol identity, so a match can mean a reference.
//
// `structural-check.ts` answers a claim with a lexical walk: ast-grep matches
// syntax, and for a common identifier the normal result is same-named noise —
// `wallet.budget()` on an unrelated class and `{ budget: 1 }` in a config
// object are indistinguishable from a real caller. This module adds the layer
// the lexical result cannot provide: the TypeScript compiler's own name
// resolution, asked one question per candidate occurrence — does THIS name
// bind to the symbol the finding's own file declares?
//
// TRUST (read this before "just run the compiler"): the compiler here READS
// the base worktree — sources, and `tsconfig.json` as DATA via
// `ts.readConfigFile`, which parses JSON and never evaluates it. The compiler
// API does not execute project code during program construction: `plugins`
// entries in a tsconfig are language-service extensions and are ignored by
// `ts.createProgram`, and nothing in program construction evaluates a source
// file. No process is spawned, nothing is written (`noEmit` is forced).
// That is the line ADR-003 draws: configuration is read as data the way rule
// files are read as data, and — the same decision as the lexical check — the
// tree that is read is the BASE, so a pull request author's code never
// reaches the compiler. Reading is still trusting the tree's contents to the
// extent the answers derive from them, which is exactly what a host check is;
// what it must never become is execution, and it does not.
//
// DEGRADATION IS THE DESIGN. Resolution is an upgrade to the lexical answer,
// never a replacement for it: no tsconfig, no `typescript` package, a program
// that cannot be built in budget, a finding's file that does not declare the
// symbol, or an ambiguous declaration all return `unavailable` with a reason,
// and the caller publishes the lexical answer exactly as before. A file the
// checker cannot resolve still deserves the lexical answer rather than nothing
// — that sentence is the feature request, and it is also the failure mode.
import path from "node:path";
import type ts from "typescript";
import type { StructuralClaim, SymbolReference } from "./structural-check.js";

/**
 * The compiler, loaded on first use and remembered — including a failure.
 *
 * Lazily for the same reason the ast-grep parser is: `cli.ts` imports this
 * module chain unconditionally, and a dependency that fails to load must
 * degrade one feature, not take the CLI down with it. `typescript` is pure
 * JavaScript, so unlike the native parser there is no platform dimension —
 * the laziness is about cost and isolation, not availability.
 */
type TsModule = typeof import("typescript");
let tsModule: Promise<TsModule | undefined> | undefined;
function loadCompiler(): Promise<TsModule | undefined> {
  tsModule ??= import("typescript").then(
    (module) => module as TsModule,
    () => undefined,
  );
  return tsModule;
}

/** Bounds, so one resolution cannot turn a bounded check into an open one. */
export const DEFAULT_RESOLUTION_TIME_BUDGET_MS = 60_000;

/**
 * Why resolution is unavailable for this check, when it is.
 *
 * Carried verbatim into the published wording by the caller, so every value
 * is a HOST-AUTHORED phrase about the situation — never a caught error's
 * message, which quotes filesystem paths from the runner.
 */
export type ResolutionUnavailable =
  | "no-tsconfig"
  | "no-compiler"
  | "budget-exhausted"
  | "symbol-not-declared-here"
  | "ambiguous-declaration";

export type SymbolResolution =
  | {
    readonly available: true;
    /**
     * Candidates the checker resolved to the symbol declared in the finding's
     * own file. This is the contradiction evidence the lexical result could
     * not stand behind.
     */
    readonly resolved: readonly SymbolReference[];
    /** Exact count of resolved occurrences, same census rule as the lexical walk. */
    readonly resolvedOccurrences: number;
    /**
     * Lexical candidates in type-checked files that did NOT resolve to the
     * claimed symbol — same-named members of other types, object keys, and
     * names the checker could not attribute (an import whose package the base
     * tree does not vendor). This is the noise resolution removes from the
     * accusation, kept visible because the published wording promises what
     * became of every occurrence. Not an accusation in either direction.
     */
    readonly unresolved: readonly SymbolReference[];
    readonly unresolvedOccurrences: number;
    /** Type-checked files under the base root, for the published wording. */
    readonly filesResolved: number;
  }
  | { readonly available: false; readonly reason: ResolutionUnavailable };

/** One candidate occurrence, as the lexical walk reports it. */
export interface ResolutionCandidate {
  /** Repository-relative, POSIX-separated — the same spelling the walk reports. */
  readonly file: string;
  /** One-based, as an editor counts. */
  readonly line: number;
}

/** What the resolver needs to answer, per claim. */
export interface ResolveInput {
  readonly claim: StructuralClaim;
  /** Repository-relative head path of the finding's own file. */
  readonly findingFile: string;
  /** The same file's path at the base commit, when the PR renamed it. */
  readonly findingFileAtBase?: string;
  /**
   * The finding's anchored line, as the reviewer wrote it (head side).
   *
   * Used for exactly ONE decision: when the finding's own file declares
   * several DIFFERENT symbols under the claim's name — a function and an
   * unrelated class property, say — which one is "this symbol"? The
   * declaration nearest the anchor is the one the reviewer was looking at.
   * This is a heuristic about ATTRIBUTION, not about coordinates: it never
   * maps a head line onto a base position (the lexical check's refusal to do
   * that stands), it only picks among declarations IN the same file. Without
   * a hint, several candidates refuse as ambiguous; a guessed resolved
   * contradiction is the exact credibility failure this feature exists to
   * avoid. Equidistant candidates refuse too — a tie means the anchor
   * genuinely cannot attribute, and one-based/zero-based mixups in that
   * comparison would silently flip the choice (Codex review of PR #104).
   */
  readonly findingLine?: number;
  /**
   * Whether the pull request removes the line this occurrence sits on
   * (repository-relative POSIX file, one-based line) — the same
   * reconciliation the lexical walk applies during collection, passed in so
   * the resolver's independent walk cannot resurrect a deleted caller as a
   * resolved contradiction against a finding about the head revision (Codex
   * review of PR #104). Removed occurrences are skipped entirely: counted
   * neither as resolved nor as unresolved, exactly like the lexical walk's
   * suppressed matches.
   */
  readonly isRemoved?: (file: string, line: number) => boolean;
}

export interface ResolveTiming {
  /** Wall-clock bound for THIS claim's identifier walk, if the caller bounds it. */
  readonly timeBudgetMs?: number;
  /** Injectable clock, so the bound is testable without waiting. */
  readonly now?: () => number;
}

export interface SymbolResolver {
  resolve(input: ResolveInput, timing?: ResolveTiming): Promise<SymbolResolution>;
  /**
   * Whether this resolver's program covers `file` (repository-relative,
   * POSIX-separated — the spelling the lexical walk reports). The caller uses
   * it to split its census: occurrences in covered files are re-attributed by
   * the checker, occurrences outside keep their lexical answer.
   */
  covers(file: string): boolean;
  /**
   * Drops the program. The compiler holds the parsed tree in memory; a review
   * with many claims creates one resolver and shares it, and the caller
   * releases it when the review's checks are done.
   */
  dispose(): void;
}

export interface CreateResolverOptions {
  readonly now?: () => number;
  readonly resolutionTimeBudgetMs?: number;
  /**
   * Injectable module loader, so tests can exercise the missing-compiler
   * degradation without uninstalling a dependency.
   */
  readonly loadCompiler?: () => Promise<TsModule | undefined>;
}

/**
 * Builds a resolver over the base worktree, or reports why it cannot.
 *
 * Program construction is the expensive step — seconds against a large
 * repository, against the lexical walk's milliseconds — so it happens ONCE
 * here and every claim in the review shares the resolver. The budget bounds
 * construction (and only construction: per-candidate queries are the cheap
 * part), and an exhausted budget degrades to the lexical answer.
 */
export async function createSymbolResolver(
  baseRoot: string,
  options: CreateResolverOptions = {},
): Promise<SymbolResolver> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.resolutionTimeBudgetMs ?? DEFAULT_RESOLUTION_TIME_BUDGET_MS;
  const started = now();
  const expired = (): boolean => now() - started > budgetMs;
  const load = options.loadCompiler ?? loadCompiler;

  const unavailable = (reason: ResolutionUnavailable): SymbolResolver => ({
    resolve: async () => ({ available: false, reason }),
    // An unavailable resolver covers nothing, so the caller keeps every
    // occurrence lexical — the exact degradation this module promises.
    covers: () => false,
    dispose: () => {},
  });

  const ts = await load();
  if (ts === undefined) return unavailable("no-compiler");

  // v1 discovery: the base root's own tsconfig.json. Monorepo package
  // discovery is a real problem (which package's config governs a finding's
  // file?) and deliberately not this issue's problem — a repository without a
  // root tsconfig gets the lexical answer, which is the degradation this
  // module is built around.
  const configPath = path.join(baseRoot, "tsconfig.json");
  let configFile;
  try {
    configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  } catch {
    return unavailable("no-tsconfig");
  }
  // A missing or unreadable config comes back as `{config: {}}` plus an
  // `error` — NOT as a throw, and not as `config: undefined` — so both are
  // checked: without this, a repository without a tsconfig silently built a
  // program from a synthesized `**/*` include, and the "cannot resolve"
  // degradation never fired.
  if (configFile.config === undefined || configFile.error !== undefined) {
    return unavailable("no-tsconfig");
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, baseRoot);
  // Only ERRORS block (category 1); warnings and suggestions do not. A config
  // the compiler accepted with warnings is still a usable program.
  if (parsed.errors.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    return unavailable("no-tsconfig");
  }

  // Only files under the base root. A tsconfig may reach outside itself
  // (extended configs, parent-relative includes); the check's answer must be
  // about the worktree that was checked out, so anything the config pulls in
  // from elsewhere is dropped rather than read.
  const underRoot = (file: string): boolean => {
    const relative = path.relative(baseRoot, file);
    return relative !== "" && !relative.startsWith("..");
  };
  const rootNames = parsed.fileNames.filter(underRoot);
  if (rootNames.length === 0) return unavailable("no-tsconfig");

  // `noEmit` is forced: the program exists to answer questions, never to
  // write. `incremental`/`tsBuildInfoFile` are dropped with it — there is no
  // build cache to maintain, and nothing should ever be written into the
  // worktree the check reads.
  const program = ts.createProgram({
    rootNames,
    options: { ...parsed.options, noEmit: true },
  });
  if (expired()) return unavailable("budget-exhausted");
  const checker = program.getTypeChecker();
  const filesResolved = program.getSourceFiles().filter((sourceFile) => underRoot(sourceFile.fileName)).length;
  // POSIX-normalized, matching the lexical walk's `canonicalRelative` keys:
  // `path.relative` is platform-native, and on Windows it emits separators
  // the lexical census never used, which made every covered file look
  // uncovered — genuine callers reported once as resolved and again in the
  // lexical fallback (Codex review of PR #104).
  const relativePosix = (sourceFile: ts.SourceFile): string =>
    path.relative(baseRoot, sourceFile.fileName).split(path.sep).join("/");
  const covered = new Set(program.getSourceFiles()
    .filter((sourceFile) => underRoot(sourceFile.fileName))
    .map(relativePosix));

  /**
   * The symbol the finding's own file declares with the claim's name.
   *
   * The claim is about "this symbol" and the finding anchors to a file — the
   * declaration in that file (at the base commit) is the identity the
   * candidates are tested against. A file that declares no such symbol means
   * the claim cannot be attributed (the declaration lives elsewhere, or the
   * PR renamed it away). Several DIFFERENT symbols under one name are
   * disambiguated by the finding's anchor line — see `ResolveInput
   * .findingLine` — and without a hint they refuse: a guessed resolved
   * contradiction is the exact credibility failure this feature exists to
   * avoid.
   */
  const ownSymbol = (
    ownAbsolute: string,
    symbolName: string,
    hintLine: number | undefined,
  ):
    | { readonly ok: true; readonly declarations: ReadonlySet<ts.Declaration> }
    | { readonly ok: false; readonly reason: ResolutionUnavailable } => {
    const sourceFile = program.getSourceFile(ownAbsolute);
    if (sourceFile === undefined) return { ok: false, reason: "symbol-not-declared-here" };
    //
    // Identity is compared by DECLARATION SETS, not symbol objects: the
    // compiler hands out TRANSIENT copies of a symbol on the use side (an
    // object literal's property is one symbol at its declaration, a
    // transient twin at each access), and object equality between the two
    // fails. Two symbols sharing any declaration node are the same identity;
    // that also covers aliases, whose target carries the declaration.
    //
    const groups: Array<{ declarations: Set<ts.Declaration>; firstLine: number }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        const symbol = checker.getSymbolAtLocation(node);
        // An import specifier in this file is NOT a declaration of the
        // symbol — it is a reference to one declared elsewhere, and counting
        // it made a file that merely imports the name look like the
        // declaration site. Follow the alias and test where the TARGET is
        // declared; for a non-alias the target is the symbol itself.
        const target = symbol === undefined ? undefined : aliased(symbol);
        const inThisFile = (target?.getDeclarations() ?? [])
          .filter((declaration) => declaration.getSourceFile() === sourceFile);
        if (inThisFile.length > 0) {
          const firstLine = Math.min(...inThisFile.map((declaration) =>
            sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line));
          const existing = groups.find((group) =>
            inThisFile.some((declaration) => group.declarations.has(declaration)));
          if (existing === undefined) {
            groups.push({ declarations: new Set(inThisFile), firstLine });
          } else {
            for (const declaration of inThisFile) existing.declarations.add(declaration);
            existing.firstLine = Math.min(existing.firstLine, firstLine);
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
    if (groups.length === 0) return { ok: false, reason: "symbol-not-declared-here" };
    if (groups.length > 1 && hintLine === undefined) {
      return { ok: false, reason: "ambiguous-declaration" };
    }
    // Nearest declaration group to the anchor wins. `firstLine` is the
    // compiler's zero-based line; `findingLine` is one-based (an editor
    // counts) — compare them in ONE coordinate system or the nearest pick is
    // off by one and can select the WRONG symbol outright (Codex review of
    // PR #104). Ties refuse: two same-named declarations equidistant from
    // the anchor cannot be attributed, and a guessed resolved contradiction
    // is the exact credibility failure this feature exists to avoid.
    if (groups.length > 1 && hintLine !== undefined) {
      const distances = groups.map((group) => Math.abs(group.firstLine + 1 - hintLine));
      if (new Set(distances).size < distances.length) {
        return { ok: false, reason: "ambiguous-declaration" };
      }
    }
    let best = groups[0]!;
    for (const group of groups) {
      const bestDistance = Math.abs(best.firstLine + 1 - (hintLine ?? best.firstLine));
      const distance = Math.abs(group.firstLine + 1 - (hintLine ?? group.firstLine));
      if (distance < bestDistance) best = group;
    }
    return { ok: true, declarations: best.declarations };
  };

  /** Follows an import alias to the symbol it names; other symbols are themselves. */
  const aliased = (symbol: ts.Symbol): ts.Symbol | undefined => {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  };

  return {
    async resolve(input: ResolveInput, timing?: ResolveTiming): Promise<SymbolResolution> {
      const ownAbsolute = path.resolve(baseRoot, input.findingFileAtBase ?? input.findingFile);
      const own = ownSymbol(ownAbsolute, input.claim.symbol, input.findingLine);
      if (!own.ok) return { available: false, reason: own.reason };

      // The construction budget above bounds building the program; the
      // per-claim walk is bounded by the CALLER's remaining check budget, so
      // one claim's walk cannot run past the same wall the lexical walk
      // respects. Unbounded callers (none today) get an unbounded walk.
      const walkStarted = timing?.now?.() ?? 0;
      const walkExpired = (): boolean =>
        timing?.timeBudgetMs !== undefined && (timing.now?.() ?? 0) - walkStarted > timing.timeBudgetMs;

      const resolved: SymbolReference[] = [];
      const unresolved: SymbolReference[] = [];
      let resolvedOccurrences = 0;
      let unresolvedOccurrences = 0;

      for (const sourceFile of program.getSourceFiles()) {
        if (walkExpired()) break;
        if (!underRoot(sourceFile.fileName)) continue;
        const relative = relativePosix(sourceFile);
        if (sourceFile === program.getSourceFile(ownAbsolute)) continue;
        // A direct walk, one per claim per file: the identifiers of interest
        // are exactly the ones spelled like the symbol, and the compiler has
        // already parsed the file, so this is tree traversal only. The line
        // is computed AFTER the symbol test — most identifiers in a file are
        // not this symbol, and position mapping is not free.
        const visit = (node: ts.Node): void => {
          if (walkExpired()) return;
          if (ts.isIdentifier(node) && node.text === input.claim.symbol) {
            const symbol = checker.getSymbolAtLocation(node);
            const target = symbol === undefined ? undefined : aliased(symbol);
            const targetDeclarations = target?.getDeclarations() ?? [];
            const sameIdentity = targetDeclarations.some((declaration) => own.declarations.has(declaration));
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const reference: SymbolReference = { file: relative, line: line + 1 };
            // The same reconciliation the lexical walk applied during
            // collection: a line the pull request removes is skipped in BOTH
            // buckets, so the resolved census never accuses the finding of a
            // caller the diff may already be deleting.
            if (input.isRemoved?.(relative, reference.line) === true) return;
            if (sameIdentity) {
              resolvedOccurrences += 1;
              if (resolved.length < MAX_RETAINED) resolved.push(reference);
            } else {
              unresolvedOccurrences += 1;
              if (unresolved.length < MAX_RETAINED) unresolved.push(reference);
            }
          }
          node.forEachChild(visit);
        };
        visit(sourceFile);
      }

      const byLocation = (left: SymbolReference, right: SymbolReference): number =>
        left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file);
      return {
        available: true,
        resolved: resolved.sort(byLocation),
        resolvedOccurrences,
        unresolved: unresolved.sort(byLocation),
        unresolvedOccurrences,
        filesResolved,
      };
    },
    covers: (file: string): boolean => covered.has(file),
    dispose: () => {},
  };
}

/** Same retention margin as the lexical walk's display sample. */
const MAX_RETAINED = 8;
