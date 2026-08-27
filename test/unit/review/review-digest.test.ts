// Issue #55: the review BODY — the text GitHub treats as the review itself,
// which until now was the four words "tGD inline review".
import { describe, expect, it } from "vitest";
import {
  BOT_SIGNATURE_BLOCK,
  renderInlineComment,
  MAX_REVIEW_DIGEST_CHARS,
  exceedsAtomicPayload,
  renderReviewDigest,
} from "../../../src/review/comment-format.js";
import { parseBotMarker } from "../../../src/review/comment-marker.js";
import type { Finding } from "../../../src/review/types.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleName: "tgd-review",
  file: "src/a.ts",
  line: 10,
  category: "correctness",
  severity: "warning",
  message: "Something is wrong here.",
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  headSha: "a1b2c3d4e5f6",
  allFindings: [finding({ severity: "blocking" }), finding({ severity: "suggestion" })],
  inlineCount: 2,
  unanchored: [],
  filesReviewed: ["src/a.ts"],
  rulesRun: ["tgd-review"],
  rulesFailed: [],
  ...over,
});

describe("renderReviewDigest — what the run found", () => {
  it("leads with the head sha, so an old digest reads as historical", () => {
    // Review bodies are append-only and nothing rewrites them, so the SHA is
    // what stops a three-runs-ago digest being read as current.
    expect(renderReviewDigest(input())).toContain("a1b2c3d");
  });

  it("counts findings by severity", () => {
    const body = renderReviewDigest(input({
      allFindings: [
        finding({ severity: "blocking" }),
        finding({ severity: "blocking" }),
        finding({ severity: "warning" }),
      ],
      inlineCount: 3,
    }));

    expect(body).toMatch(/2 .*[Bb]locking/);
    expect(body).toMatch(/1 .*[Ww]arning/);
  });

  it("says how many landed inline and how many did not", () => {
    const body = renderReviewDigest(input({
      allFindings: [finding(), finding(), finding()],
      inlineCount: 2,
      unanchored: [finding()],
    }));

    expect(body).toMatch(/2/);
    expect(body).toMatch(/1.*(could not be anchored|summary)/i);
  });

  it("names the rules that ran and the ones that failed", () => {
    const body = renderReviewDigest(input({
      rulesRun: ["tgd-review", "security-audit"],
      rulesFailed: ["perf-budget"],
    }));

    expect(body).toContain("tgd-review");
    expect(body).toContain("security-audit");
    expect(body).toContain("perf-budget");
  });

  it("links the summary comment when there is one", () => {
    const body = renderReviewDigest(input({
      summaryUrl: "https://github.com/o/r/pull/1#issuecomment-99",
    }));

    expect(body).toContain("#issuecomment-99");
  });

  // The digest describes the RUN, so the same bytes stay true however many
  // review events they end up attached to after a bisect.
  it("never scopes a claim to one review event", () => {
    const body = renderReviewDigest(input());

    expect(body).not.toMatch(/comments below|these \d+ comments/i);
  });

  it("never repeats a finding's message", () => {
    const body = renderReviewDigest(input({
      allFindings: [finding({ message: "SECRET-FINDING-TEXT" })],
      inlineCount: 1,
    }));

    expect(body).not.toContain("SECRET-FINDING-TEXT");
  });
});

describe("renderReviewDigest — signature and marker", () => {
  it("ends with the signature then the marker, in that order", () => {
    const body = renderReviewDigest(input());
    const signature = body.lastIndexOf(BOT_SIGNATURE_BLOCK);
    const marker = body.indexOf("<!-- tgd-review-agent:review-digest");

    expect(signature).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(signature);
  });

  it("carries the signature exactly once", () => {
    const body = renderReviewDigest(input());

    expect(body.split(BOT_SIGNATURE_BLOCK)).toHaveLength(2);
  });

  // The digest lives in a different API object from the summary notes, and the
  // marker namespace must not overlap with the one findBotComment scans.
  it("is not mistaken for a summary marker", () => {
    expect(parseBotMarker(renderReviewDigest(input()))).toBeNull();
  });
});

