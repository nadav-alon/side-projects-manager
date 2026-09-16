import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import type { CommitSha } from "./commit-sha.ts";
import type {
  ApplyReviewTicket,
  RebaseTicket,
  ReviewTicket,
  Ticket,
} from "./issue-tracker.ts";
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

/** One apply-review ticket, and the project checkout it is to be worked against. */
export interface ApplyReviewRequest {
  ticket: ApplyReviewTicket;
  /**
   * The project's managed clone: what the run's own clone comes from, and
   * where its GitHub remote is read. Never written to — the agent pushes to
   * the pull request's branch itself, so nothing comes back here.
   */
  checkout: Checkout;
  spendCeiling: Usd;
  /** As `RunRequest.model`. */
  model?: ModelName;
}

/** One rebase ticket, and the project checkout it is to be worked against. */
export interface RebaseRequest {
  ticket: RebaseTicket;
  /**
   * The project's managed clone: what the run's own clone comes from, and
   * where its GitHub remote is read. Never written to — the agent
   * force-pushes to the pull request's branch itself, so nothing comes back
   * here.
   */
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

/** Tokens a run or a review consumed. True of every way either can end. */
interface Ended {
  /** Tokens the run consumed, fed back to the ledger and the summary. */
  tokensUsed: TokenCount;
}

/**
 * The branch an implementation run worked on, and what it committed there.
 * True of every variant an implementation run can end as — the branch is
 * created before the agent starts, so even a run refused before the agent did
 * anything still leaves one, empty of commits. A review has neither: it
 * never creates a branch.
 */
interface Worked {
  /** Branch the agent worked on. */
  branch: Branch;
  commits: CommitSha[];
}

/** The agent ran to completion. */
export interface RunFinished extends Ended, Worked {
  kind: "finished";
  /** The agent's own output, for the ticket comment when it committed nothing. */
  output: string;
}

/** As `RunFinished`, for a review: there is no branch or commits to carry. */
export interface ReviewFinished extends Ended {
  kind: "finished";
  /** The reviewer's own output: what it posted, or why it could not. */
  output: string;
}

/** The agent ran and stopped short: it said it could not, or left the tests red. */
export interface RunGaveUp extends Ended, Worked {
  kind: "gave-up";
  /** The agent's own output, kept for the ticket comment. */
  output: string;
  /** Why the run did not finish cleanly. */
  reason: string;
}

/** As `RunGaveUp`, for a review. */
export interface ReviewGaveUp extends Ended {
  kind: "gave-up";
  output: string;
  reason: string;
}

/**
 * The provider limit refused the run: the agent CLI's whole answer is the
 * provider's own words, reset included.
 */
export interface RunLimitRefused extends Ended, Worked {
  kind: "limit-refused";
  /** What the provider said, word for word. */
  words: string;
}

/** As `RunLimitRefused`, for a review. */
export interface ReviewLimitRefused extends Ended {
  kind: "limit-refused";
  words: string;
}

/** `RunRequest.model` was refused by the agent CLI rather than run. */
export interface RunModelRefused extends Ended, Worked {
  kind: "model-refused";
  refusal: ModelRefusal;
}

/** As `RunModelRefused`, for a review. */
export interface ReviewModelRefused extends Ended {
  kind: "model-refused";
  refusal: ModelRefusal;
}

/**
 * How a run in the container ended, as exactly one variant: finished, gave
 * up, was refused by the provider limit, or was refused the model it was
 * asked to run on. Told apart by `kind`, and nothing else — a caller that
 * matches on it exhaustively needs no other field to know which is which.
 */
export type RunOutcome = RunFinished | RunGaveUp | RunLimitRefused | RunModelRefused;

/** As `RunOutcome`, for a review — with no branch or commits on any variant. */
export type ReviewOutcome =
  | ReviewFinished
  | ReviewGaveUp
  | ReviewLimitRefused
  | ReviewModelRefused;

/**
 * As `ReviewGaveUp`, for an apply-review run — which also gives up when the
 * repo host rejects its push because the pull request's branch moved under it.
 */
export interface ApplyReviewGaveUp extends ReviewGaveUp {
  /**
   * The head the branch had moved to, as the agent reported it, present only
   * when a rejected push is why the run gave up and the agent named the head
   * by its full hash — an abbreviation cannot be compared with the head the
   * repo host reports, so a run reporting one gave up without it.
   */
  movedHead?: CommitSha;
}

/**
 * As `ReviewOutcome`, for an apply-review run. No branch or commits on any
 * variant: the agent pushes to the pull request's branch itself, and what it
 * pushed and answered is read back from the repo host, never from here.
 */
export type ApplyReviewOutcome =
  | ReviewFinished
  | ApplyReviewGaveUp
  | ReviewLimitRefused
  | ReviewModelRefused;

/**
 * As `ApplyReviewGaveUp`, for a rebase run — which also gives up when the
 * repo host rejects its force-push because the pull request's branch moved
 * under it.
 */
export interface RebaseGaveUp extends ReviewGaveUp {
  /** As `ApplyReviewGaveUp.movedHead`. */
  movedHead?: CommitSha;
}

/**
 * As `ApplyReviewOutcome`, for a rebase run. No branch or commits on any
 * variant: the agent force-pushes to the pull request's branch itself, and
 * whether it worked is read back from the repo host, never from here.
 */
export type RebaseOutcome =
  | ReviewFinished
  | RebaseGaveUp
  | ReviewLimitRefused
  | ReviewModelRefused;

/**
 * Runs a coding agent against one ticket, in a container, on a checkout of its
 * own. The loop never runs an agent on the host.
 *
 * Runs and reviews run side by side, on one checkout or several: an
 * implementation does not wait for another implementation, or for a review,
 * to finish first. See ADR-0003 for why the budget gate accepts the
 * overshoot that comes with it, and the container adapter's own doc comment
 * for what still serializes on one checkout — the git steps around an
 * agent's work, never the agent itself.
 */
export interface Sandbox {
  /**
   * Runs `request.ticket` against the project's managed clone at
   * `request.checkout`. The agent works somewhere of its own, on a branch of
   * its own, so the branch the checkout is on is never committed to; the
   * branch it leaves behind is the one named in the result.
   *
   * Rejects only when the sandbox itself could not be set up or taken down,
   * which includes a container that could not start the agent at all, a clone
   * whose commit hashes are not ones a `CommitSha` can hold, and git failing
   * to read the agent's commits back or fetch them into the checkout. An
   * agent that ran and failed comes back as a result carrying `"gave-up"`,
   * because its commits, its output and its spend are all still the morning's.
   *
   * A request naming no model can never come back refused for one: that
   * variant of `RunOutcome` is excluded from what this overload returns,
   * since nothing was asked of the agent CLI for it to refuse.
   */
  run(request: RunRequest & { model: ModelName }): Promise<RunOutcome>;
  run(request: RunRequest & { model?: undefined }): Promise<Exclude<RunOutcome, RunModelRefused>>;

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
   * As `run`, a review naming no model can never come back refused for one.
   */
  review(request: ReviewRequest & { model: ModelName }): Promise<ReviewOutcome>;
  review(
    request: ReviewRequest & { model?: undefined },
  ): Promise<Exclude<ReviewOutcome, ReviewModelRefused>>;

