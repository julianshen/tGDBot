// Issue #115: matching a rule's declared paths against the files a pull
// request changed.
//
// Written here rather than taken from a dependency, for the same reason
// `identifierMatcher` in the structural checker is: the matched set decides
// whether a rule RUNS, so a surprising match is a rule that silently did not
// review something. A small, exactly-specified subset with its own tests is
// easier to be sure of than a general implementation whose corners nobody in
// this repository has read.
//
// The supported syntax, and nothing else:
//
//   `*`      any run of characters within one path segment, including empty
//   `**`     any run of characters INCLUDING `/` — see `**/` below
//   `**/`    zero or more whole path segments, so `**\/*.ts` matches `a.ts`
//   `?`      exactly one character, never `/`
//   `{a,b}`  either alternative; no nesting
//
// Deliberately absent: character classes (`[a-z]`), negation, and `!`
// exclusions. Each is a small feature with a large corner-case surface, and a
// rule author who needs one can list several globs instead.

/** How deep a `{…}` may be nested — which is to say, not at all. */
const MAX_BRACE_DEPTH = 1;

/**
 * Compiles one glob to an anchored regular expression.
 *
 * Throws on a glob this module does not implement, rather than matching it
 * loosely: a rule declaring `src/[a-z].ts` and silently matching nothing would
 * stop running with no explanation, and the loader turns this throw into a
 * load error naming the file.
 */
export function globToRegExp(rawGlob: string): RegExp {
  if (rawGlob.length === 0) throw new Error("a path pattern must not be empty");
  // The PATTERN is normalized on the same terms as the candidates it is
  // compared against. Normalizing only one side meant `./src/*.ts` compiled
  // with its `./` intact while every candidate arrived as `src/a.ts`, so the
  // rule matched nothing and was silently skipped — the exact failure this
  // module exists to prevent (Codex review of PR #126).
  const glob = normalizeGlobPath(rawGlob);
  if (glob.length === 0) throw new Error("a path pattern must not be empty");
  if (glob.includes("[") || glob.includes("]")) {
    throw new Error("character classes are not supported in a path pattern");
  }
  if (glob.startsWith("!")) throw new Error("negated path patterns are not supported");

  let source = "";
  let braceDepth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      const isDouble = glob[index + 1] === "*";
      if (isDouble) {
        // `**/` spans whole segments and, crucially, matches ZERO of them, so
        // `**/*.ts` matches a file at the root. Consuming the slash here is
        // what makes that true; leaving it to the literal branch would demand
        // at least one directory.
        if (glob[index + 2] === "/") {
          source += "(?:[^/]*/)*";
          index += 2;
          continue;
        }
        source += ".*";
        index += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      if (braceDepth > MAX_BRACE_DEPTH) throw new Error("nested braces are not supported in a path pattern");
      source += "(?:";
      continue;
    }
    if (char === "}") {
      if (braceDepth === 0) throw new Error("unbalanced brace in a path pattern");
      braceDepth -= 1;
      source += ")";
      continue;
    }
    if (char === "," && braceDepth > 0) {
      source += "|";
      continue;
    }
    source += escapeLiteral(char);
  }
  if (braceDepth !== 0) throw new Error("unbalanced brace in a path pattern");
  return new RegExp(`^${source}$`, "u");
}

/** Every character a regular expression would otherwise read as syntax. */
function escapeLiteral(char: string): string {
  return /[.*+?^${}()|[\]\\/]/u.test(char) ? `\\${char}` : char;
}

/**
 * One canonical spelling, so two names for a path compare equal.
 *
 * `./src/a.ts` failing to match `src/**` would be a rule silently not running
 * over a cosmetic difference, which is the whole hazard here.
 *
 * A backslash is deliberately NOT treated as a separator. Git diff paths use
 * `/` on every platform, so a backslash in one is a literal character in the
 * filename — and rewriting it invented a directory that does not exist: a
 * root-level file named `src\payload.ts` became `src/payload.ts` and matched
 * a rule scoped to `src/*.ts`, dispatching it over a file outside the
 * directory it declared (Codex review of PR #126).
 */
export function normalizeGlobPath(value: string): string {
  return value.replace(/\/+/gu, "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
}

/**
 * Whether any of `patterns` matches any of `paths`.
 *
 * ANY, not all: a rule declaring `**\/*.ts` applies to a pull request that
 * touches one TypeScript file among twenty, because the file it cares about
 * is in the diff. Requiring every path to match would disable a rule the
 * moment a README was touched alongside the code.
 */
export function matchesAnyPath(
  patterns: readonly RegExp[],
  paths: readonly string[],
): boolean {
  const normalized = paths.map(normalizeGlobPath);
  return patterns.some((pattern) => normalized.some((candidate) => pattern.test(candidate)));
}
