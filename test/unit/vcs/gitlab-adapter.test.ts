import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
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
    [JSON.stringify({ ...JSON.parse(fixture), description: 123 }), "description"],
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

  it.each([
    [null, ""],
    ["", ""],
  ])("normalizes a %s description without rejecting valid emptiness", async (description, expected) => {
    const adapter = new GitLabAdapter(async () =>
      JSON.stringify({ ...JSON.parse(fixture), description }),
    );

    await expect(adapter.getPullRequest(locator())).resolves.toMatchObject({
      description: expected,
    });
  });
});

describe("GitLabAdapter trusted base-branch rules", () => {
  it("lists paginated tree records and fetches sorted direct markdown blobs as UTF-8", async () => {
    const content = new Map([
      [".review/rules/a rule.md", "---\nname: α\n---\n繁體中文\n"],
      [".review/rules/z.md", "plain UTF-8: café 🚀\n"],
    ]);
    const calls: readonly string[][] = [];
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      (calls as string[][]).push([...args]);
      if (args.includes("--paginate")) {
        return [
          JSON.stringify({ id: "3", name: "z.md", type: "blob", path: ".review/rules/z.md", mode: "100644" }),
          JSON.stringify({ id: "1", name: "nested", type: "tree", path: ".review/rules/nested", mode: "040000" }),
          JSON.stringify({ id: "2", name: "a rule.md", type: "blob", path: ".review/rules/a rule.md", mode: "100644" }),
          JSON.stringify({ id: "4", name: "link.md", type: "blob", path: ".review/rules/link.md", mode: "120000" }),
          JSON.stringify({ id: "5", name: "module.md", type: "commit", path: ".review/rules/module.md", mode: "160000" }),
          JSON.stringify({ id: "6", name: "notes.txt", type: "blob", path: ".review/rules/notes.txt", mode: "100644" }),
          JSON.stringify({ id: "7", name: "deep.md", type: "blob", path: ".review/rules/nested/deep.md", mode: "100644" }),
          "",
        ].join("\n");
      }
      const endpoint = args.find((arg) => arg.includes("/repository/files/"));
      const encodedPath = endpoint?.match(/repository\/files\/(.+)\/raw$/u)?.[1];
      const path = encodedPath === undefined ? undefined : decodeURIComponent(encodedPath);
      return content.get(path ?? "") ?? "";
    });

    await expect(
      new GitLabAdapter(execGlab).getRuleFilesFromBase(
        locator(customPortRepo),
        "1111111111111111111111111111111111111111",
        ".review/rules",
      ),
    ).resolves.toEqual([
      { path: "a rule.md", content: "---\nname: α\n---\n繁體中文\n" },
      { path: "z.md", content: "plain UTF-8: café 🚀\n" },
    ]);

    expect(calls).toEqual([
      [
        "api", "--method", "GET", "--paginate", "--output", "ndjson",
        "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/repository/tree",
        "--raw-field", "path=.review/rules",
        "--raw-field", "ref=1111111111111111111111111111111111111111",
        "--field", "per_page=100",
      ],
      [
        "api", "--method", "GET", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/repository/files/.review%2Frules%2Fa%20rule.md/raw",
        "--raw-field", "ref=1111111111111111111111111111111111111111",
      ],
      [
        "api", "--method", "GET", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/repository/files/.review%2Frules%2Fz.md/raw",
        "--raw-field", "ref=1111111111111111111111111111111111111111",
      ],
    ]);
  });

  it("fetches files concurrently with a small cap while preserving sorted result order", async () => {
    const paths = ["f.md", "e.md", "d.md", "c.md", "b.md", "a.md"];
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      if (args.includes("--paginate")) {
        return paths
          .map((name, index) =>
            JSON.stringify({
              id: String(index),
              name,
              type: "blob",
              path: `.review/rules/${name}`,
              mode: "100644",
            }),
          )
          .join("\n");
      }

      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      const endpoint = args.find((arg) => arg.includes("/repository/files/"))!;
      const encodedPath = endpoint.match(/repository\/files\/(.+)\/raw$/u)![1]!;
      return `content:${decodeURIComponent(encodedPath)}`;
    });

    const pending = new GitLabAdapter(execGlab).getRuleFilesFromBase(
      locator(),
      "1111111111111111111111111111111111111111",
      ".review/rules",
    );
    await vi.waitFor(() => expect(maximumActive).toBeGreaterThan(1));
    expect(maximumActive).toBeLessThanOrEqual(4);

    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.pop()!();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).reverse().forEach((release) => release());

    await expect(pending).resolves.toEqual(
      ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((path) => ({
        path,
        content: `content:.review/rules/${path}`,
      })),
    );
    expect(maximumActive).toBe(4);
  });

  it("returns no rules only when the initial tree listing is missing", async () => {
    const missing = new GlabCommandError("missing", { httpStatus: 404 });
    const execGlab = vi.fn<ExecGlab>().mockRejectedValue(missing);

    await expect(
      new GitLabAdapter(execGlab).getRuleFilesFromBase(
        locator(),
        "1111111111111111111111111111111111111111",
        ".review/rules",
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    ["listed file 404", new GlabCommandError("missing file", { httpStatus: 404 })],
    ["authentication", new GlabCommandError("auth", { httpStatus: 401 })],
    ["permission", new GlabCommandError("forbidden", { httpStatus: 403 })],
  ])("rejects %s failures", async (_name, failure) => {
    const execGlab = vi.fn<ExecGlab>()
      .mockResolvedValueOnce(
        JSON.stringify({ id: "1", name: "rule.md", type: "blob", path: ".review/rules/rule.md", mode: "100644" }),
      )
      .mockRejectedValueOnce(failure);

    await expect(
      new GitLabAdapter(execGlab).getRuleFilesFromBase(
        locator(),
        "1111111111111111111111111111111111111111",
        ".review/rules",
      ),
    ).rejects.toBe(failure);
  });

  it.each([
    ["malformed NDJSON", "not-json"],
    ["non-object record", "[]"],
    ["missing path", JSON.stringify({ id: "1", name: "rule.md", type: "blob", mode: "100644" })],
    ["malformed type", JSON.stringify({ id: "1", name: "rule.md", type: 4, path: ".review/rules/rule.md", mode: "100644" })],
  ])("rejects %s tree output", async (_name, stdout) => {
    const adapter = new GitLabAdapter(async () => stdout);
    await expect(
      adapter.getRuleFilesFromBase(
        locator(),
        "1111111111111111111111111111111111111111",
        ".review/rules",
      ),
    ).rejects.toBeInstanceOf(GlabOutputError);
  });

  it("does not convert non-404 tree failures into an empty directory", async () => {
    const failure = new GlabCommandError("forbidden", { httpStatus: 403 });
    await expect(
      new GitLabAdapter(async () => { throw failure; }).getRuleFilesFromBase(
        locator(),
        "1111111111111111111111111111111111111111",
        ".review/rules",
      ),
    ).rejects.toBe(failure);
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
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const end = vi.spyOn(stdin, "end");
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
      return { stdin };
    }) as typeof execFile);

    await expect(realExecGlab(["api", "user"], "secret stdin")).resolves.toBe("ok\n");
    expect(end).toHaveBeenCalledWith("secret stdin", expect.any(Function));
  });

  it("maps an early stdin EPIPE into one sanitized typed rejection even if the callback later succeeds", async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write EPIPE TOKEN=secret"), { code: "EPIPE" }));
      },
    });
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      setImmediate(() => callback(null, "late success", ""));
      return { stdin };
    }) as typeof execFile);

    const error = await realExecGlab(
      ["api", "--hostname", "gitlab.example.com", "projects/x"],
      "sensitive body",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GlabCommandError);
    expect(error).toMatchObject({ stderr: "", exitCode: undefined });
    expect((error as Error).message).toMatch(/write input.*gitlab\.example\.com/i);
    expect((error as Error).message).not.toContain("TOKEN=secret");
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("prefers a later API process failure over an earlier stdin EPIPE", async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write EPIPE TOKEN=stdin-secret"), { code: "EPIPE" }));
      },
    });
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error, stdout: string, stderr: string) => void,
    ) => {
      setImmediate(() =>
        callback(
          Object.assign(new Error("process TOKEN=process-secret"), { code: 1 }),
          "",
          "request failed\nHTTP 403\n",
        ),
      );
      return { stdin };
    }) as typeof execFile);

    const error = await realExecGlab(
      ["api", "--hostname", "gitlab.example.com", "projects/x"],
      "sensitive body",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GlabCommandError);
    expect(error).toMatchObject({
      exitCode: 1,
      httpStatus: 403,
      stderr: "request failed\nHTTP 403\n",
    });
    expect((error as Error).message).toMatch(/command failed.*gitlab\.example\.com/i);
    expect((error as Error).message).not.toMatch(/stdin-secret|process-secret/);
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
