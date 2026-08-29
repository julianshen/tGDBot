import { describe, expect, it } from "vitest";
import { parseCommandArgs } from "../../../src/cli-args.js";
import { resolvePollConfig } from "../../../src/poll/config.js";
import { GitHubAdapter } from "../../../src/vcs/github-adapter.js";
import { GitLabAdapter } from "../../../src/vcs/gitlab-adapter.js";

describe("poll command configuration", () => {
  it("accepts an absolute --state-dir", () => {
    expect(parseCommandArgs([
      "poll", "--repo", "owner/repo", "--state-dir", "/tmp/tgd-state",
    ])).toMatchObject({ stateDir: "/tmp/tgd-state" });
  });

  it.each(["relative/state", ""])("rejects non-absolute --state-dir %j", (stateDir) => {
    expect(() => parseCommandArgs([
      "poll", "--repo", "owner/repo", "--state-dir", stateDir,
    ])).toThrow(/--state-dir/);
  });

  it("resolves exactly one GitHub repository, adapter, state root, and shared review options", () => {
    const args = parseCommandArgs([
      "poll", "--repo", "Owner/Repo", "--state-dir", "/tmp/tgd-state",
      "--model", "openai/gpt-5", "--dispatch", "direct", "--advisor", "off",
    ]);
    expect(args.command).toBe("poll");
    if (args.command !== "poll") throw new Error("expected poll");
    const config = resolvePollConfig(args);
    expect(config.repository).toMatchObject({
      provider: "github",
      owner: "Owner",
      repo: "Repo",
      canonicalUrl: "https://github.com/Owner/Repo",
    });
    expect(config.conversationAdapter).toBeInstanceOf(GitHubAdapter);
    expect(config.vcsAdapter).toBe(config.conversationAdapter);
    expect(config.stateRoot).toBe("/tmp/tgd-state");
    expect(config).toMatchObject({
      model: "openai/gpt-5",
      dispatch: "direct",
      advisor: "off",
      rulesDir: ".review/rules",
      suggestions: "on",
      dryRun: false,
    });
    expect(config).not.toHaveProperty("locator");
  });

  it("resolves an explicit GitLab repository through the matching adapter", () => {
    const args = parseCommandArgs([
      "poll", "--vcs", "gitlab", "--repo", "gitlab.example.com/group/project",
      "--state-dir", "/tmp/tgd-state",
    ]);
    expect(args.command).toBe("poll");
    if (args.command !== "poll") throw new Error("expected poll");
    const config = resolvePollConfig(args);
    expect(config.repository).toMatchObject({
      provider: "gitlab",
      host: "gitlab.example.com",
      repo: "project",
    });
    expect(config.conversationAdapter).toBeInstanceOf(GitLabAdapter);
  });

  it("rejects ambient or implicit repositories for poll", () => {
    const args = parseCommandArgs(["poll", "--repo", "owner/repo", "--state-dir", "/tmp/tgd-state"]);
    expect(args.command).toBe("poll");
    if (args.command !== "poll") throw new Error("expected poll");
    expect(() => resolvePollConfig({ ...args, repo: "" })).toThrow(/--repo|repository|ambient/i);
  });
});
