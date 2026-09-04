import type { Ticket } from "./issue-tracker.ts";

export interface SandboxRunResult {
  /** Branch the agent left its commits on. */
  branch: string;
  commits: string[];
  /** The agent's own output, for the ticket comment on failure. */
  output: string;
  /** Tokens the run consumed, fed back to the ledger and the summary. */
  tokensUsed: number;
}

/**
 * Runs a coding agent against one ticket, in a container, on a worktree.
 *
 * The real implementation delegates to sandcastle (#7) against the image
 * built by #6. The loop never runs an agent on the host.
 */
export interface Sandbox {
  run(ticket: Ticket): Promise<SandboxRunResult>;
}
