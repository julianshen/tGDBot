// Retrying transient `gh` failures — and only where replaying is provably safe.
//
// A review aborted outright because a single `gh api` read hit "error connecting
// to api.github.com" (issue #30). Nothing retried, so a momentary network blip
// cost a whole review, and the operator saw a raw command dump rather than a
// classified cause.
//
// Retrying is NOT universally safe here. Replaying `POST /pulls/{n}/reviews`
// would publish a second review; replaying a resolveReviewThread mutation would
// act twice. So this retries an invocation only when it can PROVE the call is
// read-only, and treats anything it cannot classify as a write.

/** Same shape as the adapters' exec seam, kept structural to avoid a cycle. */
export type GhExec = (
  args: string[],
  stdin?: string,
  options?: { timeoutMs?: number },
) => Promise<string>;

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// `gh` subcommands that only read. Anything not listed is assumed to write:
// the default must be "do not replay".
const READ_ONLY_SUBCOMMANDS = new Set(["view", "list", "status", "diff"]);

/**
 * True only when replaying the invocation cannot change server state.
 *
 * Conservative by construction — an unrecognised shape returns false, because
 * the cost of wrongly retrying a write (a duplicate review comment) is far
 * higher than the cost of not retrying a read.
 */
export function isReadOnlyGhInvocation(args: readonly string[]): boolean {
  // Anything piping a body is a write in this codebase.
  if (args.includes("--input") || args.includes("--body-file") || args.includes("-F--input")) return false;

  const methodIndex = args.indexOf("-X");
  if (methodIndex !== -1) {
    const method = (args[methodIndex + 1] ?? "").toUpperCase();
    if (WRITE_METHODS.has(method)) return false;
    if (method !== "GET") return false;
  }

  if (args[0] === "api") {
    // GraphQL travels by POST, so the method says nothing: a query is a read,
    // a mutation is not.
    if (args[1] === "graphql") {
      return args.some((arg) => /^query=\s*query[\s({]/u.test(arg))
        && !args.some((arg) => /^query=\s*mutation\b/u.test(arg));
    }
    return true;
  }

  return args.length > 1 && READ_ONLY_SUBCOMMANDS.has(args[1]!);
}

/**
 * True for failures that are worth another attempt: the request never reached a
 * verdict. A 4xx is a definite answer and must NOT be retried — it would only
 * repeat the same rejection.
 */
export function isTransientGhFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 4\d\d/u.test(message)) return false;
  return /error connecting|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|network is unreachable|TLS|HTTP 5\d\d|timed out/iu
    .test(message);
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  readonly attempts?: number;
  /** Backoff before attempt `n` (1-based for the FIRST retry). */
  readonly delayMs?: (retry: number) => number;
}

/**
 * Wraps an exec seam so provably read-only calls survive a transient failure.
 * Writes and definite rejections pass through untouched on the first attempt.
 */
export function retryTransientGh(exec: GhExec, options: RetryOptions = {}): GhExec {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? ((retry: number) => Math.min(2_000, 250 * 2 ** (retry - 1)));

  return async (args, stdin, execOptions) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await exec(args, stdin, execOptions);
      } catch (error) {
        lastError = error;
        const retryable = attempt < attempts
          && isReadOnlyGhInvocation(args)
          && isTransientGhFailure(error);
        if (!retryable) throw error;
        const wait = delayMs(attempt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  };
}
