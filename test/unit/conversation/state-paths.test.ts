import type { Stats } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseRepositoryRef } from "../../../src/target/review-target.js";
import {
  deriveConversationStatePaths,
  prepareConversationStatePaths,
  selectConversationStateRoot,
} from "../../../src/conversation/state-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "tgd-state-paths-")));
  temporaryDirectories.push(directory);
  return directory;
}

describe("selectConversationStateRoot", () => {
  test("uses explicit, environment, XDG, HOME, then LOCALAPPDATA precedence", () => {
    expect(selectConversationStateRoot({ explicitStateDir: "/explicit", platform: "linux", env: {
      TGD_REVIEW_STATE_DIR: "/env", XDG_STATE_HOME: "/xdg", HOME: "/home",
    } })).toBe("/explicit");
    expect(selectConversationStateRoot({ platform: "linux", env: {
      TGD_REVIEW_STATE_DIR: "/env", XDG_STATE_HOME: "/xdg", HOME: "/home",
    } })).toBe("/env");
    expect(selectConversationStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "/xdg", HOME: "/home" } }))
      .toBe("/xdg/tgd-review-agent");
    expect(selectConversationStateRoot({ platform: "linux", env: { HOME: "/home" } }))
      .toBe("/home/.local/state/tgd-review-agent");
    expect(selectConversationStateRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } }))
      .toBe("C:\\Users\\me\\AppData\\Local\\tgd-review-agent\\state");
  });

  test.each(["", "relative", "../escape", "/", "/tmp/\0bad", "/tmp/\u001fbad"])(
    "rejects unsafe explicit path %j",
    (explicitStateDir) => expect(() => selectConversationStateRoot({ explicitStateDir, platform: "linux", env: {} })).toThrow(),
  );

  test("rejects relative environment paths and missing platform fallback", () => {
    expect(() => selectConversationStateRoot({ platform: "linux", env: { XDG_STATE_HOME: "relative" } })).toThrow();
    expect(() => selectConversationStateRoot({ platform: "linux", env: {} })).toThrow(/HOME|state/i);
    expect(() => selectConversationStateRoot({ platform: "win32", env: {} })).toThrow(/LOCALAPPDATA/i);
  });
});

