import { execFile } from "node:child_process";
import type { GitLabRepositoryRef } from "../target/types.js";
import type {
  BotComment,
  InlineReviewComment,
  PullRequestInfo,
  ReviewLocator,
  RuleFileContent,
  VcsAdapter,
} from "./adapter.js";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/i;
const HTTP_DIAGNOSTIC_RE = /(?:^|\n)HTTP ([1-5]\d{2})\r?\n?$/;

export type ExecGlab = (
  args: readonly string[],
  stdin?: string,
) => Promise<string>;

export class GlabCommandError extends Error {
  readonly exitCode?: number;
  readonly httpStatus?: number;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      exitCode?: number;
      httpStatus?: number;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GlabCommandError";
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
    this.stderr = options.stderr ?? "";
  }
}

export class GlabOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GlabOutputError";
  }
}

function commandHost(args: readonly string[]): string {
  const hostnameIndex = args.indexOf("--hostname");
  if (hostnameIndex >= 0 && args[hostnameIndex + 1]) {
    return args[hostnameIndex + 1]!;
  }
  const repoIndex = args.indexOf("--repo");
  if (repoIndex >= 0 && args[repoIndex + 1]) {
    try {
      return new URL(args[repoIndex + 1]!).hostname;
    } catch {
      // The adapter supplies normalized URLs. Retain a safe default if an
      // injected caller invokes this lower-level executor directly.
    }
  }
  return "gitlab.com";
}

function numericExitCode(error: NodeJS.ErrnoException): number | undefined {
  return typeof error.code === "number" ? error.code : undefined;
}

function apiHttpStatus(args: readonly string[], stderr: string): number | undefined {
  if (args[0] !== "api") return undefined;
  const match = HTTP_DIAGNOSTIC_RE.exec(stderr);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export const realExecGlab: ExecGlab = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "glab",
      [...args],
      {
        maxBuffer: MAX_BUFFER_BYTES,
        env: {
          ...process.env,
          GLAB_PROMPT_DISABLED: "true",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }

        const processError = error as NodeJS.ErrnoException;
        const host = commandHost(args);
        if (processError.code === "ENOENT") {
          reject(
            new GlabCommandError(
              `Unable to run glab. Install the GitLab CLI, then authenticate with glab auth login --hostname ${host}.`,
              { cause: error, stderr },
            ),
          );
          return;
        }
        if (processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new GlabCommandError(
              "glab output exceeded the 10 MiB safety limit; narrow the requested output or reduce the merge request diff.",
              { cause: error, exitCode: numericExitCode(processError), stderr },
            ),
          );
          return;
        }

        reject(
          new GlabCommandError(
            `glab command failed for ${host}; verify authentication, permissions, and host configuration.`,
            {
              cause: error,
              exitCode: numericExitCode(processError),
              httpStatus: apiHttpStatus(args, stderr),
              stderr,
            },
          ),
        );
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });

export function projectEndpoint(repo: GitLabRepositoryRef, suffix: string): string {
  const projectPath = [...repo.namespace, repo.repo].join("/");
  return `projects/${encodeURIComponent(projectPath)}/${suffix}`;
}

export function decodeNdjsonRecords<T>(stdout: string): T[] {
  const records: T[] = [];
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (cause) {
      throw new GlabOutputError(
        `Malformed NDJSON record from glab at line ${index + 1}`,
        { cause },
      );
    }
  }
  return records;
}

interface GlabMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  object: Record<string, unknown>,
  field: string,
  options: { sha?: boolean } = {},
): string {
  const value = object[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (options.sha === true && !SHA_RE.test(value))
  ) {
    throw new GlabOutputError(`Invalid glab MR response: malformed ${field}`);
  }
  return value;
}

function parseMergeRequest(stdout: string): GlabMergeRequest {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new GlabOutputError("Invalid glab MR response: malformed JSON", { cause });
  }
  if (!isRecord(value)) {
    throw new GlabOutputError("Invalid glab MR response: expected an object");
  }
  if (!Number.isSafeInteger(value.iid) || (value.iid as number) <= 0) {
    throw new GlabOutputError("Invalid glab MR response: malformed iid");
  }
  const diffRefs = value.diff_refs;
  if (!isRecord(diffRefs)) {
    throw new GlabOutputError("Invalid glab MR response: malformed diff_refs");
  }
  return {
    iid: value.iid as number,
    title: requiredString(value, "title"),
    description:
      value.description === null ? null : requiredString(value, "description"),
    web_url: requiredString(value, "web_url"),
    source_branch: requiredString(value, "source_branch"),
    target_branch: requiredString(value, "target_branch"),
    diff_refs: {
      base_sha: requiredString(diffRefs, "base_sha", { sha: true }),
      head_sha: requiredString(diffRefs, "head_sha", { sha: true }),
      start_sha: requiredString(diffRefs, "start_sha", { sha: true }),
    },
  };
}

function resolveMergeRequestLocator(locator: ReviewLocator): {
  repo: GitLabRepositoryRef;
  iid: string;
} {
  if (locator.kind !== "repository") {
    throw new Error("GitLabAdapter requires a GitLab repository locator");
  }
  if (locator.repo.provider !== "gitlab") {
    throw new Error("GitLabAdapter cannot use a GitHub repository locator");
  }
  if (!Number.isSafeInteger(locator.number) || locator.number <= 0) {
    throw new Error("Review locator number must be a positive integer");
  }
  return { repo: locator.repo, iid: String(locator.number) };
}

function unavailable(operation: string): never {
  throw new Error(`GitLab ${operation} is not available yet`);
}

export class GitLabAdapter implements VcsAdapter {
  constructor(private readonly execGlab: ExecGlab = realExecGlab) {}

  async getPullRequest(locator: ReviewLocator): Promise<PullRequestInfo> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    const stdout = await this.execGlab([
      "api",
      "--method",
      "GET",
      "--hostname",
      repo.host,
      projectEndpoint(repo, `merge_requests/${iid}`),
    ]);
    const mr = parseMergeRequest(stdout);
    return {
      id: String(mr.iid),
      headSha: mr.diff_refs.head_sha,
      baseSha: mr.diff_refs.base_sha,
      startSha: mr.diff_refs.start_sha,
      headRef: mr.source_branch,
      baseRef: mr.target_branch,
      title: mr.title,
      description: mr.description ?? "",
      url: mr.web_url,
    };
  }

  async getDiff(locator: ReviewLocator): Promise<string> {
    const { repo, iid } = resolveMergeRequestLocator(locator);
    return this.execGlab(["mr", "diff", iid, "--repo", repo.canonicalUrl]);
  }

  async findBotComment(locator: ReviewLocator): Promise<BotComment | null> {
    void locator;
    return unavailable("comment lookup");
  }

  async upsertComment(
    locator: ReviewLocator,
    body: string,
    existing: BotComment | null,
  ): Promise<void> {
    void [locator, body, existing];
    return unavailable("comment upsert");
  }

  async createInlineReview(
    locator: ReviewLocator,
    headSha: string,
    comments: InlineReviewComment[],
  ): Promise<void> {
    void [locator, headSha, comments];
    return unavailable("inline review");
  }

  async resolveStaleReviewThreads(locator: ReviewLocator): Promise<number> {
    void locator;
    return unavailable("thread cleanup");
  }

  async getRuleFilesFromBase(
    locator: ReviewLocator,
    baseSha: string,
    rulesDir: string,
  ): Promise<RuleFileContent[]> {
    void [locator, baseSha, rulesDir];
    return unavailable("base-branch rule loading");
  }
}
