// Issue #139: the host security detectors, in one table.
//
// A detector is defined in three places that must agree — the review path that
// runs it, the loader guard that reserves its name, and the conversation path
// that resolves its policy — and the failure mode of disagreement is silent.
// A name reserved in the loader but missing here would let a user rule publish
// under it; a policy missing here makes `explain` answer "the trusted rule is
// no longer active" about a finding the host produced moments earlier.
//
// So the table is the definition and every consumer reads it.
import type { Finding } from "../types.js";
import type { RuleDefinition } from "../../rules/types.js";
import { detectCommittedSecrets, SECRETS_POLICY, SECRETS_RULE_NAME } from "./secrets.js";
import {
  detectSupplyChainHazards,
  SUPPLY_CHAIN_POLICY,
  SUPPLY_CHAIN_RULE_NAME,
} from "./supply-chain.js";

export interface HostDetector {
  /** The reserved rule name. The host owns it unconditionally, pass on or off. */
  readonly ruleName: string;
  /** Pure, and must never throw the review away. */
  readonly detect: (diff: string) => Finding[];
  /** The host-owned policy a conversation command resolves for these findings. */
  readonly policy: RuleDefinition;
  /**
   * Whether the conversation path must WITHHOLD the surrounding code hunk when
   * answering about one of these findings.
   *
   * Deliberately per-detector rather than "any host finding". A committed
   * credential's hunk contains the value the finding refuses to quote, and a
   * model given it can repeat it into a world-readable reply. A mutable action
   * ref is public information the author needs to see, and withholding its
   * hunk would make the explanation worse for no gain — so conflating the two
   * would cost precision on one to protect the other.
   */
  readonly withholdsCodeHunk: boolean;
}

export const HOST_SECURITY_DETECTORS: readonly HostDetector[] = Object.freeze([
  {
    ruleName: SECRETS_RULE_NAME,
    detect: detectCommittedSecrets,
    policy: SECRETS_POLICY,
    withholdsCodeHunk: true,
  },
  {
    ruleName: SUPPLY_CHAIN_RULE_NAME,
    detect: detectSupplyChainHazards,
    policy: SUPPLY_CHAIN_POLICY,
    withholdsCodeHunk: false,
  },
]);

const BY_NAME: ReadonlyMap<string, HostDetector> = new Map(
  HOST_SECURITY_DETECTORS.map((detector) => [detector.ruleName, detector]),
);

/** Names the host publishes under. A user rule claiming one is a load error. */
export const RESERVED_HOST_RULE_NAMES: ReadonlySet<string> = new Set(BY_NAME.keys());

/** The detector that produced a finding, by its rule name. */
export function hostDetectorFor(ruleName: string | undefined): HostDetector | undefined {
  return ruleName === undefined ? undefined : BY_NAME.get(ruleName);
}
