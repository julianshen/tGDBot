import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ConcurrentGitLabMutationError,
  decodeNdjsonRecords,
  GitLabAdapter,
  GlabCommandError,
  GlabOutputError,
  projectEndpoint,
  realExecGlab,
  type ExecGlab,
} from "../../../src/vcs/gitlab-adapter.js";
import { GitHubAdapter } from "../../../src/vcs/github-adapter.js";
import type { GitLabRepositoryRef } from "../../../src/target/types.js";
import type { InlineReviewComment } from "../../../src/vcs/adapter.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import {
  computeContentDigest,
  computeRepositoryDigest,
  formatChildMarker,
} from "../../../src/conversation/markers.js";
import type { ReviewActivityEvent, ReviewEventCursor } from "../../../src/vcs/conversation-adapter.js";
import type { ReviewIdentity } from "../../../src/conversation/types.js";

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
const openMrsFixturePath = fileURLToPath(new URL("../../fixtures/glab-open-mrs.jsonl", import.meta.url));
const openMrsFixture = await readFile(openMrsFixturePath, "utf8");
const activityFixturePath = fileURLToPath(new URL("../../fixtures/glab-review-activity.jsonl", import.meta.url));
const activityFixture = await readFile(activityFixturePath, "utf8");
const githubActivityPath = fileURLToPath(new URL("../../fixtures/gh-review-activity.json", import.meta.url));
const githubThreadsPath = fileURLToPath(new URL("../../fixtures/gh-review-threads.json", import.meta.url));
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

  it("rebuilds a unified incremental diff from the repository compare API", async () => {
    const fromSha = "c".repeat(40);
    const toSha = "d".repeat(40);
    const hunk = "@@ -1,1 +1,2 @@\n keep\n+added\n";
    const execGlab = vi.fn<ExecGlab>().mockResolvedValue(JSON.stringify({
      diffs: [{
        old_path: "src/other.ts",
        new_path: "src/other.ts",
        new_file: false,
        deleted_file: false,
        diff: hunk,
      }],
    }));

    const diff = await new GitLabAdapter(execGlab).getCompareDiff(locator(customPortRepo), fromSha, toSha);
    expect(diff).toContain("diff --git a/src/other.ts b/src/other.ts");
    expect(diff).toContain(hunk);
    expect(execGlab).toHaveBeenCalledWith(expect.arrayContaining([
      "api",
      "--hostname",
      customPortRepo.host,
      expect.stringContaining("repository/compare"),
    ]));
    const compareArg = execGlab.mock.calls[0]?.[0].find((arg) => arg.includes("repository/compare"));
    expect(compareArg).toContain(`from=${fromSha}`);
    expect(compareArg).toContain(`to=${toSha}`);
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
    expect(result).toMatchObject([{ clientId: "finding-0", status: "posted" }]);
    expect(result[0]).toMatchObject({
      identity: {
        provider: "gitlab",
        commentId: "701",
        threadId: "discussion-1",
        url: "https://gitlab.example.com:8443/group/project/-/merge_requests/42#note_701",
      },
    });
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
    ).resolves.toMatchObject([{ clientId: "finding-0", status: "posted" }]);
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
    const startOldLine = start.type === "old" ? start.oldLine : undefined;
    const endOldLine = end.type === "old" ? end.oldLine : undefined;
    expect(payload.body).toBe("```text\nreplacement\n```");
    expect(outcomes).toMatchObject([{ clientId: "finding-range", status: "posted" }]);
    expect(payload.position.line_range).toEqual({
      start: {
        line_code: `${pathHash}_${startOldLine ?? ""}_${start.newLine}`,
        type: start.type,
        ...(startOldLine === undefined ? {} : { old_line: startOldLine }),
        new_line: start.newLine,
      },
      end: {
        line_code: `${pathHash}_${endOldLine ?? ""}_${end.newLine}`,
        type: end.type,
        ...(endOldLine === undefined ? {} : { old_line: endOldLine }),
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
    expect(outcomes).toMatchObject([
      { clientId: "finding-0", status: "posted" },
      { clientId: "finding-1", status: "failed", reason: expect.any(String) },
      { clientId: "finding-2", status: "posted" },
    ]);
    const failed = outcomes[1];
    expect(failed?.status).toBe("failed");
    if (failed?.status === "failed") {
      expect(failed.reason).not.toMatch(/TOKEN|secret|private provider/i);
    }
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
    expect(outcomes).toMatchObject([
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
    ).resolves.toMatchObject([{ clientId: added.clientId, status: "posted" }]);
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
    vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      expect(options).toMatchObject({ timeout: 5_000 });
      queueMicrotask(() => callback(null, "ok", ""));
      return { stdin: new Writable() };
    }) as unknown as typeof execFile);
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
    }) as unknown as typeof execFile);

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
    }) as unknown as typeof execFile);

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
    }) as unknown as typeof execFile);

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
    }) as unknown as typeof execFile);

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
    }) as unknown as typeof execFile);

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
      }) as unknown as typeof execFile);
      const error = await realExecGlab(sample.args).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GlabCommandError);
      expect(error).toMatchObject({ httpStatus: sample.status, stderr: sample.stderr });
      expect((error as Error).message).not.toContain(sample.stderr.trim());
    }
  });
});

