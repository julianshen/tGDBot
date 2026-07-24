import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  decodeNdjsonRecords,
  GitLabAdapter,
  GlabCommandError,
  GlabOutputError,
  projectEndpoint,
  realExecGlab,
  type ExecGlab,
} from "../../../src/vcs/gitlab-adapter.js";
import type { GitLabRepositoryRef } from "../../../src/target/types.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const gitlabComRepo: GitLabRepositoryRef = {
  provider: "gitlab",
  host: "gitlab.com",
  namespace: ["group", "subgroup"],
  repo: "project",
  canonicalUrl: "https://gitlab.com/group/subgroup/project",
};

const selfManagedRepo: GitLabRepositoryRef = {
  provider: "gitlab",
  host: "gitlab.example.com",
  namespace: ["group", "subgroup"],
  repo: "project",
  canonicalUrl: "https://gitlab.example.com/group/subgroup/project",
};

const customPortRepo: GitLabRepositoryRef = {
  provider: "gitlab",
  host: "gitlab.example.com",
  port: 8443,
  namespace: ["group"],
  repo: "project",
  canonicalUrl: "https://gitlab.example.com:8443/group/project",
};

const locator = (repo: GitLabRepositoryRef = selfManagedRepo) =>
  ({ kind: "repository", repo, number: 42 }) as const;

const fixturePath = fileURLToPath(new URL("../../fixtures/glab-mr.json", import.meta.url));
const fixture = await readFile(fixturePath, "utf8");

describe("GitLabAdapter merge request snapshot", () => {
  it.each([gitlabComRepo, selfManagedRepo, customPortRepo])(
    "fetches metadata with an encoded project endpoint and host without port",
    async (repo) => {
      const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
      const execGlab: ExecGlab = async (args, stdin) => {
        calls.push({ args, stdin });
        return fixture;
      };

      const result = await new GitLabAdapter(execGlab).getPullRequest(locator(repo));

      expect(calls).toEqual([
        {
          args: [
            "api",
            "--method",
            "GET",
            "--hostname",
            repo.host,
            `projects/${encodeURIComponent([...repo.namespace, repo.repo].join("/"))}/merge_requests/42`,
          ],
          stdin: undefined,
        },
      ]);
      expect(result).toEqual({
        id: "42",
        title: "Add GitLab support",
        description: "Review GitLab merge requests through glab.",
        url: "https://gitlab.example.com/group/subgroup/project/-/merge_requests/42",
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
        startSha: "0000000000000000000000000000000000000000",
        headRef: "feature/gitlab",
        baseRef: "main",
      });
    },
  );

  it("returns glab mr diff output byte-for-byte and passes the canonical repo URL", async () => {
    const output = "diff --git a/a b/a\n+unchanged \n";
    const execGlab = vi.fn<ExecGlab>().mockResolvedValue(output);

    await expect(new GitLabAdapter(execGlab).getDiff(locator(customPortRepo))).resolves.toBe(output);
    expect(execGlab).toHaveBeenCalledWith([
      "mr",
      "diff",
      "42",
      "--repo",
      customPortRepo.canonicalUrl,
    ]);
  });

  it("rejects ambient and GitHub repository locators before invoking glab", async () => {
    const execGlab = vi.fn<ExecGlab>();
    const adapter = new GitLabAdapter(execGlab);
    await expect(
      adapter.getDiff({ kind: "ambient", provider: "github", number: 42 }),
    ).rejects.toThrow(/requires a GitLab repository locator/);
    await expect(
      adapter.getDiff({
        kind: "repository",
        repo: {
          provider: "github",
          host: "github.com",
          owner: "o",
          repo: "r",
          canonicalUrl: "https://github.com/o/r",
        },
        number: 42,
      }),
    ).rejects.toThrow(/cannot use a GitHub repository locator/);
    expect(execGlab).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "malformed JSON"],
    [JSON.stringify([]), "object"],
    [JSON.stringify({ ...JSON.parse(fixture), iid: "42" }), "iid"],
    [JSON.stringify({ ...JSON.parse(fixture), source_branch: null }), "source_branch"],
    [JSON.stringify({ ...JSON.parse(fixture), diff_refs: undefined }), "diff_refs"],
    [
      JSON.stringify({
        ...JSON.parse(fixture),
        diff_refs: { ...JSON.parse(fixture).diff_refs, start_sha: "" },
      }),
      "start_sha",
    ],
  ])("rejects invalid MR output (%s)", async (stdout, expected) => {
    const adapter = new GitLabAdapter(async () => stdout);
    await expect(adapter.getPullRequest(locator())).rejects.toMatchObject({
      name: "GlabOutputError",
      message: expect.stringMatching(new RegExp(expected, "i")),
    });
  });
});

