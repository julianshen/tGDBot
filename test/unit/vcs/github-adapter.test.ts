import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConcurrentGitHubMutationError, GitHubAdapter } from "../../../src/vcs/github-adapter.js";
import { INLINE_COMMENT_MARKER } from "../../../src/review/comment-format.js";
import {
  validateInlinePublishOutcomes,
  AmbiguousInlinePublishError,
  type BotComment,
  type ReviewLocator,
} from "../../../src/vcs/adapter.js";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import { computeContentDigest, computeRepositoryDigest, formatChildMarker } from "../../../src/conversation/markers.js";
import type { ReviewIdentity } from "../../../src/conversation/types.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf-8");

// `-X GET` is REQUIRED here (not the implicit default) because `-f
// per_page=100` is present — see the bug-fix doc comment on findBotComment
// in src/vcs/github-adapter.ts for why `gh api` silently defaults to POST
// once any `-f`/`-F` param is passed, and the real end-to-end 422 this
// caused against `hmchangw/chat` PR #491.
const BOUNDED_COMMENTS_ARGS_PREFIX = ["api", "-X", "GET", "-f", "per_page=50", "-f", "page=1"];

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

const locator = (number: number): ReviewLocator => ({
  kind: "ambient",
  provider: "github",
  number,
});
const locator42 = locator(42);

function inlineThreadsFixture(ids: number[], paths: string[], head = "d".repeat(40), lines = [13, 5]): string {
  const nodes = ids.map((id, index) => ({
    id: `T${id}`, isResolved: false, isOutdated: false, path: paths[index],
    line: lines[index] ?? 5, originalLine: null,
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      databaseId: id, body: "posted", author: { login: "octo-bot" },
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
      url: `https://github.com/octo-org/octo-repo/pull/42#discussion_r${id}`,
      commit: { oid: head }, originalCommit: { oid: head }, replyTo: null,
    }] },
  }));
  return JSON.stringify({ data: { repository: { pullRequest: {
    id: "PR_kwDO42", url: "https://github.com/octo-org/octo-repo/pull/42", headRefOid: head,
    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
  } } } });
}

