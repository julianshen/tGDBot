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

  it("uses the referenced cross-repository project in the exact github.com arguments", async () => {
    const ref = reference(21, { projectPath: "other/project", identifier: "other/project#21" });
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Cross repo", state: "OPEN", html_url: "https://github.com/other/project/issues/21",
    }));
    await resolveGitHubRelatedWork([ref], execGh);
    expect(execGh).toHaveBeenCalledWith(
      ["api", "-X", "GET", "repos/other/project/issues/21", "--hostname", "github.com"],
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

  it("does not accept the semantically impossible merged state for an issue", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Issue", state: "MERGED", html_url: "https://github.com/octo/repo/issues/4",
    }));
    const [result] = await resolveGitHubRelatedWork([reference(4)], execGh);
    expect(result).toMatchObject({ kind: "issue", title: "Issue" });
    expect(result?.state).toBeUndefined();
  });

  it.each([
    ["OPEN", "open"],
    ["closed", "closed"],
    ["MERGED", "merged"],
    ["unknown", undefined],
  ] as const)("normalizes pull-request state %s to %s", async (providerState, expected) => {
    const ref = reference(6);
    const execGh = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ pull_request: {} }))
      .mockResolvedValueOnce(JSON.stringify({
        title: "PR", state: providerState, url: "https://github.com/octo/repo/pull/6",
      }));
    const [result] = await resolveGitHubRelatedWork([ref], execGh);
    expect(result).toMatchObject({ kind: "pull_request", title: "PR" });
    expect(result?.state).toBe(expected);
  });

  it.each([
    ["host", "https://evil.example/octo/repo/issues/10", {}],
    ["normalized port", "https://github.com:8443/octo/repo/issues/10", {}],
    ["project", "https://github.com/octo/other/issues/10", {}],
    ["number", "https://github.com/octo/repo/issues/11", {}],
    ["kind", "https://github.com/octo/repo/issues/10", { kindHint: "pull_request" as const }],
  ])("rejects metadata with a mismatched %s", async (_boundary, url, overrides) => {
    const ref = reference(10, overrides);
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({ title: "Wrong", state: "open", html_url: url }));
    expect(await resolveGitHubRelatedWork([ref], execGh)).toEqual([ref]);
  });

  it("accepts an explicitly written default HTTPS port after URL normalization", async () => {
    const execGh = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Normalized", state: "open", html_url: "https://github.com:443/octo/repo/issues/10",
    }));
    await expect(resolveGitHubRelatedWork([reference(10)], execGh)).resolves.toEqual([
      expect.objectContaining({ title: "Normalized", url: "https://github.com/octo/repo/issues/10" }),
    ]);
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
    expect(warn).toHaveBeenCalledWith("Failed to resolve github related work octo/repo#2");
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
    expect(warn).toHaveBeenCalledWith("Failed to resolve github related work octo/repo#9");
    warn.mockRestore();
  });

  it("reconstructs a safe canonical warning instead of logging caller-controlled fields", async () => {
    const ref = reference(14, {
      projectPath: "other/project",
      identifier: "TOKEN=secret\nforged",
      sourceText: "private body",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await resolveGitHubRelatedWork([ref], vi.fn().mockRejectedValue(new Error("stderr credential")));
    expect(warn).toHaveBeenCalledWith("Failed to resolve github related work other/project#14");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/TOKEN|secret|forged|private body|stderr|credential/i);
    warn.mockRestore();
  });

  it("uses a safe placeholder when a direct caller supplies a hostile project path", async () => {
    const ref = reference(15, { projectPath: "other/project\nTOKEN=secret", identifier: "also private" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await resolveGitHubRelatedWork([ref], vi.fn().mockRejectedValue(new Error("stderr credential")));
    expect(warn).toHaveBeenCalledWith("Failed to resolve github related work [invalid]#15");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/TOKEN|secret|other|private|stderr|credential/i);
    warn.mockRestore();
  });

  it.each([
    ["authentication rejection", new Error("authentication failed")],
    ["not-found rejection", new Error("HTTP 404")],
    ["timeout rejection", new Error("timed out")],
  ])("does not try PR lookup or issue fallback after an initial %s", async (_case, failure) => {
    const ref = reference(13);
    const execGh = vi.fn().mockRejectedValue(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await resolveGitHubRelatedWork([ref], execGh)).toEqual([ref]);
    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenNthCalledWith(1,
      ["api", "-X", "GET", "repos/octo/repo/issues/13", "--hostname", "github.com"],
      undefined,
      { timeoutMs: 5_000 },
    );
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

// Issue #30: when the GitHub API is unreachable, every reference lookup fails
// the same way. Retrying each one multiplies a dead network by the reference
// count — up to ten references times the retry budget — before the review can
// continue. The first transient failure is enough to know the rest will fail.
describe("resolveGitHubRelatedWork: transient outage short-circuits", () => {
  it("stops calling the provider once the network is proven unreachable", async () => {
    const execGh = vi.fn(async () => {
      throw new Error("error connecting to api.github.com");
    });
    const references = Array.from({ length: 8 }, (_, index) => ({
      provider: "github" as const,
      kind: "issue" as const,
      identifier: `#${index + 1}`,
      projectPath: "acme/app",
      number: index + 1,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await resolveGitHubRelatedWork(references as never, execGh as never);

    warn.mockRestore();
    // Every reference still comes back — unresolved, never dropped.
    expect(resolved).toHaveLength(8);
    // But the provider is not hammered once it is clearly down.
    expect(execGh.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps resolving after an ordinary per-reference failure", async () => {
    let call = 0;
    const execGh = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("gh: Not Found (HTTP 404)");
      return JSON.stringify({ title: "ok", state: "OPEN", url: "https://github.com/acme/app/issues/2" });
    });
    const references = Array.from({ length: 4 }, (_, index) => ({
      provider: "github" as const,
      kind: "issue" as const,
      identifier: `#${index + 1}`,
      projectPath: "acme/app",
      number: index + 1,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await resolveGitHubRelatedWork(references as never, execGh as never);

    warn.mockRestore();
    expect(resolved).toHaveLength(4);
    // A 404 says nothing about the network, so the rest are still attempted.
    expect(execGh.mock.calls.length).toBeGreaterThan(1);
  });
});
