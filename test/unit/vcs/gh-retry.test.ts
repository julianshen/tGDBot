// Issue #30: a review aborted outright because one `gh api` read hit
// "error connecting to api.github.com". Nothing retried, and the operator saw a
// raw command dump rather than "the network blipped".
//
// Retrying is only safe for provably read-only invocations: replaying a POST
// would duplicate a review comment.
import { describe, expect, it, vi } from "vitest";
import { isReadOnlyGhInvocation, isTransientGhFailure, retryTransientGh } from "../../../src/vcs/gh-retry.js";

describe("isReadOnlyGhInvocation", () => {
  it.each([
    [["api", "-X", "GET", "-f", "per_page=50", "repos/o/r/issues/1/comments"], true],
    [["api", "repos/o/r/pulls/42"], true],
    [["pr", "view", "42", "--json", "title"], true],
    [["api", "graphql", "-f", "query=query($o:String!){repository(owner:$o){id}}"], true],
  ])("treats %s as read-only", (args, expected) => {
    expect(isReadOnlyGhInvocation(args as string[])).toBe(expected);
  });

  it.each([
    [["api", "repos/o/r/pulls/42/reviews", "-X", "POST", "--input", "-"]],
    [["api", "repos/o/r/issues/comments/9", "-X", "PATCH", "--input", "-"]],
    [["api", "repos/o/r/pulls/comments/9", "-X", "DELETE"]],
    [["api", "graphql", "-f", "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id}}}"]],
    [["pr", "comment", "42", "--body-file", "-"]],
  ])("never treats %s as read-only", (args) => {
    expect(isReadOnlyGhInvocation(args as string[])).toBe(false);
  });
});

describe("isTransientGhFailure", () => {
  it.each([
    ["error connecting to api.github.com", true],
    ["getaddrinfo ENOTFOUND api.github.com", true],
    ["read ECONNRESET", true],
    ["HTTP 503: No server is currently available", true],
    ["HTTP 502 Bad Gateway", true],
    ["socket hang up", true],
    ["gh: Not Found (HTTP 404)", false],
    ["gh: Bad credentials (HTTP 401)", false],
    ["GitHub rejected request (HTTP 422)", false],
  ])("classifies %s", (message, expected) => {
    expect(isTransientGhFailure(new Error(message))).toBe(expected);
  });
});

describe("retryTransientGh", () => {
  it("retries a transient read and returns the eventual success", async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("error connecting to api.github.com");
      return "[]";
    });

    const wrapped = retryTransientGh(exec, { attempts: 3, delayMs: () => 0 });

    await expect(wrapped(["api", "-X", "GET", "repos/o/r/issues/1/comments"])).resolves.toBe("[]");
    expect(calls).toBe(3);
  });

  it("never retries a write, even a transient one", async () => {
    const exec = vi.fn(async () => {
      throw new Error("error connecting to api.github.com");
    });

    const wrapped = retryTransientGh(exec, { attempts: 3, delayMs: () => 0 });

    await expect(wrapped(["api", "repos/o/r/pulls/42/reviews", "-X", "POST", "--input", "-"], "{}"))
      .rejects.toThrow(/error connecting/u);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("never retries a definite rejection", async () => {
    const exec = vi.fn(async () => {
      throw new Error("gh: Not Found (HTTP 404)");
    });

    const wrapped = retryTransientGh(exec, { attempts: 3, delayMs: () => 0 });

    await expect(wrapped(["api", "-X", "GET", "repos/o/r/pulls/9"])).rejects.toThrow(/404/u);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and surfaces the last error", async () => {
    const exec = vi.fn(async () => {
      throw new Error("error connecting to api.github.com");
    });

    const wrapped = retryTransientGh(exec, { attempts: 3, delayMs: () => 0 });

    await expect(wrapped(["api", "-X", "GET", "repos/o/r/pulls/9"])).rejects.toThrow(/error connecting/u);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("passes stdin and options straight through", async () => {
    const exec = vi.fn(async () => "ok");
    const wrapped = retryTransientGh(exec, { attempts: 2, delayMs: () => 0 });

    await wrapped(["api", "-X", "GET", "x"], "payload", { timeoutMs: 1234 });

    expect(exec).toHaveBeenCalledWith(["api", "-X", "GET", "x"], "payload", { timeoutMs: 1234 });
  });
});