describe("GitHubAdapter", () => {
  const explicitRepo = parseRepositoryRef("octo-org/octo-repo", "github");
  const explicitLocator: ReviewLocator = {
    kind: "repository",
    repo: explicitRepo,
    number: 42,
  };

  it("delegates related-work resolution through its injected executor", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Linked issue", state: "open", html_url: "https://github.com/octo/repo/issues/8",
    }));
    const adapter = new GitHubAdapter(execGh);
    const reference = {
      provider: "github" as const,
      host: "github.com",
      projectPath: "octo/repo",
      number: 8,
      sourceText: "#8",
      identifier: "#8",
    };
    await expect(adapter.resolveRelatedWork([reference])).resolves.toEqual([
      expect.objectContaining({ title: "Linked issue", kind: "issue" }),
    ]);
    expect(execGh).toHaveBeenCalledWith(
      ["api", "-X", "GET", "repos/octo/repo/issues/8", "--hostname", "github.com"],
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("AC-2.1: scopes PR metadata and diff calls to the explicit repository", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[1] === "view") {
        return JSON.stringify({
          headRefOid: "abc123",
          baseRefOid: "def456",
          headRefName: "feature/topic",
          baseRefName: "main",
          title: "Explicit target",
          body: "Body",
          url: "https://github.com/octo-org/octo-repo/pull/42",
        });
      }
      return "diff --git a/a.ts b/a.ts";
    });
    const adapter = new GitHubAdapter(execGh);

    const pr = await adapter.getPullRequest(explicitLocator);
    const diff = await adapter.getDiff(explicitLocator);

    expect(pr).toEqual({
      id: "42",
      headSha: "abc123",
      baseSha: "def456",
      title: "Explicit target",
      description: "Body",
      url: "https://github.com/octo-org/octo-repo/pull/42",
    });
    expect(diff).toBe("diff --git a/a.ts b/a.ts");
    expect(execGh).toHaveBeenNthCalledWith(1, [
      "pr",
      "view",
      "42",
      "--repo",
      "github.com/octo-org/octo-repo",
      "--json",
      "headRefOid,baseRefOid,headRefName,baseRefName,title,body,url",
    ]);
    expect(execGh).toHaveBeenNthCalledWith(2, [
      "pr",
      "diff",
      "42",
      "--repo",
      "github.com/octo-org/octo-repo",
    ]);
  });

  it("AC-2.2: scopes summary and trusted-rule operations while inline posting remains disabled", async () => {
    let inlineBodies: string[] = [];
    const execGh = vi.fn(async (args: string[], stdin?: string) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      if (args.includes("repos/octo-org/octo-repo/issues/42/comments")) {
        if (args.includes("POST")) return JSON.stringify({ id: 88, body: "summary" });
        return readFixture("gh-comments.json");
      }
      if (args.includes("repos/octo-org/octo-repo/issues/comments/99")) {
        return JSON.stringify({ id: 99, body: "updated" });
      }
      if (args.includes("repos/octo-org/octo-repo/pulls/42/reviews")) {
        inlineBodies = (JSON.parse(stdin!) as { comments: { body: string }[] }).comments.map((comment) => comment.body);
        return "{}";
      }
      if (args[1] === "graphql") return inlineThreadsFixture([700], ["src/a.ts"], "a".repeat(40));
      if (args.includes("repos/octo-org/octo-repo/pulls/42/comments")) {
        return JSON.stringify(inlineBodies.map((body, index) => ({ id: 700 + index, body, user: { login: "tgd-review-agent[bot]" }, path: "src/a.ts", line: 13, side: "RIGHT", commit_id: "a".repeat(40), html_url: `https://github.com/octo-org/octo-repo/pull/42#discussion_r${700 + index}`, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42" })));
      }
      if (args.includes("repos/octo-org/octo-repo/contents/.tgd-review/rules?ref=def456")) {
        return "[]";
      }
      return "{}";
    });
    const adapter = new GitHubAdapter(execGh);

    await adapter.findBotComment(explicitLocator);
    await adapter.upsertComment(explicitLocator, "summary", null);
    await adapter.upsertComment(explicitLocator, "updated", {
      id: "99",
      body: "old",
      lastReviewedSha: "abc1234",
      reviewedConfig: "cfg",
    });
    await adapter.createInlineReview(explicitLocator, "a".repeat(40), [
      {
        clientId: "finding-0",
        path: "src/a.ts",
        line: 13,
        body: "finding",
        position: {} as never,
      },
    ]);
    await adapter.getRuleFilesFromBase(explicitLocator, "def456", ".tgd-review/rules");

    const calls = execGh.mock.calls.map(([args]) => args as string[]);
    expect(calls).toContainEqual([
      ...BOUNDED_COMMENTS_ARGS_PREFIX,
      "repos/octo-org/octo-repo/issues/42/comments",
      "--hostname",
      "github.com",
    ]);
    expect(calls).toContainEqual([
      "api",
      "repos/octo-org/octo-repo/issues/42/comments",
      "--hostname",
      "github.com",
      "-X",
      "POST",
      "--input",
      "-",
    ]);
    expect(calls).toContainEqual([
      "api",
      "repos/octo-org/octo-repo/issues/comments/99",
      "--hostname",
      "github.com",
      "-X",
      "PATCH",
      "--input",
      "-",
    ]);
    expect(calls.some((args) => args.includes("repos/octo-org/octo-repo/pulls/42/reviews"))).toBe(true);
    expect(calls).toContainEqual([
      "api",
      "repos/octo-org/octo-repo/contents/.tgd-review/rules?ref=def456",
      "--hostname",
      "github.com",
    ]);
    expect(calls.some((args) => args.join(" ").includes("{owner}"))).toBe(false);
    for (const args of calls.filter((args) => args[0] === "api")) {
      expect(args).toContain("--hostname");
      expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
    }
  });

  it("AC-2.2: resolves stale threads with explicit GraphQL owner/name and no ambient repo lookup", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      if (args[0] === "api" && args[1] === "graphql") {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        });
      }
      throw new Error(`unexpected ambient command: ${args.join(" ")}`);
    });
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.resolveStaleReviewThreads(explicitLocator)).resolves.toBe(0);

    expect(execGh.mock.calls.some(([args]) => (args as string[])[0] === "repo")).toBe(false);
    const graphQlArgs = execGh.mock.calls
      .map(([args]) => args as string[])
      .find((args) => args[0] === "api" && args[1] === "graphql");
    expect(graphQlArgs).toContain("owner=octo-org");
    expect(graphQlArgs).toContain("name=octo-repo");
    expect(graphQlArgs).toContain("number=42");
    expect(graphQlArgs).toContain("--hostname");
    expect(graphQlArgs?.[graphQlArgs.indexOf("--hostname") + 1]).toBe("github.com");
  });

  it("rejects a GitLab repository locator before invoking gh", async () => {
    const execGh = vi.fn();
    const adapter = new GitHubAdapter(execGh);
    const locator: ReviewLocator = {
      kind: "repository",
      repo: parseRepositoryRef("gitlab.com/group/project", "gitlab"),
      number: 42,
    };

    await expect(adapter.getDiff(locator)).rejects.toThrow(/GitHubAdapter.*GitLab/i);
    expect(execGh).not.toHaveBeenCalled();
  });

  it("preserves the existing ambient metadata and diff commands", async () => {
    const execGh = vi.fn()
      .mockResolvedValueOnce(readFixture("gh-pr-view.json"))
      .mockResolvedValueOnce("diff");
    const adapter = new GitHubAdapter(execGh);

    await adapter.getPullRequest(locator42);
    await adapter.getDiff(locator42);

    expect(execGh).toHaveBeenNthCalledWith(1, [
      "pr", "view", "42", "--json", "headRefOid,baseRefOid,title,body,url",
    ]);
    expect(execGh).toHaveBeenNthCalledWith(2, ["pr", "diff", "42"]);
  });

  // AC-2.1: Given a mocked `gh pr view` response for PR 42, When
  // getPullRequest("42") is called, Then it returns a PullRequestInfo with
  // the correct headSha, baseSha, title, description parsed from that JSON.
  it("AC-2.1: getPullRequest parses headSha/baseSha/title/description from mocked gh pr view output", async () => {
    const execGh = vi.fn().mockResolvedValue(readFixture("gh-pr-view.json"));
    const adapter = new GitHubAdapter(execGh);

    const pr = await adapter.getPullRequest(locator42);

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

  it("normalizes a null PR body to an empty description for both locator forms", async () => {
    const execGh = vi.fn(async (args: string[]) => JSON.stringify({
      headRefOid: "abc123",
      baseRefOid: "def456",
      headRefName: args.includes("--repo") ? "feature/topic" : undefined,
      baseRefName: args.includes("--repo") ? "main" : undefined,
      title: "No description",
      body: null,
      url: "https://github.com/octo-org/octo-repo/pull/42",
    }));
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.getPullRequest(explicitLocator)).resolves.toMatchObject({ description: "" });
    await expect(adapter.getPullRequest(locator42)).resolves.toMatchObject({ description: "" });
  });

  // AC-2.2: Given a mocked comment list containing one comment authored by
  // the bot's own identity with body `<!-- tgd-review-agent:sha=abc123... -->`,
  // When findBotComment("42") is called, Then it returns that comment with
  // lastReviewedSha === "abc123...".
  it("AC-2.2: findBotComment extracts lastReviewedSha from the marker comment", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments.json");
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment(locator42);

    expect(botComment).toEqual({
      id: "222",
      body: "## tGD Review\n\nNo blocking issues found.\n\n<!-- tgd-review-agent:sha=abc1234 -->",
      lastReviewedSha: "abc1234",
      reviewedConfig: "",
    });
    expect(execGh).toHaveBeenCalledWith([
      ...BOUNDED_COMMENTS_ARGS_PREFIX,
      "repos/{owner}/{repo}/issues/42/comments",
    ]);
  });

  // AC-2.3: Given a mocked comment list with no marker-bearing comment, When
  // findBotComment("42") is called, Then it returns null.
  it("AC-2.3: findBotComment returns null when no comment has the bot marker", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments-no-marker.json");
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment(locator42);

    expect(botComment).toBeNull();
  });

  // AC-2.3 (edge case): an empty comment list also yields null, not a throw.
  it("AC-2.3: findBotComment returns null for an empty comment list", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return "[]";
    });
    const adapter = new GitHubAdapter(execGh);

    expect(await adapter.findBotComment(locator42)).toBeNull();
  });

  // AC-2.4: Given existing is null, When upsertComment("42", body, null) is
  // called, Then the adapter issues a create-comment gh invocation (not an edit).
  it("AC-2.4: upsertComment with existing=null issues a create (not an edit)", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      id: 777,
      body: "review body text\n<!-- tgd-review-agent:pending -->",
    }));
    const adapter = new GitHubAdapter(execGh);

    const written = await adapter.upsertComment(
      locator42,
      "review body text\n<!-- tgd-review-agent:pending -->",
      null,
    );

    expect(written.id).toBe("777");
    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenCalledWith(
      ["api", "repos/{owner}/{repo}/issues/42/comments", "-X", "POST", "--input", "-"],
      JSON.stringify({ body: "review body text\n<!-- tgd-review-agent:pending -->" }),
    );
    // Must target the create collection, never the exact-comment edit endpoint.
    const [args] = execGh.mock.calls[0] as [string[], string?];
    expect(args.join(" ")).not.toMatch(/PATCH/);
  });

  // AC-2.5: Given existing is a BotComment with id: "999", When
  // upsertComment("42", body, existing) is called, Then the adapter issues
  // an edit invocation targeting comment id 999 (never a second create).
  it("AC-2.5: upsertComment with an existing BotComment issues an edit targeting that exact comment id", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      id: 999,
      body: "updated review body\n<!-- tgd-review-agent:sha=abc1234 -->",
    }));
    const adapter = new GitHubAdapter(execGh);
    const existing: BotComment = {
      id: "999",
      body: "<!-- tgd-review-agent:sha=old -->",
      lastReviewedSha: "old",
      reviewedConfig: "",
    };

    const written = await adapter.upsertComment(
      locator42,
      "updated review body\n<!-- tgd-review-agent:sha=abc1234 -->",
      existing,
    );

    expect(written.id).toBe("999");
    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenCalledWith(
      ["api", "repos/{owner}/{repo}/issues/comments/999", "-X", "PATCH", "--input", "-"],
      JSON.stringify({ body: "updated review body\n<!-- tgd-review-agent:sha=abc1234 -->" }),
    );
    // Never issues a `gh pr comment` create invocation.
    const [args] = execGh.mock.calls[0] as [string[], string?];
    expect(args).not.toEqual(expect.arrayContaining(["comment"]));
  });

  it.each([
    ["bad JSON", "not json"],
    ["missing id", JSON.stringify({ body: "x" })],
    ["wrong update id", JSON.stringify({ id: 1000, body: "x" })],
    ["malformed body", JSON.stringify({ id: 999, body: 42 })],
    ["mismatched body", JSON.stringify({ id: 999, body: "different" })],
  ])("rejects %s write responses", async (_name, response) => {
    const adapter = new GitHubAdapter(vi.fn().mockResolvedValue(response));
    await expect(adapter.upsertComment(locator42, "x", {
      id: "999",
      body: "old",
      lastReviewedSha: "",
      reviewedConfig: "",
    })).rejects.toThrow(/comment|response|id/i);
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
    const botComment = await adapter.findBotComment(locator42);

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

    const botComment = await adapter.findBotComment(locator42);

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

    await adapter.findBotComment(locator42);
    await adapter.findBotComment(locator42);

    const userCalls = execGh.mock.calls.filter(
      ([args]) => args[0] === "api" && args[1] === "user",
    );
    expect(userCalls).toHaveLength(1);
    expect(execGh).toHaveBeenCalledWith(["api", "user"]);
  });

  // --- Review fix #2 (correctness): pagination ---

  it("correctness fix: findBotComment fetches explicit bounded comment pages", async () => {
    const execGh = mockExecGhWithIdentity("gh-user.json", "gh-comments.json");
    const adapter = new GitHubAdapter(execGh);

    await adapter.findBotComment(locator42);

    expect(execGh).toHaveBeenCalledWith([
      "api",
      "-X",
      "GET",
      "-f",
      "per_page=50",
      "-f",
      "page=1",
      "repos/{owner}/{repo}/issues/42/comments",
    ]);
  });

  it("parses slurped pagination pages and finds the bot marker after page one", async () => {
    const markerComment = {
      id: 222,
      body: "## tGD Review\n\n<!-- tgd-review-agent:sha=abc1234 -->",
      user: { login: "tgd-review-agent[bot]" },
    };
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return JSON.stringify([[{ id: 111, body: "page one", user: { login: "someone" } }], [markerComment]]);
    });
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.findBotComment(locator42)).resolves.toMatchObject({ id: "222", lastReviewedSha: "abc1234" });
    expect(execGh).toHaveBeenCalledWith([
      ...BOUNDED_COMMENTS_ARGS_PREFIX,
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

    await adapter.findBotComment(locator42);

    const paginatedCall = execGh.mock.calls.find(
      ([args]) => args[0] === "api" && args.includes("per_page=50"),
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

    const botComment = await adapter.findBotComment(locator42);

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

    const botComment = await adapter.findBotComment(locator42);

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

    const botComment = await adapter.findBotComment(locator42);

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

    const botComment = await adapter.findBotComment(locator42);

    // The trailing marker wins — never the earlier decoy.
    expect(botComment?.lastReviewedSha).toBe("abc1234");
    expect(botComment?.reviewedConfig).toBe("1a2b3c4d5e6f");
  });

  it("preserves malformed non-trailing marker behavior through the shared parser", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      return JSON.stringify([{
        id: 889,
        body: "prefix <!-- tgd-review-agent:sha=abc1234 --> trailing",
        user: { login: "tgd-review-agent[bot]" },
      }]);
    });
    await expect(new GitHubAdapter(execGh).findBotComment(locator42)).resolves.toMatchObject({
      id: "889",
      lastReviewedSha: "",
      reviewedConfig: "",
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

    await expect(adapter.findBotComment(locator42)).rejects.toThrow(/JSON/);
  });

  it("test coverage fix (pinning): findBotComment rejects when the `gh api user` call returns malformed/non-JSON output", async () => {
    const execGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") return "not valid json{{{";
      return readFixture("gh-comments.json");
    });
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.findBotComment(locator42)).rejects.toThrow(SyntaxError);
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

    it("forwards a requested timeout to execFile", async () => {
      const execFileMock = vi.fn((_cmd, _args, _opts, callback) => {
        callback(null, "ok", "");
        return { stdin: { end: vi.fn() } };
      });
      vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
      const { realExecGh } = await import("../../../src/vcs/github-adapter.js");
      await realExecGh(["api", "user"], undefined, { timeoutMs: 5_000 });
      expect(execFileMock).toHaveBeenCalledWith("gh", ["api", "user"],
        { maxBuffer: 10 * 1024 * 1024, timeout: 5_000 }, expect.any(Function));
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
      await adapter.getPullRequest(locator(1));

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

      const files = await adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules");

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

      const files = await adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules");

      expect(files).toEqual([]);
    });

    it("returns [] when the rules directory exists but is empty", async () => {
      const execGh = vi.fn().mockResolvedValue("[]");
      const adapter = new GitHubAdapter(execGh);

      const files = await adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules");

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

      const files = await adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules");

      expect(files).toEqual([{ path: "security-review.md", content: "Body" }]);
    });

    it("issues the directory listing via `gh api repos/{owner}/{repo}/contents/{rulesDir}?ref={baseSha}`", async () => {
      const execGh = vi.fn().mockResolvedValue("[]");
      const adapter = new GitHubAdapter(execGh);

      await adapter.getRuleFilesFromBase(locator42, "abc123", ".tgd-review/rules");

      expect(execGh).toHaveBeenCalledWith(["api", "repos/{owner}/{repo}/contents/.tgd-review/rules?ref=abc123"]);
    });

    it("propagates a genuine error (e.g. auth failure) rather than swallowing it as 'not found'", async () => {
      const execGh = vi.fn().mockRejectedValue(new Error("gh: authentication required (HTTP 401)"));
      const adapter = new GitHubAdapter(execGh);

      await expect(adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules")).rejects.toThrow(
        /HTTP 401/,
      );
    });

    it("propagates a rejection when the directory listing response is malformed/non-JSON", async () => {
      const execGh = vi.fn().mockResolvedValue("not valid json{{{");
      const adapter = new GitHubAdapter(execGh);

      await expect(adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules")).rejects.toThrow(
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

      await expect(adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules")).rejects.toThrow(
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

      const files = await adapter.getRuleFilesFromBase(locator42, "deadbeef", ".tgd-review/rules");

      expect(files).toEqual([]);
    });
  });
});