describe("GitLab conversation activity", () => {
  const repo = gitlabComRepo;
  const repositoryDigest = computeRepositoryDigest("gitlab", repo.canonicalUrl);
  const review: ReviewIdentity = {
    provider: "gitlab",
    repositoryDigest,
    reviewNumber: 42,
    reviewId: "4200",
    url: `${repo.canonicalUrl}/-/merge_requests/42`,
  };
  const HEAD_B = "b".repeat(40);
  const HEAD_A = "a".repeat(40);

  const toNdjson = (rows: readonly unknown[]): string =>
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

  const activityRecords = (): Array<Record<string, unknown>> =>
    decodeNdjsonRecords<Record<string, unknown>>(activityFixture);

  const activityNotes = (): Array<Record<string, unknown>> =>
    activityRecords().filter((row) => typeof row.id === "number");

  const activityDiscussions = (): Array<Record<string, unknown>> =>
    activityRecords().filter((row) => typeof row.id === "string");

  const conversationMr = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ...JSON.parse(fixture),
      id: 4200,
      iid: 42,
      web_url: review.url,
      updated_at: "2026-08-01T00:00:00Z",
      sha: HEAD_B,
      diff_refs: {
        base_sha: "c".repeat(40),
        head_sha: HEAD_B,
        start_sha: "0".repeat(40),
      },
      ...overrides,
    });

  const field = (args: readonly string[], name: string): string | undefined => {
    const index = args.findIndex((arg, i) => arg === "--field" && args[i + 1]?.startsWith(`${name}=`));
    return index >= 0 ? args[index + 1]!.slice(name.length + 1) : undefined;
  };

  const activityExec = (
    notes = activityNotes(),
    discussions = activityDiscussions(),
    mr = conversationMr(),
  ) =>
    vi.fn<ExecGlab>(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "Octo-Bot" });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/merge_requests")) {
        return openMrsFixture;
      }
      if (endpoint?.match(/merge_requests\/\d+$/u)) return mr;
      if (endpoint?.endsWith("/award_emoji")) return "";
      const perPage = Number(field(args, "per_page") ?? "100");
      const page = Number(field(args, "page") ?? "1");
      if (endpoint?.includes("/notes") && !endpoint.includes("/discussions")) {
        return toNdjson(notes.slice((page - 1) * perPage, page * perPage));
      }
      if (endpoint?.includes("/discussions/")) {
        const id = decodeURIComponent(endpoint.slice(endpoint.lastIndexOf("/") + 1));
        const match = discussions.find((row) => row.id === id);
        return JSON.stringify(match ?? {});
      }
      if (endpoint?.includes("/discussions")) {
        return toNdjson(discussions.slice((page - 1) * perPage, page * perPage));
      }
      throw new Error(`unexpected glab invocation: ${args.join(" ")}`);
    });

  it("evicts a failed authenticated identity lookup and normalizes the retry", async () => {
    const execGlab = vi.fn<ExecGlab>()
      .mockRejectedValueOnce(new Error("expired token"))
      .mockResolvedValueOnce(JSON.stringify({ username: "Octo-Bot" }));
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.getAuthenticatedBotIdentity()).rejects.toThrow(/expired token/);
    await expect(adapter.getAuthenticatedBotIdentity()).resolves.toEqual({
      provider: "gitlab", login: "octo-bot", mention: "@octo-bot",
    });
    expect(execGlab).toHaveBeenCalledTimes(2);
    expect(execGlab).toHaveBeenLastCalledWith(["api", "user", "--hostname", "gitlab.com"]);
  });

  it("lists a stable explicit page of open MRs and emits bound cursors", async () => {
    const execGlab = activityExec();
    const adapter = new GitLabAdapter(execGlab, repo);
    const page = await adapter.listOpenReviews({ provider: "gitlab", repositoryDigest });
    expect(page.reviews.map((item) => item.identity.reviewId)).toEqual(["3", "12"]);
    expect(page.nextCursor).toMatchObject({ scope: "open-review-discovery", provider: "gitlab", repositoryDigest });
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "GET", "--output", "ndjson",
      "--hostname", "gitlab.com",
      "projects/group%2Fsubgroup%2Fproject/merge_requests",
      "--field", "state=all",
      "--field", "order_by=created_at",
      "--field", "sort=asc",
      "--field", "per_page=100",
      "--field", "page=1",
    ]);
  });

  it("bounds open review discovery memory while scanning immutable provider pages", async () => {
    const template = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture)[0]!;
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...template, id: index + 1, iid: index + 1,
      web_url: `${repo.canonicalUrl}/-/merge_requests/${index + 1}`,
    }));
    const execGlab = vi.fn<ExecGlab>(async (args) => field(args, "page") === "1" ? toNdjson(rows) : "");
    const adapter = new GitLabAdapter(execGlab, repo);
    const first = await adapter.listOpenReviews({ provider: "gitlab", repositoryDigest });
    expect(first.reviews).toHaveLength(100);
    expect(execGlab).toHaveBeenLastCalledWith(expect.arrayContaining(["--field", "page=2"]));
    expect(execGlab.mock.calls.flatMap(([args]) => [...args])).not.toContain("--paginate");
  });

  it("discovers an old MR updated after the cursor and includes unseen equal-time identities", async () => {
    const rows = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture);
    rows[0]!.updated_at = "2026-08-13T10:00:00Z";
    rows[1]!.updated_at = "2026-08-12T10:00:00Z";
    const adapter = new GitLabAdapter(vi.fn<ExecGlab>().mockResolvedValue(toNdjson(rows)), repo);
    const page = await adapter.listOpenReviews(
      { provider: "gitlab", repositoryDigest },
      { scope: "open-review-discovery", provider: "gitlab", repositoryDigest, opaque: JSON.stringify({ at: "2026-08-12T10:00:00Z", seen: [] }), orderKey: "2026-08-12T10:00:00Z" },
    );
    expect(page.reviews.map((item) => item.identity.reviewId)).toEqual(["12", "3"]);
    expect(JSON.parse(page.nextCursor!.opaque)).toMatchObject({ at: "2026-08-13T10:00:00.000Z", seen: [], cutoff: expect.any(String) });
  });

  it("replays the same MR at the inclusive updated-time boundary even when its ID was seen", async () => {
    const rows = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture);
    rows[0]!.updated_at = "2026-08-12T10:00:00Z";
    const adapter = new GitLabAdapter(vi.fn<ExecGlab>().mockResolvedValue(toNdjson([rows[0]])), repo);
    const page = await adapter.listOpenReviews(
      { provider: "gitlab", repositoryDigest },
      { scope: "open-review-discovery", provider: "gitlab", repositoryDigest,
        opaque: JSON.stringify({ at: "2026-08-12T10:00:00Z", seen: ["3"] }), orderKey: "2026-08-12T10:00:00Z" },
    );
    expect(page.reviews.map((item) => item.identity.reviewId)).toEqual(["3"]);
  });

  it("retries a torn open-review snapshot and filters closed rows only after verification", async () => {
    const template = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture)[0]!;
    const open = { ...template, id: 1, iid: 1, web_url: `${repo.canonicalUrl}/-/merge_requests/1` };
    const closed = { ...template, id: 2, iid: 2, state: "closed", web_url: `${repo.canonicalUrl}/-/merge_requests/2` };
    let completeScans = 0;
    const execGlab = vi.fn<ExecGlab>(async () => {
      completeScans += 1;
      if (completeScans === 1) return toNdjson([open]);
      return toNdjson([open, closed]);
    });
    const page = await new GitLabAdapter(execGlab, repo).listOpenReviews({ provider: "gitlab", repositoryDigest });
    expect(page.reviews.map((entry) => entry.identity.reviewId)).toEqual(["1"]);
    expect(execGlab).toHaveBeenCalledTimes(4);
    expect(execGlab.mock.calls[0]![0]).toEqual(expect.arrayContaining(["--field", "state=all"]));
  });

  it("fails closed when every verified open-review snapshot pair changes", async () => {
    const template = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture)[0]!;
    let sequence = 0;
    const execGlab = vi.fn<ExecGlab>(async () => {
      sequence += 1;
      return toNdjson([{ ...template, id: sequence, iid: sequence, web_url: `${repo.canonicalUrl}/-/merge_requests/${sequence}` }]);
    });
    await expect(new GitLabAdapter(execGlab, repo).listOpenReviews({ provider: "gitlab", repositoryDigest })).rejects.toBeInstanceOf(ConcurrentGitLabMutationError);
    expect(execGlab).toHaveBeenCalledTimes(6);
  });

  it("continues 250 equal-time open reviews with a compact snapshot-bound token", async () => {
    const template = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture)[0]!;
    const rows = Array.from({ length: 250 }, (_, index) => ({
      ...template, id: index + 1, iid: index + 1,
      updated_at: "2026-08-12T10:00:00Z",
      web_url: `${repo.canonicalUrl}/-/merge_requests/${index + 1}`,
    }));
    const execGlab = vi.fn<ExecGlab>(async (args) => {
      const page = Number(field(args, "page") ?? "1");
      return toNdjson(rows.slice((page - 1) * 100, page * 100));
    });
    const adapter = new GitLabAdapter(execGlab, repo);
    const found: string[] = [];
    let token: import("../../../src/vcs/conversation-adapter.js").OpenReviewPageToken | undefined;
    do {
      const page = await adapter.listOpenReviews({ provider: "gitlab", repositoryDigest }, undefined, token);
      found.push(...page.reviews.map((entry) => entry.identity.reviewId));
      token = page.nextPageToken;
      if (token) expect(Buffer.byteLength(token.opaque)).toBeLessThan(4_000);
    } while (token);
    expect(found).toEqual(rows.map((row) => String(row.id)));
  });

  it("rejects a continuation whose cutoff was altered without its checksum", async () => {
    const template = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture)[0]!;
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...template, id: index + 1, iid: index + 1,
      updated_at: "2026-08-12T10:00:00Z",
      web_url: `${repo.canonicalUrl}/-/merge_requests/${index + 1}`,
    }));
    const execGlab = vi.fn<ExecGlab>(async (args) => toNdjson(field(args, "page") === "1" ? rows.slice(0, 100) : rows.slice(100)));
    const adapter = new GitLabAdapter(execGlab, repo);
    const first = await adapter.listOpenReviews({ provider: "gitlab", repositoryDigest });
    const token = JSON.parse(first.nextPageToken!.opaque) as Record<string, unknown>;
    token.cutoff = `${String(token.cutoff)}-tampered`;
    await expect(adapter.listOpenReviews({ provider: "gitlab", repositoryDigest }, undefined, { ...first.nextPageToken!, opaque: JSON.stringify(token) })).rejects.toThrow(/checksum/i);
  });

  it("records a compact terminal cutoff so a completed equal-time tie does not replay forever", async () => {
    const template = decodeNdjsonRecords<Record<string, unknown>>(openMrsFixture)[0]!;
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...template, id: index + 1, iid: index + 1,
      updated_at: "2026-08-12T10:00:00Z",
      web_url: `${repo.canonicalUrl}/-/merge_requests/${index + 1}`,
    }));
    const execGlab = vi.fn<ExecGlab>(async (args) => toNdjson(field(args, "page") === "1" ? rows.slice(0, 100) : rows.slice(100)));
    const adapter = new GitLabAdapter(execGlab, repo);
    const first = await adapter.listOpenReviews({ provider: "gitlab", repositoryDigest });
    const last = await adapter.listOpenReviews({ provider: "gitlab", repositoryDigest }, undefined, first.nextPageToken);
    expect(JSON.parse(last.nextCursor!.opaque)).toMatchObject({ at: "2026-08-12T10:00:00.000Z", cutoff: expect.any(String) });
    await expect(adapter.listOpenReviews({ provider: "gitlab", repositoryDigest }, last.nextCursor)).resolves.toMatchObject({ reviews: [] });
  });

  it("normalizes notes and discussions in total updated-time order, including edits", async () => {
    const execGlab = activityExec();
    const events = await new GitLabAdapter(execGlab, repo).listReviewEvents(review);
    expect(events.events.map((event) => [event.kind, event.commentId, event.authorIsBot])).toEqual([
      ["thread-resolution", undefined, undefined], ["comment-edit", "7", false], ["thread-comment", "8", true],
    ]);
    expect(events.events[2]).toMatchObject({
      threadId: "T1",
      placement: { file: "src/a.ts", line: 4, side: "new", outdated: false, originalHeadSha: HEAD_A, currentHeadSha: HEAD_B },
    });
    expect(events.nextCursor).toMatchObject({ scope: "review-events", reviewNumber: 42 });
    expect(execGlab.mock.calls.filter(([args]) => args.includes("per_page=50"))).toHaveLength(2);
    expect(execGlab.mock.calls.flatMap(([args]) => [...args])).not.toContain("--paginate");
  });

  it("keeps an unseen changed revision at the same cursor timestamp regardless of digest order", async () => {
    const notes = activityNotes();
    notes[0]!.body = "changed again";
    const execGlab = activityExec(notes);
    const cursor = {
      scope: "review-events" as const, provider: "gitlab" as const, repositoryDigest, reviewNumber: 42,
      opaque: JSON.stringify({ at: "2026-08-02T00:00:00Z", seen: ["deadbeef"] }), orderKey: "2026-08-02T00:00:00Z",
    };
    const page = await new GitLabAdapter(execGlab, repo).listReviewEvents(review, cursor);
    expect(page.events).toHaveLength(2);
    expect(page.events[0]!.updatedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("never regresses an event high-water when a traversal observes only older rows", async () => {
    const execGlab = activityExec();
    const boundary = { at: "2027-01-01T00:00:00.000Z", seen: [] as string[] };
    const cursor = { scope: "review-events" as const, provider: "gitlab" as const, repositoryDigest, reviewNumber: 42, opaque: JSON.stringify(boundary), orderKey: boundary.at };
    let token: import("../../../src/vcs/conversation-adapter.js").ReviewEventPageToken | undefined;
    let last: ReviewEventCursor = cursor;
    do {
      const page = await new GitLabAdapter(execGlab, repo).listReviewEvents(review, cursor, token);
      expect(page.events).toHaveLength(0);
      expect(page.nextCursor.orderKey).toBe(boundary.at);
      last = page.nextCursor;
      token = page.nextPageToken;
    } while (token);
    expect(JSON.parse(last.opaque)).toEqual(boundary);
  });

  it("emits resolved and reopened thread snapshot revisions without a new comment", async () => {
    const discussions = activityDiscussions();
    let mrUpdated = "2026-08-03T00:00:00Z";
    const execGlab = vi.fn<ExecGlab>(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "octo-bot" });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.match(/merge_requests\/\d+$/u)) return conversationMr({ updated_at: mrUpdated });
      if (endpoint?.includes("/notes") && !endpoint.includes("/discussions")) return toNdjson(activityNotes());
      if (endpoint?.includes("/discussions")) return toNdjson(discussions);
      throw new Error(`unexpected glab invocation: ${args.join(" ")}`);
    });
    const adapter = new GitLabAdapter(execGlab, repo);
    const first = await adapter.listReviewEvents(review);
    const firstNote = (discussions[0]!.notes as Array<Record<string, unknown>>)[0]!;
    firstNote.resolved = true;
    mrUpdated = "2026-08-04T00:00:00Z";
    const resolved = await adapter.listReviewEvents(review, first.nextCursor);
    expect(resolved.events).toMatchObject([{ kind: "thread-resolution", threadId: "T1", resolved: true, updatedAt: "2026-08-04T00:00:00.000Z" }]);
    firstNote.resolved = false;
    mrUpdated = "2026-08-05T00:00:00Z";
    const reopened = await adapter.listReviewEvents(review, resolved.nextCursor);
    expect(reopened.events).toMatchObject([{ kind: "thread-resolution", threadId: "T1", resolved: false, updatedAt: "2026-08-05T00:00:00.000Z" }]);
  });

  it("pages an interleaved notes-and-discussions activity traversal with bounded exact continuation state", async () => {
    const at = (index: number) => new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
    const noteRows = Array.from({ length: 120 }, (_, index) => ({
      id: 1000 + index, body: `note-${index}`, author: { username: "alice" },
      created_at: at(index), updated_at: at(index), type: null, system: false,
    }));
    const discussions = Array.from({ length: 120 }, (_, index) => ({
      id: `T${index}`, individual_note: false,
      notes: [{
        id: 2000 + index, body: `inline-${index}`, author: { username: "bob" },
        created_at: at(index), updated_at: at(index), type: "DiffNote", system: false,
        resolvable: true, resolved: index % 2 === 0,
        position: {
          position_type: "text", new_path: `src/${index}.ts`, old_path: `src/${index}.ts`,
          new_line: 1, old_line: 1, head_sha: HEAD_A,
        },
      }],
    }));
    const execGlab = vi.fn<ExecGlab>(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "octo-bot" });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.match(/merge_requests\/\d+$/u)) return conversationMr({ updated_at: "2026-09-01T00:00:00Z" });
      const page = Number(field(args, "page") ?? "1");
      if (endpoint?.includes("/notes") && !endpoint.includes("/discussions")) {
        return toNdjson(noteRows.slice((page - 1) * 50, page * 50));
      }
      return toNdjson(discussions.slice((page - 1) * 100, page * 100));
    });
    const adapter = new GitLabAdapter(execGlab, repo);
    const found = new Set<string>();
    let token: import("../../../src/vcs/conversation-adapter.js").ReviewEventPageToken | undefined;
    do {
      const page = await adapter.listReviewEvents(review, undefined, token);
      expect(page.events.length).toBeLessThanOrEqual(100);
      for (const event of page.events) {
        const key = `${event.eventId}:${event.revisionId}`;
        expect(found.has(key)).toBe(false);
        found.add(key);
      }
      token = page.nextPageToken;
    } while (token);
    expect(found.size).toBe(360);
    expect(execGlab.mock.calls.flatMap(([args]) => [...args])).not.toContain("--paginate");
  });

  it("continues 300 equal-time activity revisions and terminally advances without starvation", async () => {
    const at = "2026-08-12T10:00:00Z";
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: index + 1, body: `note-${index}`, author: { username: "alice" },
      created_at: at, updated_at: at, type: null, system: false,
    }));
    const execGlab = vi.fn<ExecGlab>(async (args) => {
      if (args[1] === "user") return JSON.stringify({ username: "octo-bot" });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.match(/merge_requests\/\d+$/u)) return conversationMr({ updated_at: at });
      if (endpoint?.includes("/discussions")) return "";
      const page = Number(field(args, "page") ?? "1");
      return toNdjson(rows.slice((page - 1) * 50, page * 50));
    });
    const adapter = new GitLabAdapter(execGlab, repo);
    const found: string[] = [];
    let token: import("../../../src/vcs/conversation-adapter.js").ReviewEventPageToken | undefined;
    let terminal: import("../../../src/vcs/conversation-adapter.js").ReviewEventCursor | undefined;
    do {
      const page = await adapter.listReviewEvents(review, undefined, token);
      found.push(...page.events.map((event) => `${event.eventId}:${event.revisionId}`));
      token = page.nextPageToken;
      terminal = page.nextCursor;
      if (token) expect(Buffer.byteLength(token.opaque)).toBeLessThan(4_000);
    } while (token);
    expect(found).toHaveLength(300);
    expect(new Set(found)).toHaveLength(300);
    await expect(adapter.listReviewEvents(review, terminal)).resolves.toMatchObject({ events: [] });
  });

  it("resolves the merge request database id as reviewId", async () => {
    const execGlab = vi.fn<ExecGlab>().mockResolvedValue(conversationMr());
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.resolveReviewIdentity(repo, 42)).resolves.toEqual({
      provider: "gitlab",
      repositoryDigest,
      reviewNumber: 42,
      reviewId: "4200",
      url: review.url,
    });
    expect("4200").not.toBe("42");
    expect(repositoryDigest).toBe(computeRepositoryDigest("gitlab", repo.canonicalUrl));
  });

  it("resolves one discussion through PUT resolved:true", async () => {
    const execGlab = vi.fn<ExecGlab>(async () => "");
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.resolveReviewThread(review, "T1")).resolves.toBeUndefined();
    expect(execGlab).toHaveBeenCalledWith(
      expect.arrayContaining([
        "api", "--method", "PUT", "--hostname", "gitlab.com",
        expect.stringContaining("/discussions/T1"),
      ]),
      JSON.stringify({ resolved: true }),
    );
  });

  it("pages discussion thread summaries and can fetch a complete addressed thread", async () => {
    const execGlab = activityExec();
    const adapter = new GitLabAdapter(execGlab, repo);
    const page = await adapter.listReviewThreads(review);
    expect(page.threads[0]).toMatchObject({
      threadId: "T1", rootCommentId: "8", outdated: false, resolved: false,
      placement: { file: "src/a.ts", line: 4, side: "new", outdated: false, originalHeadSha: HEAD_A, currentHeadSha: HEAD_B },
    });
    const snapshot = await adapter.getReviewThread(review, "T1");
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ kind: "thread-comment", threadId: "T1", commentId: "8" });
  });

  it("normalizes human thumbs-up award emoji on discussion notes", async () => {
    const fallback = activityExec();
    const execGlab = vi.fn<ExecGlab>(async (args, stdin) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/merge_requests/42/notes/8/award_emoji")) {
        return toNdjson([{
          id: 77,
          name: "thumbsup",
          user: { username: "alice" },
          created_at: "2026-08-01T00:01:00Z",
        }]);
      }
      return fallback(args, stdin);
    });
    const snapshot = await new GitLabAdapter(execGlab, repo)
      .getReviewThread(review, "T1");

    expect(snapshot.events[0]?.reactions).toEqual([{
      id: "77",
      content: "thumbs-up",
      authorLogin: "alice",
      authorIsBot: false,
      createdAt: "2026-08-01T00:01:00.000Z",
    }]);
    expect(execGlab.mock.calls.some(([args]) =>
      (args as string[]).some((arg) => arg.endsWith("/merge_requests/42/notes/8/award_emoji"))))
      .toBe(true);
  });

  it("retains a bounded reaction subset when a discussion note has more than 100 thumbs-up awards", async () => {
    const fallback = activityExec();
    const awards = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: "thumbsup",
      user: { username: `user-${index}` },
      created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    }));
    const execGlab = vi.fn<ExecGlab>(async (args, stdin) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/merge_requests/42/notes/8/award_emoji")) {
        const page = Number(field(args, "page") ?? "1");
        return toNdjson(awards.slice((page - 1) * 100, page * 100));
      }
      return fallback(args, stdin);
    });

    const snapshot = await new GitLabAdapter(execGlab, repo).getReviewThread(review, "T1");

    expect(snapshot.events[0]?.reactions).toHaveLength(100);
    expect(snapshot.events[0]?.reactions?.[0]?.id).toBe("1");
    expect(execGlab.mock.calls.filter(([args]) =>
      (args as string[]).some((arg) => arg.endsWith("/merge_requests/42/notes/8/award_emoji"))))
      .toHaveLength(1);
  });

  it("bounds concurrent reaction requests for bot-authored discussion notes", async () => {
    const discussions = JSON.parse(JSON.stringify(activityDiscussions())) as Array<Record<string, unknown>>;
    const discussion = discussions[0]!;
    const template = (discussion.notes as Array<Record<string, unknown>>)[0]!;
    discussion.notes = Array.from({ length: 9 }, (_, index) => ({ ...template, id: 800 + index }));
    const fallback = activityExec(activityNotes(), discussions);
    let active = 0;
    let peak = 0;
    const execGlab = vi.fn<ExecGlab>(async (args, stdin) => {
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.endsWith("/award_emoji")) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return "";
      }
      return fallback(args, stdin);
    });

    await new GitLabAdapter(execGlab, repo).getReviewThread(review, "T1");

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("keeps a still-applicable thread current when only the review head moved", async () => {
    const execGlab = activityExec();
    const page = await new GitLabAdapter(execGlab, repo).listReviewThreads(review);
    expect(page.threads[0]!.outdated).toBe(false);
    expect(page.threads[0]!.placement).toMatchObject({
      file: "src/a.ts", line: 4, side: "new", outdated: false, originalHeadSha: HEAD_A, currentHeadSha: HEAD_B,
    });
    expect(HEAD_A).not.toBe(HEAD_B);
  });

  it("honors an explicit GitLab outdated flag independently of head SHAs", async () => {
    const discussions = activityDiscussions();
    const note = (discussions[0]!.notes as Array<Record<string, unknown>>)[0]!;
    note.outdated = true;
    const execGlab = activityExec(activityNotes(), discussions);
    await expect(new GitLabAdapter(execGlab, repo).listReviewThreads(review)).resolves.toMatchObject({
      threads: [{ outdated: true, placement: { outdated: true, originalHeadSha: HEAD_A, currentHeadSha: HEAD_B } }],
    });
  });

  it("fails closed when a discussion position new_path contains a control character", async () => {
    const discussions = activityDiscussions();
    const note = (discussions[0]!.notes as Array<Record<string, unknown>>)[0]!;
    const position = { ...(note.position as Record<string, unknown>), new_path: "src/a.ts\u0000evil" };
    note.position = position;
    const execGlab = activityExec(activityNotes(), discussions);
    await expect(new GitLabAdapter(execGlab, repo).listReviewThreads(review)).rejects.toBeInstanceOf(GlabOutputError);
    await expect(new GitLabAdapter(execGlab, repo).listReviewThreads(review)).rejects.toThrow(/note path/i);
  });

  it.each([
    ["missing original head", (position: Record<string, unknown>) => { delete position.head_sha; }, /originalHeadSha/i],
    ["heads equal to the current MR SHA", (position: Record<string, unknown>) => { position.head_sha = HEAD_B; }, /heads must differ/i],
  ])("fails closed when a provider-outdated placement has %s", async (_name, mutate, expected) => {
    const discussions = activityDiscussions();
    const note = (discussions[0]!.notes as Array<Record<string, unknown>>)[0]!;
    note.outdated = true;
    const position = { ...(note.position as Record<string, unknown>) };
    mutate(position);
    note.position = position;
    const execGlab = activityExec(activityNotes(), discussions);
    await expect(new GitLabAdapter(execGlab, repo).listReviewThreads(review)).rejects.toThrow(expected);
  });

  it("rejects a non-decimal GitLab thread page token", async () => {
    const adapter = new GitLabAdapter(activityExec(), repo);
    const token = {
      scope: "review-thread-page" as const,
      provider: "gitlab" as const,
      repositoryDigest,
      reviewNumber: 42,
      opaque: "01",
    };
    await expect(adapter.listReviewThreads(review, token)).rejects.toThrow(/page token/i);
  });

  it("normalizes a nullable FILE discussion without a line", async () => {
    const discussions = activityDiscussions();
    const note = (discussions[0]!.notes as Array<Record<string, unknown>>)[0]!;
    note.position = {
      position_type: "file", new_path: "src/a.ts", old_path: "src/a.ts",
      new_line: null, old_line: null, head_sha: HEAD_A,
    };
    const execGlab = activityExec(activityNotes(), discussions);
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.listReviewThreads(review)).resolves.toMatchObject({
      threads: [{ placement: { file: "src/a.ts", side: "new", outdated: false } }],
    });
    expect((await adapter.getReviewThread(review, "T1")).placement).not.toHaveProperty("line");
  });

  it("posts replies with stdin JSON and validates the returned binding", async () => {
    const execGlab = vi.fn<ExecGlab>(async (args, stdin) => {
      if (args[1] === "user") return JSON.stringify({ username: "octo-bot" });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (args.includes("POST")) {
        const body = JSON.parse(stdin ?? "{}") as { body?: string };
        const threadReply = endpoint?.includes("/discussions/");
        return JSON.stringify({
          id: threadReply ? 10 : 9,
          body: body.body,
          author: { username: "octo-bot" },
        });
      }
      if (endpoint?.includes("/discussions/")) return JSON.stringify(activityDiscussions()[0]);
      if (endpoint?.match(/merge_requests\/\d+$/u)) return conversationMr();
      throw new Error(`unexpected glab invocation: ${args.join(" ")}`);
    });
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.postGeneralReply(review, { provider: "gitlab", repositoryDigest, reviewNumber: 42, body: "hello" })).resolves.toMatchObject({
      commentId: "9",
      url: `${review.url}#note_9`,
    });
    await expect(adapter.postThreadReply(review, { provider: "gitlab", repositoryDigest, reviewNumber: 42, threadId: "T1", parentCommentId: "8", body: "reply" })).resolves.toMatchObject({
      commentId: "10",
      threadId: "T1",
      url: `${review.url}#note_10`,
    });
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "POST", "--hostname", "gitlab.com",
      "projects/group%2Fsubgroup%2Fproject/merge_requests/42/notes", "--input", "-",
    ], JSON.stringify({ body: "hello" }));
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "POST", "--hostname", "gitlab.com",
      "projects/group%2Fsubgroup%2Fproject/merge_requests/42/discussions/T1/notes", "--input", "-",
    ], JSON.stringify({ body: "reply" }));
  });

  it("rejects a thread reply when the parent is outside the addressed discussion", async () => {
    const execGlab = activityExec();
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.postThreadReply(review, { provider: "gitlab", repositoryDigest, reviewNumber: 42, threadId: "T1", parentCommentId: "999", body: "reply" })).rejects.toThrow(/parent.*thread/i);
    expect(execGlab.mock.calls.some(([args]) => args.includes("POST"))).toBe(false);
  });

  it("posts a reply addressed to a nested comment through the discussion endpoint", async () => {
    const discussion = structuredClone(activityDiscussions()[0]!) as {
      notes: Array<Record<string, unknown>>;
    };
    discussion.notes.push({
      id: 9, body: "nested", author: { username: "alice" },
      created_at: "2026-08-01T00:00:01Z", updated_at: "2026-08-01T00:00:01Z",
      type: "DiffNote", system: false, resolvable: true, resolved: false,
    });
    const execGlab = vi.fn<ExecGlab>(async (args, stdin) => {
      if (args.includes("POST")) {
        return JSON.stringify({ id: 10, body: JSON.parse(stdin!).body, author: { username: "octo-bot" } });
      }
      if (args[1] === "user") return JSON.stringify({ username: "octo-bot" });
      const endpoint = args.find((arg) => arg.startsWith("projects/"));
      if (endpoint?.includes("/discussions/")) return JSON.stringify(discussion);
      if (endpoint?.includes("/discussions")) return toNdjson([discussion]);
      if (endpoint?.match(/merge_requests\/\d+$/u)) return conversationMr();
      return "";
    });
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.postThreadReply(review, { provider: "gitlab", repositoryDigest, reviewNumber: 42, threadId: "T1", parentCommentId: "9", body: "reply" })).resolves.toMatchObject({ commentId: "10", threadId: "T1" });
    expect(execGlab).toHaveBeenCalledWith([
      "api", "--method", "POST", "--hostname", "gitlab.com",
      "projects/group%2Fsubgroup%2Fproject/merge_requests/42/discussions/T1/notes", "--input", "-",
    ], JSON.stringify({ body: "reply" }));
  });

  it("ignores spoofed markers and rejects multiple authenticated matches", async () => {
    const visibleBody = "trusted finding";
    const contentDigest = computeContentDigest(visibleBody);
    const marker = formatChildMarker({
      kind: "finding", parentId: `act_${"a".repeat(32)}`, childId: `finding_${"b".repeat(32)}`,
      repositoryDigest, reviewNumber: 42, contentDigest,
    });
    const discussions = [
      { id: "N1", individual_note: true, notes: [{ id: 1, body: `${visibleBody}\n${marker}`, author: { username: "mallory" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", type: null, system: false, resolved: false }] },
      { id: "N2", individual_note: true, notes: [{ id: 2, body: `${visibleBody}\n${marker}`, author: { username: "octo-bot" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", type: null, system: false, resolved: false }] },
      { id: "N3", individual_note: true, notes: [{ id: 3, body: `${visibleBody}\n${marker}`, author: { username: "octo-bot" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", type: null, system: false, resolved: false }] },
    ];
    const execGlab = activityExec([], discussions);
    const adapter = new GitLabAdapter(execGlab, repo);
    await expect(adapter.findBotChildMarker(review, {
      provider: "gitlab", repositoryDigest, reviewNumber: 42, kind: "finding",
      parentId: `act_${"a".repeat(32)}`, childId: `finding_${"b".repeat(32)}`, contentDigest,
    })).rejects.toThrow(/multiple.*marker/i);
  });

  it("rejects an authenticated child marker copied onto edited visible content", async () => {
    const contentDigest = computeContentDigest("trusted");
    const expected = {
      provider: "gitlab" as const, repositoryDigest, reviewNumber: 42, kind: "finding" as const,
      parentId: `act_${"a".repeat(32)}`, childId: `finding_${"b".repeat(32)}`, contentDigest,
    };
    const marker = formatChildMarker(expected);
    const discussions = [{
      id: "N2", individual_note: true,
      notes: [{ id: 2, body: `edited\n${marker}`, author: { username: "octo-bot" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", type: null, system: false, resolved: false }],
    }];
    await expect(new GitLabAdapter(activityExec([], discussions), repo).findBotChildMarker(review, expected)).rejects.toThrow(/body digest/i);
  });

  it("findPublishedMarker recovers a child marker through findBotChildMarker", async () => {
    const visibleBody = "trusted finding";
    const contentDigest = computeContentDigest(visibleBody);
    const marker = formatChildMarker({
      kind: "finding",
      parentId: `act_${"a".repeat(32)}`,
      childId: `finding_${"b".repeat(32)}`,
      repositoryDigest,
      reviewNumber: 42,
      contentDigest,
    });
    const discussions = [{
      id: "N2",
      individual_note: true,
      notes: [{
        id: 2,
        body: `${visibleBody}\n${marker}`,
        author: { username: "octo-bot" },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
        type: null,
        system: false,
        resolved: false,
      }],
    }];
    await expect(new GitLabAdapter(activityExec([], discussions), repo).findPublishedMarker({
      kind: "repository",
      repo,
      number: 42,
    }, marker)).resolves.toMatchObject({ commentId: "2" });
  });

  it("normalizes equivalent GitHub and GitLab fixtures into core records that differ only by provider identity", async () => {
    const githubRepo = parseRepositoryRef("octo-org/octo-repo", "github");
    const githubDigest = computeRepositoryDigest("github", githubRepo.canonicalUrl);
    const githubReview: ReviewIdentity = {
      provider: "github", repositoryDigest: githubDigest, reviewNumber: 42,
      reviewId: "PR_kwDO42", url: "https://github.com/octo-org/octo-repo/pull/42",
    };
    const githubActivity = JSON.parse(await readFile(githubActivityPath, "utf8")) as { issueComments: unknown[]; reviewComments: unknown[] };
    const githubExec = vi.fn(async (args: string[]) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") return await readFile(githubThreadsPath, "utf8");
      return JSON.stringify(args.some((arg) => arg.includes("issues/42/comments")) ? githubActivity.issueComments : githubActivity.reviewComments);
    });
    const githubPage = await new GitHubAdapter(githubExec, githubRepo).listReviewEvents(githubReview);
    const gitlabPage = await new GitLabAdapter(activityExec(), repo).listReviewEvents(review);
    const core = (event: ReviewActivityEvent) => ({
      kind: event.kind,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      body: event.body,
      authorIsBot: event.authorIsBot,
      resolved: event.resolved,
      outdated: event.outdated,
      placement: event.placement === undefined ? undefined : {
        file: event.placement.file,
        line: event.placement.line,
        side: event.placement.side,
        originalHeadSha: event.placement.originalHeadSha,
        currentHeadSha: event.placement.currentHeadSha,
        outdated: event.placement.outdated,
      },
    });
    expect(gitlabPage.events.map(core)).toEqual(githubPage.events.map(core));
    expect(new Set(gitlabPage.events.map((event) => event.provider))).toEqual(new Set(["gitlab"]));
    expect(new Set(githubPage.events.map((event) => event.provider))).toEqual(new Set(["github"]));
    expect(gitlabPage.events.map((event) => event.url)).not.toEqual(githubPage.events.map((event) => event.url));
  });
});

// Issue #56: one file at one ref, the general form of the machinery
// getRuleFilesFromBase already used for rule files.
describe("GitLabAdapter.getFileAtRef", () => {
  const repo = parseRepositoryRef("https://gitlab.com/acme/app", "gitlab");
  const at = { kind: "repository" as const, repo, number: 7 };

  it("reads a file at the given ref", async () => {
    const execGlab = vi.fn<ExecGlab>(async () => '{"name":"x"}');

    const content = await new GitLabAdapter(execGlab)
      .getFileAtRef(at, "headsha", "package.json");

    expect(content).toBe('{"name":"x"}');
    expect(execGlab).toHaveBeenCalledWith(
      expect.arrayContaining([
        projectEndpoint(repo, `repository/files/${encodeURIComponent("package.json")}/raw`),
        "--raw-field",
        "ref=headsha",
      ]),
    );
  });

  it("encodes the whole path, separators included, as the API requires", async () => {
    const execGlab = vi.fn<ExecGlab>(async () => "{}");

    await new GitLabAdapter(execGlab)
      .getFileAtRef(at, "headsha", "packages/@acme/w/package.json");

    expect(execGlab).toHaveBeenCalledWith(
      expect.arrayContaining([
        projectEndpoint(
          repo,
          `repository/files/${encodeURIComponent("packages/@acme/w/package.json")}/raw`,
        ),
      ]),
    );
  });

  it("returns undefined for a path that is not there", async () => {
    const execGlab = vi.fn<ExecGlab>(async () => {
      throw new GlabCommandError("not found", { httpStatus: 404 } as never);
    });

    await expect(
      new GitLabAdapter(execGlab).getFileAtRef(at, "headsha", "nope.json"),
    ).resolves.toBeUndefined();
  });

  // An outage or an auth failure is not "the file is absent".
  it("propagates a genuine failure", async () => {
    const execGlab = vi.fn<ExecGlab>(async () => {
      throw new GlabCommandError("unauthorized", { httpStatus: 401 } as never);
    });

    await expect(
      new GitLabAdapter(execGlab).getFileAtRef(at, "headsha", "package.json"),
    ).rejects.toThrow(/unauthorized/);
  });
});
