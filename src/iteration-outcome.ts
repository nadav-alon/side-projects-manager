import type { Discard, HandBackRecord } from "./hand-back.ts";
import type {
  ApplyReviewTicket,
  Branch,
  Checkout,
  ModelName,
  ModelRefusal,
  PullRequestResolution,
  PullRequestTicket,
  PullRequestUrl,
  RebaseFinished,
  RebaseTicket,
  RepoSlug,
  ReviewFinished,
  ReviewLimitRefused,
  ReviewProviderFailed,
  ReviewTicket,
  RunFinished,
  RunLimitRefused,
  RunOutcome,
  RunProviderFailed,
  Ticket,
  TokenCount,
  TranscriptPath,
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
}

/**
 * A run that never happened, or whose work never reached the checkout,
 * because the sandbox or the repo host could not do its part — before the
 * agent started, or after it stopped. The setup is the problem. Never handed
 * back: the ticket is left eligible on purpose.
 */
export interface InfrastructureFailure {
  kind: "infrastructure";
  reason: string;
  /**
   * What an agent that did start spent, present exactly when the sandbox
   * failed after the agent had already run (`RunOutcome`'s `"sandbox-failed"`
   * case) — absent when the setup never got the agent running at all. Told
   * apart here, on the failure itself, rather than left for a reader to infer
   * from `Failed.tokensUsed`, which every kind of `RunFailure` can carry for
   * its own reason.
   */
  tokensUsed?: TokenCount;
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
  | PullRequestResolved
  | LimitRefused
  | ProviderFailed;

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
  /**
   * Where the refused run's session transcript landed, absent when none was
   * ever found. Carried here rather than read off `run`, which is absent for
   * a review, an apply-review or a rebase run's own limit refusal: every kind
   * of run can still leave a transcript behind, so this is the one field a
   * reader checks regardless of which kind refused.
   */
  transcript?: TranscriptPath;
  /** What became of any branch the run left, discarded as a failed run's is. */
  discard: Discard;
}

/**
 * A provider failure: an implementation, review, apply-review or rebase run
 * the provider itself cut off — down, overloaded or unreachable. As
 * `LimitRefused`: not a failure, so the ticket is nobody's problem, and stays
 * eligible for a later firing.
 */
export interface ProviderFailed {
  kind: "provider-failed";
  /**
   * What the CLI said, word for word — or, when it gave no message to quote,
   * a fixed line saying so; see `RunProviderFailed.words`.
   */
  providerFailure: string;
  /**
   * What ran spent before the provider stopped answering. Always set, though
   * possibly zero: a run cut off before any usage block existed to read has
   * nothing to report.
   */
  tokensUsed: TokenCount;
  /** What the implementation run left behind. Absent for a review. */
  run?: RunProviderFailed;
  /**
   * Where the cut-off run's session transcript landed, absent when none was
   * ever found. Carried and read exactly as `LimitRefused.transcript` is:
   * every kind of run leaves one behind whichever way the provider stopped
   * it.
   */
  transcript?: TranscriptPath;
  /** What became of any branch the run left, discarded as a failed run's is. */
  discard: Discard;
}

/**
 * A run the provider stopped before it finished — CONTEXT.md's "Cut off": a
 * limit refusal or a provider failure. Neither is a failure: the ticket is
 * left exactly as it was, and the invocation stands down, since every run
 * after it would be stopped the same way.
 */
export type CutOff = LimitRefused | ProviderFailed;

/** Whether `iteration` is cut off — CONTEXT.md's "Cut off" — rather than any other kind of ending. */
export function isCutOff(iteration: Iteration): iteration is CutOff {
  return iteration.kind === "limit-refused" || iteration.kind === "provider-failed";
}

/**
 * `run`'s own cut-off kind, as the iteration it comes to: the one place an
 * implementation run's limit refusal and provider failure are each built,
 * rather than a parallel copy for every ticket kind that can hit one.
 */
export function cutOffRunOutcome(
  run: RunLimitRefused | RunProviderFailed,
  discard: Discard,
): CutOff {
  const transcript =
    run.transcript === undefined ? {} : { transcript: run.transcript };
  return run.kind === "limit-refused"
    ? {
        kind: "limit-refused",
        limitRefusal: run.words,
        tokensUsed: run.tokensUsed,
        ...transcript,
        run,
        discard,
      }
    : {
        kind: "provider-failed",
        providerFailure: run.words,
        tokensUsed: run.tokensUsed,
        ...transcript,
        run,
        discard,
      };
}

/**
 * As `cutOffRunOutcome`, for a review, apply-review or rebase run: none of
 * those ever creates a branch, so there is never one to discard.
 */
