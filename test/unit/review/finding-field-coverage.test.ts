// Issue #40: a Finding has eleven hand-written representations — the type, the
// reviewer-output parser, three prompt contracts, two serializers, a snapshot
// type, a strict validator, and two renderers — and nothing makes them agree.
//
// Adding ONE optional field in #38 took four commits, because five separate
// sites were missed and every miss was caught by a review bot rather than by
// the compiler or a test. This file is the guard that was missing.
//
// It works in two layers:
//
//  1. COMPILE TIME. `Required<Finding>` means a new optional field on Finding
//     is a type error here until it is populated below. That is the tripwire:
//     you cannot add a field without this file failing to build.
//  2. RUN TIME. Every key of that value is then walked against each
//     representation, so populating it is not enough — the field has to
//     actually survive each round trip and appear in each contract.
//
// A field that legitimately does NOT belong somewhere is listed as an
// exception WITH ITS REASON. That list is the point: it turns "we forgot" into
// "we decided", and a future field forces the same decision.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINDING_JSON_CONTRACT, FINDING_OBJECT_CONTRACT } from "../../../src/review/dispatch-prompt.js";
import {
  parseFindingsFromFinalOutput,
  referencesDeclaredBy,
} from "../../../src/review/dispatch-results.js";
import { renderInlineComment, renderSummaryComment } from "../../../src/review/comment-format.js";
import { stripReviewMarker, stripSignature, toFindingSnapshot } from "../../../src/review/review-publication.js";
import { BOT_SIGNATURE, BOT_SIGNATURE_BLOCK, INLINE_COMMENT_MARKER } from "../../../src/review/comment-format.js";
import { composeFrozenSummary } from "../../../src/review/review-publication.js";
import type { PublicationAction, PublicationChild } from "../../../src/conversation/publication-manifest.js";
import {
  createPreparedClarification,
  toClarificationFindingSnapshot,
} from "../../../src/conversation/clarification.js";
import { encodeClarificationPublicId } from "../../../src/conversation/clarification.js";
import { validatePendingSnapshot } from "../../../src/conversation/state-schema.js";
import { createHash } from "node:crypto";
import type { Finding } from "../../../src/review/types.js";

const sourceText = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url)), "utf-8");

/**
 * The literal `[{ ... }]` shape in a contract, not its surrounding prose.
 *
 * Checking that a field name appears ANYWHERE in a contract is a placebo:
 * deleting it from the schema while a sentence below still mentions it passes
 * a substring test, and the model is then told the field exists without being
 * told where it goes. Verified by deleting a schema line and watching the
 * loose version stay green.
 */
const schemaOf = (contract: string): string => {
  const start = contract.indexOf("[{");
  const end = contract.indexOf("}]", start);
  if (start < 0 || end < 0) throw new Error("no findings schema found in contract");
  return contract.slice(start, end);
};

/** The single line declaring a schema, for contracts that inline it. */
const schemaLine = (text: string, marker: string): string => {
  const line = text.split("\n").find((candidate) => candidate.includes(marker));
  if (line === undefined) throw new Error(`no schema line containing ${marker}`);
  return line;
};

/**
 * Every field of a Finding, populated.
 *
 * `Required<Finding>` is load-bearing: it is what makes adding an optional
 * field to Finding break this file at COMPILE time rather than silently at
 * runtime in one of eleven places.
 *
 * `decision`/`question` are set consistently (a question is only valid for
 * `needs-clarification`) so the value is one a real reviewer could emit.
 */
