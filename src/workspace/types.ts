import type { RepositoryRef } from "../target/types.js";

export interface WorkspaceRequest {
  root: string;
  repo: RepositoryRef;
  baseSha: string;
  /**
   * Refuse a root other users could previously write, rather than adopting it.
   *
   * Off by default, preserving the adopt-and-secure behaviour this module has
   * always had and its tests assert. Callers that go on to RUN something out of
   * the workspace turn it on: a previously-shared root can hold a
   * pre-created bare mirror carrying the expected origin plus an attacker's
   * `hooks/post-checkout`, and the `git worktree add` below executes that hook.
   * chmod 0700 locks such a mirror in rather than shutting it out.
   */
  rejectPreviouslySharedRoot?: boolean;
}

export interface WorkspacePaths {
  root: string;
  repositoryRoot: string;
  mirrorPath: string;
  worktreesRoot: string;
  baseWorktreePath: string;
  ownerMarkerPath: string;
}

export interface PreparedWorkspace extends WorkspacePaths {
  baseSha: string;
}

/**
 * One checked-out tree, at the commit that was asked for.
 *
 * Issue #144. The manager has always been commit-generic — `deriveWorkspacePaths`
 * keys the directory and the ownership marker on the SHA, and the checkout is
 * `git worktree add --detach <path> <sha>` — so nothing here is new capability.
 * What the `baseSha`/`baseWorktreePath` naming hid is that a consumer wanting
 * the HEAD tree had to ask for it through a field called "base", and a consumer
 * wanting BOTH had no way to get them under one lock.
 */
export interface PreparedWorktree {
  /** The commit this tree is checked out at, lowercased. */
  readonly sha: string;
  readonly path: string;
}

/** Several trees of one repository, prepared under a single lock acquisition. */
export interface PreparedWorkspaces extends Omit<WorkspacePaths, "baseWorktreePath" | "ownerMarkerPath"> {
  /** In the order requested, one per requested SHA, deduplicated. */
  readonly worktrees: readonly PreparedWorktree[];
  /** The tree for a requested SHA. Throws for a SHA that was not requested. */
  readonly at: (sha: string) => string;
}

export type WorkspaceTool = "gh" | "glab" | "git";
export type ExecWorkspaceCommand = (tool: WorkspaceTool, args: string[], timeoutMs?: number) => Promise<string>;

export interface WorkspaceDependencies {
  exec: ExecWorkspaceCommand;
  commandTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Absolute ceiling on lock waiting; see `maxWaitMs` on the lock itself. */
  lockMaxWaitMs?: number;
}