describe("GitLab adapter helpers", () => {
  it("encodes the complete namespace/project as one endpoint segment", () => {
    expect(projectEndpoint(selfManagedRepo, "merge_requests/42/versions")).toBe(
      "projects/group%2Fsubgroup%2Fproject/merge_requests/42/versions",
    );
  });

  it("decodes one NDJSON object per non-empty line across pages", () => {
    expect(decodeNdjsonRecords<{ id: number }>('{"id":1}\n\n{"id":2}\n')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it("rejects malformed NDJSON records with a named output error", () => {
    expect(() => decodeNdjsonRecords('{"id":1}\nnope\n')).toThrow(GlabOutputError);
  });
});

describe("realExecGlab", () => {
  it("uses execFile argv, a 10 MiB buffer, non-interactive environment, and optional stdin", async () => {
    const end = vi.fn();
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: readonly string[],
      options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      expect(file).toBe("glab");
      expect(args).toEqual(["api", "user"]);
      expect(options).toMatchObject({
        maxBuffer: 10 * 1024 * 1024,
        env: expect.objectContaining({ GLAB_PROMPT_DISABLED: "true" }),
      });
      queueMicrotask(() => callback(null, "ok\n", ""));
      return { stdin: { end } };
    }) as typeof execFile);

    await expect(realExecGlab(["api", "user"], "secret stdin")).resolves.toBe("ok\n");
    expect(end).toHaveBeenCalledWith("secret stdin");
  });

  it("maps ENOENT to actionable installation and host-specific auth guidance", async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: NodeJS.ErrnoException, stdout: string, stderr: string) => void,
    ) => {
      const error = Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" });
      queueMicrotask(() => callback(error, "", ""));
      return { stdin: { end: vi.fn() } };
    }) as typeof execFile);

    const error = await realExecGlab([
      "api",
      "--hostname",
      "gitlab.example.com",
      "user",
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GlabCommandError);
    expect((error as Error).message).toMatch(
      /install.*gitlab CLI.*glab auth login --hostname gitlab\.example\.com/i,
    );
  });

  it("maps maxBuffer overflow to a named actionable error", async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: NodeJS.ErrnoException, stdout: string, stderr: string) => void,
    ) => {
      const error = Object.assign(new Error("stdout maxBuffer length exceeded TOKEN=secret"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      queueMicrotask(() => callback(error, "", "TOKEN=secret"));
      return { stdin: { end: vi.fn() } };
    }) as typeof execFile);

    await expect(realExecGlab(["mr", "diff", "42"])).rejects.toMatchObject({
      name: "GlabCommandError",
      message: expect.stringMatching(/output exceeded.*10 MiB/i),
      stderr: "TOKEN=secret",
    });
    await expect(realExecGlab(["mr", "diff", "42"])).rejects.not.toThrow(/TOKEN=secret/);
  });

  it("parses anchored API HTTP diagnostics but not incidental or non-API statuses", async () => {
    const errors = [
      { args: ["api", "projects/x"], stderr: "request failed\nHTTP 403\n", status: 403 },
      { args: ["api", "projects/x"], stderr: "body says HTTP 418 maybe\n", status: undefined },
      { args: ["mr", "diff", "42"], stderr: "HTTP 403\n", status: undefined },
    ] as const;

    for (const sample of errors) {
      vi.mocked(execFile).mockImplementationOnce(((
        _file: string,
        _args: readonly string[],
        _options: object,
        callback: (error: Error, stdout: string, stderr: string) => void,
      ) => {
        queueMicrotask(() => callback(Object.assign(new Error("secret"), { code: 1 }), "", sample.stderr));
        return { stdin: { end: vi.fn() } };
      }) as typeof execFile);
      const error = await realExecGlab(sample.args).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GlabCommandError);
      expect(error).toMatchObject({ httpStatus: sample.status, stderr: sample.stderr });
      expect((error as Error).message).not.toContain(sample.stderr.trim());
    }
  });
});
