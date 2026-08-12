import { describe, expect, it } from "vitest";

import {
  extractRelatedWork,
  normalizeRelatedWorkState,
  relatedWorkIdentity,
  sanitizeRelatedWorkTitle,
  validateResolvedRelatedWork,
  type RelatedWorkReference,
} from "../../../src/review/related-work.js";

describe("extractRelatedWork", () => {
  it("extracts GitHub references in first-seen order, deduplicates without kind, and removes self", () => {
    const result = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.example.com/acme/widget/pull/9",
      title: "Ship #1, acme/api#2 and [bug](https://github.example.com/acme/widget/issues/3).",
      description: "Duplicate https://github.example.com/acme/widget/pull/1; self #9; `#7`; other https://github.com/acme/widget/issues/8",
    });

    expect(result).toEqual({
      references: [
        expect.objectContaining({ identifier: "#1", number: 1, sourceText: "#1" }),
        expect.objectContaining({ identifier: "acme/api#2", projectPath: "acme/api", number: 2 }),
        expect.objectContaining({ identifier: "#3", kindHint: "issue", sourceText: "https://github.example.com/acme/widget/issues/3" }),
      ],
      omittedCount: 0,
    });
  });

  it("extracts GitLab issue and MR identities separately, including subgroup projects and ports", () => {
    const result = extractRelatedWork({
      provider: "gitlab",
      reviewUrl: "https://git.example.com:8443/group/app/-/merge_requests/5",
      title: "#2 !2 group/sub/api#3 group/sub/api!4",
      description: "https://git.example.com:8443/group/app/-/issues/6 and https://git.example.com:8443/group/app/-/merge_requests/7",
    });

    expect(result.references.map((reference) => [reference.identifier, reference.kindHint])).toEqual([
      ["#2", "issue"],
      ["!2", "merge_request"],
      ["group/sub/api#3", "issue"],
      ["group/sub/api!4", "merge_request"],
      ["#6", "issue"],
      ["!7", "merge_request"],
    ]);
    expect(result.references[0]?.fallbackUrl).toBe("https://git.example.com:8443/group/app/-/issues/2");
  });

  it("ignores code, lookalikes, unsafe paths and malformed review URLs", () => {
    const description = [
      "email x#1@y.test version v#2x worda/b#3x",
      "`#4` and https://evil-git.example.com/a/b/-/issues/5",
      "https://git.example.com/a%2Fb/c/-/issues/6",
      "~~~ts",
      "#7",
    ].join("\n");
    expect(extractRelatedWork({ provider: "gitlab", reviewUrl: "http://git.example.com/a/b/-/merge_requests/1", title: "#9", description }).references).toEqual([]);
    expect(extractRelatedWork({ provider: "gitlab", reviewUrl: "https://git.example.com/a/b/-/merge_requests/1", title: "", description }).references).toEqual([]);
  });

  it("does not close a fenced block when text follows the closing marker", () => {
    const description = ["```js", "```not-a-close", "#7", "```"].join("\n");
    const result = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "",
      description,
    });
    expect(result.references).toEqual([]);
  });

  it("closes fenced blocks with CRLF line endings", () => {
    const result = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "",
      description: "```js\r\n#1\r\n```\r\n#2",
    });
    expect(result.references.map((reference) => reference.identifier)).toEqual(["#2"]);
  });

  it("limits after deduplication and reports only extra unique references", () => {
    const title = Array.from({ length: 12 }, (_, index) => `#${index + 1}`).join(" ") + " #1 #2";
    const result = extractRelatedWork({ provider: "github", reviewUrl: "https://github.com/a/b/pull/99", title, description: "" });
    expect(result.references.map((reference) => reference.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.omittedCount).toBe(2);
  });

  it("rejects invalid numbers and provider URL shapes", () => {
    for (const token of ["#0", "#01", "#9007199254740992", "#1.2", "x#3", "#4x"]) {
      expect(extractRelatedWork({ provider: "github", reviewUrl: "https://github.com/a/b/pull/9", title: token, description: "" }).references).toEqual([]);
    }
    expect(extractRelatedWork({ provider: "github", reviewUrl: "https://github.com/a/b/issues/9", title: "#1", description: "" }).references).toEqual([]);
    expect(extractRelatedWork({ provider: "gitlab", reviewUrl: "https://gitlab.com/a/-/merge_requests/9", title: "#1", description: "" }).references).toEqual([]);
  });

  it("accepts Markdown URL punctuation but not numeric-path prefixes", () => {
    const result = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "[ok](https://github.com/a/b/issues/2), bad https://github.com/a/b/issues/3.1 and https://github.com/a/b/pull/4evil",
      description: "",
    });
    expect(result.references.map((reference) => reference.number)).toEqual([2]);
  });

  it("rejects noncanonical full URLs instead of accepting valid path prefixes", () => {
    const github = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "https://github.com/a/b/issues/3/evil https://github.com/a/b/pull/4%2Fevil",
      description: "",
    });
    const gitlab = extractRelatedWork({
      provider: "gitlab",
      reviewUrl: "https://gitlab.com/a/b/-/merge_requests/9",
      title: "https://gitlab.com/a/b/-/issues/3/evil https://gitlab.com/a/b/-/merge_requests/4%2Fevil",
      description: "",
    });
    expect(github.references).toEqual([]);
    expect(gitlab.references).toEqual([]);
  });

  it("rejects full URLs with query or fragment suffixes", () => {
    const github = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "https://github.com/a/b/issues/3?view=1 https://github.com/a/b/pull/4#discussion",
      description: "",
    });
    const gitlab = extractRelatedWork({
      provider: "gitlab",
      reviewUrl: "https://gitlab.com/a/b/-/merge_requests/9",
      title: "https://gitlab.com/a/b/-/issues/3?view=1 https://gitlab.com/a/b/-/merge_requests/4#note_1",
      description: "",
    });
    expect(github.references).toEqual([]);
    expect(gitlab.references).toEqual([]);
  });

  it("validates complete URL tokens instead of accepting prefixes before RFC path characters", () => {
    const github = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "https://github.com/a/b/issues/3:evil https://github.com/a/b/pull/4;evil https://github.com/a/b/issues/5@evil",
      description: "",
    });
    const gitlab = extractRelatedWork({
      provider: "gitlab",
      reviewUrl: "https://gitlab.com/a/b/-/merge_requests/9",
      title: "https://gitlab.com/a/b/-/issues/3:evil https://gitlab.com/a/b/-/merge_requests/4;evil https://gitlab.com/a/b/-/issues/5@evil",
      description: "",
    });
    expect(github.references).toEqual([]);
    expect(gitlab.references).toEqual([]);
  });

  it("strips only supported sentence and Markdown punctuation from exact URL source text", () => {
    const result = extractRelatedWork({
      provider: "github",
      reviewUrl: "https://github.com/a/b/pull/9",
      title: "[issue](https://github.com/a/b/issues/2), then https://github.com/a/b/pull/3.",
      description: "",
    });
    expect(result.references.map((reference) => reference.sourceText)).toEqual([
      "https://github.com/a/b/issues/2",
      "https://github.com/a/b/pull/3",
    ]);
  });
});