  /**
   * Runs the `apply-pr-review` skill against `request.ticket.pullRequest`, on
   * a clone checked out on that pull request's head branch and mounted
   * read-write. The agent commits, pushes and replies itself, with the
   * implementation's own credential; no branch is created, and nothing is
   * fetched back into the checkout.
   *
   * Rejects as `run` does, and also when the pull request's head branch
   * cannot be looked up or fetched. As `run`, a request naming no model can
   * never come back refused for one.
   */
  applyReview(
    request: ApplyReviewRequest & { model: ModelName },
  ): Promise<ApplyReviewOutcome>;
  applyReview(
    request: ApplyReviewRequest & { model?: undefined },
  ): Promise<Exclude<ApplyReviewOutcome, ReviewModelRefused>>;

  /**
   * Runs the `rebase-pr` skill against `request.ticket.pullRequest`, on a
   * clone checked out on that pull request's head branch and mounted
   * read-write, exactly as `applyReview` sets one up — the run resolves the
   * conflicts and force-pushes itself, with the implementation's own
   * credential; no branch is created, and nothing is fetched back into the
   * checkout.
   *
   * Rejects as `applyReview` does. As `run`, a request naming no model can
   * never come back refused for one.
   */
  rebase(request: RebaseRequest & { model: ModelName }): Promise<RebaseOutcome>;
  rebase(
    request: RebaseRequest & { model?: undefined },
  ): Promise<Exclude<RebaseOutcome, ReviewModelRefused>>;
}
