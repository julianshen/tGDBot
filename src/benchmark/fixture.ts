// Issue #113: loading fixtures off disk, validated on the way in.
//
// Strict rather than forgiving, for the same reason the state schema is: a
// fixture is the ground truth every number in the report is measured against.
// A typo that silently drops an expectation would make the benchmark report an
// improvement, which is worse than reporting nothing.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeUnknownFinding } from "../review/dispatch-results.js";
import type { Finding } from "../review/types.js";
import type { ExpectedFinding, Fixture } from "./types.js";

/** Where fixtures live, relative to the repository root. */
export const FIXTURE_ROOT = "test/benchmark/fixtures";

export async function loadFixtures(root: string): Promise<Fixture[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const fixtures: Fixture[] = [];
  for (const name of names) fixtures.push(await loadFixture(path.join(root, name), name));
  return fixtures;
}

export async function loadFixture(dir: string, name: string): Promise<Fixture> {
  const manifest: unknown = JSON.parse(await readFile(path.join(dir, "fixture.json"), "utf8"));
  const diff = await readFile(path.join(dir, "diff.patch"), "utf8");
  const recorded = await readRecorded(dir);

  const object = requireObject(manifest, `${name}/fixture.json`);
  const pr = requireObject(object.pr, `${name}.pr`);
  const expected = requireArray(object.expected, `${name}.expected`)
    .map((entry, index) => expectedFinding(entry, `${name}.expected[${index}]`));

  const ids = new Set<string>();
  for (const entry of expected) {
    // Ids name rows in a baseline diff. Two rows with one name is a diff
    // nobody can read.
    if (ids.has(entry.id)) throw new Error(`${name}: duplicate expectation id "${entry.id}"`);
    ids.add(entry.id);
  }

  return {
    name,
    description: requireString(object.description, `${name}.description`),
    pr: {
      id: requireString(pr.id, `${name}.pr.id`),
      title: requireString(pr.title, `${name}.pr.title`),
      description: requireString(pr.description, `${name}.pr.description`),
      baseSha: requireString(pr.baseSha, `${name}.pr.baseSha`),
      headSha: requireString(pr.headSha, `${name}.pr.headSha`),
      url: requireString(pr.url, `${name}.pr.url`),
    },
    diff,
    ...(object.baseFiles === undefined ? {} : { baseFiles: fileMap(object.baseFiles, `${name}.baseFiles`) }),
    ...(object.headFiles === undefined ? {} : { headFiles: fileMap(object.headFiles, `${name}.headFiles`) }),
    expected,
    ...(recorded === undefined ? {} : recorded),
  };
}

/**
 * The replayed model output, when the fixture has one.
 *
 * A missing file is "real mode only", which the runner reports as skipped. A
 * malformed one is an error: silently treating corrupt ground truth as absent
 * would turn a broken fixture into a quietly shrinking benchmark.
 */
async function readRecorded(
  dir: string,
): Promise<{ recordedFindings: Finding[]; recordedRulesRun: string[] } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, "recorded.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  const object = requireObject(parsed, "recorded.json");
  return {
    // Through the PRODUCTION parser, not a cast. A recording is dispatcher
    // output that happens to be committed, and asserting `Finding[]` over
    // untyped JSON let a typo like "blockng" become ground truth: it matches
    // nothing, so it reads as a miss, and `severityMix` counts it into a key
    // that does not exist and serializes as null (Codex review of PR #118).
    // The same gate real output passes means a recording cannot express a
    // finding the reviewer could never have produced.
    recordedFindings: requireArray(object.findings, "recorded.findings").map((value, index) => {
      const finding = normalizeUnknownFinding(value);
      if (finding === undefined) throw new Error(`recorded.findings[${index}] is not a valid finding`);
      return finding;
    }),
    recordedRulesRun: requireArray(object.rulesRun, "recorded.rulesRun").map((value, index) =>
      requireString(value, `recorded.rulesRun[${index}]`)),
  };
}

function expectedFinding(value: unknown, where: string): ExpectedFinding {
  const object = requireObject(value, where);
  const lines = object.lines === undefined ? undefined : requireArray(object.lines, `${where}.lines`);
  if (lines !== undefined && lines.length !== 2) throw new Error(`${where}.lines must be [start, end]`);
  const range = lines === undefined
    ? undefined
    : [requireNumber(lines[0], `${where}.lines[0]`), requireNumber(lines[1], `${where}.lines[1]`)] as const;
  if (range !== undefined && range[0] > range[1]) throw new Error(`${where}.lines is inverted`);
  if (object.severity !== undefined && object.severity !== "blocking" &&
    object.severity !== "warning" && object.severity !== "suggestion") {
    throw new Error(`${where}.severity is invalid`);
  }
  if (object.messagePattern !== undefined) {
    const pattern = requireString(object.messagePattern, `${where}.messagePattern`);
    // Compiled here so a bad pattern fails the load rather than every run.
    try {
      new RegExp(pattern, "iu");
    } catch (error) {
      throw new Error(`${where}.messagePattern is not a valid regular expression`, { cause: error });
    }
  }
  // An expectation naming only a file matches ANY finding in that file, so an
  // unrelated one counts as the defect and inflates both precision and recall.
  // The README warned about this shape; a warning is not a guard, and a fixture
  // is ground truth (CodeRabbit review of PR #118).
  if (range === undefined && object.messagePattern === undefined) {
    throw new Error(`${where} must give lines or messagePattern: a file alone matches any finding in it`);
  }
  return {
    id: requireString(object.id, `${where}.id`),
    file: requireString(object.file, `${where}.file`),
    ...(range === undefined ? {} : { lines: range }),
    ...(object.messagePattern === undefined
      ? {}
      : { messagePattern: requireString(object.messagePattern, `${where}.messagePattern`) }),
    ...(object.severity === undefined ? {} : { severity: object.severity }),
  };
}

function fileMap(value: unknown, where: string): Record<string, string> {
  const object = requireObject(value, where);
  return Object.fromEntries(Object.entries(object).map(([key, content]) => {
    if (typeof content !== "string") throw new Error(`${where}["${key}"] must be a string`);
    return [key, content];
  }));
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${where} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where} must be a positive integer`);
  }
  return value;
}