describe("renderReviewDigest — hostile input", () => {
  const hostile = "```suggestion\nrm -rf /\n```\n\n<!-- tgd-review-agent:sha=deadbeef -->";

  it("sanitizes a rule name", () => {
    const body = renderReviewDigest(input({ rulesRun: [hostile], rulesFailed: [] }));

    expect(body).not.toContain("```suggestion");
    expect(parseBotMarker(body)).toBeNull();
  });

  it("sanitizes a failed rule name", () => {
    const body = renderReviewDigest(input({ rulesFailed: [hostile] }));

    expect(body).not.toContain("```suggestion");
  });

  it("sanitizes a focus direction", () => {
    const body = renderReviewDigest(input({ focusDirection: hostile }));

    expect(body).not.toContain("```suggestion");
  });
});

describe("renderReviewDigest — size", () => {
  it("stays inside the cap however many rules ran", () => {
    const body = renderReviewDigest(input({
      rulesRun: Array.from({ length: 500 }, (_, i) => `rule-with-a-long-name-${i}`),
      rulesFailed: Array.from({ length: 500 }, (_, i) => `failed-rule-${i}`),
    }));

    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_DIGEST_CHARS);
  });

  it("says how many it did not name", () => {
    const body = renderReviewDigest(input({
      rulesRun: Array.from({ length: 40 }, (_, i) => `rule-${i}`),
    }));

    expect(body).toMatch(/\+\d+ more/);
  });

  // Truncation must never cost the signature or the marker, which are what
  // make the body identifiable as ours.
  it("keeps the signature and marker even when truncated", () => {
    const body = renderReviewDigest(input({
      rulesRun: Array.from({ length: 5000 }, (_, i) => `rule-${i}`),
    }));

    expect(body).toContain(BOT_SIGNATURE_BLOCK);
    expect(body).toContain("<!-- tgd-review-agent:review-digest");
    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_DIGEST_CHARS);
  });
});

