import type { Ticket } from "./issue-tracker.ts";
import type { TokenCount } from "./token-count.ts";

export interface SandboxRunResult {
  /** Branch the agent left its commits on. */
  branch: string;
  commits: string[];
  /** The agent's own output, for the ticket comment on failure. */
  output: string;
  /** Tokens the run consumed, fed back to the ledger and the summary. */
  tokensUsed: TokenCount;
}

/**
 * Runs a coding agent against one ticket, in a container, on a worktree. The
 * loop never runs an agent on the host.
 *
 * TODO[#7]: delegate to sandcastle, against the image built by #6.
 */
export interface Sandbox {
  run(ticket: Ticket): Promise<SandboxRunResult>;
}
