import { describe, expect, it } from "vitest";
import path from "node:path";
import { contextRoots, selectContextRoot } from "../../../src/context/root.js";

// The precedence order and the two throws below are what the CLI's degrade path
// names when it reports "repository context is unavailable" before a single
// byte is mapped — an operator reading that message is reading this function's
// decision. Pinned here because every branch is environment-dependent and so
// none of it is exercised by any other test on the machine that runs the suite.
describe("selectContextRoot", () => {
  it("prefers an explicit --context-dir over every environment source", () => {
    expect(
      selectContextRoot({
        explicitContextDir: "/srv/ctx",
        platform: "linux",
        env: { TGD_REVIEW_CONTEXT_DIR: "/env/ctx", XDG_CACHE_HOME: "/xdg", HOME: "/home/u" },
      }),
    ).toBe("/srv/ctx");
  });

  it("prefers TGD_REVIEW_CONTEXT_DIR over the platform default", () => {
    expect(
      selectContextRoot({ platform: "linux", env: { TGD_REVIEW_CONTEXT_DIR: "/env/ctx", HOME: "/home/u" } }),
    ).toBe("/env/ctx");
  });

  it("uses XDG_CACHE_HOME ahead of HOME on POSIX", () => {
    expect(selectContextRoot({ platform: "linux", env: { XDG_CACHE_HOME: "/xdg", HOME: "/home/u" } }))
      .toBe("/xdg/tgd-review-agent");
  });

  it("falls back to ~/.cache on POSIX", () => {
    expect(selectContextRoot({ platform: "linux", env: { HOME: "/home/u" } }))
      .toBe("/home/u/.cache/tgd-review-agent");
  });

  it("uses LOCALAPPDATA on Windows and never consults HOME or XDG_CACHE_HOME", () => {
    expect(
      selectContextRoot({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", XDG_CACHE_HOME: "/xdg", HOME: "/home/u" },
      }),
    ).toBe(path.win32.join("C:\\Users\\u\\AppData\\Local", "tgd-review-agent", "context"));
  });

  // A container with neither set is the case this exists for: the CLI catches
  // the throw and degrades, rather than writing a cache somewhere it guessed.
  it("refuses to guess when the POSIX default has no HOME", () => {
    expect(() => selectContextRoot({ platform: "linux", env: {} }))
      .toThrow(/HOME is required/);
  });

  it("refuses to guess when the Windows default has no LOCALAPPDATA", () => {
    expect(() => selectContextRoot({ platform: "win32", env: {} }))
      .toThrow(/LOCALAPPDATA is required/);
  });

  // Every source is validated by the same rule, so each is checked here: a
  // relative or NUL-bearing root would otherwise be resolved against whatever
  // the process happened to have as its cwd.
  it.each([
    ["Explicit context directory", { explicitContextDir: "relative/ctx", env: {} }],
    ["TGD_REVIEW_CONTEXT_DIR", { env: { TGD_REVIEW_CONTEXT_DIR: "relative/ctx" } }],
    ["XDG_CACHE_HOME", { env: { XDG_CACHE_HOME: "relative" } }],
    ["HOME", { env: { HOME: "relative" } }],
  ])("rejects a relative %s", (name, options) => {
    expect(() => selectContextRoot({ platform: "linux", ...options }))
      .toThrow(new RegExp(`${name} must be an absolute path`));
  });

  it("rejects a NUL byte in an otherwise absolute root", () => {
    expect(() => selectContextRoot({ explicitContextDir: "/srv/c\0tx", platform: "linux", env: {} }))
      .toThrow(/must be an absolute path/);
  });

  it("normalizes a traversal-bearing root rather than passing it through", () => {
    expect(selectContextRoot({ explicitContextDir: "/srv/ctx/../ctx2", platform: "linux", env: {} }))
      .toBe("/srv/ctx2");
  });
});

describe("contextRoots", () => {
  // The workspace holds a checkout of the PR's BASE commit and the cache holds
  // text that is handed to the model as [TRUSTED_CONTEXT]. They are separate
  // subtrees so that protecting or discarding one says nothing about the other.
  it("splits the root into disjoint workspace and cache subtrees", () => {
    const roots = contextRoots(path.join(path.sep, "srv", "ctx"));
    expect(roots.workspaceRoot).toBe(path.join(path.sep, "srv", "ctx", "workspaces"));
    expect(roots.cacheRoot).toBe(path.join(path.sep, "srv", "ctx", "cache"));
    expect(roots.workspaceRoot).not.toBe(roots.cacheRoot);
  });
});
