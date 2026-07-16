import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "../../../src/vcs/github-adapter.js";
import type { BotComment } from "../../../src/vcs/adapter.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf-8");

// `-X GET` is REQUIRED here (not the implicit default) because `-f
// per_page=100` is present — see the bug-fix doc comment on findBotComment
// in src/vcs/github-adapter.ts for why `gh api` silently defaults to POST
// once any `-f`/`-F` param is passed, and the real end-to-end 422 this
// caused against `hmchangw/chat` PR #491.
const PAGINATED_COMMENTS_ARGS_PREFIX = ["api", "-X", "GET", "--paginate", "-f", "per_page=100"];

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
      // Design-review #9: the canonical PR URL carries the owner/repo `gh`
      // actually resolved; review() logs it so a mis-inferred target is visible.
      url: "https://github.com/octo-org/octo-repo/pull/42",
    });
    // Never calls the real gh CLI directly — always routed through execGh.
    expect(execGh).toHaveBeenCalledWith([
      "pr",
      "view",
      "42",
      "--json",
      "headRefOid,baseRefOid,title,body,url",
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
      reviewedConfig: "",
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
      reviewedConfig: "",
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
      reviewedConfig: "",
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
      "-X",
      "GET",
      "--paginate",
      "-f",
      "per_page=100",
      "repos/{owner}/{repo}/issues/42/comments",
    ]);
  });

  // --- Bug fix (real end-to-end run): `gh api` silently defaults to POST
  // once `-f`/`-F` params are present, even for a GET-shaped endpoint ---
  //
  // Found via a live end-to-end run against `hmchangw/chat` PR #491:
  // `findBotComment` — called on EVERY `review` invocation, before
  // dedup/rule-loading/dispatch ever run — failed 100% of the time with an
  // HTTP 422 ("body" wasn't supplied), because `gh api --paginate -f
  // per_page=100 <endpoint>` (no explicit `-X`/`--method`) issues a POST,
  // not a GET, whenever any `-f`/`-F` parameter is present — regardless of
  // the target endpoint. No unit test caught this before the fix because
  // every test here mocks `execGh` entirely: a wrong HTTP-method flag never
  // produces a wrong *result* in a mocked test, since the mock just returns
  // whatever fixture it's told to, independent of the args actually passed.
  // This test exists specifically to pin the exact args shape (including
  // `-X GET`) so this real-world regression can never silently return.
  it("bug fix (real end-to-end run, hmchangw/chat PR #491): findBotComment issues an explicit -X GET, since gh api silently defaults to POST once -f per_page=100 is present", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments.json");
    const adapter = new GitHubAdapter(execGh);

    await adapter.findBotComment("42");

    const paginatedCall = execGh.mock.calls.find(
      ([args]) => args[0] === "api" && args.includes("--paginate"),
    );
    expect(paginatedCall).toBeDefined();
    const [args] = paginatedCall as [string[]];
    expect(args).toContain("-X");
    expect(args[args.indexOf("-X") + 1]).toBe("GET");
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
      reviewedConfig: "",
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
      reviewedConfig: "",
    });
  });

  // Config-aware dedup: a marker carrying a `cfg=` segment must have that hash
  // parsed into reviewedConfig, so decideDedup can tell whether the review
  // config changed since the last run. A legacy marker (no cfg) yields "".
  it("config-aware dedup: findBotComment parses the cfg= hash from a config-aware marker into reviewedConfig", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return JSON.stringify([
        {
          id: 777,
          body: "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 cfg=1a2b3c4d5e6f -->",
          user: { login: "tgd-review-agent[bot]" },
        },
      ]);
    });
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    expect(botComment).toEqual({
      id: "777",
      body: "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 cfg=1a2b3c4d5e6f -->",
      lastReviewedSha: "abc1234",
      reviewedConfig: "1a2b3c4d5e6f",
    });
  });

  // Hardening (CodeRabbit review): the marker buildBody appends is always the
  // LAST thing in the body, so only the TRAILING marker is authoritative. A
  // marker-shaped string quoted earlier in the body (e.g. echoed review content)
  // must NOT be parsed as the reviewed SHA/config, or dedup could skip wrongly.
  it("hardening: parses the authoritative TRAILING marker, ignoring an earlier marker-shaped string in the body", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return JSON.stringify([
        {
          id: 888,
          body:
            "Quoted from the diff: <!-- tgd-review-agent:sha=deadbeef cfg=ffffffffffff -->\n\n" +
            "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 cfg=1a2b3c4d5e6f -->",
          user: { login: "tgd-review-agent[bot]" },
        },
      ]);
    });
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    // The trailing marker wins — never the earlier decoy.
    expect(botComment?.lastReviewedSha).toBe("abc1234");
    expect(botComment?.reviewedConfig).toBe("1a2b3c4d5e6f");
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
        ["pr", "view", "1", "--json", "headRefOid,baseRefOid,title,body,url"],
        { maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function),
      );
    });
  });

  // --- getRuleFilesFromBase (ADR-002 CLI-native fix) ---
  //
  // Uses GitHub's Contents API via `gh api repos/{owner}/{repo}/contents/{path}?ref={sha}`,
  // routed through the same injectable `execGh` seam as every other method —
  // no real `gh` calls in these unit tests.
  describe("getRuleFilesFromBase", () => {
    const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");

    it("lists the rules directory at the given base sha, fetches each .md file's content, and decodes it from base64", async () => {
      const dirListing = JSON.stringify([
        { name: "security-review.md", path: ".tgd-review/rules/security-review.md", type: "file", sha: "sha1" },
        { name: "style-guide.md", path: ".tgd-review/rules/style-guide.md", type: "file", sha: "sha2" },
      ]);
      const execGh = vi.fn(async (args: string[]) => {
        const target = args[1];
        if (target === "repos/{owner}/{repo}/contents/.tgd-review/rules?ref=deadbeef") {
          return dirListing;
        }
        if (target === "repos/{owner}/{repo}/contents/.tgd-review/rules/security-review.md?ref=deadbeef") {
          return JSON.stringify({ content: b64("---\nname: security-review\n---\nBody A"), encoding: "base64" });
        }
        if (target === "repos/{owner}/{repo}/contents/.tgd-review/rules/style-guide.md?ref=deadbeef") {
          return JSON.stringify({ content: b64("---\nname: style-guide\n---\nBody B"), encoding: "base64" });
        }
        throw new Error(`unexpected execGh call: ${JSON.stringify(args)}`);
      });
      const adapter = new GitHubAdapter(execGh);

      const files = await adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules");

      expect(files).toEqual(
        expect.arrayContaining([
          { path: "security-review.md", content: "---\nname: security-review\n---\nBody A" },
          { path: "style-guide.md", content: "---\nname: style-guide\n---\nBody B" },
        ]),
      );
      expect(files).toHaveLength(2);
    });

    it("returns [] (not an error) when the rules directory doesn't exist on the base branch (404)", async () => {
      const execGh = vi.fn(async () => {
        throw new Error(
          "Command failed: gh api repos/{owner}/{repo}/contents/.tgd-review/rules?ref=deadbeef\n" +
            "gh: Not Found (HTTP 404)",
        );
      });
      const adapter = new GitHubAdapter(execGh);

      const files = await adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules");

      expect(files).toEqual([]);
    });

    it("returns [] when the rules directory exists but is empty", async () => {
      const execGh = vi.fn().mockResolvedValue("[]");
      const adapter = new GitHubAdapter(execGh);

      const files = await adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules");

      expect(files).toEqual([]);
    });

    it("filters out non-.md files and subdirectories, and never fetches their content", async () => {
      const dirListing = JSON.stringify([
        { name: "README.txt", path: ".tgd-review/rules/README.txt", type: "file", sha: "sha1" },
        { name: "security-review.md", path: ".tgd-review/rules/security-review.md", type: "file", sha: "sha2" },
        { name: "nested", path: ".tgd-review/rules/nested", type: "dir", sha: "sha3" },
      ]);
      const execGh = vi.fn(async (args: string[]) => {
        const target = args[1];
        if (target === "repos/{owner}/{repo}/contents/.tgd-review/rules?ref=deadbeef") {
          return dirListing;
        }
        if (target === "repos/{owner}/{repo}/contents/.tgd-review/rules/security-review.md?ref=deadbeef") {
          return JSON.stringify({ content: b64("Body"), encoding: "base64" });
        }
        throw new Error(`unexpected execGh call for a filtered-out entry: ${JSON.stringify(args)}`);
      });
      const adapter = new GitHubAdapter(execGh);

      const files = await adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules");

      expect(files).toEqual([{ path: "security-review.md", content: "Body" }]);
    });

    it("issues the directory listing via `gh api repos/{owner}/{repo}/contents/{rulesDir}?ref={baseSha}`", async () => {
      const execGh = vi.fn().mockResolvedValue("[]");
      const adapter = new GitHubAdapter(execGh);

      await adapter.getRuleFilesFromBase("abc123", ".tgd-review/rules");

      expect(execGh).toHaveBeenCalledWith(["api", "repos/{owner}/{repo}/contents/.tgd-review/rules?ref=abc123"]);
    });

    it("propagates a genuine error (e.g. auth failure) rather than swallowing it as 'not found'", async () => {
      const execGh = vi.fn().mockRejectedValue(new Error("gh: authentication required (HTTP 401)"));
      const adapter = new GitHubAdapter(execGh);

      await expect(adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules")).rejects.toThrow(
        /HTTP 401/,
      );
    });

    it("propagates a rejection when the directory listing response is malformed/non-JSON", async () => {
      const execGh = vi.fn().mockResolvedValue("not valid json{{{");
      const adapter = new GitHubAdapter(execGh);

      await expect(adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules")).rejects.toThrow(
        SyntaxError,
      );
    });

    it("propagates a genuine error raised while fetching an individual file's content", async () => {
      const dirListing = JSON.stringify([
        { name: "security-review.md", path: ".tgd-review/rules/security-review.md", type: "file", sha: "sha1" },
      ]);
      const execGh = vi.fn(async (args: string[]) => {
        const target = args[1];
        if (target === "repos/{owner}/{repo}/contents/.tgd-review/rules?ref=deadbeef") {
          return dirListing;
        }
        throw new Error("gh: network error (ECONNRESET)");
      });
      const adapter = new GitHubAdapter(execGh);

      await expect(adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules")).rejects.toThrow(
        /ECONNRESET/,
      );
    });

    it("treats a single-file (non-array) contents response as 'no rules directory' rather than throwing", async () => {
      // The Contents API returns a single object (not an array) when the
      // given path is itself a file rather than a directory — e.g. if
      // rulesDir was misconfigured to point at a file. Treated the same as
      // "directory doesn't exist": zero user rules, not an error.
      const execGh = vi.fn().mockResolvedValue(
        JSON.stringify({ name: "rules", path: ".tgd-review/rules", type: "file", sha: "sha1", content: "x" }),
      );
      const adapter = new GitHubAdapter(execGh);

      const files = await adapter.getRuleFilesFromBase("deadbeef", ".tgd-review/rules");

      expect(files).toEqual([]);
    });
  });
});

