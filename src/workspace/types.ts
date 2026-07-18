import type { RepositoryRef } from "../vcs/adapter.js";

export interface WorkspaceRequest {
  root: string;
  repo: RepositoryRef;
  baseSha: string;
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

export type WorkspaceTool = "gh" | "git";
export type ExecWorkspaceCommand = (tool: WorkspaceTool, args: string[]) => Promise<string>;

export interface WorkspaceDependencies {
  exec: ExecWorkspaceCommand;
}
