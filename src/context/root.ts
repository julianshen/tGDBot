// Where the managed base worktree and the published context cache live.
//
// Deliberately a sibling of the conversation state root rather than a
// subdirectory of it: conversation state is small, durable and precious (it is
// the ledger), while context is large, regenerable cache. Keeping them apart
// means an operator can delete the whole context tree to reclaim disk without
// touching a single ledger entry, and can point `--context-dir` at a bigger
// or faster volume independently.
import path from "node:path";

export interface ContextRootSelection {
  readonly explicitContextDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

function validateAbsoluteRoot(value: string, platform: NodeJS.Platform, name: string): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (value.length === 0 || value.includes("\0") || !platformPath.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return platformPath.normalize(value);
}

/**
 * Resolves where context lives, in strict precedence: `--context-dir`, then
 * `TGD_REVIEW_CONTEXT_DIR`, then the platform default (`%LOCALAPPDATA%` on
 * Windows, `$XDG_CACHE_HOME` then `~/.cache` elsewhere).
 *
 * Every source must be an absolute path with no NUL byte, and is normalized.
 * Throws when the platform default's variable is unset rather than guessing a
 * location — a container may set neither, and the caller degrades on the throw.
 * Everything written under this root is either regenerable cache or a managed
 * git checkout, and its contents are read back as `[TRUSTED_CONTEXT]`, so where
 * it lands is a security decision as much as a tidiness one.
 */
export function selectContextRoot(options: ContextRootSelection = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (options.explicitContextDir !== undefined) {
    return validateAbsoluteRoot(options.explicitContextDir, platform, "Explicit context directory");
  }
  if (env.TGD_REVIEW_CONTEXT_DIR !== undefined) {
    return validateAbsoluteRoot(env.TGD_REVIEW_CONTEXT_DIR, platform, "TGD_REVIEW_CONTEXT_DIR");
  }
  if (platform === "win32") {
    if (env.LOCALAPPDATA === undefined) {
      throw new Error("LOCALAPPDATA is required to select the context directory");
    }
    const base = validateAbsoluteRoot(env.LOCALAPPDATA, platform, "LOCALAPPDATA");
    return path.win32.join(base, "tgd-review-agent", "context");
  }
  if (env.XDG_CACHE_HOME !== undefined) {
    const base = validateAbsoluteRoot(env.XDG_CACHE_HOME, platform, "XDG_CACHE_HOME");
    return path.posix.join(base, "tgd-review-agent");
  }
  if (env.HOME === undefined) throw new Error("HOME is required to select the context directory");
  const home = validateAbsoluteRoot(env.HOME, platform, "HOME");
  return path.posix.join(home, ".cache", "tgd-review-agent");
}

/** The managed git mirror/worktree tree, and the published context cache. */
export function contextRoots(root: string): { workspaceRoot: string; cacheRoot: string } {
  return {
    workspaceRoot: path.join(root, "workspaces"),
    cacheRoot: path.join(root, "cache"),
  };
}
