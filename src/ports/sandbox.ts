import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import type { ReviewTicket, Ticket } from "./issue-tracker.ts";
import type { ModelName } from "./model-name.ts";
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
  /**
   * The model to start the agent CLI on, absent to leave the image's own pin
   * in force. Resolving which model a ticket gets is not this port's job —
   * whatever names it here is what the run uses, passed through unchanged.
   */
  model?: ModelName;
}

/** One review ticket, and the project checkout it is to be worked against. */
export interface ReviewRequest {
  ticket: ReviewTicket;
  /** The project's managed clone, read from but never written to. */
  checkout: Checkout;
  spendCeiling: Usd;
  /** As `RunRequest.model`. */
  model?: ModelName;
}

/**
 * What the agent CLI said when it refused the model it was started on: the
 * name that was asked for, and the CLI's own words refusing it.
 *
 * The ticket is the problem here, not the agent and not the setup — a bad
 * model label or a stale model default is what this names, distinct from an
 * agent that gave up on the work and from a sandbox that could not run the
 * agent at all.
 */
export interface ModelRefusal {
  /** The model the run was asked for. */
  model: ModelName;
  /** The agent CLI's own words refusing it, as a reader would want them. */
  words: string;
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
  /**
   * What the provider said when the provider limit refused the run, absent
   * when it did not. Set instead of `failure`, never beside it: the limit is
   * nobody's problem with the ticket, and a caller that read it as an agent
   * giving up would hand back every ticket the limit touches.
   */
  limitRefusal?: string;
  /**
   * Set instead of `failure` and `limitRefusal`, never beside either, when
   * `RunRequest.model` was refused by the agent CLI rather than run.
   */
  modelRefusal?: ModelRefusal;
}

/** What a reviewing agent's run in the container came back with. */
export interface ReviewRunResult {
  /** The reviewer's own output: what it posted, or why it could not. */
  output: string;
  tokensUsed: TokenCount;
  /** Why the run did not finish cleanly, absent when it did. */
  failure?: string;
  /** As `SandboxRunResult.limitRefusal`. */
  limitRefusal?: string;
  /** As `SandboxRunResult.modelRefusal`. */
  modelRefusal?: ModelRefusal;
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
   * Rejects only when the sandbox itself could not be set up or taken down,
   * which includes a container that could not start the agent at all. An
   * agent that ran and failed comes back as a result carrying `failure`,
   * because its commits, its output and its spend are all still the morning's.
   */
  run(request: RunRequest): Promise<SandboxRunResult>;
  /**
   * Runs a reviewing agent against `request.ticket.pullRequest`, in a
   * container with no context from the run that produced it — a fresh
   * `docker run`, exactly like any other, is what makes the separation real
   * rather than a fresh-looking prompt inside the same one.
   *
   * The reviewer staying a reviewer is enforced rather than merely asked for:
   * the container has no write access to its clone, and is handed a
   * separately scoped credential rather than the implementation's own, so an
   * attempt to commit or push fails whatever is tried and wherever it is
   * tried from (see the container adapter's `Mount` for the full story).
   *
   * Queues behind, and ahead of, calls to `run` on the same instance: reviews
   * and implementations still share the one budgeted lane.
   */
  review(request: ReviewRequest): Promise<ReviewRunResult>;
}
