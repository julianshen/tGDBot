import {
  validateResolvedRelatedWork,
  type RelatedWorkItem,
  type RelatedWorkReference,
} from "../review/related-work.js";
import type { ExecGlab } from "./gitlab-adapter.js";

const LOOKUP_OPTIONS = { timeoutMs: 5_000 } as const;
const PROJECT_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function validReference(reference: RelatedWorkReference): boolean {
  if (!Number.isSafeInteger(reference.number) || reference.number < 1) return false;
  if (reference.projectPath.split("/").length < 2 ||
      reference.projectPath.split("/").some((segment) => !PROJECT_SEGMENT.test(segment) || segment === "." || segment === "..")) return false;
  if (reference.port !== undefined && (!/^[0-9]+$/.test(reference.port) || Number(reference.port) < 1 || Number(reference.port) > 65_535)) return false;
  try {
    const candidate = new URL(`https://${reference.host}${reference.port ? `:${reference.port}` : ""}/`);
    return !candidate.username && !candidate.password && candidate.hostname.toLowerCase() === reference.host.toLowerCase();
  } catch {
    return false;
  }
}

function authority(reference: RelatedWorkReference): string {
  return `${reference.host}${reference.port && reference.port !== "443" ? `:${reference.port}` : ""}`;
}

function diagnosticIdentifier(reference: RelatedWorkReference): string {
  return `${reference.projectPath}${reference.kindHint === "merge_request" ? "!" : "#"}${reference.number}`;
}

function parseRecord(output: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveOne(reference: RelatedWorkReference, execGlab: ExecGlab): Promise<RelatedWorkItem> {
  if (reference.provider !== "gitlab" ||
      (reference.kindHint !== "issue" && reference.kindHint !== "merge_request") ||
      !validReference(reference)) return reference;
  try {
    const host = authority(reference);
    const projectUrl = `https://${host}/${reference.projectPath}`;
    const command = reference.kindHint === "issue" ? "issue" : "mr";
    const output = await execGlab([
      command, "view", String(reference.number), "--repo", projectUrl,
      "--hostname", host, "--output", "json",
    ], undefined, LOOKUP_OPTIONS);
    const record = parseRecord(output);
    if (!record) return reference;
    return validateResolvedRelatedWork(reference, {
      kind: reference.kindHint,
      title: record.title,
      state: record.state,
      url: record.web_url ?? record.url,
    });
  } catch {
    console.warn(`Failed to resolve gitlab related work ${diagnosticIdentifier(reference)}`);
    return reference;
  }
}

export async function resolveGitLabRelatedWork(
  references: readonly RelatedWorkReference[],
  execGlab: ExecGlab,
): Promise<readonly RelatedWorkItem[]> {
  const results: RelatedWorkItem[] = new Array(references.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < references.length) {
      const index = next++;
      results[index] = await resolveOne(references[index]!, execGlab);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, references.length) }, worker));
  return results;
}
