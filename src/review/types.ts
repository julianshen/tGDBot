import type { ContextPackResult } from "../context/context-pack.js";
import type { StructuralCheck, StructuralClaim } from "./structural-check.js";
import type { RuleDefinition } from "../rules/types.js";

// Finding/DispatchResult: the shape produced by dispatching every loaded rule
// through the orchestrating AgentSession's `subagent` tool call and parsing
// its final JSON message. See SPEC.md "Data Models" and TASKS.md Task 5.
export type FindingDecision =
  | "new"
  | "still-valid"
  | "addressed"
  | "disputed"
  | "needs-clarification";

export interface Finding {
  file: string;
  line?: number;
  severity: "blocking" | "warning" | "suggestion";
  category: string;
  message: string;
  ruleName: string;
  /**
   * Reviewer judgment relative to prior discussion. Omitted on older reviewer
   * output and treated as `new`.
   */
  decision?: FindingDecision;
  /**
   * One short, answerable question. Present only when `decision` is
   * `needs-clarification`.
   */
  question?: string;

  /**
   * ADR-008: a short, AUTHORED headline (<= 80 chars, one line).
   *
   * Previously the bold headline was DERIVED by splitting `message` at its first
   * sentence — which produced no headline at all when that sentence was long,
   * because truncating it and reprinting the same sentence below reads as a
   * stutter. A title is something the reviewer should write, not something we
   * should guess. Optional: when absent, the derived-headline fallback still
   * applies, so older rules keep working.
   */
  title?: string;

  /**
   * ADR-007: replacement text for the anchored line range — rendered as a
   * provider-native committable suggestion (a one-click commit action).
   *
   * SECURITY (this is the whole reason it is a separate field): free-text
   * `message` is LLM output over an ATTACKER-CONTROLLED diff, and any
   * ```suggestion fence inside it is deliberately DEFANGED (ADR-006) — otherwise
   * prompt injection could mint a committable block. A suggestion may therefore
   * ONLY originate here: a structured field we validate, fence with a run longer
   * than any inside it, and scope to the anchored lines. See ADR-007 for the full
   * threat model and the `--suggestions off` escape hatch.
   *
   * Verbatim replacement text — NOT a diff, NOT fenced. Exactly what the lines
   * `line`..`endLine` should become.
   */
  suggestion?: string;

  /**
   * ADR-007: last line of the range a `suggestion` replaces (inclusive).
   * Omitted for a single-line suggestion, where the range is just `line`.
   * Both ends must be inside the diff, or the suggestion is dropped (the finding
   * itself is still posted).
   */
  endLine?: number;

  /**
   * Issue #38: roughly how much work the fix is — NOT how much it matters.
   *
   * Severity orders findings against each other; effort orders them within a
   * severity band, which is what makes a run of eight blocking findings
   * something a reviewer can plan around instead of just absorb.
   *
   * Deliberately two buckets, not a scale. The decision a reader is making is
   * "now or later", and a middle value would collect everything the model was
   * unsure about, which answers nothing. Coarse also keeps it honest: this is
   * an impression formed while writing the finding, not an estimate anyone
   * costed.
   *
   * Optional, and unrecognized values are dropped rather than rejected — a
   * finding is worth posting whether or not its metadata parsed.
   */
  effort?: "quick" | "heavy";

  /**
   * Issue #49: documentation this finding rests on, so a reader can check the
   * claim rather than take it.
   *
   * Only URLs that appear in the finding's OWN rule text survive parsing. A
   * fabricated citation looks authoritative and is worse than none, and a model
   * cannot invent a link it was never given — so the guarantee is structural
   * rather than a matter of the model behaving. Where the rule text is not
   * available, every citation is dropped: fail closed.
   */
  references?: readonly string[];

  /**
   * Issue #75: a structural assertion this finding rests on, for the HOST to
   * check against the trusted base tree.
   *
   * The failure mode it exists for is the confident false positive: "this
   * function is never called", written about code the reviewer cannot see,
   * because its only caller sits outside the diff. #58's context pack helps the
   * reviewer reason; nothing checked the assertion afterwards.
   *
   * Structured rather than inferred from `message`, for the same reason
   * `references` is a field rather than a regex over prose: "never called",
   * "no other caller" and "nothing else implements this" are one claim in three
   * phrasings, and a matcher over them would both miss real claims and invent
   * ones that were never made. Absent is the safe default.
   *
   * The claim is the model's; the CHECK is the host's, and only the check is
   * ever presented as established. A contradicted claim never suppresses the
   * finding — see `structural-check.ts`.
   */
  claim?: StructuralClaim;

  /**
   * Issue #75: what the HOST found when it checked `claim`. Host-computed, and
   * never copied from reviewer output.
   *
   * That guarantee is structural rather than a matter of the model behaving:
   * `normalizeUnknownFinding` builds a finding field by field from an allowlist,
   * so a reviewer that emits `"hostCheck"` in its JSON has it dropped like any
   * other unknown key. A forged verification would be the most damaging thing a
   * finding could carry — it is the one part a reader is meant to trust without
   * re-deriving — so it must not be forgeable, the same reasoning that keeps
   * `suggestion` a validated field rather than free text in `message`.
   */
  hostCheck?: StructuralCheck;
}

export interface DispatchResult {
  findings: Finding[];
  rulesRun: string[];
  rulesFailed: string[];
  /**
   * The RESOLVED `provider/model` specs the rules actually ran on, distinct.
   *
   * Reported so a published comment can name what produced it: a reader who
   * disagrees with a finding should not have to dig through CI logs to learn
   * what wrote it. A run can pin different models per rule, hence a list.
   * Absent when nothing resolved, which is honest — unpinned rules on a
   * provider's own default leave the host genuinely not knowing.
   */
  modelsUsed?: string[];
  /**
   * ruleName -> WHY it failed, as a short CLASSIFIED phrase safe to publish.
   *
   * Found by the zero-config smoke test: a rule could fail and the comment said
   * only "rules failed to run and were skipped", with the real cause (no API key
   * for the rule's pinned provider) captured from the subagent and then dropped.
   *
   * Deliberately NOT the raw provider error: this is rendered into a review comment,
   * which is world-readable on a public repo, and raw provider errors can echo
   * request details. The raw error goes to stderr (private CI logs) instead.
   *
   * Optional: absent when reconciliation couldn't map results to rules, and
   * absent per-rule for rules that succeeded.
   */
  ruleFailureReasons?: Record<string, string>;

  /** Present only when every dispatched rule used a pack from one validated manifest. */
  contextManifestHash?: string;
}

export type RuleContextPacks = Readonly<Record<string, ContextPackResult>>;

/** Provider-neutral discussion/memory text already bounded by conversation/context.ts. */
export interface ReviewConversationContext {
  readonly text: string;
  readonly digest: string;
}

/** Runtime dispatch data shared by the direct and legacy engines. */
export interface ReviewDispatchInput {
  rules: RuleDefinition[];
  diff: string;
  useAdvisor: boolean;
  contextPacks?: RuleContextPacks;
  orchestratorModel?: string;
  conversationContext?: ReviewConversationContext;
}