describe("GitHub conversation activity", () => {
  const repo = parseRepositoryRef("octo-org/octo-repo", "github");
  const repositoryDigest = computeRepositoryDigest("github", repo.canonicalUrl);
  const review: ReviewIdentity = {
    provider: "github",
    repositoryDigest,
    reviewNumber: 42,
    reviewId: "PR_kwDO42",
    url: "https://github.com/octo-org/octo-repo/pull/42",
  };

  it("evicts a failed authenticated identity lookup and normalizes the retry", async () => {
    const execGh = vi.fn()
      .mockRejectedValueOnce(new Error("expired token"))
      .mockResolvedValueOnce(JSON.stringify({ login: "Octo-Bot" }));
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.getAuthenticatedBotIdentity()).rejects.toThrow(/expired token/);
    await expect(adapter.getAuthenticatedBotIdentity()).resolves.toEqual({
      provider: "github", login: "octo-bot", mention: "@octo-bot",
    });
    expect(execGh).toHaveBeenCalledTimes(2);
    expect(execGh).toHaveBeenLastCalledWith(["api", "user", "--hostname", "github.com"]);
  });

  it("lists a stable explicit page of open PRs and emits bound cursors", async () => {
    const execGh = vi.fn().mockResolvedValue(readFixture("gh-open-prs.json"));
    const adapter = new GitHubAdapter(execGh, repo);
    const page = await adapter.listOpenReviews({ provider: "github", repositoryDigest });
    expect(page.reviews.map((item) => item.identity.reviewId)).toEqual(["PR_kwDO3", "PR_kwDO12"]);
    expect(page.nextCursor).toMatchObject({ scope: "open-review-discovery", provider: "github", repositoryDigest });
    expect(execGh).toHaveBeenCalledWith([
      "api", "-X", "GET", "repos/octo-org/octo-repo/pulls", "--hostname", "github.com",
      "-f", "state=all", "-f", "sort=created", "-f", "direction=asc", "-f", "per_page=100", "-f", "page=1",
    ]);
  });

  it("bounds open review discovery memory while scanning immutable provider pages", async () => {
    const template = (JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>)[0]!;
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...template, id: index + 1, node_id: `PR_${index + 1}`, number: index + 1, html_url: `${repo.canonicalUrl}/pull/${index + 1}` }));
    const execGh = vi.fn(async (args: string[]) => args.includes("page=1") ? JSON.stringify(rows) : "[]");
    const adapter = new GitHubAdapter(execGh, repo);
    const first = await adapter.listOpenReviews({ provider: "github", repositoryDigest });
    expect(first.reviews).toHaveLength(100);
    expect(execGh).toHaveBeenLastCalledWith(expect.arrayContaining(["-f", "page=2"]));
    expect(execGh.mock.calls.flatMap(([args]) => args as string[])).not.toContain("--paginate");
  });

  it("discovers an old PR updated after the cursor and includes unseen equal-time identities", async () => {
    const rows = JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>;
    rows[0]!.updated_at = "2026-08-13T10:00:00Z";
    rows[1]!.updated_at = "2026-08-12T10:00:00Z";
    const adapter = new GitHubAdapter(vi.fn().mockResolvedValue(JSON.stringify(rows)), repo);
    const page = await adapter.listOpenReviews(
      { provider: "github", repositoryDigest },
      { scope: "open-review-discovery", provider: "github", repositoryDigest, opaque: JSON.stringify({ at: "2026-08-12T10:00:00Z", seen: [] }), orderKey: "2026-08-12T10:00:00Z" },
    );
    expect(page.reviews.map((item) => item.identity.reviewId)).toEqual(["PR_kwDO12", "PR_kwDO3"]);
    expect(JSON.parse(page.nextCursor!.opaque)).toMatchObject({ at: "2026-08-13T10:00:00.000Z", seen: [], cutoff: expect.any(String) });
  });

  it("replays the same PR at the inclusive updated-time boundary even when its ID was seen", async () => {
    const rows = JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>;
    rows[0]!.updated_at = "2026-08-12T10:00:00Z";
    const adapter = new GitHubAdapter(vi.fn().mockResolvedValue(JSON.stringify([rows[0]])), repo);
    const page = await adapter.listOpenReviews(
      { provider: "github", repositoryDigest },
      { scope: "open-review-discovery", provider: "github", repositoryDigest,
        opaque: JSON.stringify({ at: "2026-08-12T10:00:00Z", seen: ["PR_kwDO3"] }), orderKey: "2026-08-12T10:00:00Z" },
    );
    expect(page.reviews.map((item) => item.identity.reviewId)).toEqual(["PR_kwDO3"]);
  });

  it("retries a torn open-review snapshot and filters closed rows only after verification", async () => {
    const template = (JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>)[0]!;
    const open = { ...template, id: 1, node_id: "PR_1", number: 1, html_url: `${repo.canonicalUrl}/pull/1` };
    const closed = { ...template, id: 2, node_id: "PR_2", number: 2, state: "closed", html_url: `${repo.canonicalUrl}/pull/2` };
    let completeScans = 0;
    const execGh = vi.fn(async () => {
      completeScans += 1;
      if (completeScans === 1) return JSON.stringify([open]);
      return JSON.stringify([open, closed]);
    });
    const page = await new GitHubAdapter(execGh, repo).listOpenReviews({ provider: "github", repositoryDigest });
    expect(page.reviews.map((entry) => entry.identity.reviewId)).toEqual(["PR_1"]);
    expect(execGh).toHaveBeenCalledTimes(4);
    expect(execGh.mock.calls[0]![0]).toEqual(expect.arrayContaining(["-f", "state=all"]));
  });

  it("fails closed when every verified open-review snapshot pair changes", async () => {
    const template = (JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>)[0]!;
    let sequence = 0;
    const execGh = vi.fn(async () => {
      sequence += 1;
      return JSON.stringify([{ ...template, id: sequence, node_id: `PR_${sequence}`, number: sequence, html_url: `${repo.canonicalUrl}/pull/${sequence}` }]);
    });
    await expect(new GitHubAdapter(execGh, repo).listOpenReviews({ provider: "github", repositoryDigest })).rejects.toBeInstanceOf(ConcurrentGitHubMutationError);
    expect(execGh).toHaveBeenCalledTimes(6);
  });

  it("continues 250 equal-time open reviews with a compact snapshot-bound token", async () => {
    const template = (JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>)[0]!;
    const rows = Array.from({ length: 250 }, (_, index) => ({ ...template, id: index + 1, node_id: `PR_${index + 1}`, number: index + 1,
      updated_at: "2026-08-12T10:00:00Z", html_url: `${repo.canonicalUrl}/pull/${index + 1}` }));
    const execGh = vi.fn(async (args: string[]) => {
      const page = Number(args.find((arg) => arg.startsWith("page="))?.slice(5) ?? "1");
      return JSON.stringify(rows.slice((page - 1) * 100, page * 100));
    });
    const adapter = new GitHubAdapter(execGh, repo);
    const found: string[] = [];
    let token: import("../../../src/vcs/conversation-adapter.js").OpenReviewPageToken | undefined;
    do {
      const page = await adapter.listOpenReviews({ provider: "github", repositoryDigest }, undefined, token);
      found.push(...page.reviews.map((entry) => entry.identity.reviewId));
      token = page.nextPageToken;
      if (token) expect(Buffer.byteLength(token.opaque)).toBeLessThan(4_000);
    } while (token);
    expect(found).toEqual(rows.map((row) => row.node_id));
  });

  it("rejects a continuation whose cutoff was altered without its checksum", async () => {
    const template = (JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>)[0]!;
    const rows = Array.from({ length: 101 }, (_, index) => ({ ...template, id: index + 1, node_id: `PR_${index + 1}`, number: index + 1,
      updated_at: "2026-08-12T10:00:00Z", html_url: `${repo.canonicalUrl}/pull/${index + 1}` }));
    const execGh = vi.fn(async (args: string[]) => JSON.stringify(args.includes("page=1") ? rows.slice(0, 100) : rows.slice(100)));
    const adapter = new GitHubAdapter(execGh, repo);
    const first = await adapter.listOpenReviews({ provider: "github", repositoryDigest });
    const token = JSON.parse(first.nextPageToken!.opaque) as Record<string, unknown>;
    token.cutoff = `${String(token.cutoff)}-tampered`;
    await expect(adapter.listOpenReviews({ provider: "github", repositoryDigest }, undefined, { ...first.nextPageToken!, opaque: JSON.stringify(token) })).rejects.toThrow(/checksum/i);
  });

  it("records a compact terminal cutoff so a completed equal-time tie does not replay forever", async () => {
    const template = (JSON.parse(readFixture("gh-open-prs.json")) as Array<Record<string, unknown>>)[0]!;
    const rows = Array.from({ length: 101 }, (_, index) => ({ ...template, id: index + 1, node_id: `PR_${index + 1}`, number: index + 1,
      updated_at: "2026-08-12T10:00:00Z", html_url: `${repo.canonicalUrl}/pull/${index + 1}` }));
    const execGh = vi.fn(async (args: string[]) => JSON.stringify(args.includes("page=1") ? rows.slice(0, 100) : rows.slice(100)));
    const adapter = new GitHubAdapter(execGh, repo);
    const first = await adapter.listOpenReviews({ provider: "github", repositoryDigest });
    const last = await adapter.listOpenReviews({ provider: "github", repositoryDigest }, undefined, first.nextPageToken);
    expect(JSON.parse(last.nextCursor!.opaque)).toMatchObject({ at: "2026-08-12T10:00:00.000Z", cutoff: expect.any(String) });
    await expect(adapter.listOpenReviews({ provider: "github", repositoryDigest }, last.nextCursor)).resolves.toMatchObject({ reviews: [] });
  });

  it("normalizes issue and inline comments in total updated-time order, including edits", async () => {
    const fixture = JSON.parse(readFixture("gh-review-activity.json")) as { issueComments: unknown[]; reviewComments: unknown[] };
    const execGh = vi.fn(async (args: string[]) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") return readFixture("gh-review-threads.json");
      return JSON.stringify(args.some((arg) => arg.includes("issues/42/comments")) ? fixture.issueComments : fixture.reviewComments);
    });
    const events = await new GitHubAdapter(execGh, repo).listReviewEvents(review);
    expect(events.events.map((event) => [event.kind, event.commentId, event.authorIsBot])).toEqual([
      ["thread-resolution", undefined, undefined], ["comment-edit", "7", false], ["thread-comment", "8", true],
    ]);
    expect(events.events[2]).toMatchObject({ threadId: "T1", placement: { file: "src/a.ts", line: 4, side: "new", outdated: false, currentHeadSha: "b".repeat(40) } });
    expect(events.nextCursor).toMatchObject({ scope: "review-events", reviewNumber: 42 });
    expect(execGh.mock.calls.filter(([args]) => (args as string[]).includes("per_page=50"))).toHaveLength(4);
    expect(execGh.mock.calls.flatMap(([args]) => args as string[])).not.toContain("--paginate");
  });

  it("keeps an unseen changed revision at the same cursor timestamp regardless of digest order", async () => {
    const fixture = JSON.parse(readFixture("gh-review-activity.json")) as { issueComments: Array<Record<string, unknown>>; reviewComments: unknown[] };
    fixture.issueComments[0]!.body = "changed again";
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) :
      args[1] === "graphql" ? readFixture("gh-review-threads.json") : JSON.stringify(args.some((arg) => arg.includes("issues/42/comments")) ? fixture.issueComments : fixture.reviewComments));
    const cursor = { scope: "review-events" as const, provider: "github" as const, repositoryDigest, reviewNumber: 42,
      opaque: JSON.stringify({ at: "2026-08-02T00:00:00Z", seen: ["deadbeef"] }), orderKey: "2026-08-02T00:00:00Z" };
    const page = await new GitHubAdapter(execGh, repo).listReviewEvents(review, cursor);
    expect(page.events).toHaveLength(2);
    expect(page.events[0]!.updatedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("never regresses an event high-water when a traversal observes only older rows", async () => {
    const fixture = JSON.parse(readFixture("gh-review-activity.json")) as { issueComments: unknown[]; reviewComments: unknown[] };
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) :
      args[1] === "graphql" ? readFixture("gh-review-threads.json") : JSON.stringify(args.some((arg) => arg.includes("issues/42/comments")) ? fixture.issueComments : fixture.reviewComments));
    const boundary = { at: "2027-01-01T00:00:00.000Z", seen: [] as string[] };
    const cursor = { scope: "review-events" as const, provider: "github" as const, repositoryDigest, reviewNumber: 42, opaque: JSON.stringify(boundary), orderKey: boundary.at };
    let token: import("../../../src/vcs/conversation-adapter.js").ReviewEventPageToken | undefined;
    let last = cursor;
    do {
      const page = await new GitHubAdapter(execGh, repo).listReviewEvents(review, cursor, token);
      expect(page.events).toHaveLength(0);
      expect(page.nextCursor.orderKey).toBe(boundary.at);
      last = page.nextCursor;
      token = page.nextPageToken;
    } while (token);
    expect(JSON.parse(last.opaque)).toEqual(boundary);
  });

  it("emits resolved and reopened thread snapshot revisions without a new comment", async () => {
    const activity = JSON.parse(readFixture("gh-review-activity.json")) as { issueComments: unknown[]; reviewComments: unknown[] };
    const threads = JSON.parse(readFixture("gh-review-threads.json")) as { data: { repository: { pullRequest: Record<string, unknown> & { reviewThreads: { nodes: Array<Record<string, unknown>> } } } } };
    threads.data.repository.pullRequest.updatedAt = "2026-08-03T00:00:00Z";
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) :
      args[1] === "graphql" ? JSON.stringify(threads) : JSON.stringify(args.some((arg) => arg.includes("issues/42/comments")) ? activity.issueComments : activity.reviewComments));
    const adapter = new GitHubAdapter(execGh, repo);
    const first = await adapter.listReviewEvents(review);
    threads.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved = true;
    threads.data.repository.pullRequest.updatedAt = "2026-08-04T00:00:00Z";
    const resolved = await adapter.listReviewEvents(review, first.nextCursor);
    expect(resolved.events).toMatchObject([{ kind: "thread-resolution", threadId: "T1", resolved: true, updatedAt: "2026-08-04T00:00:00.000Z" }]);
    threads.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved = false;
    threads.data.repository.pullRequest.updatedAt = "2026-08-05T00:00:00Z";
    const reopened = await adapter.listReviewEvents(review, resolved.nextCursor);
    expect(reopened.events).toMatchObject([{ kind: "thread-resolution", threadId: "T1", resolved: false, updatedAt: "2026-08-05T00:00:00.000Z" }]);
  });

  it("pages an interleaved three-stream activity traversal with bounded exact continuation state", async () => {
    const at = (index: number) => new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
    const issueRows = Array.from({ length: 120 }, (_, index) => ({ id: 1000 + index, body: `issue-${index}`, user: { login: "alice" }, created_at: at(index), updated_at: at(index), html_url: `${review.url}#issuecomment-${1000 + index}` }));
    const inlineRows = Array.from({ length: 120 }, (_, index) => ({ id: 2000 + index, body: `inline-${index}`, user: { login: "bob" }, created_at: at(index), updated_at: at(index), html_url: `${review.url}#discussion_r${2000 + index}`, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42", path: `src/${index}.ts`, line: 1, side: "RIGHT", commit_id: "a".repeat(40) }));
    const threadNodes = inlineRows.map((row, index) => ({ id: `T${index}`, isResolved: index % 2 === 0, isOutdated: false, subjectType: "LINE", diffSide: "RIGHT", path: row.path, line: 1, originalLine: 1,
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ databaseId: row.id, body: row.body, author: { login: "bob" }, createdAt: at(index), updatedAt: at(index), url: row.html_url, commit: { oid: "a".repeat(40) }, originalCommit: { oid: "a".repeat(40) }, replyTo: null }] } }));
    const execGh = vi.fn(async (args: string[]) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") {
        const cursorArg = args.find((arg) => arg.startsWith("cursor="));
        const start = cursorArg === undefined ? 0 : Number(cursorArg.slice("cursor=T".length));
        const nodes = threadNodes.slice(start, start + 100);
        const end = start + nodes.length;
        return JSON.stringify({ data: { repository: { pullRequest: { id: review.reviewId, url: review.url, headRefOid: "a".repeat(40), updatedAt: "2026-09-01T00:00:00Z",
          reviewThreads: { pageInfo: { hasNextPage: end < threadNodes.length, endCursor: end < threadNodes.length ? `T${end}` : null }, nodes } } } } });
      }
      const pageArg = args.find((arg) => arg.startsWith("page="));
      const start = ((Number(pageArg?.slice(5) ?? "1")) - 1) * 50;
      return JSON.stringify((args.some((arg) => arg.includes("issues/42/comments")) ? issueRows : inlineRows).slice(start, start + 50));
    });
    const adapter = new GitHubAdapter(execGh, repo);
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
    expect(execGh.mock.calls.flatMap(([args]) => args as string[])).not.toEqual(expect.arrayContaining(["--paginate", "--slurp"]));
  });

  it("continues 300 equal-time activity revisions and terminally advances without starvation", async () => {
    const at = "2026-08-12T10:00:00Z";
    const rows = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, body: `issue-${index}`, user: { login: "alice" }, created_at: at,
      updated_at: at, html_url: `${review.url}#issuecomment-${index + 1}` }));
    const emptyThreads = JSON.stringify({ data: { repository: { pullRequest: { id: review.reviewId, url: review.url, headRefOid: "a".repeat(40), updatedAt: at,
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    const execGh = vi.fn(async (args: string[]) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") return emptyThreads;
      if (args.some((arg) => arg.includes("pulls/42/comments"))) return "[]";
      const page = Number(args.find((arg) => arg.startsWith("page="))?.slice(5) ?? "1");
      return JSON.stringify(rows.slice((page - 1) * 50, page * 50));
    });
    const adapter = new GitHubAdapter(execGh, repo);
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

  it("resolves the GraphQL pull request node id as reviewId", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      data: { repository: { pullRequest: { id: "PR_kwDO42", url: review.url } } },
    }));
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.resolveReviewIdentity(repo, 42)).resolves.toEqual({
      provider: "github",
      repositoryDigest,
      reviewNumber: 42,
      reviewId: "PR_kwDO42",
      url: review.url,
    });
    expect("PR_kwDO42").not.toBe("42");
    expect(repositoryDigest).toBe(computeRepositoryDigest("github", repo.canonicalUrl));
  });

  it("canonicalizes mixed-case owner/repo into one review identity digest", async () => {
    const mixed = parseRepositoryRef("Octo-Org/Octo-Repo", "github");
    const canonical = parseRepositoryRef("octo-org/octo-repo", "github");
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      data: { repository: { pullRequest: { id: "PR_kwDO42", url: `${mixed.canonicalUrl}/pull/42` } } },
    }));
    const adapter = new GitHubAdapter(execGh, mixed);
    await expect(adapter.resolveReviewIdentity(mixed, 42)).resolves.toEqual({
      provider: "github",
      repositoryDigest: computeRepositoryDigest("github", canonical.canonicalUrl),
      reviewNumber: 42,
      reviewId: "PR_kwDO42",
      url: `${canonical.canonicalUrl}/pull/42`,
    });
    expect(computeRepositoryDigest("github", mixed.canonicalUrl))
      .not.toBe(computeRepositoryDigest("github", canonical.canonicalUrl));
  });

  it("pages GraphQL thread summaries and can fetch a complete addressed thread", async () => {
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) : readFixture("gh-review-threads.json"));
    const adapter = new GitHubAdapter(execGh, repo);
    const page = await adapter.listReviewThreads(review);
    expect(page.threads[0]).toMatchObject({ threadId: "T1", rootCommentId: "8", outdated: false, resolved: false });
    const snapshot = await adapter.getReviewThread(review, "T1");
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ kind: "thread-comment", threadId: "T1", commentId: "8" });
  });

  it("normalizes a nullable FILE review thread without a line", async () => {
    const fixture = JSON.parse(readFixture("gh-review-threads.json")) as { data: { repository: { pullRequest: { reviewThreads: { nodes: Array<Record<string, unknown>> } } } } };
    const node = fixture.data.repository.pullRequest.reviewThreads.nodes[0];
    Object.assign(node, { subjectType: "FILE", diffSide: "RIGHT", line: null, originalLine: null });
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) : JSON.stringify(fixture));
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.listReviewThreads(review)).resolves.toMatchObject({ threads: [{ placement: { file: "src/a.ts", side: "new", outdated: false } }] });
    expect((await adapter.getReviewThread(review, "T1")).placement).not.toHaveProperty("line");
    expect(execGh.mock.calls.find(([args]) => (args as string[])[1] === "graphql")?.[0].join(" ")).toContain("subjectType diffSide path line originalLine");
  });

  it("posts replies with stdin JSON and validates the returned binding", async () => {
    const execGh = vi.fn(async (args: string[], stdin?: string) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") return readFixture("gh-review-threads.json");
      const body = JSON.parse(stdin ?? "{}") as { body?: string };
      const id = args.some((arg) => arg.includes("comments/8/replies")) ? 10 : 9;
      return JSON.stringify({ id, body: body.body, user: { login: "octo-bot" }, html_url: `https://github.com/octo-org/octo-repo/pull/42#${id === 9 ? "issuecomment-" : "discussion_r"}${id}`, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42", ...(id === 10 ? { in_reply_to_id: 8 } : {}) });
    });
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.postGeneralReply(review, { provider: "github", repositoryDigest, reviewNumber: 42, body: "hello" })).resolves.toMatchObject({ commentId: "9" });
    await expect(adapter.postThreadReply(review, { provider: "github", repositoryDigest, reviewNumber: 42, threadId: "T1", parentCommentId: "8", body: "reply" })).resolves.toMatchObject({ commentId: "10", threadId: "T1" });
    expect(execGh).toHaveBeenCalledWith(["api", "repos/octo-org/octo-repo/issues/42/comments", "--hostname", "github.com", "-X", "POST", "--input", "-"], JSON.stringify({ body: "hello" }));
    expect(execGh).toHaveBeenCalledWith(["api", "repos/octo-org/octo-repo/pulls/42/comments/8/replies", "--hostname", "github.com", "-X", "POST", "--input", "-"], JSON.stringify({ body: "reply" }));
  });

  it("rejects a thread reply when the parent is outside the addressed GraphQL thread", async () => {
    const execGh = vi.fn(async (args: string[]) => args[1] === "graphql" ? readFixture("gh-review-threads.json") : JSON.stringify({ login: "octo-bot" }));
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.postThreadReply(review, { provider: "github", repositoryDigest, reviewNumber: 42, threadId: "T1", parentCommentId: "999", body: "reply" })).rejects.toThrow(/parent.*thread/i);
    expect(execGh.mock.calls.some(([args]) => (args as string[]).includes("POST"))).toBe(false);
  });

  it("posts a reply addressed to a nested comment through the thread root endpoint", async () => {
    const fixture = JSON.parse(readFixture("gh-review-threads.json")) as { data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ comments: { nodes: Array<Record<string, unknown>> } }> } } } } };
    fixture.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes.push({
      databaseId: 9, body: "nested", author: { login: "alice" }, createdAt: "2026-08-01T00:00:01Z", updatedAt: "2026-08-01T00:00:01Z",
      url: `${review.url}#discussion_r9`, commit: { oid: "a".repeat(40) }, originalCommit: { oid: "a".repeat(40) }, replyTo: { databaseId: 8 },
    });
    const execGh = vi.fn(async (args: string[], stdin?: string) => {
      if (args.includes("POST")) return JSON.stringify({ id: 10, body: JSON.parse(stdin!).body, user: { login: "octo-bot" }, html_url: `${review.url}#discussion_r10`, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42", in_reply_to_id: 8 });
      return args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) : JSON.stringify(fixture);
    });
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.postThreadReply(review, { provider: "github", repositoryDigest, reviewNumber: 42, threadId: "T1", parentCommentId: "9", body: "reply" })).resolves.toMatchObject({ commentId: "10", threadId: "T1" });
    expect(execGh).toHaveBeenCalledWith(["api", "repos/octo-org/octo-repo/pulls/42/comments/8/replies", "--hostname", "github.com", "-X", "POST", "--input", "-"], JSON.stringify({ body: "reply" }));
  });

  it("ignores spoofed markers and rejects multiple authenticated matches", async () => {
    const visibleBody = "trusted finding";
    const contentDigest = computeContentDigest(visibleBody);
    const marker = formatChildMarker({ kind: "finding", parentId: `act_${"a".repeat(32)}`, childId: `finding_${"b".repeat(32)}`, repositoryDigest, reviewNumber: 42, contentDigest });
    const comments = [
      { id: 1, body: `${visibleBody}\n${marker}`, user: { login: "mallory" }, html_url: "https://github.com/octo-org/octo-repo/pull/42#issuecomment-1" },
      { id: 2, body: `${visibleBody}\n${marker}`, user: { login: "octo-bot" }, html_url: "https://github.com/octo-org/octo-repo/pull/42#issuecomment-2" },
      { id: 3, body: `${visibleBody}\n${marker}`, user: { login: "octo-bot" }, html_url: "https://github.com/octo-org/octo-repo/pull/42#issuecomment-3" },
    ];
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) : args.some((arg) => arg.includes("issues/42/comments")) ? JSON.stringify(comments) : "[]");
    const adapter = new GitHubAdapter(execGh, repo);
    await expect(adapter.findBotChildMarker(review, { provider: "github", repositoryDigest, reviewNumber: 42, kind: "finding", parentId: `act_${"a".repeat(32)}`, childId: `finding_${"b".repeat(32)}`, contentDigest })).rejects.toThrow(/multiple.*marker/i);
  });

  it("rejects an authenticated child marker copied onto edited visible content", async () => {
    const contentDigest = computeContentDigest("trusted");
    const expected = { provider: "github" as const, repositoryDigest, reviewNumber: 42, kind: "finding" as const, parentId: `act_${"a".repeat(32)}`, childId: `finding_${"b".repeat(32)}`, contentDigest };
    const marker = formatChildMarker(expected);
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) :
      args.some((arg) => arg.includes("issues/42/comments")) ? JSON.stringify([{ id: 2, body: `edited\n${marker}`, user: { login: "octo-bot" }, html_url: `${review.url}#issuecomment-2` }]) : "[]");
    await expect(new GitHubAdapter(execGh, repo).findBotChildMarker(review, expected)).rejects.toThrow(/body digest/i);
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
    const execGh = vi.fn(async (args: string[]) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") {
        return JSON.stringify({
          data: { repository: { pullRequest: { id: "PR_kwDO42", url: "https://github.com/octo-org/octo-repo/pull/42" } } },
        });
      }
      if (args.some((arg) => String(arg).includes("issues/42/comments"))) {
        return JSON.stringify([{
          id: 2,
          body: `${visibleBody}\n${marker}`,
          user: { login: "octo-bot" },
          html_url: "https://github.com/octo-org/octo-repo/pull/42#issuecomment-2",
        }]);
      }
      return "[]";
    });
    await expect(new GitHubAdapter(execGh, repo).findPublishedMarker({
      kind: "repository",
      repo,
      number: 42,
    }, marker)).resolves.toMatchObject({ commentId: "2" });
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

  // A tool-posted inline body: what renderInlineComment emits always ends
  // with INLINE_COMMENT_MARKER. `body` defaults to that shape; pass a custom
  // body to model a MANUAL comment written by the same account.
  function threadsPage(
    nodes: { id: string; isResolved: boolean; author: string; body?: string }[],
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
                comments: {
                  nodes: [
                    {
                      author: { login: n.author },
                      body: n.body ?? `**Some finding**\n\n${INLINE_COMMENT_MARKER}`,
                    },
                  ],
                },
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

    const count = await adapter.resolveStaleReviewThreads(locator42);

    expect(count).toBe(1);
    expect(resolvedThreadIds()).toEqual(["T-bot-open"]);
  });

  // Codex review (PR #6): same-account MANUAL comments must never be
  // auto-resolved. When the CLI runs under a developer's personal gh login,
  // the author check alone can't tell the tool's comments from the human's —
  // the inline marker is what does.
  it("codex fix: a same-account thread WITHOUT the inline marker (a manual comment) is never resolved", async () => {
    const { execGh, resolvedThreadIds } = makeResolveExecGh([
      threadsPage([
        {
          id: "T-manual",
          isResolved: false,
          author: "tgd-review-agent[bot]",
          body: "I hand-wrote this note about the design; please discuss.",
        },
        { id: "T-tool", isResolved: false, author: "tgd-review-agent[bot]" },
      ]),
    ]);
    const adapter = new GitHubAdapter(execGh);

    const count = await adapter.resolveStaleReviewThreads(locator42);

    expect(count).toBe(1);
    expect(resolvedThreadIds()).toEqual(["T-tool"]);
  });

  it("paginates: threads past the first page are still found and resolved", async () => {
    const { execGh, resolvedThreadIds } = makeResolveExecGh([
      threadsPage([{ id: "T-page1", isResolved: false, author: "tgd-review-agent[bot]" }], "CUR1"),
      threadsPage([{ id: "T-page2", isResolved: false, author: "tgd-review-agent[bot]" }]),
    ]);
    const adapter = new GitHubAdapter(execGh);

    const count = await adapter.resolveStaleReviewThreads(locator42);

    expect(count).toBe(2);
    expect(resolvedThreadIds()).toEqual(["T-page1", "T-page2"]);
  });

  it("returns 0 and mutates nothing when there are no stale bot threads", async () => {
    const { execGh, resolvedThreadIds } = makeResolveExecGh([threadsPage([])]);
    const adapter = new GitHubAdapter(execGh);

    expect(await adapter.resolveStaleReviewThreads(locator42)).toBe(0);
    expect(resolvedThreadIds()).toEqual([]);
  });

  it("propagates a failure (the CALLER treats it as non-fatal — see cli-review tests)", async () => {
    const execGh: ExecGh = async (args) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      throw new Error("gh repo view failed");
    };
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.resolveStaleReviewThreads(locator42)).rejects.toThrow(/gh repo view failed/);
  });

  // Gemini review (PR #6): one thread failing to resolve must not abandon the
  // rest of the cleanup — each mutation is individually guarded, and the
  // returned count is what actually resolved.
  it("gemini fix: a single failing mutation warns and continues; the remaining threads still resolve", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolvedIds: string[] = [];
      const execGh: ExecGh = async (args) => {
        if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
        if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "octo-org/octo-repo" });
        const query = args.find((a) => a.startsWith("query="));
        if (query?.startsWith("query=mutation(")) {
          const threadId = args.find((a) => a.startsWith("threadId="))?.slice("threadId=".length);
          if (threadId === "T-flaky") throw new Error("HTTP 502 transient");
          resolvedIds.push(threadId ?? "");
          return JSON.stringify({ data: { resolveReviewThread: { thread: { id: "x" } } } });
        }
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "T-flaky", isResolved: false, comments: { nodes: [{ author: { login: "tgd-review-agent[bot]" }, body: INLINE_COMMENT_MARKER }] } },
                    { id: "T-ok", isResolved: false, comments: { nodes: [{ author: { login: "tgd-review-agent[bot]" }, body: INLINE_COMMENT_MARKER }] } },
                  ],
                },
              },
            },
          },
        });
      };
      const adapter = new GitHubAdapter(execGh);

      const count = await adapter.resolveStaleReviewThreads(locator42);

      expect(count).toBe(1); // what actually resolved, not what was attempted
      expect(resolvedIds).toEqual(["T-ok"]);
      const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warned).toContain("T-flaky");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Gemini review (PR #6): a GraphQL-level failure ({errors:[...]} with no
  // data) must THROW — the optional chaining would otherwise read it as
  // "zero threads" and silently return 0, hiding the failure entirely.
  it("gemini fix: a GraphQL errors-only response rejects instead of silently returning 0", async () => {
    const execGh: ExecGh = async (args) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "octo-org/octo-repo" });
      return JSON.stringify({ errors: [{ message: "Something went wrong" }] });
    };
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.resolveStaleReviewThreads(locator42)).rejects.toThrow(
      /missing expected data/,
    );
  });

  it("gemini fix: an unexpected gh repo view shape rejects with a message naming the cause (never a bare TypeError)", async () => {
    const execGh: ExecGh = async (args) => {
      if (args[0] === "api" && args[1] === "user") return readFixture("gh-user.json");
      if (args[0] === "repo") return JSON.stringify({ unexpected: true });
      throw new Error("should not get here");
    };
    const adapter = new GitHubAdapter(execGh);

    await expect(adapter.resolveStaleReviewThreads(locator42)).rejects.toThrow(
      /invalid response from gh repo view/,
    );
  });
});

