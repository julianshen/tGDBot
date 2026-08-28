// The audit reader walks the journal HEAD. `outcomes` is a sidecar with its own
// head and is not reachable from there, so offering it as an argument was an
// API that type-checked and then threw — and a caller had no way to tell which
// kinds were real (PR #74 review). The compiler refuses it now.
import { expectTypeOf } from "vitest";
import type { AuditJournalKind, JournalKind } from "../../../src/conversation/state-schema.js";
import type { ConversationStateStore } from "../../../src/conversation/state-store.js";

expectTypeOf<AuditJournalKind>().toEqualTypeOf<"events" | "memories" | "findings">();

// `outcomes` still names a journal FILE; it is only audit reads that exclude it.
expectTypeOf<JournalKind>().toEqualTypeOf<"events" | "memories" | "findings" | "outcomes">();

expectTypeOf<Parameters<ConversationStateStore["readAuditPage"]>[0]>()
  .toEqualTypeOf<AuditJournalKind>();

declare const store: ConversationStateStore;
// @ts-expect-error the outcome sidecar is not reachable through the audit reader
void store.readAuditPage("outcomes");
