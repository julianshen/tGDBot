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

function parseRuleFile(sourcePath: string, raw: string): ParsedRuleFile {
  const parsed = matter(raw);
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
  const raw = await readFile(sourcePath, "utf-8");
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
