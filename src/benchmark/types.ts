// Issue #113: the shapes a fixed-fixture review benchmark is built from.
//
// The point of the harness is to make a prompt or dispatch change ARGUABLE
// from numbers rather than from intuition. That only works if the committed
// baseline moves when the pipeline's behaviour moves, and not otherwise — so
// the split between `BaselineEntry` (deterministic, committed, diffed) and
// `RunReport` (everything else, including wall-clock) is load-bearing rather
// than tidiness. See `report.ts`.
import type { Finding } from "../review/types.js";

/**
 * One defect a fixture asserts the reviewer should find.
 *
 * Deliberately a MATCHER rather than a copy of a finding. Pinning exact prose
 * would make every wording change a benchmark regression, which trains the
 * reader to ignore the diff — the failure mode this harness exists to avoid.
 */
export interface ExpectedFinding {
  /**
   * Stable identifier, unique within the fixture.
   *
   * Present so a baseline diff can say WHICH expectation started failing.
   * Ordering is not stable across edits and array positions are not either.
   */
  readonly id: string;
  readonly file: string;
  /**
   * Inclusive line range the finding must land in, on the head side.
   *
   * Absent means "anywhere in this file". Use that only when the defect is
   * genuinely file-scoped (a missing import, a manifest-wide problem); a
   * range is what makes the anchoring path measurable at all (#114).
   */
  readonly lines?: readonly [number, number];
  /**
   * Case-insensitive regular expression the finding's message must match.
   *
   * The semantic half of the match. Without it a fixture rewards a reviewer
   * for saying anything at all about the right line, which is precisely the
   * volume-rewarding metric that ranks the noisiest configuration first.
   */
  readonly messagePattern?: string;
  /** When set, the finding's severity must match exactly. */
  readonly severity?: Finding["severity"];
}

/** A fixture: one pull request, its diff, and what a good review would say. */
export interface Fixture {
  readonly name: string;
  /** Why this fixture exists — printed in reports, so keep it one line. */
  readonly description: string;
  readonly pr: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly url: string;
  };
  readonly diff: string;
  /**
   * File contents the review may read at the base and head revisions, keyed by
   * path. Today that is manifests, which dependency extraction reads at both
   * revisions to work out what actually changed.
   *
   * Absent for a fixture whose review reads no files, which is most of them.
   */
  readonly baseFiles?: Readonly<Record<string, string>>;
  readonly headFiles?: Readonly<Record<string, string>>;
  readonly expected: readonly ExpectedFinding[];
  /**
   * The recorded model output this fixture replays under `--mode recorded`.
   *
   * Absent means the fixture is real-mode only. A fixture with no recording
   * is reported as SKIPPED rather than as passing with no findings — an
   * absent measurement is not a good measurement.
   */
  readonly recordedFindings?: readonly Finding[];
  readonly recordedRulesRun?: readonly string[];
}

/** How one expectation resolved against one run's findings. */
export interface MatchOutcome {
  readonly truePositives: readonly { readonly expectedId: string; readonly findingIndex: number }[];
  /** Expectations nothing matched. */
  readonly falseNegatives: readonly string[];
  /** Indices into the produced findings that matched no expectation. */
  readonly falsePositives: readonly number[];
}

/**
 * Precision, recall and F1, kept SEPARATE.
 *
 * Collapsing to one score makes a model change unreadable: measured on the
 * same harness, a newer model scored higher precision and much lower recall
 * than its predecessor and landed at a worse F1 (see #113's discussion). A
 * single number cannot say which of those happened.
 *
 * `null` means UNDEFINED, not zero. Precision is undefined when a run
 * produced no findings at all, and recall is undefined when a fixture asserts
 * none; reporting 0 there would read as "got everything wrong" and reporting
 * 1 as "got everything right", and neither is a thing the harness knows.
 */
export interface QualityMetrics {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

/** The deterministic half: committed, diffed, and expected to be stable. */
export interface BaselineEntry {
  readonly fixture: string;
  readonly quality: QualityMetrics;
  readonly findingsCount: number;
  readonly severityMix: { readonly blocking: number; readonly warning: number; readonly suggestion: number };
  /** ruleName -> findings produced. Sorted by key so the JSON diff is stable. */
  readonly findingsPerRule: Readonly<Record<string, number>>;
  /** Sum of `buildTaskText` across dispatched rules — the real prompt cost. */
  readonly dispatchChars: number;
  readonly diffChars: number;
  /** Sum of title+message+suggestion lengths: the output-size variable (#110). */
  readonly findingTextChars: number;
  /**
   * Bytes of review a reader actually receives: the summary body plus every
   * inline comment body.
   *
   * Distinct from `findingTextChars`, which sums the finding FIELDS before
   * rendering. A formatter that dropped a message would leave that number
   * untouched while the published review lost content, so only this one can
   * catch a rendering regression (Codex review of PR #118).
   */
  readonly renderedChars: number;
  /**
   * How many findings a reader sees anchored to a line, rather than folded
   * into the summary because nothing could place them.
   *
   * The variable #114 would move. Tracked separately from `findingsCount`
   * because a run that finds every defect and anchors none of them is a
   * materially worse review, and no quality metric here would show it.
   */
  readonly anchoredInline: number;
  /** Which expectations were missed, by id, sorted. Makes a diff legible. */
  readonly missed: readonly string[];
}

/** The full per-fixture result, including what must NOT be committed. */
export interface FixtureRunResult {
  readonly baseline: BaselineEntry;
  /**
   * Wall clock. Deliberately OUTSIDE `BaselineEntry`: it varies with machine
   * load by more than any change we would be trying to detect, and committing
   * it would make every baseline diff churn until nobody read them.
   */
  readonly durationMs: number;
  /** Present in real mode; absent when replaying, where it would be a lie. */
  readonly modelsUsed?: readonly string[];
  readonly findings: readonly Finding[];
  readonly match: MatchOutcome;
}

export interface RunReport {
  readonly mode: "recorded" | "real";
  readonly generatedAt: string;
  readonly results: readonly FixtureRunResult[];
  /**
   * Fixtures that produced no measurement, and why. Never silently omitted.
   *
   * `kind` separates two very different situations. `no-recording` is expected
   * and permanent: a real-mode-only fixture simply cannot be replayed, and the
   * baseline correctly has no row for it. `failed` means a fixture that SHOULD
   * have measured did not, which makes the whole run partial — and blessing a
   * partial run as the baseline silently deletes that fixture's row (Codex
   * review of PR #118).
   */
  readonly skipped: readonly {
    readonly fixture: string;
    readonly kind: "no-recording" | "failed";
    readonly reason: string;
  }[];
}