const COMPLETE: Required<Finding> = {
  file: "src/subauthcache.go",
  line: 120,
  endLine: 124,
  severity: "blocking",
  category: "consistency",
  message: "The cached authorization outlives its revocation.",
  ruleName: "distributed-system",
  decision: "needs-clarification",
  question: "Is the 90-minute window intentional?",
  title: "L2 hits bypass authorization revalidation.",
  // Indented, because that is what a real suggestion looks like: it replaces a
  // whole line range, so it carries the file's existing indentation. This was
  // an unindented placeholder while #43 was open — both the parser and the
  // state schema rejected indented values back then, and this fixture is what
  // exposed it. Now that they accept them, using a representative value also
  // makes this file notice if that regresses.
  suggestion: "\tif stale(entry) {\n\t\treturn revalidate(ctx)\n\t}",
  effort: "heavy",
  references: ["https://docs.example.com/ttl"],
  claim: { kind: "no-other-references", symbol: "revalidate" },
  hostCheck: { status: "contradicted", references: [{ file: "src/other.go", line: 7 }], filesSearched: 3 },
};

const FIELDS = Object.keys(COMPLETE) as (keyof Finding)[];

/** Fields a REVIEWING rule is deliberately never asked to produce. */
const NOT_IN_RULE_CONTRACT: Partial<Record<keyof Finding, string>> = {
  ruleName: "stamped by the dispatcher from the rule that actually ran — a rule naming itself would be unverifiable",
  hostCheck: "computed by the host from the base tree (#75); a rule able to emit it could forge its own verification, which is the one part of a finding a reader is invited to trust without re-deriving",
};

/**
 * Fields the reviewer-output parser deliberately refuses.
 *
 * This is not an omission to be fixed later — it IS the forgery guarantee for
 * #75. The parser rebuilds a finding from an allowlist, so a field absent from
 * that list cannot arrive from reviewer output however the model spells it.
 */
const NOT_FROM_REVIEWER: Partial<Record<keyof Finding, string>> = {
  hostCheck: "host-computed; accepting it from reviewer output would let a finding fabricate its own verification",
};

/**
 * Fields deliberately absent from the PERSISTED forms.
 *
 * Both are derived from one review against one base commit. `hostCheck` is a
 * parse of the base tree, and a stored verification goes stale the moment that
 * tree moves — a stale verification being precisely the artifact #75 exists to
 * prevent. `claim` is only meaningful next to its check: persisting the
 * assertion without the answer would store an unverified claim as part of the
 * finding's identity. Both are recomputed per review, cheaply, from scratch.
 */
const NOT_PERSISTED: Partial<Record<keyof Finding, string>> = {
  claim: "recomputed per review; meaningless without the check that answers it",
  hostCheck: "derived from one base commit; a persisted verification would go stale silently",
};

/**
 * Fields the aggregator does not copy through verbatim.
 *
 * That instruction exists to stop the orchestrator "improving" model-authored
 * TEXT on the way through — above all a `suggestion`, which is committable
 * code. Structural fields are reconstructed rather than retyped, so they are
 * not at risk in the same way. Listed explicitly so a new field forces the
 * question rather than defaulting to silence.
 */
const NOT_COPIED_THROUGH: Partial<Record<keyof Finding, string>> = {
  hostCheck: "never emitted by a task in the first place — see NOT_IN_RULE_CONTRACT",
  file: "structural; the aggregator carries it, not the prose of it",
  line: "structural, as above",
  severity: "a closed vocabulary, not free text",
  category: "a short label the orchestrator has no reason to rewrite",
  ruleName: "stamped by the dispatcher, never authored by the rule",
};

/** Fields the builtin reviewer agent is deliberately never asked to produce. */
const NOT_IN_REVIEWER_AGENT: Partial<Record<keyof Finding, string>> = {
  hostCheck: "host-computed, as above",
  ruleName: "stamped by the dispatcher, as above",
  decision: "requires prior-discussion context the builtin agent is not given",
  question: "only meaningful alongside `decision`, which the agent does not emit",
};

