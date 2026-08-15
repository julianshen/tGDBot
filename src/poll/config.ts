import type { PollArgs, SharedReviewOptions } from "../cli-args.js";
import { createProviderAdapter } from "../config.js";
import { selectConversationStateRoot } from "../conversation/state-paths.js";
import { parseRepositoryRef } from "../target/review-target.js";
import type { RepositoryRef } from "../target/types.js";
import type { VcsAdapter } from "../vcs/adapter.js";
import type { ConversationAdapter } from "../vcs/conversation-adapter.js";

export const MAX_POLL_EVENTS = 200;

export interface ResolvedPollConfig extends SharedReviewOptions {
  readonly command: "poll";
  readonly repo: string;
  readonly repository: RepositoryRef;
  readonly conversationAdapter: ConversationAdapter;
  readonly vcsAdapter: VcsAdapter;
  readonly stateRoot: string;
}

export function resolvePollConfig(args: PollArgs): ResolvedPollConfig {
  if (typeof args.repo !== "string" || args.repo.length === 0) {
    throw new Error("poll requires an explicit --repo and rejects ambient repositories");
  }
  const repository = parseRepositoryRef(args.repo, args.vcs);
  const adapter = createProviderAdapter(repository);
  return {
    ...args,
    command: "poll",
    repo: args.repo,
    repository,
    conversationAdapter: adapter,
    vcsAdapter: adapter,
    stateRoot: selectConversationStateRoot({ explicitStateDir: args.stateDir }),
  };
}