describe("repository state paths", () => {
  test("encodes providers, nested namespaces, ports, and similar names without collision", async () => {
    const root = await temporaryDirectory();
    const github = deriveConversationStatePaths(root, parseRepositoryRef("owner/repo", "github"));
    const nested = deriveConversationStatePaths(root, parseRepositoryRef("https://gitlab.example.com:8443/a/b/repo", "gitlab"));
    const similar = deriveConversationStatePaths(root, parseRepositoryRef("https://gitlab.example.com:8443/a-b/repo", "gitlab"));
    expect(new Set([github.repositoryRoot, nested.repositoryRoot, similar.repositoryRoot]).size).toBe(3);
    expect(nested.repositoryRoot).not.toBe(similar.repositoryRoot);
    for (const candidate of Object.values(nested)) {
      const relative = path.relative(nested.repositoryRoot, candidate);
      if (candidate !== nested.root && candidate !== nested.repositoryRoot) {
        expect(relative.startsWith("..")).toBe(false);
      }
    }
    expect(path.basename(nested.cursorPath)).toBe("cursor.json");
    expect(path.basename(nested.eventsPath)).toBe("events.jsonl");
    expect(path.basename(nested.memoriesPath)).toBe("memories.jsonl");
    expect(path.basename(nested.findingsPath)).toBe("findings.jsonl");
    expect(path.basename(nested.pendingPath)).toBe("pending.json");
    expect(path.basename(nested.lockPath)).toBe(".conversation.lock");
    expect(path.basename(nested.transactionIntentPath)).toBe(".conversation-transaction.json");
    expect(path.basename(nested.journalHeadPath)).toBe("journal-head.json");
  });

  test("validates canonical repository references", async () => {
    const root = await temporaryDirectory();
    const repo = { ...parseRepositoryRef("owner/repo", "github"), canonicalUrl: "https://github.com/other/repo" };
    expect(() => deriveConversationStatePaths(root, repo)).toThrow(/canonical/i);
  });

  test("uses injected Windows path semantics when deriving repository paths", () => {
    const paths = deriveConversationStatePaths("C:\\state",
      parseRepositoryRef("https://gitlab.example.com:8443/a/b/repo", "gitlab"), "win32");
    expect(paths.repositoryRoot).toBe(
      "C:\\state\\repositories\\gitlab\\gitlab.example.com%3A8443\\a\\b\\repo",
    );
    expect(paths.transactionIntentPath).toBe(`${paths.repositoryRoot}\\.conversation-transaction.json`);
  });

  test("uses one lowercase state domain for case-equivalent GitHub repositories", async () => {
    const root = await temporaryDirectory();
    const mixed = deriveConversationStatePaths(root, parseRepositoryRef("Owner/Repo", "github"));
    const lower = deriveConversationStatePaths(root, parseRepositoryRef("owner/repo", "github"));
    expect(mixed.repositoryRoot).toBe(lower.repositoryRoot);
    expect(mixed.lockPath).toBe(lower.lockPath);
  });

  test("creates owner-only directories and rejects symlink candidates", async () => {
    if (process.platform === "win32") return;
    const parent = await temporaryDirectory();
    const root = path.join(parent, "state");
    const paths = deriveConversationStatePaths(root, parseRepositoryRef("owner/repo", "github"));
    await prepareConversationStatePaths(paths);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.repositoryRoot)).mode & 0o777).toBe(0o700);

    const other = path.join(parent, "other");
    await mkdir(other);
    await rm(paths.repositoryRoot, { recursive: true });
    await symlink(other, paths.repositoryRoot);
    await expect(prepareConversationStatePaths(paths)).rejects.toThrow(/symbolic link/i);
  });

  test("rejects a symlink at every managed repository directory level", async () => {
    if (process.platform === "win32") return;
    const parent = await temporaryDirectory();
    const other = path.join(parent, "other");
    await mkdir(other, { mode: 0o700 });
    for (const level of ["state", "state/repositories", "state/repositories/gitlab",
      "state/repositories/gitlab/gitlab.example.com%3A8443", "state/repositories/gitlab/gitlab.example.com%3A8443/a",
      "state/repositories/gitlab/gitlab.example.com%3A8443/a/b",
      "state/repositories/gitlab/gitlab.example.com%3A8443/a/b/repo"]) {
      const root = path.join(parent, "state");
      const candidate = path.join(parent, ...level.split("/"));
      await rm(root, { recursive: true, force: true });
      await mkdir(path.dirname(candidate), { recursive: true, mode: 0o700 });
      await symlink(other, candidate);
      const paths = deriveConversationStatePaths(root,
        parseRepositoryRef("https://gitlab.example.com:8443/a/b/repo", "gitlab"));
      await expect(prepareConversationStatePaths(paths)).rejects.toThrow(/symbolic link/i);
    }
  });

  test("rejects unsafe managed modes and injectable foreign ownership", async () => {
    if (process.platform === "win32") return;
    const parent = await temporaryDirectory();
    const root = path.join(parent, "state");
    const paths = deriveConversationStatePaths(root, parseRepositoryRef("owner/repo", "github"));
    await prepareConversationStatePaths(paths);
    const providerDirectory = path.join(root, "repositories", "github");
    await chmod(providerDirectory, 0o733);
    await expect(prepareConversationStatePaths(paths)).rejects.toThrow(/permission|writable|mode/i);
    await chmod(providerDirectory, 0o700);

    const actualUid = process.getuid();
    await expect(prepareConversationStatePaths(paths, {
      platform: "linux",
      uid: actualUid,
      fileSystem: {
        lstat: async (candidate) => {
          const info = await lstat(candidate);
          return candidate === root
            ? new Proxy(info, { get: (target, property, receiver) =>
              property === "uid" ? actualUid + 1 : Reflect.get(target, property, receiver) }) as Stats
            : info;
        },
      },
    })).rejects.toThrow(/owned|owner/i);
  });
});
