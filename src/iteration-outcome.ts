import type { Discard } from "./handback-comment.ts";
import type {
  ApplyReviewTicket,
  Branch,
  Checkout,
  ModelName,
  ModelRefusal,
  PullRequestUrl,
  RebaseFinished,
  RebaseTicket,
  RepoSlug,
  ReviewFinished,
  ReviewTicket,
  RunFinished,
  RunLimitRefused,
  RunOutcome,
  Ticket,
  TokenCount,
} from "./ports/index.ts";

/**
 * Whose problem a failed run is.
 *
 * The distinction is the one the developer acts on: a hard ticket is theirs to
 * rewrite or drop, a broken sandbox is theirs to fix, and a morning that says
 * only "it failed" makes them go and find out which.
 */
export type FailureKind = RunFailure["kind"];

/**
 * Why an iteration's run did not finish, never started, or finished without
 * its work being handed over.
 */
export type RunFailure =
  | GaveUp
  | HandoverFailed
  | InfrastructureFailure
  | ModelRefused
  | UnsettledMergeability
  | UnusableModelLabel;

/** A failure whose ticket the loop hands back: every kind but the setup's. */
export type HandedBackFailure = Exclude<RunFailure, InfrastructureFailure>;

/** The agent ran and stopped short: it said it could not, or left the tests red. */
export interface GaveUp {
  kind: "gave-up";
  reason: string;
  /**
   * Whether the ticket made it back to the developer. False says the loop
   * could not comment or relabel, so the ticket is still eligible and will be
   * selected again — a morning that needs the developer to go and look at the
   * ticket themselves.
   */
  handedBack: boolean;
}

/**
 * A run that finished and committed, whose work could not be handed over: the
 * branch would not push or no draft pull request would open for it, or the
 * pull request opened and its review ticket could not be created.
 *
 * Handed back all the same, since the work exists and running the ticket again
 * would only make it twice. The branch is kept, not discarded: it is the work.
 */
export interface HandoverFailed {
  kind: "handover-failed";
  reason: string;
  /** Where the run's commits are. */
  branch: Branch;
  /** How far the branch got, and so where the developer finds the work. */
  where: HandoverReach;
  /** As `GaveUp.handedBack`. */
  handedBack: boolean;
}

/** How far a failed handover's branch got before the handover failed. */
export type HandoverReach =
  /** Never reached the host: `checkout` is the one place the work is. */
  | { kind: "unpushed"; checkout: Checkout }
  /** On the host, with no draft pull request known to be open for it. */
  | { kind: "pushed" }
  /** On the host, in `pullRequest`: only the review ticket failed. */
  | { kind: "opened"; pullRequest: PullRequestUrl };

/**
 * Where the model a run was started on came from. Absent from a run started
 * on no model at all, which the sandbox image's pin decides.
 */
export type ModelSource = "model label" | "model defaults";

/**
 * A model refusal: the agent CLI would not start on the model the run was
 * given. The ticket's model is the problem, so the ticket is handed back —
 * but the agent never gave up, and the setup did its part.
 */
export interface ModelRefused {
  kind: "model-refused";
  reason: string;
  refusal: ModelRefusal;
  /** What named the refused model: the ticket's model label or the model defaults. */
  source: ModelSource;
  /** As `GaveUp.handedBack`. */
  handedBack: boolean;
}

/**
 * A ticket whose model labels no run could be started on — two or more that
 * disagree, or one naming no usable model — caught at selection, so nothing
 * was cloned, run or spent.
 */
export interface UnusableModelLabel {
  kind: "conflicting-model-labels" | "unusable-model-label";
  reason: string;
  /** The model labels at fault, as the ticket carries them. */
  labels: readonly string[];
  /** As `GaveUp.handedBack`. */
  handedBack: boolean;
}

/**
 * A rebase ticket whose pull request the repo host never settled as
 * conflicting or not — commonly one merged or closed since — caught before
 * any run, so nothing was cloned, run or spent. The pull request is the
 * problem, not the setup, so the ticket is handed back: left eligible, it
 * would come round every firing ahead of the project's other work.
 */
