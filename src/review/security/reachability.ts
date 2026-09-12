// Issue #139 stage 4: host-established reachability facts.
//
// The narrow scope here is the point, and two corrections from spec review
// matter more than the capability:
//
// **Resolving a call chain proves neither `vector` nor `authScope`.** The same
// handler is public or authenticated depending on Express or Fastify
// middleware, a decorator, generated routing, or a project's own wrapper —
// none of which a caller-edge walk observes. So a host fact is produced ONLY
// under an explicitly supported pattern with positive evidence.
//
// **Unmatched is `unknown`, never the reviewer's assertion.** An earlier draft
// let an unmatched pattern retain whatever the reviewer claimed, which — since
// the supported list starts nearly empty — would have let model text drive
// severity on every review until the first framework landed.
//
// | Situation | Result |
// |---|---|
// | a supported router registration resolves to the finding's file, mounting evidence read | `host`, established |
// | the language parses but no supported pattern matches | `unknown` |
// | no grammar for the language, or no ast-grep binding | `unknown` |
//
// `vector` and `authScope` are the two fields this stage may set, because they
// are the two that drive severity. The other four are judgements no host check
// establishes, and they stay `source: "reviewer"` always.
//
// A MISSING GRAMMAR MUST NEVER READ AS AN ABSENT ATTACK PATH. Every failure
// path here returns `unknown` with a reason naming what was not available.
import path from "node:path";
import type { AuthScope, Fact, Vector } from "./attack-path.js";
import { unknownFact } from "./attack-path.js";

/**
 * One framework's route-registration shape.
 *
 * `match` is deliberately a line predicate rather than an AST query. The
 * evidence a reader needs is "this file registers an HTTP route, here is the
 * line", and a regex over the registration call answers that on every language
 * whose grammar may be absent. Upgrading a pattern to an AST query is a
 * per-framework decision, not a precondition for any of them.
 */
interface RoutePattern {
  readonly framework: string;
  /** Extensions this pattern applies to. Empty means every extension. */
  readonly extensions: readonly string[];
  /** Returns the matched registration text when the line registers a route. */
  readonly match: (line: string) => string | undefined;
  /** What the registration implies about who can reach it. */
  readonly vector: Vector;
  /**
   * The auth scope a BARE registration implies.
   *
   * `public` only where the framework's own registration carries no auth. A
   * pattern whose framework has pluggable middleware cannot claim more than
   * this from the registration line alone, which is why `authScope` is
   * withdrawn below whenever an auth-shaped guard appears in the same file.
   */
  readonly authScope: AuthScope;
}

