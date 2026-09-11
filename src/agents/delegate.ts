// Issue #138 phase 3: HOST-MEDIATED nesting.
//
// A reviewer may ask for a file-scoped deep dive. It cannot perform one. The
// parent names a file and a question; the host decides whether that is
// allowed, builds the child's task text itself, spawns the child session,
// harvests the child's findings FILE, and merges them. The parent never
// constructs a session, never chooses a prompt, and never handles the child's
// findings.
//
// That asymmetry is the entire design, because the alternative is the legacy
// engine wearing a new hat. If the child's findings came back as text for the
// parent to relay, an LLM would once again sit on the data path between a
// reviewer and the merge — which is the exact relay that produced whole-rule
// drops, field stripping, and misattribution (#138's failure table). So:
//
//   - the child writes `findings.json` into host-created staging;
//   - the host reads that file and merges it, attributed to the PARENT rule;
//   - the parent receives a short digest for its own reasoning only.
//
// Nothing the parent says afterwards can add, remove, or edit a child finding.
// The digest is advisory to the parent and inert to the merge.
//
// Gated behind `--subagent-nesting on`. The issue asks for the gate because
// nesting has no data behind it yet; the gate is also the honest place to
// stand while it is unproven, since every delegation is real model spend the
// operator did not directly ask for.
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./definition.js";
import { withinPathScope } from "./definition.js";
import { normalizeGlobPath } from "../rules/glob.js";
import type { Finding } from "../review/types.js";

/**
 * How many delegations one parent task may make.
 *
 * A budget rather than a depth counter, because depth is already fixed at one
 * (a child is spawned without the delegate tool, below — it cannot delegate
 * further). What is unbounded without this is BREADTH: a reviewer that calls
 * the tool once per changed file turns one task into fifty sessions of real
 * spend. Small on purpose; a deep dive that is needed everywhere is not a deep
 * dive.
 */
export const MAX_DELEGATIONS_PER_TASK = 3;

/** Caps the parent-supplied question. Long enough to be specific, short enough not to be a second prompt. */
const MAX_QUESTION_CHARS = 500;

export interface DelegationRequest {
  readonly file: string;
  readonly question: string;
}

export interface DelegationOutcome {
  /** Findings the CHILD submitted, already attributed to the parent rule. */
  readonly findings: readonly Finding[];
  /** What the parent is told. Advisory: it cannot change `findings`. */
  readonly digest: string;
  readonly failureReason?: string;
}

/** Spawns and harvests one child. Injected so tests never touch the SDK. */
export type DelegationRunner = (
  request: DelegationRequest,
  context: { readonly parentRule: string; readonly outputDir: string },
) => Promise<DelegationOutcome>;

export type DelegationRejection =
  | "nesting-disabled"
  | "agent-not-permitted"
  | "out-of-scope"
  | "not-in-diff"
  | "budget-exhausted"
  | "empty-question";

export interface DelegationGateResult {
  readonly allowed: boolean;
  readonly rejection?: DelegationRejection;
  readonly message?: string;
}

export interface DelegationGateInput {
  readonly nestingEnabled: boolean;
  readonly agent: AgentDefinition | undefined;
  /** Paths the diff under review actually touches. */
  readonly changedFiles: readonly string[];
  readonly used: number;
  readonly request: DelegationRequest;
}

/**
 * Whether one delegation request may proceed.
 *
 * Pure and synchronous so every rejection is testable without a session, and
 * so the ORDER of the checks is visible. That order is deliberate: the two
 * capability checks come before the two content checks, because a disabled
 * gate or an unpermitted agent should give the same answer regardless of what
 * was asked — an error that varies with the request is an oracle for probing
 * what the host would otherwise allow.
 */
export function gateDelegation(input: DelegationGateInput): DelegationGateResult {
  if (!input.nestingEnabled) {
    return {
      allowed: false,
      rejection: "nesting-disabled",
      message: "Delegation is disabled. Continue the review yourself.",
    };
  }
  if (input.agent?.delegate !== true) {
    return {
      allowed: false,
      rejection: "agent-not-permitted",
      message: "This reviewer is not permitted to delegate. Continue the review yourself.",
    };
  }
  if (input.used >= MAX_DELEGATIONS_PER_TASK) {
    return {
      allowed: false,
      rejection: "budget-exhausted",
      message:
        `Delegation budget exhausted (${MAX_DELEGATIONS_PER_TASK} per review). ` +
        `Continue the review yourself.`,
    };
  }

  const question = input.request.question?.trim() ?? "";
  if (question.length === 0) {
    return {
      allowed: false,
      rejection: "empty-question",
      message: "A delegation needs a specific question. Nothing was asked.",
    };
  }

  const file = normalizeGlobPath((input.request.file ?? "").replace(/\\/gu, "/").trim());
  if (file.length === 0) {
    return { allowed: false, rejection: "not-in-diff", message: "No file was named." };
  }

  // IN THE DIFF is checked before the agent's own scope, and it is the check
  // that carries the security weight. `path_scope` is the agent author's
  // narrowing; this is the host's, and it is not optional or configurable: a
  // reviewer may only deep-dive a file this pull request actually changes.
  // Without it, `delegate("~/.pi/agent/auth.json", "...")` is a request the
  // host would happily build a prompt around.
  const changed = new Set(input.changedFiles.map((candidate) => normalizeGlobPath(candidate)));
  if (!changed.has(file)) {
    return {
      allowed: false,
      rejection: "not-in-diff",
      message: `"${file}" is not a file this pull request changes.`,
    };
  }

  if (!withinPathScope(input.agent, file)) {
    return {
      allowed: false,
      rejection: "out-of-scope",
      message: `"${file}" is outside this reviewer's declared path scope.`,
    };
  }

  return { allowed: true };
}