export interface UnsettledMergeability {
  kind: "unsettled-mergeability";
  reason: string;
  /** As `GaveUp.handedBack`. */
  handedBack: boolean;
}

/**
 * The sandbox or the repo host could not do its part, so nothing ran. Never
 * handed back: the ticket is left eligible on purpose, since the setup is the
 * problem.
 */
export interface InfrastructureFailure {
  kind: "infrastructure";
  reason: string;
}

/**
 * What one iteration did with the ticket it selected: finished a run, failed
 * one, worked a review, an apply-review or a rebase ticket's own run, or had
 * any kind of run refused by the provider limit. Told apart by `kind`, and nothing else.
 *
 * Nothing here is thrown. A run that gave up, and one that never happened, are
 * described rather than raised, so the invocation still reports on the
 * projects behind them.
 */
export type Iteration =
  | Finished
  | Failed
  | Reviewed
  | AppliedReview
  | Rebased
  | LimitRefused;

/**
 * A limit refusal: an implementation, review, apply-review or rebase run the
 * provider limit refused. Not a failure: the ticket is nobody's problem, so it
 * is neither commented on nor relabelled, and stays eligible for a morning
 * with limit left to spend.
 */
export interface LimitRefused {
  kind: "limit-refused";
  /** What the provider said. */
  limitRefusal: string;
  /** What ran spent before the provider refused. Always set — a limit refusal has spent. */
  tokensUsed: TokenCount;
  /** What the implementation run left behind. Absent for a review. */
  run?: RunLimitRefused;
  /** What became of any branch the run left, discarded as a failed run's is. */
  discard: Discard;
}

/** An iteration whose run finished, and how its work reached the developer. */
export interface Finished {
  kind: "finished";
  run: RunFinished;
  /**
   * What the run spent. Always equal to `run.tokensUsed` — duplicated here so
   * `costOf` reads one field without telling a run and a review apart.
   */
  tokensUsed: TokenCount;
  /** Absent when the run committed nothing, so there was nothing to hand over. */
  handover?: Handover;
  /**
   * Set when the ticket itself could not be taken out of the queue: the
   * tracker refused the comment or the relabel that `handFinishedTicketBack`
   * tried on its behalf. Absent when that succeeded, whether or not the run
   * produced a handover — a run that committed nothing is given back too,
   * just with nothing to name in the comment but that.
   */
  handbackFailure?: string;
}

/**
 * What a finished run comes to for the developer: the draft pull request its
 * commits wait in, and the review queued against that pull request.
 */
export interface Handover {
  pullRequest: PullRequestUrl;
  reviewTicket: Ticket;
}

/**
 * An iteration whose run did not finish: an agent that gave up, whose ticket
 * is handed back, or an infrastructure failure, whose ticket is left as it was.
 */
export interface Failed {
  kind: "failed";
  failure: RunFailure;
  /** What the agent left behind. Absent when it never ran, and for a review. */
  run?: RunOutcome;
  /**
   * What ran spent, carried the same way whether it was a run's failure or a
   * review's — so the summary reads it without telling the two apart. Absent
   * when model labels named no run to start, and for an infrastructure
   * failure — including one where the sandbox rejected after the agent had
   * already spent something, a gap `TODO[#35]` still owns.
   */
  tokensUsed?: TokenCount;
}

/**
 * The project and ticket an iteration worked, and the model its run was
 * started on — absent when the sandbox image's pin decided, and when no run
 * was started because the ticket's model labels were unusable.
 */
export interface Attempt<T extends Ticket = Ticket> {
  repo: RepoSlug;
  ticket: T;
  model?: ModelName;
}

/** One iteration's outcome, and the project and ticket that earned it. */
export type IterationOutcome =
  | (Attempt & Finished)
  | (Attempt & Failed)
  | (Attempt<ReviewTicket> & Reviewed)
  | (Attempt<ApplyReviewTicket> & AppliedReview)
  | (Attempt<RebaseTicket> & Rebased)
  | (Attempt & LimitRefused);

