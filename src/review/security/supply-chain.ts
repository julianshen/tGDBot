// Issue #139, `security:supply-chain`. The second HOST detector, and a host
// check for the same reason the first is one: these defects are decidable from
// the text. A workflow with `pull_request_target` plus a mutable action ref, a
// dependency pinned to a branch, `permissions: write-all` — none of them needs
// a model to have an opinion, and a model asked for one will sometimes
// disagree with the evidence in front of it.
//
// Being a host check also removes them from the per-review model budget
// entirely, which is the difference between a security pass that runs on every
// review and one an operator turns off because of the bill.
//
// Same discipline as `secrets.ts`:
//
//   - it reports only what it can DECIDE, from an added line and its file's
//     path. A workflow whose risk depends on what a called action does is not
//     reported, because the detector cannot read that action.
//   - `suggestion` is never used. A fired detector has found something that is
//     not correct as written, and `suggestion` asserts the opposite.
//   - a line it cannot classify produces nothing, rather than a hedge.
//
// Unlike secrets, these findings are SAFE TO QUOTE: a mutable action ref is
// public information and the author needs to see which one. So no
// `redactSource` here — and that difference is deliberate rather than an
// oversight, because a detector that redacted everything would make its own
// findings harder to act on for no gain.
import path from "node:path";
import { addedLinesByFile } from "../diff-anchors.js";
import type { Finding } from "../types.js";
import type { RuleDefinition } from "../../rules/types.js";

/** The reserved rule name these findings carry. */
export const SUPPLY_CHAIN_RULE_NAME = "security:supply-chain";

/**
 * The policy `poll.ts` resolves for a conversation command on one of these.
 *
 * Without it, `explain` answers "the trusted rule is no longer active" about a
 * finding the host produced moments earlier, because the lookup searches the
 * loaded rules and this name is never dispatched. Same shape and reason as
 * `SECRETS_POLICY`.
 */
export const SUPPLY_CHAIN_POLICY: RuleDefinition = Object.freeze({
  name: SUPPLY_CHAIN_RULE_NAME,
  dependsOn: Object.freeze([]),
  body:
    "This finding was computed by the host: a line added by this pull request matches a known " +
    "supply-chain or CI hazard. Explain what the hazard is and what a safe version looks like, " +
    "using the recorded finding and the current code. Do not invent scanner evidence and do not " +
    "claim the referenced action or dependency was inspected — the host matched a pattern in the " +
    "workflow or manifest text and nothing more.",
  sourcePath: "<host:security-supply-chain>",
});

/** Whether a path is a GitHub Actions workflow — the only files the CI checks apply to. */
function isWorkflow(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/");
  return (
    /(^|\/)\.github\/workflows\//u.test(normalized) &&
    [".yml", ".yaml"].includes(path.extname(normalized).toLowerCase())
  );
}

/** Whether a path is a GitHub Actions composite/action definition. */
function isActionDefinition(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/").toLowerCase();
  return normalized.endsWith("/action.yml") || normalized.endsWith("/action.yaml") ||
    normalized === "action.yml" || normalized === "action.yaml";
}

/**
 * A 40-character hex SHA is the only immutable way to name an action version.
 *
 * Tags and branches are both mutable: `@v4` moves when the publisher moves it,
 * and a compromised or transferred repository can move it somewhere else. This
 * is not a hypothetical — it is the shape of the `tj-actions/changed-files`
 * incident, where a tag was repointed at malicious code.
 */
const IMMUTABLE_REF = /^[0-9a-f]{40}$/u;

interface Hazard {
  readonly title: string;
  readonly message: string;
  readonly severity: Finding["severity"];
}

