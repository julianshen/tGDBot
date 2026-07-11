import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "../../../src/vcs/github-adapter.js";
import type { BotComment } from "../../../src/vcs/adapter.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf-8");

const PAGINATED_COMMENTS_ARGS_PREFIX = ["api", "--paginate", "-f", "per_page=100"];

/**
 * Builds an execGh mock that dispatches based on the `gh` subcommand:
 * `gh api user` (bot identity resolution) gets `userFixture`, everything
 * else (the paginated comments fetch) gets `commentsFixture`.
 */
const mockExecGhWithIdentity = (userFixture: string, commentsFixture: string) =>
  vi.fn(async (args: string[]) => {
    if (args[0] === "api" && args[1] === "user") {
      return readFixture(userFixture);
    }
    return readFixture(commentsFixture);
  });

describe("GitHubAdapter", () => {
  // AC-2.1: Given a mocked `gh pr view` response for PR 42, When
  // getPullRequest("42") is called, Then it returns a PullRequestInfo with
  // the correct headSha, baseSha, title, description parsed from that JSON.
  it("AC-2.1: getPullRequest parses headSha/baseSha/title/description from mocked gh pr view output", async () => {
    const execGh = vi.fn().mockResolvedValue(readFixture("gh-pr-view.json"));
    const adapter = new GitHubAdapter(execGh);

    const pr = await adapter.getPullRequest("42");

    expect(pr).toEqual({
      id: "42",
      headSha: "abc1234567890abc1234567890abc1234567890",
      baseSha: "def4567890def4567890def4567890def4567890",
      title: "Add feature X",
      description: "This PR adds feature X.\n\nCloses #12",
    });
    // Never calls the real gh CLI directly — always routed through execGh.
    expect(execGh).toHaveBeenCalledWith([
      "pr",
      "view",
      "42",
      "--json",
      "headRefOid,baseRefOid,title,body",
    ]);
  });

  // AC-2.2: Given a mocked comment list containing one comment authored by
  // the bot's own identity with body `<!-- tgd-review-agent:sha=abc123... -->`,
  // When findBotComment("42") is called, Then it returns that comment with
  // lastReviewedSha === "abc123...".
  it("AC-2.2: findBotComment extracts lastReviewedSha from the marker comment", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments.json");
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    expect(botComment).toEqual({
      id: "222",
      body: "## tGD Review\n\nNo blocking issues found.\n\n<!-- tgd-review-agent:sha=abc1234 -->",
      lastReviewedSha: "abc1234",
    });
    expect(execGh).toHaveBeenCalledWith([
      ...PAGINATED_COMMENTS_ARGS_PREFIX,
      "repos/{owner}/{repo}/issues/42/comments",
    ]);
  });

  // AC-2.3: Given a mocked comment list with no marker-bearing comment, When
  // findBotComment("42") is called, Then it returns null.
  it("AC-2.3: findBotComment returns null when no comment has the bot marker", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments-no-marker.json");
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    expect(botComment).toBeNull();
  });

  // AC-2.3 (edge case): an empty comment list also yields null, not a throw.
  it("AC-2.3: findBotComment returns null for an empty comment list", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return "[]";
    });
    const adapter = new GitHubAdapter(execGh);

    expect(await adapter.findBotComment("42")).toBeNull();
  });

  // AC-2.4: Given existing is null, When upsertComment("42", body, null) is
  // called, Then the adapter issues a create-comment gh invocation (not an edit).
  it("AC-2.4: upsertComment with existing=null issues a create (not an edit)", async () => {
    const execGh = vi.fn().mockResolvedValue("");
    const adapter = new GitHubAdapter(execGh);

    await adapter.upsertComment("42", "review body text", null);

    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenCalledWith(
      ["pr", "comment", "42", "--body-file", "-"],
      "review body text",
    );
    // Must never touch the `gh api .../issues/comments/{id}` edit endpoint.
    const [args] = execGh.mock.calls[0] as [string[], string?];
    expect(args).not.toContain("api");
    expect(args.join(" ")).not.toMatch(/PATCH/);
  });

  // AC-2.5: Given existing is a BotComment with id: "999", When
  // upsertComment("42", body, existing) is called, Then the adapter issues
  // an edit invocation targeting comment id 999 (never a second create).
  it("AC-2.5: upsertComment with an existing BotComment issues an edit targeting that exact comment id", async () => {
    const execGh = vi.fn().mockResolvedValue("");
    const adapter = new GitHubAdapter(execGh);
    const existing: BotComment = {
      id: "999",
      body: "<!-- tgd-review-agent:sha=old -->",
      lastReviewedSha: "old",
    };

    await adapter.upsertComment("42", "updated review body", existing);

    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenCalledWith(
      ["api", "repos/{owner}/{repo}/issues/comments/999", "-X", "PATCH", "--input", "-"],
      JSON.stringify({ body: "updated review body" }),
    );
    // Never issues a `gh pr comment` create invocation.
    const [args] = execGh.mock.calls[0] as [string[], string?];
    expect(args).not.toEqual(expect.arrayContaining(["comment"]));
  });

  // --- Review fix #1 (security): comment authorship verification ---

  it("security fix: findBotComment only matches comments from the bot's own identity (ignores a spoofed marker from another user)", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments-spoofed.json");
    const adapter = new GitHubAdapter(execGh);

    // gh-comments-spoofed.json contains a comment from "attacker" with a
    // valid-looking marker but no comment from the bot's own identity
    // ("tgd-review-agent[bot]"). An attacker on a public PR could post this
    // to trick decideDedup() into skipping review forever; the fix requires
    // the comment's author to match the authenticated `gh` identity.
    const botComment = await adapter.findBotComment("42");

    expect(botComment).toBeNull();
  });

  it("security fix: findBotComment ignores a spoofed marker comment even when the bot's genuine comment is also present", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return JSON.stringify([
        { id: 111, body: "Thanks for the PR!", user: { login: "someone-else" } },
        {
          id: 444,
          body: "<!-- tgd-review-agent:sha=spoofedsha -->",
          user: { login: "attacker" },
        },
        {
          id: 222,
          body: "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 -->",
          user: { login: "tgd-review-agent[bot]" },
        },
      ]);
    });
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    expect(botComment).toEqual({
      id: "222",
      body: "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 -->",
      lastReviewedSha: "abc1234",
    });
  });

  it("security fix: findBotComment resolves the bot identity via `gh api user`, cached across multiple calls on the same adapter", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments.json");
    const adapter = new GitHubAdapter(execGh);

    await adapter.findBotComment("42");
    await adapter.findBotComment("42");

    const userCalls = execGh.mock.calls.filter(
      ([args]) => args[0] === "api" && args[1] === "user",
    );
    expect(userCalls).toHaveLength(1);
    expect(execGh).toHaveBeenCalledWith(["api", "user"]);
  });

  // --- Review fix #2 (correctness): pagination ---

  it("correctness fix: findBotComment paginates the comment list fetch (--paginate -f per_page=100)", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments.json");
    const adapter = new GitHubAdapter(execGh);

    await adapter.findBotComment("42");

    expect(execGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "-f",
      "per_page=100",
      "repos/{owner}/{repo}/issues/42/comments",
    ]);
  });

  // --- Review fix #3 (correctness): malformed marker on the bot's own comment ---

  it("correctness fix: findBotComment returns lastReviewedSha: '' (not null) for the bot's own comment with a malformed marker SHA", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments-malformed-marker.json");
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    // The comment IS the bot's own (correct author) and DOES contain the
    // marker prefix, so it must be returned (never null, which would cause
    // upsertComment to create a duplicate) — but with an empty
    // lastReviewedSha since the SHA itself is malformed. dedup.ts's
    // decideDedup already treats a falsy lastReviewedSha as "no prior
    // review" (safe default), so no changes are needed there.
    expect(botComment).toEqual({
      id: "555",
      body: "## tGD Review\n\nNo blocking issues found.\n\n<!-- tgd-review-agent:sha=CORRUPTED!! -->",
      lastReviewedSha: "",
    });
  });

  // --- Test coverage fix (DEBT.md): "first match wins" semantics ---

  it("test coverage fix: findBotComment returns the FIRST bot-authored, marker-matching comment when multiple are present", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return JSON.stringify([
        {
          id: 111,
          body: "## tGD Review\n\n<!-- tgd-review-agent:sha=aaa1111 -->",
          user: { login: "tgd-review-agent[bot]" },
        },
        {
          id: 222,
          body: "## tGD Review\n\n<!-- tgd-review-agent:sha=bbb2222 -->",
          user: { login: "tgd-review-agent[bot]" },
        },
      ]);
    });
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    // Both comments are authored by the bot and both match the marker
    // pattern; findBotComment iterates the list in order and returns on
    // the first match, so the second (later, presumably newer) comment
    // must never win here.
    expect(botComment).toEqual({
      id: "111",
      body: "## tGD Review\n\n<!-- tgd-review-agent:sha=aaa1111 -->",
      lastReviewedSha: "aaa1111",
    });
  });

  // --- Test coverage fix (DEBT.md): malformed/non-JSON gh output ---
  //
  // Pinning tests only (no code change): JSON.parse throws synchronously
  // inside these async methods, so the returned promise rejects and the
  // rejection propagates out of findBotComment uncaught. That is the
  // correct behavior here, not an oversight — review()'s call site
  // (cli.ts) never wraps getPullRequest/findBotComment/getDiff in a
  // try/catch; per SPEC.md's exit-code contract (exit 1: "missing gh/glab
  // auth, no such PR, all rules failed to load") and cli.ts's own
  // EXIT_FATAL comment, any pre-write VCS fetch failure — including
  // unparseable `gh` output — is a fatal, pre-write condition that must
  // abort before any comment is posted, not be swallowed into a
  // partial/degraded result. main()'s outer catch-all turns this rejection
  // into a human-readable `tgd-review-agent: <message>` stderr line and
  // exit code 1, which is the desired behavior. So: pin it, don't change it.

  it("test coverage fix (pinning): findBotComment rejects when the paginated comments call returns malformed/non-JSON output", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return "not valid json{{{";
    });
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.findBotComment("42")).rejects.toThrow(SyntaxError);
  });

  it("test coverage fix (pinning): findBotComment rejects when the `gh api user` call returns malformed/non-JSON output", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return "not valid json{{{";
      return readFixture("gh-comments.json");
    });
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.findBotComment("42")).rejects.toThrow(SyntaxError);
  });

  // --- Review fix #4 (test gap): realExecGh coverage ---

  describe("realExecGh (test gap fix: real child_process.execFile-backed implementation)", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("test gap fix: realExecGh invokes `gh` with the given args unchanged and the configured maxBuffer, resolving with stdout", async () => {
      const execFileMock = vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: object,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "command output", "");
          return { stdin: { end: vi.fn() } };
        },
      );
      vi.doMock("node:child_process", () => ({ execFile: execFileMock }));

      const { realExecGh } = await import("../../../src/vcs/github-adapter.js");
      const result = await realExecGh(["pr", "view", "1"]);

      expect(result).toBe("command output");
      expect(execFileMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "view", "1"],
        { maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function),
      );
    });

    it("test gap fix: realExecGh pipes stdin to the child process for --body-file -/--input - invocations", async () => {
      const end = vi.fn();
      const execFileMock = vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: object,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
          return { stdin: { end } };
        },
      );
      vi.doMock("node:child_process", () => ({ execFile: execFileMock }));

      const { realExecGh } = await import("../../../src/vcs/github-adapter.js");
      await realExecGh(["pr", "comment", "1", "--body-file", "-"], "hello body");

      expect(end).toHaveBeenCalledWith("hello body");
    });

    it("test gap fix: realExecGh REJECTS the returned promise (not resolves with garbage) when execFile's callback receives an error", async () => {
      const boom = new Error("gh: command failed with exit code 1");
      const execFileMock = vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: object,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(boom, "", "some stderr output");
          return { stdin: { end: vi.fn() } };
        },
      );
      vi.doMock("node:child_process", () => ({ execFile: execFileMock }));

      const { realExecGh } = await import("../../../src/vcs/github-adapter.js");

      await expect(realExecGh(["pr", "view", "999"])).rejects.toBe(boom);
    });

    it("test gap fix: new GitHubAdapter() with no execGh argument defaults to realExecGh (shells out for real)", async () => {
      const execFileMock = vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: object,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, JSON.stringify({ login: "tgd-review-agent[bot]" }), "");
          return { stdin: { end: vi.fn() } };
        },
      );
      vi.doMock("node:child_process", () => ({ execFile: execFileMock }));

      const { GitHubAdapter: MockedGitHubAdapter } = await import(
        "../../../src/vcs/github-adapter.js"
      );
      const adapter = new MockedGitHubAdapter();
      // getPullRequest routes through the default (real) execGh, which in
      // turn shells out via the mocked child_process.execFile.
      await adapter.getPullRequest("1");

      expect(execFileMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "view", "1", "--json", "headRefOid,baseRefOid,title,body"],
        { maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function),
      );
    });
  });
});