/**
 * A review ticket's own run that finished without the agent giving up. There
 * is no pull request to name here — the review ticket already names the one
 * it is about — and no further review to queue, since nothing reviews a
 * review. A review that gave up or posted nothing is `Failed` instead.
 */
export interface Reviewed {
  kind: "reviewed";
  review: ReviewFinished;
  /**
   * What the review spent. Always equal to `review.tokensUsed` — duplicated
   * here for the same reason as `Finished.tokensUsed`.
   */
  tokensUsed: TokenCount;
  /**
   * Set when the loop could not finish the ticket off: the pull request could
   * not be checked for the posted comment, or the ticket could not be closed.
   * Either way it is still ready-for-agent, and the developer checks the pull
   * request and closes it by hand.
   */
  notClosed?: NotClosed;
}

/**
 * Why a review or a rebase that ran left its ticket open, and the error that
 * stopped it.
 */
export interface NotClosed {
  kind: "check-failed" | "close-failed";
  error: string;
}

/**
 * An apply-review ticket's own iteration that left no thread on its pull
 * request unanswered: its run finished and answered every one, or none was
 * open when the iteration started, so no run was needed. Either way the pull
 * request is marked ready for review and the ticket closed, declined threads
 * or not. A run that left a thread unanswered, or gave up, is `Failed`
 * instead.
 */
export interface AppliedReview {
  kind: "applied-review";
  /** The run. Absent when no thread was open to answer, so nothing ran. */
  review?: ReviewFinished;
  /** As `Failed.tokensUsed`: absent exactly when `review` is, nothing having run. */
  tokensUsed?: TokenCount;
  /**
   * The replies the run posted, by verdict. Absent when nothing ran, and when
   * they could not be read — `notClosed` says so.
   */
  answers?: { applied: number; declined: number };
  /**
   * Set when the loop could not finish the ticket off: the answers could not
   * be read, the pull request could not be marked ready, or the ticket could
   * not be closed. Either way the ticket is still ready-for-agent.
   */
  notClosed?: ApplyReviewNotClosed;
}

/** Why an apply-review iteration left its ticket open, and the error that stopped it. */
export interface ApplyReviewNotClosed {
  kind: "check-failed" | "ready-failed" | "close-failed";
  error: string;
}

/**
 * A rebase ticket's own iteration whose pull request no longer needs a
 * rebase: its run finished and the repo host no longer reports the pull
 * request conflicting, or it needed none when the iteration started, so no
 * run was needed. Either way the ticket is closed and the pull request's
 * draft state left alone. A run that gave up, or left the pull request still
 * conflicting, is `Failed` instead.
 */
export interface Rebased {
  kind: "rebased";
  /** The run. Absent when there was nothing to rebase, so nothing ran. */
  rebase?: RebaseFinished;
  /** As `Failed.tokensUsed`: absent exactly when `rebase` is, nothing having run. */
  tokensUsed?: TokenCount;
  /**
   * Set when the loop could not finish the ticket off: the pull request could
   * not be read back after the run, or the ticket could not be closed. Either
   * way the ticket is still ready-for-agent.
   */
  notClosed?: NotClosed;
}

/**
 * Whether `iteration` handed its ticket back for its model labels, and so
 * never started a run: nothing was spent, and on no model.
 */
export function handedBackForModelLabels(
  iteration: IterationOutcome,
): boolean {
  return iteration.kind === "failed" && isModelLabelFailure(iteration.failure);
}

function isModelLabelFailure(
  failure: RunFailure,
): failure is UnusableModelLabel {
  return (
    failure.kind === "conflicting-model-labels" ||
    failure.kind === "unusable-model-label"
  );
}

/** Why `iteration` failed: undefined when it ended any other way, or there was none. */
export function failureOf(
  iteration: Iteration | undefined,
): RunFailure | undefined {
  return iteration?.kind === "failed" ? iteration.failure : undefined;
}

/**
 * Whether `iteration` failed on the setup rather than the ticket: the one
 * failure that leaves its ticket eligible, and that a trigger exits non-zero on.
 */
export function failedOnInfrastructure(iteration: Iteration): boolean {
  return failureOf(iteration)?.kind === "infrastructure";
}
