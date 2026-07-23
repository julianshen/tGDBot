// Rule loader: discovers Markdown+YAML-frontmatter rule files under a
// configurable directory, validates required fields, and (unless disabled)
// appends the vendored built-in `tgd-review` rule. See SPEC.md "Rule file
// format" / "Built-in tGD-review skill" and TASKS.md Task 4.
//
// Invalid rule files are never thrown for — a single bad rule file must not
// fail the whole run (SPEC.md boundary). Each is instead recorded in
// `errors` and excluded from `rules`.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type { RuleDefinition } from "./types.js";

export interface LoadResult {
  rules: RuleDefinition[];
  errors: { sourcePath: string; message: string }[];
}

// Resolved relative to this module's own location (not process.cwd()) so it
// works correctly whether running from src/ in dev (tsx/vitest) or from
// dist/ after `npm run build` — the build script copies this .md file
// alongside the compiled loader.js at dist/rules/builtin/tgd-review.md.
const BUILTIN_RULE_PATH = fileURLToPath(new URL("./builtin/tgd-review.md", import.meta.url));

interface ParsedRuleFile {
  rule?: RuleDefinition;
  error?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const PARALLEL_GROUP_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Wraps `matter(raw)` in try/catch: malformed YAML frontmatter (bad
// indentation, unclosed brackets, etc.) makes gray-matter throw a
// `YAMLException` rather than returning a parse-error value. Left
// uncaught, that exception would propagate out of `loadRules()` and abort
// the entire run — the same "one bad rule file must not fail the whole
// run" boundary that already applies to missing-field errors below, just
// not yet applied to YAML-syntax errors. See Task 4 review fix #1.
function parseRuleFile(sourcePath: string, raw: string): ParsedRuleFile {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `rule file has malformed YAML frontmatter: ${message}` };
  }
  const data = parsed.data as Record<string, unknown>;

  if (!isNonEmptyString(data.name)) {
    return { error: `rule file is missing required frontmatter field "name"` };
  }

  // Design-review #6: `provider`/`model` are optional (an unpinned rule runs
  // on the default model — see resolveEffectiveRules), but when used they must
  // come as a PAIR. A provider without a model (or vice versa) is ambiguous —
  // half a pin is certainly a mistake, and silently guessing the other half
  // would run the rule somewhere its author never intended.
  const hasProvider = isNonEmptyString(data.provider);
  const hasModel = isNonEmptyString(data.model);
  if (hasProvider !== hasModel) {
    const present = hasProvider ? "provider" : "model";
    const missing = hasProvider ? "model" : "provider";
    return {
      error:
        `rule file sets frontmatter field "${present}" without "${missing}" — ` +
        `pin both (provider AND model) or neither (the rule then runs on the default model)`,
    };
  }

  const dependsOnValue = data.depends_on;
  if (dependsOnValue !== undefined && !Array.isArray(dependsOnValue)) {
    return { error: `frontmatter field "depends_on" must be an array of non-empty strings` };
  }
  const dependsOn = dependsOnValue ?? [];
  if (!(dependsOn as unknown[]).every(isNonEmptyString)) {
    return { error: `frontmatter field "depends_on" must be an array of non-empty strings` };
  }
  if (new Set(dependsOn as string[]).size !== (dependsOn as string[]).length) {
    return { error: `frontmatter field "depends_on" contains a duplicate dependency` };
  }

  const parallelGroupValue = data.parallel_group;
  if (
    parallelGroupValue !== undefined &&
    (!isNonEmptyString(parallelGroupValue) || !PARALLEL_GROUP_PATTERN.test(parallelGroupValue))
  ) {
    return {
      error:
        `frontmatter field "parallel_group" must match ` +
        `"^[a-z0-9][a-z0-9._-]{0,63}$"`,
    };
  }

  return {
    rule: {
      name: data.name,
      ...(hasProvider ? { provider: data.provider as string, model: data.model as string } : {}),
      dependsOn: Object.freeze([...(dependsOn as string[])]),
      ...(parallelGroupValue === undefined
        ? {}
        : { parallelGroup: parallelGroupValue as string }),
      body: parsed.content.trim(),
      sourcePath,
    },
  };
}

