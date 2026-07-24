import { describe, expect, it } from "vitest";
import {
  parseRepositoryRef,
  parseReviewTarget,
} from "../../../src/target/review-target.js";

describe("parseReviewTarget", () => {
  it("parses and normalizes a canonical GitHub pull-request URL", () => {
    expect(parseReviewTarget("https://github.com/Example-Org/Review_Tool/pull/42/")).toEqual({
      provider: "github",
      repo: {
        provider: "github",
        host: "github.com",
        owner: "Example-Org",
        repo: "Review_Tool",
        canonicalUrl: "https://github.com/Example-Org/Review_Tool",
      },
      number: 42,
      canonicalUrl: "https://github.com/Example-Org/Review_Tool/pull/42",
    });
  });

  it("parses a self-hosted GitLab merge-request URL with a nested namespace", () => {
    expect(
      parseReviewTarget(
        "https://gitlab.example.com/group/sub/project/-/merge_requests/42",
      ),
    ).toEqual({
      provider: "gitlab",
      repo: {
        provider: "gitlab",
        host: "gitlab.example.com",
        port: undefined,
        namespace: ["group", "sub"],
        repo: "project",
        canonicalUrl: "https://gitlab.example.com/group/sub/project",
      },
      number: 42,
      canonicalUrl:
        "https://gitlab.example.com/group/sub/project/-/merge_requests/42",
    });
  });

  it("retains an explicit default HTTPS port in a GitLab merge-request identity", () => {
    expect(
      parseReviewTarget(
        "https://gitlab.example.com:443/group/project/-/merge_requests/42",
      ),
    ).toEqual({
      provider: "gitlab",
      repo: {
        provider: "gitlab",
        host: "gitlab.example.com",
        port: 443,
        namespace: ["group"],
        repo: "project",
        canonicalUrl: "https://gitlab.example.com:443/group/project",
      },
      number: 42,
      canonicalUrl:
        "https://gitlab.example.com:443/group/project/-/merge_requests/42",
    });
  });

  it("rejects a review URL when it does not match the expected provider", () => {
    expect(() =>
      parseReviewTarget(
        "https://gitlab.com/group/project/-/merge_requests/42",
        "github",
      ),
    ).toThrow(/provider/i);
  });

  it.each([
    ["credentials", "https://user:secret@gitlab.com/group/project/-/merge_requests/42"],
    ["HTTP", "http://gitlab.com/group/project/-/merge_requests/42"],
    ["a query", "https://gitlab.com/group/project/-/merge_requests/42?x=1"],
    ["a fragment", "https://gitlab.com/group/project/-/merge_requests/42#note"],
    ["a zero IID", "https://gitlab.com/group/project/-/merge_requests/0"],
    ["an encoded slash", "https://gitlab.com/group%2Fadmin/project/-/merge_requests/42"],
    ["an encoded dot segment", "https://gitlab.com/group/%2e%2e/project/-/merge_requests/42"],
    ["a control character", "https://gitlab.com/group/proj\tect/-/merge_requests/42"],
    ["a missing namespace", "https://gitlab.com/project/-/merge_requests/42"],
    ["a missing project", "https://gitlab.com/group/-/merge_requests/42"],
    ["a malformed marker", "https://gitlab.com/group/project/merge_requests/42"],
    ["a malformed suffix", "https://gitlab.com/group/project/-/merge_requests/42/files"],
  ])("rejects GitLab review targets containing %s", (_case, input) => {
    expect(() => parseReviewTarget(input)).toThrow(/review target|GitLab/i);
  });

  it.each([
    "https://gitlab.com/group/.%2e/project/-/merge_requests/42",
    "https://gitlab.com/group/%2e./project/-/merge_requests/42",
  ])("rejects the encoded dot-segment variant %s before URL normalization", (input) => {
    expect(() => parseReviewTarget(input)).toThrow(/encoded|dot/i);
  });

  it.each([
    "https://github.com/acme/widget/issues/42",
    "https://github.com/acme/widget/pull/0",
    "https://github.com/acme/widget/pull/42/files",
    "https://github.com/acme/widget/pull/42?view=files",
    "https://github.com/acme%2Fadmin/widget/pull/42",
  ])("continues to reject the invalid GitHub target %s", (input) => {
    expect(() => parseReviewTarget(input)).toThrow();
  });
});

describe("parseRepositoryRef", () => {
  it("retains an explicit HTTPS port as repository identity", () => {
    expect(
      parseRepositoryRef(
        "gitlab.example.com:8443/group/sub/project",
        "gitlab",
      ),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.example.com",
      port: 8443,
      namespace: ["group", "sub"],
      repo: "project",
      canonicalUrl: "https://gitlab.example.com:8443/group/sub/project",
    });
  });

  it("retains an explicit default HTTPS port as repository identity", () => {
    expect(
      parseRepositoryRef(
        "https://gitlab.example.com:443/group/project",
        "gitlab",
      ),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.example.com",
      port: 443,
      namespace: ["group"],
      repo: "project",
      canonicalUrl: "https://gitlab.example.com:443/group/project",
    });
  });

  it.each([
    "user:secret@gitlab.example.com/group/project",
    "user@gitlab.example.com/group/project",
    "user:secret@localhost/group/project",
  ])("rejects credentials in host/path repository selector %s without echoing them", (input) => {

    let caught: unknown;
    try {
      parseRepositoryRef(input, "gitlab");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/credentials/i);
    expect((caught as Error).message).not.toContain("user");
    expect((caught as Error).message).not.toContain("secret");
  });

  it.each([
    "group/sub/project",
    "https://gitlab.com/group/sub/project",
    "git@gitlab.com:group/sub/project.git",
    "ssh://git@gitlab.com/group/sub/project.git",
  ])("normalizes the GitLab repository form %s", (input) => {
    expect(parseRepositoryRef(input, "gitlab")).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      port: undefined,
      namespace: ["group", "sub"],
      repo: "project",
      canonicalUrl: "https://gitlab.com/group/sub/project",
    });
  });

  it.each([
    "https://user:secret@gitlab.com/group/project",
    "http://gitlab.com/group/project",
    "https://gitlab.com/group/project?x=1",
    "https://gitlab.com/group/project#x",
    "https://gitlab.com/group%2Fsub/project",
    "https://gitlab.com/group/%2e%2e/project",
    "gitlab.com/group",
  ])("rejects the invalid GitLab repository form %s", (input) => {
    expect(() => parseRepositoryRef(input, "gitlab")).toThrow();
  });

  it("rejects a GitLab repository parsed as GitHub", () => {
    expect(() =>
      parseRepositoryRef("gitlab.example.com/group/project", "github"),
    ).toThrow(/GitHub|provider/i);
  });
});
