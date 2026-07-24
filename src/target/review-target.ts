import type {
  GitHubRepositoryRef,
  GitLabRepositoryRef,
  RepositoryRef,
  ReviewProvider,
  ReviewTarget,
} from "./types.js";

function invalid(kind: string, reason: string): Error {
  return new Error(`Invalid ${kind}: ${reason}`);
}

function validateRawInput(input: string, kind: string): void {
  if (input.trim() !== input) {
    throw invalid(kind, "leading or trailing whitespace is not allowed");
  }
  if (/[\\\u0000-\u001f\u007f]/u.test(input)) {
    throw invalid(kind, "backslashes and ASCII control characters are not allowed");
  }
  if (
    /%(?:2f|5c)/i.test(input) ||
    /(?:^|\/)(?:%2e|\.){1,2}(?:\/|$)/i.test(input)
  ) {
    throw invalid(kind, "encoded separators and dot segments are not allowed");
  }
}

function pathSegments(pathname: string, kind: string): string[] {
  if (!pathname.startsWith("/")) {
    throw invalid(kind, "path must begin with one slash");
  }
  const withoutLeadingSlash = pathname.slice(1);
  if (withoutLeadingSlash.startsWith("/") || withoutLeadingSlash.includes("//")) {
    throw invalid(kind, "empty path segments and repeated slashes are not allowed");
  }
  const trimmed = withoutLeadingSlash.endsWith("/")
    ? withoutLeadingSlash.slice(0, -1)
    : withoutLeadingSlash;
  const rawSegments = trimmed === "" ? [] : trimmed.split("/");
  let segments: string[];
  try {
    segments = rawSegments.map(decodeURIComponent);
  } catch {
    throw invalid(kind, "path contains malformed percent encoding");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw invalid(kind, "dot path segments are not allowed");
  }
  return segments;
}

function positiveNumber(text: string, kind: string): number {
  if (!/^[1-9]\d*$/.test(text)) {
    throw invalid(kind, "review number must be a positive integer");
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw invalid(kind, "review number is too large");
  }
  return number;
}

function validateUrl(url: URL, kind: string, protocols: readonly string[]): void {
  if (!protocols.includes(url.protocol)) {
    throw invalid(kind, `scheme must be ${protocols.join(" or ")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalid(kind, "credentials are not allowed");
  }
  if (url.search !== "" || url.hash !== "") {
    throw invalid(kind, "queries and fragments are not allowed");
  }
}

function explicitHttpsPort(input: string): number | undefined {
  if (!input.startsWith("https://")) {
    return undefined;
  }
  const afterScheme = input.slice("https://".length);
  const authorityEnd = afterScheme.search(/[/?#]/u);
  const authority = afterScheme.slice(0, authorityEnd === -1 ? undefined : authorityEnd);
  const portMatch = /:(\d+)$/u.exec(authority);
  return portMatch === null ? undefined : Number(portMatch[1]);
}

function makeGitHubRepo(owner: string, repo: string): GitHubRepositoryRef {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) {
    throw invalid("GitHub repository", "owner is missing or invalid");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") {
    throw invalid("GitHub repository", "repository is missing or invalid");
  }
  return {
    provider: "github",
    host: "github.com",
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

function makeGitLabRepo(
  host: string,
  port: number | undefined,
  segments: string[],
): GitLabRepositoryRef {
  if (segments.length < 2) {
    throw invalid("GitLab repository", "namespace and project are required");
  }
  const normalized = [...segments];
  const last = normalized.length - 1;
  normalized[last] = normalized[last].replace(/\.git$/, "");
  if (
    normalized.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[/?#\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw invalid("GitLab repository", "namespace or project segment is invalid");
  }
  const repo = normalized.pop()!;
  const namespace = normalized;
  const normalizedHost = host.toLowerCase();
  const authority = port === undefined ? normalizedHost : `${normalizedHost}:${port}`;
  const canonicalPath = [...namespace, repo].map(encodeURIComponent).join("/");
  return {
    provider: "gitlab",
    host: normalizedHost,
    port,
    namespace,
    repo,
    canonicalUrl: `https://${authority}/${canonicalPath}`,
  };
}

function parseGitHubRepository(input: string): GitHubRepositoryRef {
  validateRawInput(input, "GitHub repository");
  let owner: string;
  let repo: string;

  if (input.startsWith("https://")) {
    const url = new URL(input);
    validateUrl(url, "GitHub repository", ["https:"]);
    if (url.hostname.toLowerCase() !== "github.com" || url.port !== "") {
      throw invalid("GitHub repository", "host must be github.com without a port");
    }
    const segments = pathSegments(url.pathname, "GitHub repository");
    if (segments.length !== 2) {
      throw invalid("GitHub repository", "owner and repository are required");
    }
    [owner, repo] = segments;
  } else {
    const scp = /^git@github\.com:(.+)$/i.exec(input);
    const ssh = input.startsWith("ssh://") ? new URL(input) : undefined;
    if (scp) {
      const segments = pathSegments(`/${scp[1]}`, "GitHub repository");
      if (segments.length !== 2) {
        throw invalid("GitHub repository", "owner and repository are required");
      }
      [owner, repo] = segments;
    } else if (ssh) {
      if (ssh.username !== "git" || ssh.password !== "" || ssh.hostname !== "github.com") {
        throw invalid("GitHub repository", "SSH host must be github.com");
      }
      const segments = pathSegments(ssh.pathname, "GitHub repository");
      if (segments.length !== 2) {
        throw invalid("GitHub repository", "owner and repository are required");
      }
      [owner, repo] = segments;
    } else {
      const segments = pathSegments(`/${input}`, "GitHub repository");
      if (segments.length !== 2) {
        throw invalid("GitHub repository", "owner and repository are required");
      }
      [owner, repo] = segments;
    }
  }
  if (owner === undefined || repo === undefined) {
    throw invalid("GitHub repository", "owner and repository are required");
  }
  return makeGitHubRepo(owner, repo.replace(/\.git$/, ""));
}

function parseGitLabRepository(input: string): GitLabRepositoryRef {
  validateRawInput(input, "GitLab repository");
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input) &&
    !input.startsWith("https://") &&
    !input.startsWith("ssh://")
  ) {
    throw invalid("GitLab repository", "scheme must be HTTPS or SSH");
  }
  let host = "gitlab.com";
  let port: number | undefined;
  let segments: string[];

  if (input.startsWith("https://") || input.startsWith("ssh://")) {
    const url = new URL(input);
    const ssh = url.protocol === "ssh:";
    if (ssh) {
      if (url.username !== "git" || url.password !== "") {
        throw invalid("GitLab repository", "SSH user must be git");
      }
      if (url.search !== "" || url.hash !== "") {
        throw invalid("GitLab repository", "queries and fragments are not allowed");
      }
    } else {
      validateUrl(url, "GitLab repository", ["https:"]);
    }
    host = url.hostname;
    port =
      url.protocol === "https:"
        ? (explicitHttpsPort(input) ?? (url.port === "" ? undefined : Number(url.port)))
        : url.port === ""
          ? undefined
          : Number(url.port);
    segments = pathSegments(url.pathname, "GitLab repository");
  } else {
    const scp = /^git@([^:/]+):(.+)$/.exec(input);
    if (scp) {
      host = scp[1];
      segments = pathSegments(`/${scp[2]}`, "GitLab repository");
    } else {
      const parts = input.split("/");
      const authorityCandidate = parts[0];
      if (authorityCandidate.includes("@")) {
        throw invalid("GitLab repository", "credentials are not allowed");
      }
      const explicitHost = parts[0].includes(".") || /^[^:]+:\d+$/.test(parts[0]);
      if (explicitHost) {
        const authority = new URL(`https://${parts.shift()!}`);
        host = authority.hostname;
        port = authority.port === "" ? undefined : Number(authority.port);
      }
      segments = pathSegments(`/${parts.join("/")}`, "GitLab repository");
    }
  }
  return makeGitLabRepo(host, port, segments);
}