// ADR-007: a multi-line committable suggestion spans start_line..line. GitHub
// requires start_side alongside start_line, and start_line < line.
describe("createInlineReview: multi-line suggestion ranges", () => {
  it("posts one atomic review and recovers every identity after an incomplete direct response", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const execGh: ExecGh = async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") return inlineThreadsFixture([100, 101], ["a.ts", "b.ts"]);
      if (args.includes("POST")) return "{}";
      const posted = calls.find((call) => call.args.includes("POST"));
      if (!posted) return "[]";
      const bodies = (JSON.parse(posted.stdin!) as { comments: { body: string }[] }).comments.map((comment, index) => ({
        id: 100 + index, body: comment.body, user: { login: "octo-bot" },
        path: index === 0 ? "a.ts" : "b.ts", line: index === 0 ? 13 : 5, side: "RIGHT",
        ...(index === 0 ? { start_line: 11, start_side: "RIGHT" } : {}), commit_id: "d".repeat(40),
        html_url: `https://github.com/octo-org/octo-repo/pull/42#discussion_r${100 + index}`,
        pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42",
      }));
      return JSON.stringify(bodies);
    };
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    const adapter = new GitHubAdapter(execGh, repo);

    const comments = [
      { clientId: "finding-0", path: "a.ts", line: 13, startLine: 11, body: "multi", position: {} as never },
      { clientId: "finding-1", path: "b.ts", line: 5, body: "single", position: {} as never },
    ];
    const outcomes = await adapter.createInlineReview({ kind: "repository", repo, number: 42 }, "d".repeat(40), comments);
    expect(outcomes).toMatchObject([
      { clientId: "finding-0", status: "posted", identity: { commentId: "100" } },
      { clientId: "finding-1", status: "posted", identity: { commentId: "101" } },
    ]);
    expect(calls.filter((call) => call.args.includes("POST"))).toHaveLength(1);
    expect(JSON.parse(calls.find((call) => call.args.includes("POST"))!.stdin!)).toMatchObject({
      commit_id: "d".repeat(40), event: "COMMENT", body: "tGD inline review",
      comments: [{ path: "a.ts", line: 13, side: "RIGHT", start_line: 11, start_side: "RIGHT" }, { path: "b.ts", line: 5, side: "RIGHT" }],
    });
  });

  it("fails closed after an accepted write with partial recovery and never posts twice", async () => {
    let posts = 0;
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    const adapter = new GitHubAdapter(async (args, stdin) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args.includes("POST")) { posts += 1; return "{}"; }
      if (posts === 0) return "[]";
      const body = (JSON.parse(stdin ?? "{}") as { body?: string }).body;
      void body;
      return "[]";
    }, repo);
    const comments = [
      { clientId: "finding-0", path: "a.ts", line: 1, body: "a", position: {} as never },
      { clientId: "finding-1", path: "b.ts", line: 2, body: "b", position: {} as never },
    ];
    await expect(adapter.createInlineReview({ kind: "repository", repo, number: 42 }, "d".repeat(40), comments)).rejects.toBeInstanceOf(AmbiguousInlinePublishError);
    expect(posts).toBe(1);
  });

  it("posts the same client/body again on a later head because the marker binds head and placement", async () => {
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    const posted: Array<{ body: string; head: string }> = [];
    let currentHead = "a".repeat(40);
    const execGh: ExecGh = async (args, stdin) => {
      if (args[1] === "user") return JSON.stringify({ login: "octo-bot" });
      if (args[1] === "graphql") return inlineThreadsFixture(posted.map((_, index) => 200 + index), posted.map(() => "a.ts"), currentHead, posted.map(() => 13));
      if (args.includes("POST")) {
        const payload = JSON.parse(stdin!) as { commit_id: string; comments: Array<{ body: string }> };
        currentHead = payload.commit_id;
        posted.push(...payload.comments.map((comment) => ({ body: comment.body, head: payload.commit_id })));
        return "{}";
      }
      return JSON.stringify(posted.map((comment, index) => ({ id: 200 + index, body: comment.body, user: { login: "octo-bot" }, path: "a.ts", line: 13, side: "RIGHT", commit_id: comment.head, html_url: `https://github.com/octo-org/octo-repo/pull/42#discussion_r${200 + index}`, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42" })));
    };
    const adapter = new GitHubAdapter(execGh, repo);
    const comments = [{ clientId: "finding-0", path: "a.ts", line: 13, body: "same", position: {} as never }];
    await adapter.createInlineReview({ kind: "repository", repo, number: 42 }, "a".repeat(40), comments);
    await adapter.createInlineReview({ kind: "repository", repo, number: 42 }, "b".repeat(40), comments);
    expect(posted).toHaveLength(2);
    expect(posted[0]!.body.split(/\r?\n/u).at(-1)).not.toBe(posted[1]!.body.split(/\r?\n/u).at(-1));
  });

  it("prepares exact run-bound child markers so an earlier same-head/config child cannot recover", async () => {
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    const repositoryDigest = computeRepositoryDigest("github", repo.canonicalUrl);
    const adapter = new GitHubAdapter(vi.fn(), repo);
    const comments = [{ clientId: "finding-0", path: "a.ts", line: 1, body: "same", position: {} as never }];
    const first = await adapter.prepareInlineReviewRecovery({ kind: "repository", repo, number: 42 }, "a".repeat(40), comments, "config-a");
    const second = await adapter.prepareInlineReviewRecovery({ kind: "repository", repo, number: 42 }, "a".repeat(40), comments, "config-b");
    expect(first.children[0]).toMatchObject({ clientId: "finding-0", kind: "finding", repositoryDigest, reviewNumber: 42, headSha: "a".repeat(40) });
    expect(first.children[0]!.marker).not.toBe(second.children[0]!.marker);
    expect(first.children[0]!.parentId).not.toBe(second.children[0]!.parentId);
  });

  it("recovers only exact full child markers and ignores same-head content, placement, and config variants", async () => {
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    let rows: unknown[] = [];
    const execGh = vi.fn(async (args: string[]) => args[1] === "user" ? JSON.stringify({ login: "octo-bot" }) : JSON.stringify(rows));
    const adapter = new GitHubAdapter(execGh, repo);
    const locator = { kind: "repository" as const, repo, number: 42 };
    const head = "a".repeat(40);
    const comment = (body: string, line: number) => [{ clientId: "finding-0", path: "a.ts", line, body, position: {} as never }];
    const expected = await adapter.prepareInlineReviewRecovery(locator, head, comment("current", 2), "config-current");
    const variants = await Promise.all([
      adapter.prepareInlineReviewRecovery(locator, head, comment("old", 2), "config-current"),
      adapter.prepareInlineReviewRecovery(locator, head, comment("current", 1), "config-current"),
      adapter.prepareInlineReviewRecovery(locator, head, comment("current", 2), "config-old"),
    ]);
    rows = variants.map((manifest, index) => ({ id: index + 1, body: `body\n${manifest.children[0]!.marker}`, user: { login: "octo-bot" }, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42" }));
    await expect(adapter.recoverInlineReview(locator, expected)).resolves.toBe("none");
    rows.push({ id: 9, body: `current\n${INLINE_COMMENT_MARKER}\n${expected.children[0]!.marker}`, user: { login: "octo-bot" }, path: "a.ts", line: 2, side: "RIGHT", start_line: null, start_side: null, commit_id: head, pull_request_url: "https://api.github.com/repos/octo-org/octo-repo/pulls/42" });
    await expect(adapter.recoverInlineReview(locator, expected)).resolves.toBe("complete");
  });

  it("rejects duplicate or tampered recovery manifests before any GitHub API call", async () => {
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    const execGh = vi.fn();
    const adapter = new GitHubAdapter(execGh, repo);
    const locator = { kind: "repository" as const, repo, number: 42 };
    const comments = [
      { clientId: "finding-0", path: "a.ts", line: 1, body: "a", position: {} as never },
      { clientId: "finding-1", path: "b.ts", line: 2, body: "b", position: {} as never },
    ];
    const manifest = await adapter.prepareInlineReviewRecovery(locator, "a".repeat(40), comments, "config");
    const first = manifest.children[0]!;
    for (const children of [
      [first, { ...manifest.children[1]!, childId: first.childId, marker: first.marker }],
      [first, { ...manifest.children[1]!, marker: first.marker }],
      [{ ...first, childId: `finding_${"0".repeat(32)}` }],
    ]) {
      await expect(adapter.recoverInlineReview(locator, { ...manifest, children } as never)).rejects.toThrow(/manifest|recovery/i);
    }
    expect(execGh).not.toHaveBeenCalled();
  });

  it("rejects explicit recovery repository and review mismatches before any GitHub API call", async () => {
    const repo = parseRepositoryRef("octo-org/octo-repo", "github");
    const execGh = vi.fn();
    const adapter = new GitHubAdapter(execGh, repo);
    const locator = { kind: "repository" as const, repo, number: 42 };
    const comments = [{ clientId: "finding-0", path: "a.ts", line: 1, body: "a", position: {} as never }];
    const manifest = await adapter.prepareInlineReviewRecovery(locator, "a".repeat(40), comments, "config");

    await expect(adapter.recoverInlineReview({ ...locator, number: 43 }, manifest)).rejects.toThrow(/review mismatch/i);
    const otherRepo = parseRepositoryRef("octo-org/other-repo", "github");
    await expect(adapter.recoverInlineReview({ ...locator, repo: otherRepo }, manifest)).rejects.toThrow(/repository mismatch/i);
    expect(execGh).not.toHaveBeenCalled();
  });

  it("validates complete, unique, known outcome IDs", () => {
    const comments = [
      { clientId: "finding-0", path: "a.ts", line: 1, body: "a", position: {} as never },
      { clientId: "finding-1", path: "b.ts", line: 2, body: "b", position: {} as never },
    ];
    expect(() => validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "failed", reason: "safe" },
    ])).toThrow(/complete/i);
    expect(() => validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "failed", reason: "safe" },
      { clientId: "finding-0", status: "failed", reason: "safe" },
    ])).toThrow(/duplicate/i);
    expect(() => validateInlinePublishOutcomes(comments, [
      { clientId: "finding-0", status: "failed", reason: "safe" },
      { clientId: "unknown", status: "failed", reason: "safe" },
    ])).toThrow(/unknown/i);
  });
});
