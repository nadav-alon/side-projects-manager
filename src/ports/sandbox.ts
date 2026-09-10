import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import type { Ticket } from "./issue-tracker.ts";
import type { TokenCount } from "./token-count.ts";
import type { Usd } from "./usd.ts";

/** One ticket, and the project checkout it is to be worked against. */
export interface RunRequest {
  ticket: Ticket;
  /**
   * The project's managed clone. The agent never works here — the sandbox
   * gives it a clone of its own — but this is what that clone comes from and
   * what the branch is fetched back into.
   */
  checkout: Checkout;
  /**
   * The most this run may spend, enforced by the agent CLI itself rather than
   * by anything the manager can observe. Distinct from the budget gate: the
   * gate decides whether a run starts, and the ceiling bounds how far a run
   * that has started can take the windows before the gate is asked again.
   */
  spendCeiling: Usd;
}

export interface SandboxRunResult {
  /** Branch the agent left its commits on. */
  branch: Branch;
  commits: string[];
  /** The agent's own output, for the ticket comment on failure. */
  output: string;
  /** Tokens the run consumed, fed back to the ledger and the summary. */
  tokensUsed: TokenCount;
  /**
   * Why the run did not finish cleanly, absent when it did.
   *
   * A failed agent is still a run: it spent tokens, it may have committed
   * before it fell over, and what it said is what a person needs to read. So
   * the failure is reported alongside that rather than thrown in place of it,
   * and a caller that ignores this field must not read the result as success.
   */
  failure?: string;
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
   * Runs `request.ticket` against the project's managed clone at
   * `request.checkout`. The agent works somewhere of its own, on a branch of
   * its own, so the branch the checkout is on is never committed to; the
   * branch it leaves behind is the one named in the result.
   *
   * Rejects only when the sandbox itself could not be set up or taken down.
   * An agent that failed comes back as a result carrying `failure`, because
   * its commits, its output and its spend are all still the morning's.
   */
  run(request: RunRequest): Promise<SandboxRunResult>;
}