async function loadOneRuleFile(
  sourcePath: string,
): Promise<{ rule?: RuleDefinition; loadError?: { sourcePath: string; message: string } }> {
  // The `readFile` call is included in this try/catch (not just
  // `parseRuleFile`'s YAML parsing) in case of OS-level read errors (e.g. a
  // permissions error, or a race where the file is removed between
  // `readdir` and `readFile`) — those must also become a per-file
  // `loadError` rather than propagating and aborting the whole run.
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { loadError: { sourcePath, message: `could not read rule file: ${message}` } };
  }
  const { rule, error } = parseRuleFile(sourcePath, raw);
  if (error) {
    return { loadError: { sourcePath, message: error } };
  }
  return { rule };
}

async function listMarkdownFiles(rulesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries.filter((entry) => entry.endsWith(".md")).sort();
}

// De-duplicates rules by `name`, in the order they appear in `candidates`.
// The FIRST rule to claim a given name is kept in the returned array; every
// later rule with the same name is dropped and turned into a `loadError`
// naming its own `sourcePath` and the conflicting `name` (the same "skip and
// record, never throw" pattern used for missing-field validation above).
//
// Load order (and therefore "first wins") is: user rule files in the
// `rulesDir`, in the alphabetical-by-filename order `listMarkdownFiles`
// already sorts them into, followed by the vendored builtin (appended last,
// only when `includeBuiltin` is true). This is deterministic and, as a
// side effect, lets a user rule file shadow the builtin's `name: tgd-review`
// by defining its own rule under that same name — consistent with the
// "project config wins on a name collision" precedent already used for
// dispatch's `.pi/agents` override (see ADR-003) — rather than the builtin
// silently winning and the user's same-named file being dropped instead.
function dedupeByName(
  candidates: RuleDefinition[],
): { rules: RuleDefinition[]; errors: { sourcePath: string; message: string }[] } {
  const rules: RuleDefinition[] = [];
  const errors: { sourcePath: string; message: string }[] = [];
  const firstSourceByName = new Map<string, string>();

  for (const candidate of candidates) {
    const firstSourcePath = firstSourceByName.get(candidate.name);
    if (firstSourcePath === undefined) {
      firstSourceByName.set(candidate.name, candidate.sourcePath);
      rules.push(candidate);
    } else {
      errors.push({
        sourcePath: candidate.sourcePath,
        message: `duplicate rule name "${candidate.name}": already defined by ${firstSourcePath}; this file's rule was skipped`,
      });
    }
  }

  return { rules, errors };
}

export async function loadRules(rulesDir: string, includeBuiltin: boolean): Promise<LoadResult> {
  const candidates: RuleDefinition[] = [];
  const errors: { sourcePath: string; message: string }[] = [];

  const mdFiles = await listMarkdownFiles(rulesDir);
  // Read + parse every user rule file concurrently rather than one at a
  // time. `loadOneRuleFile` never rejects (it wraps both the `readFile` and
  // the YAML/field parsing in try/catch and resolves to a `loadError`
  // marker instead) so `Promise.all` here still isolates each file's
  // failure to that file alone — one bad file cannot abort the others or
  // reject the whole batch. Order is preserved (`Promise.all` resolves in
  // input order), so the alphabetical "first wins" ordering `dedupeByName`
  // relies on is unaffected by this becoming concurrent.
  const results = await Promise.all(
    mdFiles.map((file) => loadOneRuleFile(path.join(rulesDir, file))),
  );
  for (const { rule, loadError } of results) {
    if (rule) candidates.push(rule);
    if (loadError) errors.push(loadError);
  }

  if (includeBuiltin) {
    const { rule, loadError } = await loadOneRuleFile(BUILTIN_RULE_PATH);
    if (rule) candidates.push(rule);
    if (loadError) errors.push(loadError);
  }

  const deduped = dedupeByName(candidates);
  return { rules: deduped.rules, errors: [...errors, ...deduped.errors] };
}
