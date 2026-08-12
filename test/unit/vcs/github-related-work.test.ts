import { describe, expect, it, vi } from "vitest";
import { resolveGitHubRelatedWork } from "../../../src/vcs/github-related-work.js";
import type { RelatedWorkReference } from "../../../src/review/related-work.js";

const reference = (number: number, overrides: Partial<RelatedWorkReference> = {}): RelatedWorkReference => ({
  provider: "github",
  host: "github.com",
  projectPath: "octo/repo",
  number,
  sourceText: `#${number}`,
  identifier: `#${number}`,
  fallbackUrl: `https://github.com/octo/repo/issues/${number}`,
  ...overrides,
});

describe("resolveGitHubRelatedWork", () => {
  it("resolves an issue with the exact REST lookup and timeout", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Fix it", state: "open", html_url: "https://github.com/octo/repo/issues/12",
    }));
    await expect(resolveGitHubRelatedWork([reference(12)], execGh)).resolves.toEqual([
      expect.objectContaining({ kind: "issue", title: "Fix it", state: "open", url: "https://github.com/octo/repo/issues/12" }),
    ]);
    expect(execGh).toHaveBeenCalledWith(
      ["api", "-X", "GET", "repos/octo/repo/issues/12", "--hostname", "github.com"],
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("uses pr view for pull-request state and supports enterprise ports", async () => {
    const ref = reference(7, { host: "git.example.com", port: "8443", projectPath: "team/app" });
    const execGh = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ pull_request: {}, html_url: "https://git.example.com:8443/team/app/pull/7" }))
      .mockResolvedValueOnce(JSON.stringify({ title: "Ship", state: "MERGED", url: "https://git.example.com:8443/team/app/pull/7" }));
    await expect(resolveGitHubRelatedWork([ref], execGh)).resolves.toEqual([
      expect.objectContaining({ kind: "pull_request", title: "Ship", state: "merged" }),
    ]);
    expect(execGh).toHaveBeenNthCalledWith(1,
      ["api", "-X", "GET", "repos/team/app/issues/7", "--hostname", "git.example.com:8443"], undefined, { timeoutMs: 5_000 });
    expect(execGh).toHaveBeenNthCalledWith(2,
      ["pr", "view", "7", "--repo", "git.example.com:8443/team/app", "--json", "title,state,url"], undefined, { timeoutMs: 5_000 });
  });

  it("normalizes open and closed case-insensitively, and omits unknown states", async () => {
    const execGh = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ title: "A", state: "OPEN", html_url: "https://github.com/octo/repo/issues/1" }))
      .mockResolvedValueOnce(JSON.stringify({ title: "B", state: "closed", html_url: "https://github.com/octo/repo/issues/2" }))
      .mockResolvedValueOnce(JSON.stringify({ title: "C", state: "mystery", html_url: "https://github.com/octo/repo/issues/3" }));
    const result = await resolveGitHubRelatedWork([reference(1), reference(2), reference(3)], execGh);
    expect(result.map(({ state }) => state)).toEqual(["open", "closed", undefined]);
  });

  it("returns malformed, mismatched, and hostile metadata unresolved", async () => {
    const hostile = Object.create(null, { title: { get: () => { throw new Error("secret"); } } });
    const outputs: unknown[] = ["not json", 42, {
      title: "wrong", state: "open", html_url: "https://evil.example/octo/repo/issues/3",
    }, hostile];
    const execGh = vi.fn(async () => {
      const value = outputs.shift();
      return typeof value === "string" ? value : JSON.stringify(value);
    });
    const refs = [1, 2, 3, 4].map(reference);
    expect(await resolveGitHubRelatedWork(refs, execGh)).toEqual(refs);
  });

  it("keeps failures isolated, stable, and does not fall back between kinds", async () => {
    const refs = [reference(1), reference(2), reference(3)];
    const execGh = vi.fn(async (args: string[]) => {
      const number = Number(args[3]?.split("/").at(-1) ?? args[2]);
      if (number === 2) throw Object.assign(new Error("token=secret body"), { stderr: "credential" });
      return JSON.stringify({ title: `Issue ${number}`, state: "open", html_url: `https://github.com/octo/repo/issues/${number}` });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await resolveGitHubRelatedWork(refs, execGh);
    expect(result.map(({ title }) => title)).toEqual(["Issue 1", undefined, "Issue 3"]);
    expect(execGh).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith("Failed to resolve github related work #2");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|credential|body/i);
    warn.mockRestore();
  });

  it("returns a detected pull request unresolved when pr view times out", async () => {
    const ref = reference(9);
    const execGh = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ pull_request: {} }))
      .mockRejectedValueOnce(new Error("timed out with private output"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await resolveGitHubRelatedWork([ref], execGh)).toEqual([ref]);
    expect(execGh).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Failed to resolve github related work #9");
    warn.mockRestore();
  });

  it("does not issue GitHub calls for other providers", async () => {
    const ref = reference(1, { provider: "gitlab" });
    const execGh = vi.fn();
    expect(await resolveGitHubRelatedWork([ref], execGh)).toEqual([ref]);
    expect(execGh).not.toHaveBeenCalled();
  });

  it("limits concurrent lookups to three while preserving order", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const execGh = vi.fn(async (args: string[]) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      const number = args[3]!.split("/").at(-1)!;
      return JSON.stringify({ title: number, state: "open", html_url: `https://github.com/octo/repo/issues/${number}` });
    });
    const pending = resolveGitHubRelatedWork([1, 2, 3, 4, 5].map(reference), execGh);
    await vi.waitFor(() => expect(execGh).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(execGh).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());
    expect((await pending).map(({ title }) => title)).toEqual(["1", "2", "3", "4", "5"]);
    expect(maximum).toBe(3);
  });
});