/** `uses: owner/repo@ref` on an added line, with the ref captured. */
const USES_RE = /^\s*(?:-\s*)?uses:\s*["']?([^"'\s@]+)@([^"'\s#]+)/u;

/** `permissions: write-all` or a bare `write-all` value under it. */
const WRITE_ALL_RE = /^\s*permissions:\s*write-all\s*$/u;

/**
 * Whether a workflow is actually TRIGGERED by `pull_request_target`.
 *
 * Matching the name anywhere was a false positive at `blocking` severity — the
 * worst kind a host detector can produce. A comment mentioning the trigger, or
 * `run: echo pull_request_target`, blocked a safe workflow change (Codex
 * review of PR #151).
 *
 * Scanned rather than parsed: a YAML parser is a dependency this detector does
 * not need, and the shapes a trigger declaration takes are few. It must be
 * either the `on:` key's own value, or a key inside the `on:` block —
 *
 *     on: pull_request_target
 *     on: [push, pull_request_target]
 *     on:
 *       pull_request_target:
 *         types: [opened]
 *
 * — and the block ends at the next top-level key, which is what stops a `jobs:`
 * step being read as a trigger.
 */
function triggersOnPullRequestTarget(lines: readonly string[]): boolean {
  const NAME = /(?:^|[\s[,])pull_request_target(?:[\s\]:,]|$)/u;
  let inOnBlock = false;
  for (const raw of lines) {
    // A comment is never a declaration, whatever it says.
    const line = raw.replace(/#.*$/u, "");
    if (line.trim().length === 0) continue;

    const inlineOn = /^on\s*:(.*)$/u.exec(line);
    if (inlineOn) {
      const value = inlineOn[1] as string;
      if (NAME.test(value)) return true;
      // `on:` with nothing after it opens a block; `on: push` does not.
      inOnBlock = value.trim().length === 0;
      continue;
    }
    // Any other top-level key closes the block.
    if (/^\S/u.test(line)) {
      inOnBlock = false;
      continue;
    }
    // Inside the block, a trigger is a key of its own.
    if (inOnBlock && /^\s+pull_request_target\s*:/u.test(line)) return true;
    // A YAML sequence item under `on:` — `  - pull_request_target`.
    if (inOnBlock && /^\s+-\s*pull_request_target\s*$/u.test(line)) return true;
  }
  return false;
}

/**
 * Git-URL and branch-pinned dependency specs in a package.json line.
 *
 * Bounded deliberately: only the forms where the RESOLVED code can change
 * without the manifest changing. A caret range is not reported — it is
 * ordinary practice, the lockfile pins it, and reporting it would bury the
 * genuinely mutable specs underneath.
 */
const GIT_DEPENDENCY_RE =
  /"\s*:\s*"((?:git\+|github:|gitlab:|bitbucket:)[^"]*|[^"]*\.git#[^"]*)"/u;

/**
 * A git dependency pinned to a full commit SHA is NOT a moving ref.
 *
 * Without this the detector told the author to pin to exactly the form
 * already in front of them, which is the kind of finding that teaches readers
 * the section is not worth reading (Codex review of PR #151). Same rule the
 * action refs already follow.
 */
function isImmutableGitSpec(spec: string): boolean {
  const fragment = spec.slice(spec.lastIndexOf("#") + 1);
  return spec.includes("#") && IMMUTABLE_REF.test(fragment);
}

function classifyWorkflowLine(text: string): Hazard | undefined {
  const uses = USES_RE.exec(text);
  if (uses) {
    const [, action, ref] = uses as unknown as [string, string, string];
    // A local action (`./.github/actions/x`) has no ref to move — it is the
    // repository's own code, reviewed by this very pull request.
    if (action.startsWith("./") || action.startsWith("docker://")) return undefined;
    if (IMMUTABLE_REF.test(ref)) return undefined;
    return {
      severity: "warning",
      title: `This workflow pins \`${action}\` to a mutable ref`,
      message:
        `\`${action}@${ref}\` names a tag or branch, not a commit. Both can be repointed by ` +
        `anyone who can push to that repository, so the code this workflow runs can change ` +
        `without this repository changing — which is how the \`tj-actions/changed-files\` ` +
        `compromise reached its downstream users. Pin the 40-character commit SHA and keep the ` +
        `human-readable version in a trailing comment.`,
    };
  }

  if (WRITE_ALL_RE.test(text)) {
    return {
      severity: "warning",
      title: "This workflow grants `write-all` permissions",
      message:
        "`permissions: write-all` gives every step in this workflow write access to the whole " +
        "repository, including contents, packages and actions. Any compromised dependency in " +
        "any step inherits it. Declare the specific permissions the job needs instead; the " +
        "common case is `contents: read`.",
    };
  }

  return undefined;
}

/**
 * `pull_request_target` combined with an explicit checkout of the PR's head.
 *
 * Reported TOGETHER rather than separately because `pull_request_target` alone
 * is legitimate — it is the documented way to label or comment on a pull
 * request from a fork. The hazard is the combination: that trigger runs with
 * the base repository's secrets and a writable token, and checking out the
 * PR's own code under it executes an attacker's changes with them.
 *
 * Two separate warnings would report the safe use of the trigger on every
 * repository that labels pull requests, which is the alarm fatigue that trains
 * people to skip the section.
 */
const HEAD_CHECKOUT_RE =
  /^\s*ref:\s*["']?\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)\s*\}\}/u;

function pullRequestTargetHazard(
  lines: ReadonlyMap<number, string>,
  headText: string | undefined,
): number | undefined {
  let addedTrigger: number | undefined;
  let addedCheckout: number | undefined;
  for (const [line, text] of lines) {
    // Judged against the WHOLE file, not the line alone: `on:` may be above
    // the added line, and a trigger declaration is a property of its position
    // in the document. The added line still has to be part of the declaration,
    // which `triggersOnPullRequestTarget` establishes over the added lines in
    // isolation as a conservative approximation.
    if (triggersOnPullRequestTarget([text])) addedTrigger ??= line;
    if (HEAD_CHECKOUT_RE.test(text)) addedCheckout ??= line;
  }
  // At least one HALF must be added by this pull request — otherwise the
  // combination predates it and reporting it on every unrelated change to the
  // workflow is the alarm fatigue added-lines-only exists to avoid.
  if (addedTrigger === undefined && addedCheckout === undefined) return undefined;

  // But the OTHER half may already be in the file. A pull request that adds
  // the head `ref:` to a workflow that already uses `pull_request_target`
  // introduces the exploitable combination just as surely as one that adds
  // both, and an added-lines-only check saw one half and stayed silent
  // (Codex review of PR #151).
  const whole = headText === undefined ? [...lines.values()] : headText.split("\n");
  // The HEAD file is the authority on whether the workflow is triggered this
  // way; the added-line check above is only about which half is new.
  const hasTrigger = triggersOnPullRequestTarget(whole) || addedTrigger !== undefined;
  const hasCheckout =
    addedCheckout !== undefined || whole.some((text) => HEAD_CHECKOUT_RE.test(text));
  if (!hasTrigger || !hasCheckout) return undefined;

  // Anchored to the half this pull request ADDED: that is the line its author
  // can act on, and the line a reviewer is looking at.
  return addedTrigger ?? addedCheckout;
}

/**
 * Workflow paths this diff touches, for the host to read at HEAD.
 *
 * Only workflows: they are the only files whose combined checks need more than
 * the added lines, and reading every changed file would cost a provider call
 * per file for nothing.
 */
export function changedWorkflowFiles(diff: string): readonly string[] {
  return [...addedLinesByFile(diff).keys()].filter(isWorkflow);
}

/**
 * Supply-chain and CI hazards introduced by this pull request.
 *
 * ADDED lines only, for the same reason `secrets.ts` reports only added lines:
 * a hazard already present at the base was not introduced here, and reporting
 * it on every unrelated pull request that touches the file is alarm fatigue.
 * It is a real problem, but it is not this review's finding to make.
 *
 * Never throws: a detector that cannot run must not take the review with it.
 */
export function detectSupplyChainHazards(
  diff: string,
  /**
   * Workflow contents at HEAD, by path. Optional: without it the combined
   * `pull_request_target` check sees only added lines and misses a pull
   * request that supplies one half of the pairing. The rest of the detector
   * needs nothing beyond the diff.
   */
  headFiles: ReadonlyMap<string, string> = new Map(),
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, lines] of addedLinesByFile(diff)) {
    const workflow = isWorkflow(file);
    const action = isActionDefinition(file);

    if (workflow || action) {
      for (const [line, text] of lines) {
        const hazard = classifyWorkflowLine(text);
        if (hazard === undefined) continue;
        findings.push({
          file,
          line,
          severity: hazard.severity,
          category: "security",
          ruleName: SUPPLY_CHAIN_RULE_NAME,
          title: hazard.title,
          message: hazard.message,
          decision: "new",
        });
      }
    }

    if (workflow) {
      // Whole-file, not per-line: the trigger and the checkout are different
      // lines, and either alone is unremarkable.
      const line = pullRequestTargetHazard(lines, headFiles.get(file));
      if (line !== undefined) {
        findings.push({
          file,
          line,
          severity: "blocking",
          category: "security",
          ruleName: SUPPLY_CHAIN_RULE_NAME,
          title: "This workflow runs pull request code with the base repository's secrets",
          message:
            "`pull_request_target` runs in the context of the BASE repository — with its secrets " +
            "and a writable `GITHUB_TOKEN` — and this workflow also checks out the pull " +
            "request's own head. Any contributor who can open a pull request can therefore run " +
            "arbitrary code with those credentials. Either use `pull_request`, which runs " +
            "without them, or keep `pull_request_target` and do not check out or execute the " +
            "pull request's code.",
          decision: "new",
        });
      }
    }

    if (path.basename(file.replace(/\\/gu, "/")) === "package.json") {
      for (const [line, text] of lines) {
        const spec = GIT_DEPENDENCY_RE.exec(text)?.[1];
        if (spec === undefined || isImmutableGitSpec(spec)) continue;
        findings.push({
          file,
          line,
          severity: "warning",
          category: "security",
          ruleName: SUPPLY_CHAIN_RULE_NAME,
          title: "This dependency resolves to a moving git ref",
          message:
            "A dependency specified as a git URL or a branch resolves to whatever that ref " +
            "points at when it is installed, so the code entering the build can change without " +
            "this manifest changing, and the registry's integrity checks do not apply to it. " +
            "Depend on a published version, or pin the git dependency to a full commit SHA.",
          decision: "new",
        });
      }
    }
  }
  return findings;
}
