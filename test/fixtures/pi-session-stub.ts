// A stubbed pi SDK session for dispatch.test.ts — implements exactly the
// `DispatchSession` slice `dispatchRules` depends on (`prompt`,
// `getLastAssistantText`), never touching the real pi SDK or network. See
// TASKS.md Task 5 "Files Likely Touched" and its testing note: "No live LLM
// calls in tests".
import type { DispatchSession } from "../../src/review/dispatch.js";

export interface PiSessionStub {
  session: DispatchSession;
  prompts: string[];
}

export function createPiSessionStub(finalMessage: string | undefined): PiSessionStub {
  const prompts: string[] = [];

  const session: DispatchSession = {
    async prompt(text: string) {
      prompts.push(text);
    },
    getLastAssistantText() {
      return finalMessage;
    },
  };

  return { session, prompts };
}