describe("metadata safety", () => {
  const reference: RelatedWorkReference = {
    provider: "github",
    host: "github.example.com",
    projectPath: "a/b",
    number: 4,
    kindHint: "pull_request",
    sourceText: "https://github.example.com/a/b/pull/4",
    identifier: "#4",
    fallbackUrl: "https://github.example.com/a/b/issues/4",
  };

  it("normalizes only compatible known states", () => {
    expect(normalizeRelatedWorkState("issue", "opened")).toBe("open");
    expect(normalizeRelatedWorkState("pull_request", "merged")).toBe("merged");
    expect(normalizeRelatedWorkState("issue", "merged")).toBeUndefined();
    expect(normalizeRelatedWorkState("merge_request", "unknown")).toBeUndefined();
  });

  it("sanitizes titles and truncates by Unicode code point", () => {
    expect(sanitizeRelatedWorkTitle(" a\n\u0000b\tc ")).toBe("a bc");
    expect(sanitizeRelatedWorkTitle("😀".repeat(201))).toBe("😀".repeat(199) + "…");
    expect(sanitizeRelatedWorkTitle(42)).toBeUndefined();
  });

  it("accepts matching resolved metadata and rejects spoofed or malformed candidates", () => {
    expect(validateResolvedRelatedWork(reference, {
      kind: "pull_request",
      title: " PR\n title ",
      state: "merged",
      url: "https://github.example.com/a/b/pull/4",
    })).toEqual(expect.objectContaining({ kind: "pull_request", title: "PR title", state: "merged", url: "https://github.example.com/a/b/pull/4" }));

    for (const candidate of [
      null,
      { kind: "issue", url: "https://github.example.com/a/b/issues/4" },
      { kind: "pull_request", url: "https://github.example.com.evil.test/a/b/pull/4" },
      { kind: "pull_request", url: "https://github.example.com/a/b/pull/4/evil" },
      { kind: "pull_request", url: "https://github.example.com/a%2Fb/pull/4" },
    ]) expect(validateResolvedRelatedWork(reference, candidate)).toBe(reference);
    const hostile = Object.defineProperty({}, "kind", { get() { throw new Error("hostile getter"); } });
    expect(() => validateResolvedRelatedWork(reference, hostile)).not.toThrow();
    expect(validateResolvedRelatedWork(reference, hostile)).toBe(reference);
  });

  it("exposes canonical provider identity", () => {
    expect(relatedWorkIdentity(reference)).toBe("github|github.example.com|443|a/b|4");
  });
});