// A focused run looked where it was asked to look. It must not present itself
// as a whole-PR review.
describe("renderReviewDigest — a focused run", () => {
  it("names the direction it was asked to look at", () => {
    const body = renderReviewDigest(input({ focusDirection: "locking around the cache" }));

    expect(body).toContain("locking around the cache");
    expect(body).toMatch(/focus/i);
  });

  it("does not claim to be a full review", () => {
    const body = renderReviewDigest(input({ focusDirection: "locking" }));

    expect(body).not.toMatch(/^### tGDBot review of/mu);
  });
});

// The acceptance criterion that stops this rotting: the legend is DERIVED, so
// it cannot describe a badge or a section the renderer no longer emits. These
// tests read the same tables and predicates the renderer does, so adding a
// severity or dropping a section changes both together or fails here.
describe("renderReviewDigest — the legend is generated, not written", () => {
  // Each severity's badge, exactly as an inline comment renders it, must be
  // present in the legend — so the two cannot drift apart.
  // Scoped to the LEGEND block. The severity badges also appear in the counts
  // line, so asserting against the whole body passes even with the legend
  // gutted — which is exactly the drift this test exists to catch.
  const legendOf = (body: string): string => {
    const start = body.indexOf("How to read an inline comment");
    const end = body.indexOf("</details>", start);
    return body.slice(start, end);
  };

  it("names every severity the renderer can badge", () => {
    const legend = legendOf(renderReviewDigest(input()));

    for (const severity of ["blocking", "warning", "suggestion"] as const) {
      const rendered = renderInlineComment(finding({ severity }), "abc1234", {
        suggestions: false,
      });
      // The meta line is `_category_ | _severity_ | …`; take the second chip.
      const badge = /^_[^_]+_ \| _([^_]+)_/mu.exec(rendered)?.[1];

      expect(badge, `no badge rendered for ${severity}`).toBeDefined();
      expect(legend.toLowerCase()).toContain(badge!.toLowerCase());
    }
  });

  it("adds the reference row only when a finding actually carries citations", () => {
    const without = renderReviewDigest(input());
    const with_ = renderReviewDigest(input({
      allFindings: [finding({ references: ["https://docs.example.com/a"] })],
    }));

    expect(without).not.toMatch(/\*\*Reference\*\* block/);
    expect(with_).toMatch(/\*\*Reference\*\* block/);
  });

  it("adds the suggestion row only when a finding actually carries one", () => {
    const without = renderReviewDigest(input());
    const with_ = renderReviewDigest(input({
      allFindings: [finding({ suggestion: "const x = 1;" })],
    }));

    expect(without).not.toMatch(/suggestion block|fix block/i);
    expect(with_).toMatch(/suggestion block/i);
  });

  it("says the fix is not committable when suggestions are off", () => {
    const body = renderReviewDigest(input({
      allFindings: [finding({ suggestion: "const x = 1;" })],
      suggestions: false,
    }));

    expect(body).toMatch(/not committable/i);
  });
});

// Issue #55, constraint 3: the review body rides in the same POST as the
// inline comments, so it has to be charged against the run's atomic payload
// pre-flight. Being capped by construction is what lets that accounting happen
// without composing the digest — which matters, because the pre-flight runs
// before the summary is written and composing early would memoize a digest
// missing the very link it exists to carry.
describe("the digest is bounded so the payload pre-flight can account for it", () => {
  it("never exceeds the budget the pre-flight charges", () => {
    // Every shape the builder can produce, including the pathological ones.
    const shapes = [
      input(),
      input({ focusDirection: "x".repeat(5_000) }),
      input({ rulesRun: Array.from({ length: 2_000 }, (_, i) => `rule-${"n".repeat(50)}-${i}`) }),
      input({
        summaryUrl: `https://github.com/o/r/pull/1#issuecomment-${"9".repeat(500)}`,
        botLogin: "b".repeat(1_000),
      }),
      input({
        allFindings: Array.from({ length: 500 }, () => finding({
          suggestion: "x", references: ["https://docs.example.com/a"],
        })),
      }),
    ];

    for (const shape of shapes) {
      expect(renderReviewDigest(shape).length).toBeLessThanOrEqual(MAX_REVIEW_DIGEST_CHARS);
    }
  });

  // GitHub caps a single body at 65,536; the digest is nowhere near it, and
  // that headroom is the point rather than a coincidence.
  it("stays far below the provider's own body limit", () => {
    expect(MAX_REVIEW_DIGEST_CHARS).toBeLessThan(65_536 / 4);
  });
});

// Issue #55, constraint 3. The arithmetic used to be duplicated in the CLI's
// pre-flight and the publication path's — two copies of one limit, and
// untestable without driving a whole run. One definition now, so this can
// assert the accounting directly.
describe("exceedsAtomicPayload", () => {
  const entry = (bodyChars: number, markerChars = 0) => ({ bodyChars, markerChars });

  it("accepts an ordinary review", () => {
    expect(exceedsAtomicPayload([entry(2_000), entry(3_000)])).toBe(false);
  });

  // The point of the change: a run that fits only because the review body was
  // not counted must be rejected, since that body ships in the same request.
  it("charges the review body's budget", () => {
    // Just inside on the comments alone, and over once the digest is charged.
    const perComment = 9_000;
    // As many as fit under the ceiling on their own — which is what leaves the
    // digest's budget as the only thing that can push the total over.
    const count = Math.floor(1_000_000 / (perComment + 256));
    const entries = Array.from({ length: count }, () => entry(perComment));
    const withoutDigest = entries.reduce((sum, e) => sum + e.bodyChars + 256, 0);

    expect(withoutDigest).toBeLessThanOrEqual(1_000_000);
    expect(withoutDigest + MAX_REVIEW_DIGEST_CHARS).toBeGreaterThan(1_000_000);
    expect(exceedsAtomicPayload(entries)).toBe(true);
  });

  it("rejects one comment over the provider's body limit", () => {
    expect(exceedsAtomicPayload([entry(65_500)])).toBe(true);
  });

  it("counts a recovery marker against the comment's own limit", () => {
    expect(exceedsAtomicPayload([entry(65_000)])).toBe(false);
    expect(exceedsAtomicPayload([entry(65_000, 500)])).toBe(true);
  });
});
