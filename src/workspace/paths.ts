import path from "node:path";
import type { WorkspacePaths, WorkspaceRequest } from "./types.js";

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const SEGMENT_RE = /^[^/\\\u0000-\u001f\u007f]+$/u;

export function encodeWorkspaceAuthority(host: string, port?: number): string {
  return encodeURIComponent(port === undefined ? host : `${host}:${port}`);
}

function validateGitLabSegment(kind: string, segment: string): void {
  if (!SEGMENT_RE.test(segment) || segment === "." || segment === "..") {
    throw new Error(`Managed workspace ${kind} is invalid`);
  }
}

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
  let repositorySegments: string[];
  if (request.repo.provider === "github") {
    if (request.repo.host !== "github.com") {
      throw new Error("Managed workspace host must be github.com");
    }
    if (!OWNER_RE.test(request.repo.owner)) {
      throw new Error("Managed workspace owner is invalid");
    }
    if (!REPO_RE.test(request.repo.repo) || request.repo.repo === "." || request.repo.repo === "..") {
      throw new Error("Managed workspace repository is invalid");
    }
    if (request.repo.canonicalUrl !== `https://${request.repo.host}/${request.repo.owner}/${request.repo.repo}`) {
      throw new Error("Managed workspace canonical repository identity is invalid");
    }
    repositorySegments = [request.repo.host, request.repo.owner, request.repo.repo];
  } else {
    validateGitLabSegment("host", request.repo.host);
    if (
      request.repo.port !== undefined &&
      (!Number.isSafeInteger(request.repo.port) || request.repo.port < 1 || request.repo.port > 65535)
    ) {
      throw new Error("Managed workspace port is invalid");
    }
    if (request.repo.namespace.length === 0) {
      throw new Error("Managed workspace namespace is invalid");
    }
    request.repo.namespace.forEach((segment) => validateGitLabSegment("namespace", segment));
    validateGitLabSegment("repository", request.repo.repo);
    const authority = request.repo.port === undefined
      ? request.repo.host
      : `${request.repo.host}:${request.repo.port}`;
    const canonicalPath = [...request.repo.namespace, request.repo.repo].map(encodeURIComponent).join("/");
    if (request.repo.canonicalUrl !== `https://${authority}/${canonicalPath}`) {
      throw new Error("Managed workspace canonical repository identity is invalid");
    }
    repositorySegments = [
      encodeWorkspaceAuthority(request.repo.host, request.repo.port),
      ...request.repo.namespace,
      request.repo.repo,
    ];
  }
  if (!SHA_RE.test(request.baseSha)) {
    throw new Error("Managed workspace base SHA is invalid");
  }

  const repositoryRoot = path.join(root, "repos", ...repositorySegments);
  const mirrorPath = path.join(repositoryRoot, "repository.git");
  const worktreesRoot = path.join(repositoryRoot, "worktrees");
  const baseWorktreePath = path.join(worktreesRoot, request.baseSha.toLowerCase());
  const ownerMarkerPath = path.join(worktreesRoot, ".owners", `${request.baseSha.toLowerCase()}.json`);

  for (const candidate of [repositoryRoot, mirrorPath, worktreesRoot, baseWorktreePath, ownerMarkerPath]) {
    assertInside(root, candidate);
  }

  return { root, repositoryRoot, mirrorPath, worktreesRoot, baseWorktreePath, ownerMarkerPath };
}
