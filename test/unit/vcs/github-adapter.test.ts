import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { GitHubAdapter } from "../../../src/vcs/github-adapter.js";
import type { BotComment } from "../../../src/vcs/adapter.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf-8");

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

  // AC-2.2: Given a mocked comment list containing one comment with body
  // `<!-- tgd-review-agent:sha=abc123... -->`, When findBotComment("42") is
  // called, Then it returns that comment with lastReviewedSha === "abc123...".
  it("AC-2.2: findBotComment extracts lastReviewedSha from the marker comment", async () => {
    const execGh = vi.fn().mockResolvedValue(readFixture("gh-comments.json"));
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    expect(botComment).toEqual({
      id: "222",
      body: "## tGD Review\n\nNo blocking issues found.\n\n<!-- tgd-review-agent:sha=abc1234 -->",
      lastReviewedSha: "abc1234",
    });
    expect(execGh).toHaveBeenCalledWith(["api", "repos/{owner}/{repo}/issues/42/comments"]);
  });

  // AC-2.3: Given a mocked comment list with no marker-bearing comment, When
  // findBotComment("42") is called, Then it returns null.
  it("AC-2.3: findBotComment returns null when no comment has the bot marker", async () => {
    const execGh = vi.fn().mockResolvedValue(readFixture("gh-comments-no-marker.json"));
    const adapter = new GitHubAdapter(execGh);

    const botComment = await adapter.findBotComment("42");

    expect(botComment).toBeNull();
  });

  // AC-2.3 (edge case): an empty comment list also yields null, not a throw.
  it("AC-2.3: findBotComment returns null for an empty comment list", async () => {
    const execGh = vi.fn().mockResolvedValue("[]");
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
});