// Design-review #10: resolveStaleReviewThreads collapses the bot's OWN
// unresolved inline threads via GraphQL — never a human's thread, never an
// already-resolved one, and never by deleting anything.
describe("resolveStaleReviewThreads", () => {
  // execGh stub speaking all four dialects the method uses: `gh api user`,
  // `gh repo view`, the reviewThreads GraphQL query, and the resolve mutation.
  function makeResolveExecGh(pages: object[]): {
    execGh: ExecGh;
    resolvedThreadIds: () => string[];
  } {
    const mutations: string[] = [];
    let page = 0;
    const execGh: ExecGh = async (args) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      if (args[0] === "repo" && args[1] === "view") {
        return JSON.stringify({ nameWithOwner: "octo-org/octo-repo" });
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const query = args.find((a) => a.startsWith("query="));
        if (query?.startsWith("query=mutation(")) {
          const threadId = args.find((a) => a.startsWith("threadId="));
          mutations.push(threadId?.slice("threadId=".length) ?? "");
          return JSON.stringify({ data: { resolveReviewThread: { thread: { id: "x" } } } });
        }
        return JSON.stringify(pages[Math.min(page++, pages.length - 1)]);
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    return { execGh, resolvedThreadIds: () => mutations };
  }

  function threadsPage(
    nodes: { id: string; isResolved: boolean; author: string }[],
    endCursor: string | null = null,
  ): object {
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: endCursor !== null, endCursor },
              nodes: nodes.map((n) => ({
                id: n.id,
                isResolved: n.isResolved,
                comments: { nodes: [{ author: { login: n.author } }] },
              })),
            },
          },
        },
      },
    };
  }

  it("resolves only the bot's own UNRESOLVED threads — a human's thread and an already-resolved one are untouched", async () => {
    const { execGh, resolvedThreadIds } = makeResolveExecGh([
      threadsPage([
        { id: "T-bot-open", isResolved: false, author: "tgd-review-agent[bot]" },
        { id: "T-human-open", isResolved: false, author: "some-human" },
        { id: "T-bot-done", isResolved: true, author: "tgd-review-agent[bot]" },
      ]),
    ]);
    const adapter = new GitHubAdapter(execGh);

    const count = await adapter.resolveStaleReviewThreads("42");

    expect(count).toBe(1);
    expect(resolvedThreadIds()).toEqual(["T-bot-open"]);
  });

  it("paginates: threads past the first page are still found and resolved", async () => {
    const { execGh, resolvedThreadIds } = makeResolveExecGh([
      threadsPage([{ id: "T-page1", isResolved: false, author: "tgd-review-agent[bot]" }], "CUR1"),
      threadsPage([{ id: "T-page2", isResolved: false, author: "tgd-review-agent[bot]" }]),
    ]);
    const adapter = new GitHubAdapter(execGh);

    const count = await adapter.resolveStaleReviewThreads("42");

    expect(count).toBe(2);
    expect(resolvedThreadIds()).toEqual(["T-page1", "T-page2"]);
  });

  it("returns 0 and mutates nothing when there are no stale bot threads", async () => {
    const { execGh, resolvedThreadIds } = makeResolveExecGh([threadsPage([])]);
    const adapter = new GitHubAdapter(execGh);

    expect(await adapter.resolveStaleReviewThreads("42")).toBe(0);
    expect(resolvedThreadIds()).toEqual([]);
  });

  it("propagates a failure (the CALLER treats it as non-fatal — see cli-review tests)", async () => {
    const execGh: ExecGh = async (args) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      throw new Error("gh repo view failed");
    };
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.resolveStaleReviewThreads("42")).rejects.toThrow(/gh repo view failed/);
  });
});

