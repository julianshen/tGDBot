import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import type { InlineReviewComment } from "../../../src/vcs/adapter.js";

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
const notesFixturePath = fileURLToPath(new URL("../../fixtures/glab-notes.jsonl", import.meta.url));
const notesFixture = await readFile(notesFixturePath, "utf8");
const discussionsFixturePath = fileURLToPath(new URL("../../fixtures/glab-discussions.jsonl", import.meta.url));
const discussionsFixture = await readFile(discussionsFixturePath, "utf8");
const writtenDiscussionFixture = (body: string) => JSON.stringify({
  id: "discussion-1",
  individual_note: false,
  notes: [{ id: 701, body }],
});

const BASE_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";
const START_SHA = "0000000000000000000000000000000000000000";

const versionsFixture = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify([{
    id: 9,
    base_commit_sha: BASE_SHA,
    head_commit_sha: HEAD_SHA,
    start_commit_sha: START_SHA,
    ...overrides,
  }, {
    id: 8,
    base_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    head_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    start_commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
  }]);

function inlineComment(
  clientId: string,
  position: InlineReviewComment["position"],
  body = `body:${clientId}`,
): InlineReviewComment {
  return {
    clientId,
    path: position.newPath,
    line: position.end.newLine,
    ...(position.start.newLine === position.end.newLine
      ? {}
      : { startLine: position.start.newLine }),
    position,
    body,
  };
}

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

describe("GitLabAdapter stale discussion cleanup", () => {
  it("lists every page and resolves only own marked unresolved discussions", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const execGlab: ExecGlab = async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      if (args.includes("--paginate")) return discussionsFixture;
      return JSON.stringify({ id: "resolved" });
    };

    const count = await new GitLabAdapter(execGlab).resolveStaleReviewThreads(locator());

    expect(count).toBe(2);
    expect(calls).toEqual([
      { args: ["api", "user", "--hostname", "gitlab.example.com"], stdin: undefined },
      {
        args: [
          "api", "--method", "GET", "--paginate", "--output", "ndjson",
          "--hostname", "gitlab.example.com",
          `projects/${encodeURIComponent("group/subgroup/project")}/merge_requests/42/discussions`,
          "--field", "per_page=100",
        ],
        stdin: undefined,
      },
      {
        args: [
          "api", "--method", "PUT", "--hostname", "gitlab.example.com",
          `projects/${encodeURIComponent("group/subgroup/project")}/merge_requests/42/discussions/${encodeURIComponent("own-marked-one")}`,
          "--input", "-",
        ],
        stdin: JSON.stringify({ resolved: true }),
      },
      {
        args: [
          "api", "--method", "PUT", "--hostname", "gitlab.example.com",
          `projects/${encodeURIComponent("group/subgroup/project")}/merge_requests/42/discussions/${encodeURIComponent("own-marked.two")}`,
          "--input", "-",
        ],
        stdin: JSON.stringify({ resolved: true }),
      },
    ]);
  });

  it("warns with sanitized errors, continues after each resolve failure, and counts successes", async () => {
    let puts = 0;
    const execGlab: ExecGlab = async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      if (args.includes("--paginate")) return discussionsFixture;
      puts += 1;
      if (puts === 1) {
        throw new GlabCommandError("TOKEN=secret", {
          httpStatus: 401,
          stderr: "private TOKEN=secret",
        });
      }
      return JSON.stringify({ id: "resolved" });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(new GitLabAdapter(execGlab).resolveStaleReviewThreads(locator()))
      .resolves.toBe(1);
    expect(puts).toBe(2);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/TOKEN|secret|private/i);
    warn.mockRestore();
  });

  it("isolates plain Error PUT failures without leaking their message", async () => {
    let puts = 0;
    const execGlab: ExecGlab = async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      if (args.includes("--paginate")) return discussionsFixture;
      puts += 1;
      if (puts === 1) throw new Error("private TOKEN=secret from provider");
      return JSON.stringify({ id: "resolved" });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(new GitLabAdapter(execGlab).resolveStaleReviewThreads(locator()))
      .resolves.toBe(1);
    expect(puts).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/TOKEN|secret|private|provider/i);
    warn.mockRestore();
  });

  it.each([
    "",
    "../escape",
    "space id",
    "slash%2Fescape",
    "unicode-討論",
  ])("rejects invalid opaque discussion id %j before resolving", async (id) => {
    const execGlab: ExecGlab = async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      return JSON.stringify({
        id,
        notes: [{
          id: 1,
          body: "<!-- tgd-review-agent:inline -->",
          author: { username: "review-bot" },
          resolved: false,
        }],
      });
    };

    await expect(new GitLabAdapter(execGlab).resolveStaleReviewThreads(locator()))
      .rejects.toThrow(/discussion/i);
  });
});