export function cutOffReviewOutcome(
  review: ReviewLimitRefused | ReviewProviderFailed,
): CutOff {
  const transcript =
    review.transcript === undefined ? {} : { transcript: review.transcript };
  return review.kind === "limit-refused"
    ? {
        kind: "limit-refused",
        limitRefusal: review.words,
        tokensUsed: review.tokensUsed,
        ...transcript,
        discard: { kind: "none" },
      }
    : {
        kind: "provider-failed",
        providerFailure: review.words,
        tokensUsed: review.tokensUsed,
        ...transcript,
        discard: { kind: "none" },
      };
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
   * What became of the ticket's own hand-back — whether or not the run
   * produced a handover, since a run that committed nothing is given back
   * too, just with nothing to name in the comment but that.
   */
  handedBack: HandBackRecord;
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
 *
 * Split on `failure`'s kind, rather than carrying `handedBack` as one
 * optional field, so whether a ticket was handed back is recorded one way for
 * every kind of failure: a `HandedBackFailure` always carries the record of
 * its hand-back, and an `InfrastructureFailure` — never handed back — can
 * never be built with one.
 */
export type Failed = {
  kind: "failed";
  /** What the agent left behind. Absent when it never ran, and for a review. */
  run?: RunOutcome;
  /**
   * What ran spent, carried the same way whether it was a run's failure or a
   * review's — so the summary reads it without telling the two apart. Absent
   * when model labels named no run to start, and for an infrastructure
   * failure the sandbox never got the agent running for. Present all the
   * same for an infrastructure failure where the sandbox failed after the
   * agent had already run — equal, there, to `InfrastructureFailure.tokensUsed`,
   * which is where that distinction is actually told apart.
   */
  tokensUsed?: TokenCount;
  /**
   * Where the failed run's session transcript landed, absent when none was
   * ever found. As `tokensUsed`, carried here rather than read off `run` —
   * which is absent for a review, an apply-review or a rebase run — so a
   * reader checks the one field regardless of which kind of run failed.
   */
  transcript?: TranscriptPath;
} & (
  | { failure: InfrastructureFailure }
  /** What became of the ticket's own hand-back. */
  | { failure: HandedBackFailure; handedBack: HandBackRecord }
);

/**
 * Narrows `failed` to the branch that carries its own hand-back — every kind
 * but an infrastructure failure, which is never handed back. Checking
 * `failed.failure.kind` directly does not narrow `failed.handedBack` itself,
 * since the two live in different members of the intersection; this says so
 * once, as a type predicate, rather than at every reader of `Failed`.
 */
export function handedBackFailure<T extends Failed>(
  failed: T,
): failed is T & { failure: HandedBackFailure; handedBack: HandBackRecord } {
  return failed.failure.kind !== "infrastructure";
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
  | (Attempt<PullRequestTicket> & PullRequestResolved)
  | (Attempt & LimitRefused)
  | (Attempt & ProviderFailed);

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
  /**
   * Set when the ticket closed but `REVIEWED_LABEL` could not be added to its
   * pull request. The last step, tried only once the ticket is already
   * closed: a refusal here is reported rather than retried, never `notClosed`
   * — the ticket did close.
   */
  notLabelled?: NotLabelled;
}

/**
 * Why a review's iteration, or a pull request already resolved, left its
 * ticket open, and the error that stopped it.
 */
export interface NotClosed {
  kind: "check-failed" | "close-failed";
  error: string;
}

/**
 * Why a review or apply-review iteration's closed ticket could not have its
 * pull request labelled, and the error that stopped it.
 */
export interface NotLabelled {
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
  /**
   * Set when the ticket closed but `APPLIED_REVIEW_LABEL` could not be added
   * to its pull request. As `Reviewed.notLabelled`: the last step, tried only
   * once the ticket is already closed, and reported rather than retried.
   */
  notLabelled?: NotLabelled;
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
 * run was needed. Either way the ticket is closed, `needs-rebase` is taken
 * off the pull request, and its draft state is left alone. A run that gave
 * up, or left the pull request still conflicting, is `Failed` instead, and
 * leaves the label on.
 */
export interface Rebased {
  kind: "rebased";
  /** The run. Absent when there was nothing to rebase, so nothing ran. */
  rebase?: RebaseFinished;
  /** As `Failed.tokensUsed`: absent exactly when `rebase` is, nothing having run. */
  tokensUsed?: TokenCount;
  /**
   * Set when the loop could not finish the ticket off: the pull request could
   * not be read back after the run, `needs-rebase` could not be taken off it,
   * or the ticket could not be closed. Either way the ticket is still
   * ready-for-agent.
   */
  notClosed?: RebaseNotClosed;
}

/** Why a rebase iteration left its ticket open, and the error that stopped it. */
export interface RebaseNotClosed {
  kind: "check-failed" | "label-failed" | "close-failed";
  error: string;
}

/**
 * A pull request ticket — review, apply-review or rebase — whose own pull
 * request the repo host already reports merged or closed, checked before
 * anything else the ticket's iteration would do: closed with a comment
 * naming which, and no run started. Its branch is commonly gone with the
 * pull request, so a run started on it would only fail the same way every
 * morning after — closed rather than handed back, since coming round again
 * would find the same pull request in the same state.
 */
export interface PullRequestResolved {
  kind: "pull-request-resolved";
  /** How the pull request was resolved by the time the loop looked. */
  resolution: PullRequestResolution;
  /** Always absent: no run ever starts, so there is never anything spent. */
  tokensUsed?: TokenCount;
  /**
   * Set when the ticket itself could not be closed. Still ready-for-agent,
   * and due to come round again.
   */
  notClosed?: NotClosed & { kind: "close-failed" };
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
