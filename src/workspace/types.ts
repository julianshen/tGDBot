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

export type WorkspaceTool = "gh" | "glab" | "git";
export type ExecWorkspaceCommand = (tool: WorkspaceTool, args: string[], timeoutMs?: number) => Promise<string>;

export interface WorkspaceDependencies {
  exec: ExecWorkspaceCommand;
  commandTimeoutMs?: number;
  lockTimeoutMs?: number;
}
