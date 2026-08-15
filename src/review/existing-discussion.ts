import type { ReviewThreadSnapshot } from "../vcs/conversation-adapter.js";

export const MAX_DISCUSSION_MEMORIES = 10;
export const MAX_DISCUSSION_MEMORY_CHARS = 240;

export interface ExistingReviewIssue {
  readonly threadId: string;
  readonly file: string;
  readonly line: number;
}

export interface DiscussionMemory {
  readonly threadId: string;
  readonly file?: string;
  readonly line?: number;
  readonly author: string;
  readonly summary: string;
  readonly url?: string;
}

export interface ExistingDiscussionSummary {
  readonly existingIssues: readonly ExistingReviewIssue[];
  readonly discussionMemories: readonly DiscussionMemory[];
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/gu;

function summarizeBody(body: string): string {
  const normalized = body.replace(CONTROL_RE, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_DISCUSSION_MEMORY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_DISCUSSION_MEMORY_CHARS - 1).trimEnd()}…`;
}

/**
 * Produces deterministic, provider-neutral evidence from active review threads.
 * An active anchor suppresses another inline finding at the same file/line;
 * human comments are separately retained as bounded summaries for the managed
 * review comment. Bot text is never echoed as "other reviewer" memory.
 */
export function summarizeExistingDiscussion(
  threads: readonly ReviewThreadSnapshot[],
): ExistingDiscussionSummary {
  const existingIssues: ExistingReviewIssue[] = [];
  const discussionMemories: DiscussionMemory[] = [];
  const seenAnchors = new Set<string>();
  const seenMemories = new Set<string>();

  for (const thread of threads) {
    if (thread.resolved || thread.outdated) continue;
    const file = thread.placement?.file;
    const line = thread.placement?.line;
    if (file !== undefined && line !== undefined) {
      const anchorKey = JSON.stringify([file, line]);
      if (!seenAnchors.has(anchorKey)) {
        seenAnchors.add(anchorKey);
        existingIssues.push({ threadId: thread.threadId, file, line });
      }
    }

    for (const event of thread.events ?? []) {
      if (discussionMemories.length >= MAX_DISCUSSION_MEMORIES) break;
      if (event.kind === "thread-resolution" || event.authorIsBot) continue;
      const summary = summarizeBody(event.body);
      if (summary.length === 0) continue;
      const memoryKey = JSON.stringify([thread.threadId, event.commentId ?? event.eventId, event.revisionId]);
      if (seenMemories.has(memoryKey)) continue;
      seenMemories.add(memoryKey);
      discussionMemories.push({
        threadId: thread.threadId,
        ...(file === undefined ? {} : { file }),
        ...(line === undefined ? {} : { line }),
        author: event.authorLogin,
        summary,
        ...(thread.url === undefined ? {} : { url: thread.url }),
      });
    }
  }

  return { existingIssues, discussionMemories };
}