describe("every Finding field survives every representation", () => {
  it("is fully populated, so the compiler guards this file", () => {
    // Guards the guard: if someone satisfies Required<Finding> with undefined
    // values, the walks below would pass vacuously.
    for (const field of FIELDS) {
      expect(COMPLETE[field], `${field} must be populated`).toBeDefined();
    }
    expect(FIELDS.length).toBeGreaterThan(0);
  });

  it("round-trips through the publication snapshot", () => {
    const snapshot = toFindingSnapshot(COMPLETE) as unknown as Record<string, unknown>;

    for (const field of FIELDS) {
      if (NOT_PERSISTED[field]) continue;
      expect(snapshot[field], `toFindingSnapshot drops ${field}`).toEqual(COMPLETE[field]);
    }
  });

  it("round-trips through the clarification snapshot", () => {
    const snapshot = toClarificationFindingSnapshot(COMPLETE) as unknown as Record<string, unknown>;

    for (const field of FIELDS) {
      if (NOT_PERSISTED[field]) continue;
      expect(snapshot[field], `toClarificationFindingSnapshot drops ${field}`).toEqual(COMPLETE[field]);
    }
  });

  // The persisted form is validated strictly on read-back, so a field the
  // schema does not know about is an integrity failure rather than a silent
  // loss — both directions have to agree.
  it("round-trips through the strict state schema", () => {
    const repository = { provider: "github" as const, repositoryDigest: "a".repeat(64) };
    const prepared = createPreparedClarification({
      id: encodeClarificationPublicId(createHash("sha256").update("field-coverage").digest()),
      reviewNumber: 7,
      headSha: "c".repeat(40),
      question: COMPLETE.question,
      createdAt: "2026-08-24T00:00:00.000Z",
      finding: COMPLETE,
    });

    const validated = validatePendingSnapshot(
      { version: 1, repository, clarifications: [prepared], directions: [] },
      repository,
    );
    const stored = validated.clarifications[0]?.finding as unknown as Record<string, unknown>;

    for (const field of FIELDS) {
      if (NOT_PERSISTED[field]) continue;
      expect(stored[field], `the state schema drops ${field}`).toEqual(COMPLETE[field]);
    }
  });

  it("round-trips through the reviewer-output parser", () => {
    // The per-rule dispatch path, which is what the CLI runs. The legacy
    // orchestrator's merged output is checked separately in dispatch.test.ts:
    // it drops citations on purpose, because it cannot prove which rule
    // produced a finding (PR #54 review).
    const parsed = parseFindingsFromFinalOutput(
      JSON.stringify([COMPLETE]),
      COMPLETE.ruleName,
      // The rule must DECLARE the citation, or the parser correctly discards
      // it — a finding may only cite what its own rule text contains (#49).
      referencesDeclaredBy(`rule body — see ${COMPLETE.references[0]}`),
    );
    const finding = parsed[0] as unknown as Record<string, unknown>;

    for (const field of FIELDS) {
      if (NOT_FROM_REVIEWER[field]) {
        expect(finding[field], `the parser accepted ${field} from reviewer output`).toBeUndefined();
        continue;
      }
      expect(finding[field], `the parser drops ${field}`).toEqual(COMPLETE[field]);
    }
  });
});

describe("every Finding field is described to the model", () => {
  it("appears in the per-rule finding contract", () => {
    for (const field of FIELDS) {
      if (NOT_IN_RULE_CONTRACT[field]) continue;
      expect(schemaOf(FINDING_JSON_CONTRACT), `the rule contract's schema omits ${field}`)
        .toContain(`"${field}"`);
    }
  });

  // The aggregator re-declares the schema and separately instructs the
  // orchestrator which fields to copy through verbatim; a field missing from
  // either is dropped on the legacy dispatch path.
  it("appears in the aggregator schema", () => {
    // The aggregator re-declares the schema on one line, and separately lists
    // the fields to copy through verbatim. Both are checked: a field missing
    // from the schema is never requested, and one missing from the copy-through
    // list is requested and then discarded in the merge.
    const prompt = sourceText("review/dispatch-prompt.ts");
    const schema = schemaLine(prompt, '"rulesRun": string[]');
    const copyThrough = schemaLine(prompt, "through EXACTLY as the task emitted them");

    for (const field of FIELDS) {
      if (NOT_IN_RULE_CONTRACT[field] && NOT_COPIED_THROUGH[field]) continue;
      expect(schema, `the aggregator schema omits ${field}`).toContain(`"${field}"`);
      if (NOT_COPIED_THROUGH[field]) continue;
      expect(copyThrough, `the aggregator never copies ${field} through`).toContain(`"${field}"`);
    }
  });

  it("appears in the builtin reviewer agent contract", () => {
    const schema = schemaLine(sourceText("review/builtin-agents/reviewer.md"), '"severity"');

    for (const field of FIELDS) {
      if (NOT_IN_REVIEWER_AGENT[field]) continue;
      expect(schema, `the reviewer agent schema omits ${field}`).toContain(`"${field}"`);
    }
  });

  // Exceptions must be real fields. A stale entry here would silently excuse a
  // field from coverage after it was renamed or removed.
  it("has no exception for a field that no longer exists", () => {
    const excepted = [
      ...Object.keys(NOT_IN_RULE_CONTRACT),
      ...Object.keys(NOT_IN_REVIEWER_AGENT),
      ...Object.keys(NOT_COPIED_THROUGH),
      ...Object.keys(NOT_FROM_REVIEWER),
      ...Object.keys(NOT_PERSISTED),
    ];
    for (const field of excepted) {
      expect(FIELDS, `${field} is excepted but is not a Finding field`).toContain(field);
    }
  });
});