const TS_JS = Object.freeze([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);

/**
 * The supported patterns. Starts small and grows one framework at a time, each
 * with fixtures.
 *
 * An unrecognised routing style yields `unknown` — a coverage gap that says
 * so, not a guess wearing a host label.
 */
const ROUTE_PATTERNS: readonly RoutePattern[] = Object.freeze([
  {
    framework: "Express",
    extensions: TS_JS,
    // `app.get("/x", ...)`, `router.post('/x', ...)`. The method list is the
    // HTTP verbs Express routes; `use` is excluded because it mounts
    // middleware as readily as a handler and proves much less.
    match: (line) =>
      /\b(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|head|options|all)\s*\(\s*["'`]/u
        .exec(line)?.[0],
    vector: "remote",
    authScope: "public",
  },
  {
    framework: "Fastify",
    extensions: TS_JS,
    match: (line) =>
      /\b(?:fastify|app|server)\s*\.\s*(?:get|post|put|patch|delete|head|options)\s*\(\s*["'`]/u
        .exec(line)?.[0],
    vector: "remote",
    authScope: "public",
  },
  {
    framework: "Koa router",
    extensions: TS_JS,
    match: (line) =>
      /\brouter\s*\.\s*(?:get|post|put|patch|del|delete)\s*\(\s*["'`]/u.exec(line)?.[0],
    vector: "remote",
    authScope: "public",
  },
]);

/**
 * Text that withdraws an `authScope: public` claim.
 *
 * Not an attempt to determine WHAT the auth is — that needs the framework's
 * composition rules and often its runtime configuration. It answers the much
 * smaller question the host can actually answer: is there any sign of an
 * authorization decision in this file? If there is, the registration line no
 * longer supports "anyone can reach this", and the honest answer becomes
 * `unknown` rather than a claim contradicted by the file it was read from.
 */
const AUTH_HINT =
  /\b(?:requireAuth|isAuthenticated|ensureAuthenticated|authenticate|authorize|authGuard|withAuth|passport\s*\.\s*authenticate|verifyToken|checkPermission|requireRole|requireAdmin|@UseGuards|preHandler\s*:)/u;

export interface ReachabilityInput {
  /** The finding's file, repo-relative. */
  readonly file: string;
  /**
   * The file's text at the HEAD revision.
   *
   * HEAD, not base: a pull request that ADDS a handler creates a path the base
   * tree does not contain, so a base-only analysis misses exactly the attack
   * surface this exists to rate. Absent when the tree could not be read, which
   * is a reason for `unknown` rather than an error.
   */
  readonly headText: string | undefined;
}

export interface ReachabilityFacts {
  readonly vector: Fact<Vector>;
  readonly authScope: Fact<AuthScope>;
}

/**
 * What the host can establish about who can reach a file's code.
 *
 * Returns `unknown` for both fields unless a supported registration pattern
 * matched, and says why in the evidence either way. Never throws.
 */
export function establishReachability(input: ReachabilityInput): ReachabilityFacts {
  const extension = path.extname(input.file).toLowerCase();

  if (input.headText === undefined) {
    const reason = `the head revision of ${input.file} could not be read`;
    return { vector: unknownFact(reason, "host"), authScope: unknownFact(reason, "host") };
  }

  const applicable = ROUTE_PATTERNS.filter(
    (pattern) => pattern.extensions.length === 0 || pattern.extensions.includes(extension),
  );
  if (applicable.length === 0) {
    // The honest answer for Go, Rust, Java, Python and everything else today.
    // It is a coverage gap, and it says so.
    const reason =
      `no supported route-registration pattern covers "${extension || "this file type"}", ` +
      `so the host could not establish how this code is reached`;
    return { vector: unknownFact(reason, "host"), authScope: unknownFact(reason, "host") };
  }

  const lines = input.headText.split("\n");
  let matched: { pattern: RoutePattern; line: number; text: string } | undefined;
  for (let index = 0; index < lines.length && matched === undefined; index += 1) {
    const text = lines[index] as string;
    for (const pattern of applicable) {
      const registration = pattern.match(text);
      if (registration !== undefined) {
        matched = { pattern, line: index + 1, text: registration };
        break;
      }
    }
  }

  if (matched === undefined) {
    const reason =
      `${input.file} parses, but no supported route registration was found in it, ` +
      `so the host could not establish how this code is reached`;
    return { vector: unknownFact(reason, "host"), authScope: unknownFact(reason, "host") };
  }

  const vectorEvidence =
    `${input.file}:${matched.line} registers an HTTP route ` +
    `(${matched.pattern.framework}: \`${matched.text.trim()}\`)`;
  const vector: Fact<Vector> = {
    value: matched.pattern.vector,
    evidence: vectorEvidence,
    source: "host",
  };

  // An auth-shaped guard anywhere in the file withdraws the `public` claim the
  // bare registration would support. The host cannot say WHICH scope applies —
  // that needs the framework's composition rules — so it says `unknown` rather
  // than a claim the file itself contradicts.
  if (AUTH_HINT.test(input.headText)) {
    return {
      vector,
      authScope: unknownFact(
        `${input.file} contains an authorization guard, so the route registration alone does ` +
          `not establish who may reach this code`,
        "host",
      ),
    };
  }

  return {
    vector,
    authScope: {
      value: matched.pattern.authScope,
      evidence:
        `${vectorEvidence}, and no authorization guard appears in the file`,
      source: "host",
    },
  };
}

/** The frameworks the host can currently establish a route for. For the README and the summary. */
export function supportedRouteFrameworks(): readonly string[] {
  return [...new Set(ROUTE_PATTERNS.map((pattern) => pattern.framework))];
}
