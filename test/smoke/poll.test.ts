// End-to-end poll smoke tests. Unlike test/unit/poll, these drive the REAL
// GitHubAdapter and GitLabAdapter, with only the `gh`/`glab` process seam
// faked, so provider translation is exercised rather than stubbed: argv
// construction, response parsing, pagination, and identity validation all run
// for real. No network, no credentials, no model.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { poll } from "../../src/poll/poll.js";
import { parseCommandArgs, type PollArgs } from "../../src/cli-args.js";
import { createConversationStateStore } from "../../src/conversation/state-store.js";
import { GitHubAdapter } from "../../src/vcs/github-adapter.js";
import { GitLabAdapter } from "../../src/vcs/gitlab-adapter.js";
import { parseRepositoryRef } from "../../src/target/review-target.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-poll-smoke-")));
  temporaryRoots.push(directory);
  return path.join(directory, "state");
}

function pollArgs(repo: string, stateDir: string, vcs: "github" | "gitlab"): PollArgs {
  const parsed = parseCommandArgs(["poll", "--repo", repo, "--vcs", vcs, "--state-dir", stateDir]);
  if (parsed.command !== "poll") throw new Error("expected poll args");
  return parsed;
}

/**
 * Dispatches on argv the way the real CLI would, and throws on anything it was
 * not taught about. A silent default would let the adapter drift away from what
 * this test claims to cover.
 */
function fakeExec(routes: readonly { match: (args: readonly string[]) => boolean; reply: string }[]) {
  const calls: string[][] = [];
  const exec = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const route = routes.find((candidate) => candidate.match(args));
    if (route === undefined) throw new Error(`unrouted CLI call: ${args.join(" ")}`);
    return route.reply;
  };
  return { exec, calls };
}

describe("poll smoke: first-run bootstrap through the real adapters", () => {
  it("bootstraps a GitHub repository without handling history", async () => {
    const stateDir = await tempStateDir();
    const repository = parseRepositoryRef("owner/repo", "github");
    const { exec, calls } = fakeExec([
      { match: (args) => args.includes("user") || args.includes("/user"), reply: JSON.stringify({ login: "tgdbot" }) },
      // `gh api .../pulls` is REST and slurped as an array: an empty repository
      // is an empty page, which is what bootstrap should record nothing from.
      { match: (args) => args.some((arg) => arg.endsWith("/pulls")), reply: "[]" },
    ]);
    const adapter = new GitHubAdapter(exec, repository);

    await expect(poll(pollArgs("owner/repo", stateDir, "github"), {
      conversationAdapter: adapter,
    })).resolves.toBe(0);

    expect(calls.length).toBeGreaterThan(0);
    const snapshot = await createConversationStateStore({ root: stateDir, repository }).readContextSnapshot();
    // Bootstrap records where to resume from and handles nothing that predates it.
    expect(snapshot.cursor.initialized).toBe(true);
    expect(snapshot.events).toEqual([]);
  });

  it("bootstraps a GitLab project without handling history", async () => {
    const stateDir = await tempStateDir();
    const repository = parseRepositoryRef("https://gitlab.com/group/project", "gitlab");
    const { exec, calls } = fakeExec([
      { match: (args) => args.some((arg) => arg.includes("user")), reply: JSON.stringify({ username: "tgdbot" }) },
      // NDJSON pagination: no lines is an empty page.
      { match: (args) => args.some((arg) => arg.includes("merge_requests")), reply: "" },
    ]);
    const adapter = new GitLabAdapter(exec, repository);

    await expect(poll(pollArgs("https://gitlab.com/group/project", stateDir, "gitlab"), {
      conversationAdapter: adapter,
    })).resolves.toBe(0);

    expect(calls.length).toBeGreaterThan(0);
    const snapshot = await createConversationStateStore({ root: stateDir, repository }).readContextSnapshot();
    expect(snapshot.cursor.initialized).toBe(true);
    expect(snapshot.events).toEqual([]);
  });
});
