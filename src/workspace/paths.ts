import path from "node:path";
import type { WorkspacePaths, WorkspaceRequest } from "./types.js";

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Managed workspace path escapes its root: ${candidate}`);
  }
}

export function deriveWorkspacePaths(request: WorkspaceRequest): WorkspacePaths {
  const root = path.resolve(request.root);
  if (root === path.parse(root).root) {
    throw new Error("Managed workspace root cannot be the filesystem root");
  }
  if (request.repo.host !== "github.com") {
    throw new Error("Managed workspace host must be github.com");
  }
  if (!OWNER_RE.test(request.repo.owner)) {
    throw new Error("Managed workspace owner is invalid");
  }
  if (!REPO_RE.test(request.repo.repo) || request.repo.repo === "." || request.repo.repo === "..") {
    throw new Error("Managed workspace repository is invalid");
  }
  if (!SHA_RE.test(request.baseSha)) {
    throw new Error("Managed workspace base SHA is invalid");
  }

  const repositoryRoot = path.join(
    root,
    "repos",
    request.repo.host,
    request.repo.owner,
    request.repo.repo,
  );
  const mirrorPath = path.join(repositoryRoot, "repository.git");
  const worktreesRoot = path.join(repositoryRoot, "worktrees");
  const baseWorktreePath = path.join(worktreesRoot, request.baseSha.toLowerCase());
  const ownerMarkerPath = path.join(worktreesRoot, ".owners", `${request.baseSha.toLowerCase()}.json`);

  for (const candidate of [repositoryRoot, mirrorPath, worktreesRoot, baseWorktreePath, ownerMarkerPath]) {
    assertInside(root, candidate);
  }

  return { root, repositoryRoot, mirrorPath, worktreesRoot, baseWorktreePath, ownerMarkerPath };
}
