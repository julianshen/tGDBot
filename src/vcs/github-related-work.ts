import {
  validateResolvedRelatedWork,
  type RelatedWorkItem,
  type RelatedWorkReference,
  type RelatedWorkState,
} from "../review/related-work.js";
import type { ExecGh } from "./github-adapter.js";
import { isTransientGhFailure } from "./gh-retry.js";

const LOOKUP_OPTIONS = { timeoutMs: 5_000 } as const;

function authority(reference: RelatedWorkReference): string {
  return `${reference.host}${reference.port ? `:${reference.port}` : ""}`;
}

function diagnosticIdentifier(reference: RelatedWorkReference): string {
  const segments = reference.projectPath.split("/");
  const validProject = segments.length === 2 && segments.every((segment) =>
    segment !== "." && segment !== ".." && /^[A-Za-z0-9_.-]+$/.test(segment));
  const number = Number.isSafeInteger(reference.number) && reference.number > 0
    ? String(reference.number)
    : "?";
  return `${validProject ? reference.projectPath : "[invalid]"}#${number}`;
}

function normalizedState(value: unknown): RelatedWorkState | undefined {
  if (typeof value !== "string") return undefined;
  const state = value.toLowerCase();
  return state === "open" || state === "closed" || state === "merged" ? state : undefined;
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

async function resolveOne(reference: RelatedWorkReference, execGh: ExecGh): Promise<RelatedWorkItem> {
  if (reference.provider !== "github") return reference;
  try {
    const host = authority(reference);
    const common = parseRecord(await execGh([
      "api", "-X", "GET", `repos/${reference.projectPath}/issues/${reference.number}`,
      "--hostname", host,
    ], undefined, LOOKUP_OPTIONS));
    if (!common) return reference;
    const isPullRequest = "pull_request" in common;
    if (!isPullRequest) {
      return validateResolvedRelatedWork(reference, {
        kind: "issue", title: common.title, state: normalizedState(common.state), url: common.html_url,
      });
    }
    const pull = parseRecord(await execGh([
      "pr", "view", String(reference.number), "--repo", `${host}/${reference.projectPath}`,
      "--json", "title,state,url",
    ], undefined, LOOKUP_OPTIONS));
    if (!pull) return reference;
    return validateResolvedRelatedWork(reference, {
      kind: "pull_request", title: pull.title, state: normalizedState(pull.state), url: pull.url,
    });
  } catch (error) {
    console.warn(`Failed to resolve github related work ${diagnosticIdentifier(reference)}`);
    if (isTransientGhFailure(error)) throw new ProviderUnreachableError();
    return reference;
  }
}

/**
 * Raised once the provider is proven unreachable, so the remaining references
 * are left unresolved instead of repeating a dead lookup.
 *
 * Every reference fails identically when the network is down, and each retry
 * budget multiplies the wait before the review can carry on (issue #30). The
 * references are still RETURNED — unresolved, never dropped.
 */
class ProviderUnreachableError extends Error {}

export async function resolveGitHubRelatedWork(
  references: readonly RelatedWorkReference[],
  execGh: ExecGh,
): Promise<readonly RelatedWorkItem[]> {
  const results: RelatedWorkItem[] = new Array(references.length);
  let next = 0;
  let unreachable = false;
  const worker = async (): Promise<void> => {
    while (next < references.length) {
      const index = next++;
      if (unreachable) {
        results[index] = references[index]!;
        continue;
      }
      try {
        results[index] = await resolveOne(references[index]!, execGh);
      } catch (error) {
        if (!(error instanceof ProviderUnreachableError)) throw error;
        unreachable = true;
        results[index] = references[index]!;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, references.length) }, worker));
  return results;
}
