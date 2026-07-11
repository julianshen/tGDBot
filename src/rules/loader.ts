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

const REQUIRED_STRING_FIELDS = ["name", "provider", "model"] as const;

interface ParsedRuleFile {
  rule?: RuleDefinition;
  error?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

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

  const missingField = REQUIRED_STRING_FIELDS.find((field) => !isNonEmptyString(data[field]));
  if (missingField) {
    return { error: `rule file is missing required frontmatter field "${missingField}"` };
  }

  return {
    rule: {
      name: data.name as string,
      provider: data.provider as string,
      model: data.model as string,
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

export async function loadRules(rulesDir: string, includeBuiltin: boolean): Promise<LoadResult> {
  const rules: RuleDefinition[] = [];
  const errors: { sourcePath: string; message: string }[] = [];

  const mdFiles = await listMarkdownFiles(rulesDir);
  for (const file of mdFiles) {
    const sourcePath = path.join(rulesDir, file);
    const { rule, loadError } = await loadOneRuleFile(sourcePath);
    if (rule) rules.push(rule);
    if (loadError) errors.push(loadError);
  }

  if (includeBuiltin) {
    const { rule, loadError } = await loadOneRuleFile(BUILTIN_RULE_PATH);
    if (rule) rules.push(rule);
    if (loadError) errors.push(loadError);
  }

  return { rules, errors };
}