const DELEGATE_SCHEMA = Type.Object({
  file: Type.String({
    description: "One file, exactly as it appears in the diff, to examine closely.",
  }),
  question: Type.String({
    description: "The specific question to answer about that file.",
  }),
});

/**
 * Builds the `delegate` tool for one parent task.
 *
 * Every decision is host-side and closed over: the parent's rule name, its
 * agent, the diff's file list, the staging directory, and the running budget
 * all live here rather than in the tool's arguments. The model supplies a file
 * and a question; it supplies nothing else, and cannot.
 */
export function createDelegateTool(options: {
  readonly parentRule: string;
  readonly agent: AgentDefinition | undefined;
  readonly nestingEnabled: boolean;
  readonly changedFiles: readonly string[];
  readonly outputDir: string;
  readonly run: DelegationRunner;
  /** Collects child findings for the host merge. The parent never sees this array. */
  readonly harvested: Finding[];
}): ToolDefinition<typeof DELEGATE_SCHEMA> {
  let used = 0;
  return {
    name: "delegate",
    label: "Delegate a file-scoped deep dive",
    description:
      "Ask for a closer look at ONE file this pull request changes. A separate reviewer " +
      "examines it and its findings are recorded automatically. You receive a short summary " +
      `for your own reasoning. At most ${MAX_DELEGATIONS_PER_TASK} per review.`,
    parameters: DELEGATE_SCHEMA,
    async execute(_toolCallId, params) {
      const request: DelegationRequest = {
        file: typeof params.file === "string" ? params.file : "",
        question: typeof params.question === "string" ? params.question.slice(0, MAX_QUESTION_CHARS) : "",
      };
      const gate = gateDelegation({
        nestingEnabled: options.nestingEnabled,
        agent: options.agent,
        changedFiles: options.changedFiles,
        used,
        request,
      });
      if (!gate.allowed) {
        // A refusal is a TOOL RESULT, not an exception: a reviewer that asked
        // for something it may not have should carry on reviewing, and a
        // thrown error would end the task and lose every finding it already
        // had. The reason is stated plainly so the model stops retrying.
        return {
          content: [{ type: "text", text: gate.message ?? "Delegation refused." }],
          details: { delegated: false, rejection: gate.rejection },
        };
      }

      // Counted BEFORE the run, so a child that throws still consumes budget.
      // Otherwise a failing delegation is retryable without limit, which is
      // the same unbounded spend the budget exists to stop.
      used += 1;

      const childDir = path.join(options.outputDir, `delegate-${used}`);
      let outcome: DelegationOutcome;
      try {
        outcome = await options.run(request, { parentRule: options.parentRule, outputDir: childDir });
      } catch (err) {
        const message = (err as Error).message;
        console.warn(
          `delegate: child for rule "${options.parentRule}" failed (${message})`,
        );
        return {
          content: [
            {
              type: "text",
              text: "The delegated review did not complete. Continue the review yourself.",
            },
          ],
          details: { delegated: true, succeeded: false },
        };
      }

      // The findings go to the HOST's collection. They are not returned to the
      // parent in a form it could edit and re-emit — that would put an LLM
      // back on the data path between the child and the merge.
      options.harvested.push(...outcome.findings);

      return {
        content: [{ type: "text", text: outcome.digest }],
        details: {
          delegated: true,
          succeeded: outcome.failureReason === undefined,
          findingCount: outcome.findings.length,
        },
      };
    },
  };
}

/**
 * The digest a parent receives after a delegation.
 *
 * Titles and locations only — never the child's full message, and never its
 * `suggestion`. The parent's job after a delegation is to decide what ELSE to
 * look at, and giving it the complete finding invites it to restate one in its
 * own words, producing a near-duplicate that clustering then has to merge back
 * together. Saying less is what keeps the child's finding the only copy.
 */
export function buildDelegationDigest(findings: readonly Finding[], question: string): string {
  if (findings.length === 0) {
    return `The delegated reviewer found nothing for: ${question}`;
  }
  const lines = findings.map((finding) => {
    const where = typeof finding.line === "number" ? `${finding.file}:${finding.line}` : finding.file;
    const what = finding.title?.trim() || finding.message.split(/(?<=[.!?])\s/u)[0] || "(no title)";
    return `- [${finding.severity}] ${where} — ${what}`;
  });
  return [
    `The delegated reviewer recorded ${findings.length} finding(s). They are already part of this review;`,
    `do not restate them. Use them to decide what else to examine.`,
    "",
    ...lines,
  ].join("\n");
}