describe("GitLabAdapter review summary notes", () => {
  it("caches the in-flight authenticated username once per normalized authority", async () => {
    let releaseUser!: (value: string) => void;
    const userResult = new Promise<string>((resolve) => { releaseUser = resolve; });
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      if (args[1] === "user") return userResult;
      return notesFixture;
    });
    const adapter = new GitLabAdapter(execGlab);

    const first = adapter.findBotComment(locator(customPortRepo));
    const second = adapter.findBotComment(locator({ ...customPortRepo, canonicalUrl: customPortRepo.canonicalUrl }));
    await vi.waitFor(() => {
      expect(execGlab.mock.calls.filter(([args]) => args[1] === "user")).toHaveLength(1);
    });
    releaseUser(JSON.stringify({ username: "review-bot" }));
    await Promise.all([first, second]);
  });

  it("evicts a rejected username lookup so a later call can retry successfully", async () => {
    let userAttempts = 0;
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      if (args[1] === "user") {
        userAttempts += 1;
        if (userAttempts === 1) throw new Error("temporary auth failure");
        return JSON.stringify({ username: "review-bot" });
      }
      return notesFixture;
    });
    const adapter = new GitLabAdapter(execGlab);

    await expect(adapter.findBotComment(locator(customPortRepo))).rejects.toThrow(
      "temporary auth failure",
    );
    await expect(adapter.findBotComment(locator(customPortRepo))).resolves.toMatchObject({
      id: "303",
    });
    expect(userAttempts).toBe(2);
  });

  it("keeps authenticated username caches separate across ports", async () => {
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      return notesFixture;
    });
    const adapter = new GitLabAdapter(execGlab);
    const otherPortRepo = {
      ...customPortRepo,
      port: 9443,
      canonicalUrl: "https://gitlab.example.com:9443/group/project",
    };

    await adapter.findBotComment(locator(customPortRepo));
    await adapter.findBotComment(locator(otherPortRepo));

    expect(execGlab.mock.calls.filter(([args]) => args[1] === "user")).toHaveLength(2);
  });

  it("inspects paginated NDJSON notes, ignores copied markers, and returns its own valid marker", async () => {
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      return notesFixture;
    });
    const result = await new GitLabAdapter(execGlab).findBotComment(locator(customPortRepo));

    expect(result).toEqual({
      id: "303",
      body: "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 cfg=deadbeef -->",
      lastReviewedSha: "abc1234",
      reviewedConfig: "deadbeef",
    });
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "GET", "--paginate", "--output", "ndjson",
      "--hostname", "gitlab.example.com",
      "projects/group%2Fproject/merge_requests/42/notes",
      "--field", "per_page=100",
    ]);
  });

  it("returns its own malformed marker with empty SHA/config so it is updated", async () => {
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "review-bot" });
      return JSON.stringify({
        id: 404,
        body: "review\n<!-- tgd-review-agent:sha=CORRUPTED!! -->",
        author: { username: "review-bot" },
      });
    });
    await expect(new GitLabAdapter(execGlab).findBotComment(locator())).resolves.toEqual({
      id: "404",
      body: "review\n<!-- tgd-review-agent:sha=CORRUPTED!! -->",
      lastReviewedSha: "",
      reviewedConfig: "",
    });
  });

  it("creates a note with JSON stdin and keeps markdown out of argv", async () => {
    const execGlab = vi.fn<ExecGlab>().mockResolvedValue(
      JSON.stringify({ id: 505, body: "new **markdown**" }),
    );
    const written = await new GitLabAdapter(execGlab).upsertComment(
      locator(customPortRepo), "new **markdown**", null,
    );
    expect(written).toEqual({
      id: "505",
      body: "new **markdown**",
      lastReviewedSha: "",
      reviewedConfig: "",
    });
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "POST", "--hostname", "gitlab.example.com",
      "projects/group%2Fproject/merge_requests/42/notes", "--input", "-",
    ], JSON.stringify({ body: "new **markdown**" }));
    expect(execGlab.mock.calls[0]![0]).not.toContain("new **markdown**");
  });

  it("updates the exact validated note ID with JSON stdin", async () => {
    const execGlab = vi.fn<ExecGlab>().mockResolvedValue(
      JSON.stringify({ id: 303, body: "updated" }),
    );
    const written = await new GitLabAdapter(execGlab).upsertComment(locator(customPortRepo), "updated", {
      id: "303", body: "old", lastReviewedSha: "abc1234", reviewedConfig: "",
    });
    expect(written.id).toBe("303");
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "PUT", "--hostname", "gitlab.example.com",
      "projects/group%2Fproject/merge_requests/42/notes/303", "--input", "-",
    ], JSON.stringify({ body: "updated" }));
  });

  it.each([
    ["bad existing id", "3/nope", JSON.stringify({ id: 3, body: "updated" })],
    ["bad response JSON", "303", "not json"],
    ["wrong response id", "303", JSON.stringify({ id: 999, body: "updated" })],
    ["malformed response body", "303", JSON.stringify({ id: 303, body: 7 })],
    ["mismatched response body", "303", JSON.stringify({ id: 303, body: "different" })],
  ])("rejects %s", async (_name, id, response) => {
    const adapter = new GitLabAdapter(async () => response);
    await expect(adapter.upsertComment(locator(), "updated", {
      id, body: "old", lastReviewedSha: "", reviewedConfig: "",
    })).rejects.toThrow(/note|id|response/i);
  });

  it("rejects malformed note and user records", async () => {
    const badUser = new GitLabAdapter(async () => JSON.stringify({ username: 42 }));
    await expect(badUser.findBotComment(locator())).rejects.toThrow(/username/i);

    const badNote = new GitLabAdapter(async (args) =>
      args[1] === "user"
        ? JSON.stringify({ username: "review-bot" })
        : JSON.stringify({ id: "oops", body: "x", author: { username: "review-bot" } }),
    );
    await expect(badNote.findBotComment(locator())).rejects.toThrow(/note/i);
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

describe("GitLabAdapter inline discussions", () => {
  function successfulExecutor(calls: Array<{ args: readonly string[]; stdin?: string }>): ExecGlab {
    return async (args, stdin) => {
      calls.push({ args, stdin });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        return writtenDiscussionFixture(
          (JSON.parse(stdin!) as { body: string }).body,
        );
      }
      return fixture;
    };
  }

  const added = inlineComment("finding-0", {
    oldPath: "src/new.ts",
    newPath: "src/new.ts",
    start: { type: "new", newLine: 10 },
    end: { type: "new", newLine: 10 },
    sameHunk: true,
  });

  it.each([
    ["empty", [{ ...added, clientId: "" }]],
    ["duplicate", [added, { ...added }]],
  ])("rejects %s client IDs before any external call", async (_name, comments) => {
    const execGlab = vi.fn<ExecGlab>();

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(locator(), HEAD_SHA, comments),
    ).rejects.toThrow(/unique|non-empty|clientId/i);
    expect(execGlab).not.toHaveBeenCalled();
  });

  it("preflights fresh metadata and the newest version before posting", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const result = await new GitLabAdapter(successfulExecutor(calls))
      .createInlineReview(locator(customPortRepo), HEAD_SHA, [added]);

    expect(calls.map(({ args }) => args)).toEqual([
      [
        "api", "--method", "GET", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/merge_requests/42",
      ],
      [
        "api", "--method", "GET", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/merge_requests/42/versions",
      ],
      [
        "api", "--method", "POST", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/merge_requests/42/discussions", "--input", "-",
      ],
    ]);
    expect(result).toEqual([{ clientId: "finding-0", status: "posted" }]);
  });

  it.each([
    ["empty versions", JSON.stringify([]), fixture, HEAD_SHA],
    ["malformed version base SHA", versionsFixture({ base_commit_sha: "bad" }), fixture, HEAD_SHA],
    ["malformed version head SHA", versionsFixture({ head_commit_sha: "bad" }), fixture, HEAD_SHA],
    ["malformed version start SHA", versionsFixture({ start_commit_sha: "bad" }), fixture, HEAD_SHA],
    ["metadata/version base mismatch", versionsFixture({ base_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), fixture, HEAD_SHA],
    ["metadata/version head mismatch", versionsFixture({ head_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), fixture, HEAD_SHA],
    ["metadata/version start mismatch", versionsFixture({ start_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), fixture, HEAD_SHA],
    ["caller/metadata head mismatch", versionsFixture(), fixture, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])("rejects %s before any POST", async (_name, versions, metadata, callerHead) => {
    const calls: readonly string[][] = [];
    const execGlab = vi.fn<ExecGlab>().mockImplementation(async (args) => {
      (calls as string[][]).push([...args]);
      return args.some((arg) => arg.endsWith("/versions")) ? versions : metadata;
    });

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(locator(), callerHead, [added]),
    ).rejects.toThrow();
    expect(calls.some((args) => args.includes("POST"))).toBe(false);
  });

  it("uses element zero only when selecting the newest version", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    await new GitLabAdapter(successfulExecutor(calls))
      .createInlineReview(locator(), HEAD_SHA, [added]);
    const payload = JSON.parse(calls[2]!.stdin!) as { position: Record<string, unknown> };
    expect(payload.position).toMatchObject({
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      start_sha: START_SHA,
    });
  });

  it("ignores malformed older versions after a valid newest entry", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const execGlab: ExecGlab = async (args, stdin) => {
      calls.push({ args, stdin });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) {
        return JSON.stringify([
          {
            base_commit_sha: BASE_SHA,
            head_commit_sha: HEAD_SHA,
            start_commit_sha: START_SHA,
          },
          { base_commit_sha: "malformed stale entry" },
          null,
        ]);
      }
      if (endpoint?.endsWith("/discussions")) {
        return writtenDiscussionFixture(
          (JSON.parse(stdin!) as { body: string }).body,
        );
      }
      return fixture;
    };

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(locator(), HEAD_SHA, [added]),
    ).resolves.toEqual([{ clientId: "finding-0", status: "posted" }]);
    expect(JSON.parse(calls[2]!.stdin!)).toMatchObject({
      position: {
        base_sha: BASE_SHA,
        head_sha: HEAD_SHA,
        start_sha: START_SHA,
      },
    });
  });

  it("posts exact single-line and renamed-context payloads in order", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const context = inlineComment("finding-1", {
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      start: { type: "old", oldLine: 7, newLine: 8 },
      end: { type: "old", oldLine: 7, newLine: 8 },
      sameHunk: true,
    }, "context suggestion");

    await new GitLabAdapter(successfulExecutor(calls))
      .createInlineReview(locator(customPortRepo), HEAD_SHA, [added, context]);

    const posts = calls.slice(2);
    expect(posts.map(({ args }) => args)).toEqual([
      [
        "api", "--method", "POST", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/merge_requests/42/discussions", "--input", "-",
      ],
      [
        "api", "--method", "POST", "--hostname", "gitlab.example.com",
        "projects/group%2Fproject/merge_requests/42/discussions", "--input", "-",
      ],
    ]);
    expect(JSON.parse(posts[0]!.stdin!)).toEqual({
      body: "body:finding-0",
      position: {
        base_sha: BASE_SHA,
        start_sha: START_SHA,
        head_sha: HEAD_SHA,
        position_type: "text",
        old_path: "src/new.ts",
        new_path: "src/new.ts",
        new_line: 10,
      },
    });
    expect(JSON.parse(posts[1]!.stdin!)).toEqual({
      body: "context suggestion",
      position: {
        base_sha: BASE_SHA,
        start_sha: START_SHA,
        head_sha: HEAD_SHA,
        position_type: "text",
        old_path: "src/old-name.ts",
        new_path: "src/new-name.ts",
        old_line: 7,
        new_line: 8,
      },
    });
  });

  it.each([
    [
      "added",
      { type: "new" as const, newLine: 10 },
      { type: "new" as const, newLine: 12 },
    ],
    [
      "context",
      { type: "old" as const, oldLine: 9, newLine: 10 },
      { type: "old" as const, oldLine: 11, newLine: 12 },
    ],
    [
      "mixed added-to-context",
      { type: "new" as const, newLine: 10 },
      { type: "old" as const, oldLine: 11, newLine: 12 },
    ],
    [
      "mixed context-to-added",
      { type: "old" as const, oldLine: 9, newLine: 10 },
      { type: "new" as const, newLine: 12 },
    ],
  ])("posts exact %s multi-line position", async (_name, start, end) => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const comment = inlineComment("finding-range", {
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      start,
      end,
      sameHunk: true,
    }, "```suggestion\nreplacement\n```");

    const outcomes = await new GitLabAdapter(successfulExecutor(calls))
      .createInlineReview(locator(), HEAD_SHA, [comment]);

    const payload = JSON.parse(calls[2]!.stdin!) as {
      body: string;
      position: { line_range: { start: Record<string, unknown>; end: Record<string, unknown> } };
    };
    const pathHash = createHash("sha1").update("src/new-name.ts").digest("hex");
    expect(payload.body).toBe("```text\nreplacement\n```");
    expect(outcomes).toEqual([{ clientId: "finding-range", status: "posted" }]);
    expect(payload.position.line_range).toEqual({
      start: {
        line_code: `${pathHash}_${start.oldLine ?? ""}_${start.newLine}`,
        type: start.type,
        ...(start.oldLine === undefined ? {} : { old_line: start.oldLine }),
        new_line: start.newLine,
      },
      end: {
        line_code: `${pathHash}_${end.oldLine ?? ""}_${end.newLine}`,
        type: end.type,
        ...(end.oldLine === undefined ? {} : { old_line: end.oldLine }),
        new_line: end.newLine,
      },
    });
  });

  it.each([
    ["cross-hunk", { ...added.position, sameHunk: false }],
    ["removed-side", {
      ...added.position,
      end: { type: "old", oldLine: 10, newLine: undefined },
    }],
  ])("returns a failed outcome without posting unsupported %s positions", async (_name, position) => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const comment = { ...added, clientId: `unsupported-${_name}`, position } as InlineReviewComment;
    const result = await new GitLabAdapter(successfulExecutor(calls))
      .createInlineReview(locator(), HEAD_SHA, [comment]);

    expect(result).toEqual([{
      clientId: `unsupported-${_name}`,
      status: "failed",
      reason: expect.any(String),
    }]);
    expect(calls).toHaveLength(2);
  });

  it("continues after item failures and preserves input-order outcomes", async () => {
    let posts = 0;
    const execGlab: ExecGlab = async (args, stdin) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        posts += 1;
        if (posts === 2) {
          throw new GlabCommandError("TOKEN=secret", {
            httpStatus: 422,
            stderr: "private provider response TOKEN=secret",
          });
        }
        return writtenDiscussionFixture(
          (JSON.parse(stdin!) as { body: string }).body,
        );
      }
      return fixture;
    };
    const comments = [0, 1, 2].map((index) => ({
      ...added,
      clientId: `finding-${index}`,
      body: `body-${index}`,
    }));

    const outcomes = await new GitLabAdapter(execGlab)
      .createInlineReview(locator(), HEAD_SHA, comments);
    expect(outcomes).toEqual([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed", reason: expect.any(String) },
      { clientId: "finding-2", status: "posted" },
    ]);
    expect(outcomes[1]?.reason).not.toMatch(/TOKEN|secret|private provider/i);
  });

  it.each([
    [400, "continue"],
    [409, "continue"],
    [422, "continue"],
    [401, "stop"],
    [403, "stop"],
    [404, "stop"],
    [408, "stop"],
    [429, "stop"],
    [500, "stop"],
  ] as const)("classifies HTTP %i as %s", async (status, behavior) => {
    let posts = 0;
    const execGlab: ExecGlab = async (args, stdin) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        posts += 1;
        if (posts === 1) throw new GlabCommandError("write failed", { httpStatus: status });
        return writtenDiscussionFixture(
          (JSON.parse(stdin!) as { body: string }).body,
        );
      }
      return fixture;
    };
    const comments = [0, 1].map((index) => ({
      ...added, clientId: `finding-${index}`,
    }));

    const outcomes = await new GitLabAdapter(execGlab)
      .createInlineReview(locator(), HEAD_SHA, comments);
    expect(posts).toBe(behavior === "continue" ? 2 : 1);
    expect(outcomes).toEqual([
      { clientId: "finding-0", status: "failed", reason: expect.any(String) },
      behavior === "continue"
        ? { clientId: "finding-1", status: "posted" }
        : { clientId: "finding-1", status: "failed", reason: expect.any(String) },
    ]);
  });

  it("stops on transport failures and marks every unattempted item failed", async () => {
    let posts = 0;
    const execGlab: ExecGlab = async (args) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        posts += 1;
        throw new GlabCommandError("process failed without status");
      }
      return fixture;
    };
    const comments = [0, 1, 2].map((index) => ({
      ...added, clientId: `finding-${index}`,
    }));

    const outcomes = await new GitLabAdapter(execGlab)
      .createInlineReview(locator(), HEAD_SHA, comments);
    expect(posts).toBe(1);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
  });

  it("rethrows programming errors instead of publishing them as outcomes", async () => {
    const execGlab: ExecGlab = async (args) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) throw new TypeError("programming defect");
      return fixture;
    };

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(locator(), HEAD_SHA, [added]),
    ).rejects.toThrow(TypeError);
  });

  it.each([
    ["empty discussion id", { id: "", notes: [{ id: 701, body: "posted" }] }],
    ["numeric discussion id", { id: 123, notes: [{ id: 701, body: "posted" }] }],
    ["empty notes", { id: "discussion-1", notes: [] }],
    ["malformed note id", { id: "discussion-1", notes: [{ id: 0, body: "posted" }] }],
    ["malformed note body", { id: "discussion-1", notes: [{ id: 701, body: 42 }] }],
  ])("turns a malformed POST response into failed outcomes and stops before later writes", async (_name, response) => {
    let posts = 0;
    const execGlab: ExecGlab = async (args) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        posts += 1;
        return JSON.stringify(response);
      }
      return fixture;
    };
    const comments = [added, { ...added, clientId: "finding-1" }];

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(locator(), HEAD_SHA, comments),
    ).resolves.toEqual([
      { clientId: "finding-0", status: "failed", reason: expect.any(String) },
      { clientId: "finding-1", status: "failed", reason: expect.any(String) },
    ]);
    expect(posts).toBe(1);
  });

  it("rejects a discussion response that does not contain the submitted body", async () => {
    let posts = 0;
    const execGlab: ExecGlab = async (args) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        posts += 1;
        return JSON.stringify({
          id: "discussion-1",
          notes: [{ id: 701, body: "different body" }],
        });
      }
      return fixture;
    };

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(
        locator(),
        HEAD_SHA,
        [added, { ...added, clientId: "finding-1" }],
      ),
    ).resolves.toEqual([
      { clientId: "finding-0", status: "failed", reason: expect.any(String) },
      { clientId: "finding-1", status: "failed", reason: expect.any(String) },
    ]);
    expect(posts).toBe(1);
  });

  it("accepts a discussion response containing a note with the submitted body", async () => {
    const execGlab: ExecGlab = async (args) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/versions")) return versionsFixture();
      if (endpoint?.endsWith("/discussions")) {
        return JSON.stringify({
          id: "discussion-1",
          notes: [
            { id: 700, body: "system-generated companion note" },
            { id: 701, body: added.body },
          ],
        });
      }
      return fixture;
    };

    await expect(
      new GitLabAdapter(execGlab).createInlineReview(locator(), HEAD_SHA, [added]),
    ).resolves.toEqual([{ clientId: added.clientId, status: "posted" }]);
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
  it("forwards an optional timeout to execFile", async () => {
    vi.mocked(execFile).mockImplementation(((_file, _args, options, callback) => {
      expect(options).toMatchObject({ timeout: 5_000 });
      queueMicrotask(() => callback(null, "ok", ""));
      return { stdin: new Writable() };
    }) as typeof execFile);
    await expect(realExecGlab(["issue", "view", "1"], undefined, { timeoutMs: 5_000 })).resolves.toBe("ok");
  });
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
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      message: expect.stringMatching(/output exceeded.*10 MiB/i),
      stderr: "TOKEN=secret",
    });
    await expect(realExecGlab(["mr", "diff", "42"])).rejects.not.toThrow(/TOKEN=secret/);
  });

  it("parses anchored API HTTP diagnostics but not incidental or non-API statuses", async () => {
    const errors = [
      { args: ["api", "projects/x"], stderr: "request failed\nHTTP 403\n", status: 403 },
      {
        args: ["api", "projects/x"],
        stderr: "glab: Forbidden (HTTP 403)\n{\"message\":\"details\"}\n",
        status: 403,
      },
      {
        args: ["api", "projects/x"],
        stderr: "glab: 404 Project Not Found (HTTP 404)\n",
        status: 404,
      },
      {
        args: ["api", "projects/x"],
        stderr: "glab: Bad Request (HTTP 400)\n",
        status: 400,
      },
      {
        args: ["api", "projects/x"],
        stderr: "glab: Conflict (HTTP 409)\n",
        status: 409,
      },
      {
        args: ["api", "projects/x"],
        stderr: "glab: API request failed: 422 Unprocessable Entity (HTTP 422)\n",
        status: 422,
      },
      { args: ["api", "projects/x"], stderr: "body says HTTP 418 maybe\n", status: undefined },
      {
        args: ["api", "projects/x"],
        stderr: '{"message":"user content (HTTP 409)"}\n',
        status: undefined,
      },
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
