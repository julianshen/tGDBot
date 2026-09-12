// The minimal slice of the pi SDK's `AgentSession` the review engine needs.
// The real `AgentSession` (from @earendil-works/pi-coding-agent) satisfies
// this shape directly, which is what lets tests substitute a plain object.
//
// This lived in `dispatch.ts` until the legacy orchestrating engine was
// deleted (#138 phase 4). Only the session SHAPE outlived it: the orchestrator
// itself, its event-capture reconciliation, and the correction layer that
// existed to repair a probabilistic merge all went with the engine.
export interface DispatchSession {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  /** Stops an in-flight prompt after timeout/failure before a later workflow wave starts. */
  abort?(): Promise<void>;
}