// ADR-007: a multi-line committable suggestion spans start_line..line. GitHub
// requires start_side alongside start_line, and start_line < line.
describe("createInlineReview: multi-line suggestion ranges", () => {
  it("sends start_line + start_side for a multi-line range, and omits them for a single line", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const execGh: ExecGh = async (args, stdin) => {
      calls.push({ args, stdin });
      return "{}";
    };
    const adapter = new GitHubAdapter(execGh);

    await adapter.createInlineReview("42", "deadbeef", [
      { path: "a.ts", line: 13, startLine: 11, body: "multi" },
      { path: "b.ts", line: 5, body: "single" },
    ]);

    const payload = JSON.parse(calls[0].stdin as string) as {
      commit_id: string;
      event: string;
      comments: Record<string, unknown>[];
    };

    expect(payload.commit_id).toBe("deadbeef");
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments[0]).toEqual({
      path: "a.ts",
      line: 13, // LAST line of the range
      side: "RIGHT",
      start_line: 11,
      start_side: "RIGHT",
      body: "multi",
    });
    // A single-line comment must NOT carry start_line (GitHub rejects start_line === line).
    expect(payload.comments[1]).toEqual({
      path: "b.ts",
      line: 5,
      side: "RIGHT",
      body: "single",
    });
  });
});
