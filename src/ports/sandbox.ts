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
 * Runs a coding agent against one ticket, in a container, on a checkout of its
 * own. The loop never runs an agent on the host.
 *
 * Implementations run one agent at a time within a process: concurrent calls
 * queue rather than overlap. Sequential runs are what keeps a morning's spend
 * predictable and what lets the budget gate mean anything, so the guarantee
 * lives here rather than in each caller. Two invocations of the manager are a
 * separate problem, and #15's once-per-day lock is what answers it.
 */
export interface Sandbox {
  /**
   * Runs `ticket` against the project's managed clone at `checkout`. The agent
   * works somewhere of its own, on a branch of its own, so the branch the
   * checkout is on is never committed to; the branch it leaves behind is the
   * one named in the result.
   */
  run(ticket: Ticket, checkout: string): Promise<SandboxRunResult>;
}