describe("every Finding field reaches the reader", () => {
  /**
   * What each field looks like ONCE RENDERED.
   *
   * Matching the raw value would be wrong for the closed vocabularies —
   * `severity: "blocking"` is shown as a badge, never as the word — so the
   * expected rendered form is stated per field instead.
   */
  const RENDERED_AS: Partial<Record<keyof Finding, string>> = {
    category: COMPLETE.category,
    severity: "🔴 Blocking",
    effort: "🏗️ Heavy lift",
    ruleName: COMPLETE.ruleName,
    title: COMPLETE.title,
    message: COMPLETE.message,
    suggestion: COMPLETE.suggestion,
    references: COMPLETE.references[0],
    // The check is what a reader sees; the claim is only visible through it.
    hostCheck: "Host check:",
  };

  /** Fields an inline comment deliberately does not print. */
  const NOT_IN_INLINE_BODY: Partial<Record<keyof Finding, string>> = {
    claim: "shown through the host check that answers it (#75) — printing the raw assertion as well would present the reviewer's word alongside the host's, which is the confusion the split avoids",
    file: "the comment is anchored to the file; repeating the path would be noise",
    line: "likewise — the anchor IS the line",
    endLine: "structural: it bounds a suggestion rather than being shown",
    decision: "routes the finding between sections; never printed in the body",
    question: "surfaced by the clarification flow, not by an inline finding",
  };

  it("renders every field the inline comment is responsible for", () => {
    const body = renderInlineComment(COMPLETE);

    for (const field of FIELDS) {
      if (NOT_IN_INLINE_BODY[field]) continue;
      const expected = RENDERED_AS[field];
      expect(expected, `${field} has no expected rendered form`).toBeDefined();
      expect(body, `the inline comment drops ${field}`).toContain(expected as string);
    }
  });

  // The compact summary builds its own prefix instead of reusing the inline
  // metadata line, which is exactly how `effort` came to be missing from it
  // (#38). It gets its own walk.
  it("renders every field the compact summary is responsible for", () => {
    const body = renderSummaryComment(
      {
        allFindings: [COMPLETE],
        inlineCount: 0,
        unanchored: [COMPLETE],
        filesReviewed: [COMPLETE.file],
        rulesRun: [COMPLETE.ruleName],
        rulesFailed: [],
      },
      400,
    );

    expect(body).toContain("compacted to fit the provider limit");
    for (const field of ["severity", "effort", "file", "ruleName"] as (keyof Finding)[]) {
      const expected = field === "severity" ? "🔴 Blocking"
        : field === "effort" ? "🏗️ Heavy lift"
        : String(COMPLETE[field]);
      expect(body, `the compact summary drops ${field}`).toContain(expected);
    }
  });

  it("has no rendering exception for a field that no longer exists", () => {
    for (const field of Object.keys(NOT_IN_INLINE_BODY)) {
      expect(FIELDS, `${field} is excepted but is not a Finding field`).toContain(field);
    }
  });
});

