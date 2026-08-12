import { describe, expect, it, vi } from "vitest";
import type { RelatedWorkReference } from "../../../src/review/related-work.js";
import { resolveGitLabRelatedWork } from "../../../src/vcs/gitlab-related-work.js";

const reference = (number: number, overrides: Partial<RelatedWorkReference> = {}): RelatedWorkReference => ({
  provider: "gitlab", host: "gitlab.com", projectPath: "group/project", number,
  kindHint: "issue", sourceText: `#${number}`, identifier: `#${number}`,
  fallbackUrl: `https://gitlab.com/group/project/-/issues/${number}`, ...overrides,
});

describe("resolveGitLabRelatedWork", () => {
  it.each([
    ["issue", "issue", "opened", "open", "issues"],
    ["mr", "merge_request", "merged", "merged", "merge_requests"],
    ["mr", "merge_request", "closed", "closed", "merge_requests"],
  ] as const)("resolves %s metadata using the exact structured invocation", async (command, kind, state, expected, path) => {
    const ref = reference(12, { kindHint: kind });
    const execGlab = vi.fn().mockResolvedValue(JSON.stringify({
      title: "Fix it", state, web_url: `https://gitlab.com/group/project/-/${path}/12`,
    }));
    await expect(resolveGitLabRelatedWork([ref], execGlab)).resolves.toEqual([
      expect.objectContaining({ kind, title: "Fix it", state: expected }),
    ]);
    expect(execGlab).toHaveBeenCalledWith(
      [command, "view", "12", "--repo", "https://gitlab.com/group/project", "--hostname", "gitlab.com", "--output", "json"],
      undefined, { timeoutMs: 5_000 },
    );
  });

  it("uses nested cross-project canonical URLs and preserves nondefault ports", async () => {
    const ref = reference(8, { host: "gitlab.example.com", port: "8443", projectPath: "org/team/app", kindHint: "merge_request" });
    const execGlab = vi.fn().mockResolvedValue(JSON.stringify({ title: "Ship", state: "open", url: "https://gitlab.example.com:8443/org/team/app/-/merge_requests/8" }));
    await resolveGitLabRelatedWork([ref], execGlab);
    expect(execGlab).toHaveBeenCalledWith(
      ["mr", "view", "8", "--repo", "https://gitlab.example.com:8443/org/team/app", "--hostname", "gitlab.example.com:8443", "--output", "json"],
      undefined, { timeoutMs: 5_000 },
    );
  });

  it("omits an explicit standard HTTPS port from canonical arguments", async () => {
    const ref = reference(3, { port: "443" });
    const execGlab = vi.fn().mockResolvedValue(JSON.stringify({ title: "A", state: "open", web_url: "https://gitlab.com/group/project/-/issues/3" }));
    await expect(resolveGitLabRelatedWork([ref], execGlab)).resolves.toEqual([
      expect.objectContaining({ title: "A", state: "open", url: "https://gitlab.com/group/project/-/issues/3" }),
    ]);
    expect(execGlab).toHaveBeenCalledWith(expect.arrayContaining(["--repo", "https://gitlab.com/group/project", "--hostname", "gitlab.com"]), undefined, { timeoutMs: 5_000 });
  });

  it.each(["not json", "42", "{}"])("returns malformed or incomplete output unresolved", async (output) => {
    const ref = reference(1);
    expect(await resolveGitLabRelatedWork([ref], vi.fn().mockResolvedValue(output))).toEqual([ref]);
  });

  it.each([
    ["host", "https://evil.example/group/project/-/issues/4"],
    ["project", "https://gitlab.com/group/other/-/issues/4"],
    ["number", "https://gitlab.com/group/project/-/issues/5"],
    ["kind", "https://gitlab.com/group/project/-/merge_requests/4"],
  ])("rejects mismatched %s metadata", async (_case, web_url) => {
    const ref = reference(4);
    const output = JSON.stringify({ title: "Wrong", state: "opened", web_url });
    expect(await resolveGitLabRelatedWork([ref], vi.fn().mockResolvedValue(output))).toEqual([ref]);
  });

  it("isolates auth, not-found, timeout, and malformed failures without leaking details", async () => {
    const refs = [1, 2, 3, 4].map(reference);
    const execGlab = vi.fn(async (args: readonly string[]) => {
      const number = Number(args[2]);
      if (number < 4) throw Object.assign(new Error("TOKEN=secret body"), { stderr: "credential" });
      return JSON.stringify({ title: "Safe", state: "unknown", web_url: "https://gitlab.com/group/project/-/issues/4" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await resolveGitLabRelatedWork(refs, execGlab);
    expect(result.map(({ title }) => title)).toEqual([undefined, undefined, undefined, "Safe"]);
    expect(result[3]?.state).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Failed to resolve gitlab related work group/project#1");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|credential|body/i);
    warn.mockRestore();
  });

  it("recovers from an injected timeout while a sibling succeeds", async () => {
    const refs = [reference(6), reference(7)];
    const execGlab = vi.fn(async (args: readonly string[]) => {
      if (args[2] === "6") throw Object.assign(new Error("private timeout output"), { code: "ETIMEDOUT" });
      return JSON.stringify({ title: "Sibling", state: "opened", web_url: "https://gitlab.com/group/project/-/issues/7" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await resolveGitLabRelatedWork(refs, execGlab)).toEqual([
      refs[0], expect.objectContaining({ title: "Sibling" }),
    ]);
    expect(execGlab).toHaveBeenNthCalledWith(1, expect.any(Array), undefined, { timeoutMs: 5_000 });
    warn.mockRestore();
  });

  it("reconstructs a safe canonical warning instead of logging caller-controlled fields", async () => {
    const ref = reference(11, {
      projectPath: "group/subgroup/project",
      kindHint: "merge_request",
      identifier: "TOKEN=secret\nforged",
      sourceText: "private body",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await resolveGitLabRelatedWork([ref], vi.fn().mockRejectedValue(new Error("stderr credential")));
    expect(warn).toHaveBeenCalledWith("Failed to resolve gitlab related work group/subgroup/project!11");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/TOKEN|secret|forged|private body|stderr|credential/i);
    warn.mockRestore();
  });

  it("sanitizes hostile title controls through shared validation", async () => {
    const output = JSON.stringify({
      title: "  safe\n title\u0000  ", state: "opened",
      web_url: "https://gitlab.com/group/project/-/issues/9",
    });
    await expect(resolveGitLabRelatedWork([reference(9)], vi.fn().mockResolvedValue(output))).resolves.toEqual([
      expect.objectContaining({ title: "safe title" }),
    ]);
  });

  it("does not invoke glab for non-GitLab or ambiguous references", async () => {
    const refs = [
      reference(1, { provider: "github" }),
      reference(2, { kindHint: undefined }),
      reference(3, { host: "bad host" }),
      reference(0),
      reference(4, { projectPath: "group/../project" }),
    ];
    const execGlab = vi.fn();
    expect(await resolveGitLabRelatedWork(refs, execGlab)).toEqual(refs);
    expect(execGlab).not.toHaveBeenCalled();
  });

  it("limits concurrency to three and preserves input order", async () => {
    let active = 0; let maximum = 0;
    const releases: Array<() => void> = [];
    const execGlab = vi.fn(async (args: readonly string[]) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve)); active--;
      const number = args[2]!;
      return JSON.stringify({ title: number, state: "opened", web_url: `https://gitlab.com/group/project/-/issues/${number}` });
    });
    const pending = resolveGitLabRelatedWork([1, 2, 3, 4, 5].map(reference), execGlab);
    await vi.waitFor(() => expect(execGlab).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(execGlab).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());
    expect((await pending).map(({ title }) => title)).toEqual(["1", "2", "3", "4", "5"]);
    expect(maximum).toBe(3);
  });
});