export function parseRepositoryRef(
  input: string,
  provider: "github",
): GitHubRepositoryRef;
export function parseRepositoryRef(
  input: string,
  provider: "gitlab",
): GitLabRepositoryRef;
export function parseRepositoryRef(input: string, provider: ReviewProvider): RepositoryRef;
export function parseRepositoryRef(input: string, provider: ReviewProvider): RepositoryRef {
  return provider === "github"
    ? parseGitHubRepository(input)
    : parseGitLabRepository(input);
}

function parseGitHubTarget(url: URL, explicitPort: number | undefined): ReviewTarget {
  if (url.port !== "" || explicitPort !== undefined) {
    throw invalid("GitHub review target", "custom ports are not allowed");
  }
  const segments = pathSegments(url.pathname, "GitHub review target");
  if (segments.length !== 4 || segments[2] !== "pull") {
    throw invalid("GitHub review target", "path must be OWNER/REPO/pull/NUMBER");
  }
  const repo = makeGitHubRepo(segments[0], segments[1]);
  const number = positiveNumber(segments[3], "GitHub review target");
  return {
    provider: "github",
    repo,
    number,
    canonicalUrl: `${repo.canonicalUrl}/pull/${number}`,
  };
}

function parseGitLabTarget(url: URL, explicitPort: number | undefined): ReviewTarget {
  const segments = pathSegments(url.pathname, "GitLab review target");
  const marker = segments.length - 3;
  if (
    marker < 2 ||
    segments[marker] !== "-" ||
    segments[marker + 1] !== "merge_requests"
  ) {
    throw invalid(
      "GitLab review target",
      "path must be NAMESPACE/PROJECT/-/merge_requests/IID",
    );
  }
  const port = explicitPort ?? (url.port === "" ? undefined : Number(url.port));
  const repo = makeGitLabRepo(url.hostname, port, segments.slice(0, marker));
  const number = positiveNumber(segments[marker + 2], "GitLab review target");
  return {
    provider: "gitlab",
    repo,
    number,
    canonicalUrl: `${repo.canonicalUrl}/-/merge_requests/${number}`,
  };
}

export function parseReviewTarget(
  input: string,
  expectedProvider?: ReviewProvider,
): ReviewTarget {
  validateRawInput(input, "review target");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid("review target", "value must be a complete absolute URL");
  }
  validateUrl(url, "review target", ["https:"]);
  const provider: ReviewProvider =
    url.hostname.toLowerCase() === "github.com" ? "github" : "gitlab";
  if (expectedProvider !== undefined && expectedProvider !== provider) {
    throw invalid(
      "review target",
      `URL provider ${provider} does not match expected provider ${expectedProvider}`,
    );
  }
  const explicitPort = explicitHttpsPort(input);
  return provider === "github"
    ? parseGitHubTarget(url, explicitPort)
    : parseGitLabTarget(url, explicitPort);
}