// Issue #41: the conversation prompts ask for findings too, and one of them
// named a contract it never carried. The field walk now reaches them, so a new
// field cannot be added to the review contract while these quietly keep asking
// for the old shape.
describe("conversation prompts describe the same finding", () => {
  it("gives the focus and reconsider contracts the shared schema", () => {
    const actions = sourceText("conversation/actions.ts");

    // Both interpolate a SHARED constant rather than restating the shape, which
    // is what keeps them from drifting as fields are added. They use different
    // ones on purpose: focus asks for a top-level array, reconsider for one
    // nested object, and mixing the envelopes contradicts the model (PR #51).
    expect(actions, "the focus contract stopped sharing the schema")
      .toContain("${FINDING_JSON_CONTRACT}");
    expect(actions, "the reconsider contract stopped sharing the schema")
      .toContain("${FINDING_OBJECT_CONTRACT}");
  });

  // The shared object shape must not carry an envelope, or nesting it
  // contradicts whatever contains it.
  it("keeps the array envelope out of the nestable shape", () => {
    expect(FINDING_OBJECT_CONTRACT).not.toMatch(/ONLY a JSON array/i);
    expect(FINDING_OBJECT_CONTRACT).not.toMatch(/respond with \[\] exactly/i);
    expect(FINDING_JSON_CONTRACT).toMatch(/ONLY a JSON array/i);
  });

  it("never asks for a finding without saying what one is", () => {
    const actions = sourceText("conversation/actions.ts");

    // A contract mentioning "finding" as a JSON field must be one that carries
    // the schema; `"finding": object` with no shape is the #41 defect.
    expect(actions).not.toMatch(/"finding":\s*object\s*\|\s*null[\s\S]{0,400}?`;/);
  });
});

// Both tails of a POSTED summary have to come off before anything is appended
// to it. `publishConfirmedClarificationFinding` appends clarification content to
// the existing summary body; leaving the signature on would strand it in the
// middle of the comment and produce a second one at the end (Codex review).
describe("stripping a posted summary back to its content", () => {
  const posted = [
    "## Review summary",
    "",
    "- src/a.ts:1 — something",
    "",
    BOT_SIGNATURE_BLOCK,
    "",
    "<!-- tgd-review-agent:sha=cafef00d cfg=abc123 -->",
  ].join("\n");

  it("removes the marker and the signature under it", () => {
    const stripped = stripReviewMarker(posted);
    expect(stripped).not.toContain(BOT_SIGNATURE);
    expect(stripped).not.toContain("tgd-review-agent:sha=");
    expect(stripped.endsWith("- src/a.ts:1 — something")).toBe(true);
  });

  it("appending content after the stripped body leaves exactly one signature to add", () => {
    const composed = `${stripReviewMarker(posted)}\n\n- src/b.ts:9 — clarified\n\n${BOT_SIGNATURE_BLOCK}`;
    expect(composed.split(BOT_SIGNATURE)).toHaveLength(2);
    expect(composed.trimEnd().endsWith(BOT_SIGNATURE_BLOCK)).toBe(true);
    expect(composed.indexOf(BOT_SIGNATURE)).toBeGreaterThan(composed.indexOf("clarified"));
  });

  it("tolerates a body with no signature — an older manifest, or a pending checkpoint", () => {
    const unsigned = "## Review summary\n\n<!-- tgd-review-agent:pending -->";
    expect(stripReviewMarker(unsigned)).toBe("## Review summary");
    expect(stripSignature("plain text")).toBe("plain text");
  });
});

// The replayed-manifest path composes the summary from FROZEN child bodies, and
// a fallback child's body is the rendered inline comment verbatim — which now
// carries its own signature. Spreading those between the summary and the footer
// put one apparent footer in the middle of the comment per relocated finding
// (Codex review). Only this path is affected: on a live run `bodyFor` prefers
// cli.ts's buildBody, which re-renders relocated findings as summary entries.
describe("composeFrozenSummary with relocated findings", () => {
  const marker = "<!-- tgd-review-agent:sha=cafef00d cfg=abc123 -->";

  function child(over: Partial<PublicationChild> & { id: string; kind: PublicationChild["kind"]; body: string }): PublicationChild {
    return {
      status: "posted",
      placement: { kind: "summary", headSha: "c".repeat(40), configHash: "abc123" },
      bodyDigest: "0".repeat(64),
      marker: "",
      ...over,
    } as PublicationChild;
  }

  it("carries exactly one signature, last, however many findings were relocated", () => {
    const relocated = (n: number) => renderInlineComment({
      file: `src/${n}.ts`,
      line: n,
      severity: "warning",
      category: "correctness",
      message: `finding ${n}`,
      ruleName: "rule-a",
    });
    const action = {
      children: [
        child({ id: "summary", kind: "summary", body: `## Review summary\n\n${BOT_SIGNATURE_BLOCK}` }),
        child({
          id: "fb-1",
          kind: "fallback",
          status: "fallback-selected",
          body: relocated(1),
          placement: { kind: "fallback" },
        }),
        child({
          id: "fb-2",
          kind: "fallback",
          status: "fallback-selected",
          body: relocated(2),
          placement: { kind: "fallback" },
        }),
      ],
    } as unknown as PublicationAction;

    const composed = composeFrozenSummary(action, new Set(), marker);

    expect(composed).toContain("finding 1");
    expect(composed).toContain("finding 2");
    expect(composed.split(BOT_SIGNATURE)).toHaveLength(2);
    expect(composed.trimEnd().endsWith(marker)).toBe(true);
    expect(composed.indexOf(BOT_SIGNATURE)).toBeGreaterThan(composed.indexOf("finding 2"));
    // The relocated bodies keep their own machine markers — only the visible
    // signature is removed, so stale-thread cleanup is unaffected.
    expect(composed).toContain(INLINE_COMMENT_MARKER);
  });

  // A `suggestion` is emitted verbatim (ADR-007), so it can legitimately carry
  // the exact block — a proposed edit to a Markdown footer, including this
  // repository's own README. Stripping every occurrence deleted it from the
  // proposed fix (Codex review); only the renderer's footer may be removed.
  it("keeps a signature that a relocated finding proposes as a code change", () => {
    const relocated = renderInlineComment({
      file: "README.md",
      line: 3,
      severity: "warning",
      category: "docs",
      message: "The footer is missing.",
      ruleName: "rule-a",
      suggestion: `## Footer\n\n${BOT_SIGNATURE_BLOCK}`,
    });
    expect(relocated.split(BOT_SIGNATURE_BLOCK)).toHaveLength(3); // suggestion + footer

    const action = {
      children: [
        child({ id: "summary", kind: "summary", body: `## Review summary\n\n${BOT_SIGNATURE_BLOCK}` }),
        child({
          id: "fb-1",
          kind: "fallback",
          status: "fallback-selected",
          body: relocated,
          placement: { kind: "fallback" },
        }),
      ],
    } as unknown as PublicationAction;

    const composed = composeFrozenSummary(action, new Set(), marker);

    // The proposed fix survives intact...
    expect(composed).toContain(`## Footer\n\n${BOT_SIGNATURE_BLOCK}`);
    // ...and the comment still ends with exactly one footer, then the marker.
    expect(composed.trimEnd().endsWith(`${BOT_SIGNATURE_BLOCK}\n\n${marker}`)).toBe(true);
    // Two occurrences total: the one inside the fenced suggestion, and the footer.
    expect(composed.split(BOT_SIGNATURE_BLOCK)).toHaveLength(3);
  });

  it("leaves a body alone when its only signature sits inside a suggestion", () => {
    const body = [
      "**A finding.**",
      "",
      "```suggestion",
      BOT_SIGNATURE_BLOCK,
      "```",
      "",
      "trailing prose",
    ].join("\n");
    expect(stripSignature(body)).toBe(body);
  });
});
