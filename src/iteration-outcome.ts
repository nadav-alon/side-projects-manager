import type { DiscoveryReport } from "./discovery-routing.ts";
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
  ReviewBudgetExhausted,
  ReviewFinished,
  ReviewLimitRefused,
  ReviewProviderFailed,
  ReviewTicket,
  RunBudgetExhausted,
  RunFinished,
  RunLimitRefused,
  RunOutcome,
  RunProviderFailed,
  Salvaged,
  SpecReviewTicket,
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
  | UnusableModelLabel
  | UnusableSizeLabel;

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
 *
 * Carries no `reason` of its own: `modelProblem` in `model-resolution.ts` is
 * the one source of wording for it, read afresh wherever it is needed rather
 * than duplicated into a field here.
 */
export interface ModelRefused {
  kind: "model-refused";
  refusal: ModelRefusal;
  /** What named the refused model: the ticket's model label or the model defaults. */
  source: ModelSource;
}

/**
 * A ticket whose model labels no run could be started on — two or more that
 * disagree, or one naming no usable model — caught at selection, so nothing
 * was cloned, run or spent.
 *
 * Carries no `reason` of its own, for the same reason `ModelRefused` does
 * not: `modelProblem` is the one source of wording.
 */
export interface UnusableModelLabel {
  kind: "conflicting-model-labels" | "unusable-model-label";
  /** The model labels at fault, as the ticket carries them. */
  labels: readonly string[];
}

/**
 * A ticket whose size label names no size the budget document knows —
 * caught at selection, so nothing was cloned, run or spent.
 *
 * Carries no `reason` of its own, for the same reason `UnusableModelLabel`
 * does not: `sizeProblem` in `size-resolution.ts` is the one source of
 * wording.
 */
export interface UnusableSizeLabel {
  kind: "unusable-size-label";
  /** The size labels at fault, as the ticket carries them. */
  labels: readonly string[];
}

/** A ticket handed back ahead of the gate, for unusable model or size labels. */
export type AheadOfGateFailure = UnusableModelLabel | UnusableSizeLabel;

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
  /**
   * The branch and the ticket's own count of limit refusals in a row, present
   * exactly when the failure's branch had already reached the checkout and
   * was kept as a salvage: see CONTEXT.md's "Salvage". The count is carried
   * rather than raised by an infrastructure failure itself — it only ever
   * repeats what an earlier limit refusal already recorded, or starts at 0.
   */
  salvage?: Salvaged;
}

/**
 * What one iteration did with the ticket it selected: finished a run, failed
 * one, worked a review, an apply-review or a rebase ticket's own run, had any
 * kind of run refused by the provider limit, or had one stopped by its own
 * spend ceiling. Told apart by `kind`, and nothing else.
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
  | SpecReviewed
  | PullRequestResolved
  | LimitRefused
  | ProviderFailed
  | BudgetExhausted
  | DiscoveryBlocked;

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
  /**
   * What a cut-off run's own discoveries came to, and the ticket they landed
   * on when it differs from the one this iteration itself worked, per
   * CONTEXT.md's "Discovery" — always advisory here, since a correction or a
   * prerequisite would have made this a `DiscoveryBlocked` iteration instead,
   * carrying its cut-off in `DiscoveryBlocked.cutOff`. Absent when the run
   * filed none.
   */
  discoveryReport?: DiscoveryReport;
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
  /** As `LimitRefused.discoveryReport`. */
  discoveryReport?: DiscoveryReport;
}

/**
 * A run the provider stopped before it finished — CONTEXT.md's "Cut off": a
 * limit refusal or a provider failure. Neither is a failure: the ticket is
 * left exactly as it was, and the invocation stands down, since every run
 * after it would be stopped the same way.
 */
export type CutOff = LimitRefused | ProviderFailed;

/**
 * A cut-off carried by a `DiscoveryBlocked` iteration, as `LimitRefused` or
 * `ProviderFailed`'s own words rather than the run's — present only when a
 * limit refusal or a provider failure cut the run off before it filed the
 * blocking discovery that handed its ticket back instead. See CONTEXT.md's
 * "Discovery".
 */
export type DiscoveryBlockedCutOff =
  | { kind: "limit-refused"; limitRefusal: string }
  | { kind: "provider-failed"; providerFailure: string };

/**
 * A review, apply-review, rebase or spec review run the provider stopped
 * before it finished — CONTEXT.md's "Cut off". Named once, rather than
 * spelling the union out at every site it crosses.
 */
export type CutOffReview = ReviewLimitRefused | ReviewProviderFailed;

/** As `CutOffReview`, for any run the provider stopped before it finished — implementation runs included. */
export type CutOffRun = RunLimitRefused | RunProviderFailed | CutOffReview;

/**
 * `iteration`'s own cut-off — CONTEXT.md's "Cut off" — whichever way it
 * carries one: a `LimitRefused` or `ProviderFailed` iteration's own kind, or
 * a `DiscoveryBlocked` iteration's `cutOff`. `undefined` for every other
 * kind, and for a `DiscoveryBlocked` iteration whose run was never cut off —
 * which is also how a caller tells whether `iteration` is cut off at all.
 */
export function cutOffOf(iteration: Iteration): DiscoveryBlockedCutOff | undefined {
  if (iteration.kind === "limit-refused") {
    return { kind: "limit-refused", limitRefusal: iteration.limitRefusal };
  }
  if (iteration.kind === "provider-failed") {
    return { kind: "provider-failed", providerFailure: iteration.providerFailure };
  }
  if (iteration.kind === "discovery-blocked") {
    return iteration.cutOff;
  }
  return undefined;
}

/** `x`'s own `transcript`, spread beside the rest of an outcome's fields — present only when `x` carries one. */
function transcriptField(x: { transcript?: TranscriptPath }) {
  return x.transcript === undefined ? {} : { transcript: x.transcript };
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
  return run.kind === "limit-refused"
    ? {
        kind: "limit-refused",
        limitRefusal: run.words,
        tokensUsed: run.tokensUsed,
        ...transcriptField(run),
        run,
        discard,
      }
    : {
        kind: "provider-failed",
        providerFailure: run.words,
        tokensUsed: run.tokensUsed,
        ...transcriptField(run),
        run,
        discard,
      };
}

/**
 * As `cutOffRunOutcome`, for a review, apply-review or rebase run: none of
 * those ever creates a branch, so there is never one to discard.
 */
export function cutOffReviewOutcome(review: CutOffReview): CutOff {
  return review.kind === "limit-refused"
    ? {
        kind: "limit-refused",
        limitRefusal: review.words,
        tokensUsed: review.tokensUsed,
        ...transcriptField(review),
        discard: { kind: "none" },
      }
    : {
        kind: "provider-failed",
        providerFailure: review.words,
        tokensUsed: review.tokensUsed,
        ...transcriptField(review),
        discard: { kind: "none" },
      };
}

/**
 * A run, implementation, review, apply-review or rebase, that its own spend
 * ceiling stopped rather than the agent giving up. Not a `CutOff`: a limit
 * refusal or a provider failure says every run after it would be stopped the
 * same way, but one run's own ceiling says nothing about the next run's, so
 * this never stands the invocation down. Not a failure either: the ticket is
 * nobody's problem, so it is neither commented on nor relabelled, and stays
 * eligible for a later firing.
 */
export interface BudgetExhausted {
  kind: "budget-exhausted";
  /** What the CLI said, word for word — see `RunBudgetExhausted.words`. */
  words: string;
  /** What ran spent before its spend ceiling stopped it. */
  tokensUsed: TokenCount;
  /** What the implementation run left behind. Absent for a review. */
  run?: RunBudgetExhausted;
  /** As `LimitRefused.transcript`. */
  transcript?: TranscriptPath;
  /** What became of any branch the run left, salvaged as a limit refusal's is. */
  discard: Discard;
}

/**
 * `run`'s own spend-ceiling ending, as the iteration it comes to: the one
 * place an implementation run's is built, rather than a parallel copy for
 * every ticket kind that can hit one.
 */
export function budgetExhaustedRunOutcome(
  run: RunBudgetExhausted,
  discard: Discard,
): BudgetExhausted {
  return {
    kind: "budget-exhausted",
    words: run.words,
    tokensUsed: run.tokensUsed,
    ...transcriptField(run),
    run,
    discard,
  };
}

/**
 * As `budgetExhaustedRunOutcome`, for a review, apply-review or rebase run:
 * none of those ever creates a branch, so there is never one to discard.
 */
export function budgetExhaustedReviewOutcome(
  review: ReviewBudgetExhausted,
): BudgetExhausted {
  return {
    kind: "budget-exhausted",
    words: review.words,
    tokensUsed: review.tokensUsed,
    ...transcriptField(review),
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
  /**
   * What the run's own discoveries came to, and the ticket they landed on
   * when it differs from the one this iteration itself worked, per
   * CONTEXT.md's "Discovery" — always advisory here, since a correction or a
   * prerequisite would have made this a `DiscoveryBlocked` iteration instead.
   * Absent when the run filed none.
   */
  discoveryReport?: DiscoveryReport;
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
  /**
   * What a gave-up run's own discoveries came to, and the ticket they landed
   * on when it differs from the one this iteration itself worked, per
   * CONTEXT.md's "Discovery" — always advisory here, since a correction or a
   * prerequisite would have made this a `DiscoveryBlocked` iteration instead.
   * Absent when the run filed none, and always absent for an infrastructure
   * failure, which this module never routes discoveries for.
   */
  discoveryReport?: DiscoveryReport;
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
 * was started because the ticket's model or size labels were unusable.
 */
export interface Attempt<T extends Ticket = Ticket> {
  repo: RepoSlug;
  ticket: T;
  model?: ModelName;
  /**
   * The run estimate the gate's go-ahead charged for this ticket, per
   * `CONTEXT.md`'s "Run estimate". Absent from a ticket handed back ahead of
   * the gate, for its model or size labels: the gate never got a chance to
   * charge one. Read by the summary, to set a finished run's cost beside it.
   */
  estimateCharged?: TokenCount;
}

/** One iteration's outcome, and the project and ticket that earned it. */
export type IterationOutcome =
  | (Attempt & Finished)
  | (Attempt & Failed)
  | (Attempt<ReviewTicket> & Reviewed)
  | (Attempt<ApplyReviewTicket> & AppliedReview)
  | (Attempt<RebaseTicket> & Rebased)
  | (Attempt<SpecReviewTicket> & SpecReviewed)
  | (Attempt<PullRequestTicket> & PullRequestResolved)
  | (Attempt & LimitRefused)
  | (Attempt & ProviderFailed)
  | (Attempt & BudgetExhausted)
  | (Attempt & DiscoveryBlocked);

/**
 * A review ticket's own run that finished without the agent giving up, having
 * posted a review — with or without a finding — on its pull request since it
 * started. There is no pull request to name here — the review ticket already
 * names the one it is about — and no further review to queue, since nothing
 * reviews a review. A review that gave up, posting neither, is `Failed`
 * instead.
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
   * Whether this was a clean review — CONTEXT.md's "Clean review": a review
   * posted since the run started, carrying no finding. Absent when the check
   * that would have decided it never ran, at `notClosed`'s `"check-failed"`.
   * Decides whether the pull request is marked ready (`notReadied` besides)
   * rather than left a draft, and whether turbo's `APPLY_REVIEW_COMMENT` is
   * ever tried.
   */
  clean?: boolean;
  /**
   * Set when the loop could not finish the ticket off: the pull request could
   * not be checked for a posted review, or the ticket could not be closed.
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
  /**
   * Set when `clean` and the repo host refused `markPullRequestReady` on the
   * pull request. As `notLabelled`: reported rather than retried, and never
   * `notClosed` — the ticket did close. Always absent when `clean` is not
   * `true`, since a review with findings is never marked ready.
   */
  notReadied?: NotReadied;
  /**
   * Set when the project is turbo (CONTEXT.md's "Turbo", ADR 0006), the
   * review was not clean, and the repo host refused `APPLY_REVIEW_COMMENT` on
   * the pull request. Tried after the label step, whatever became of it — a
   * refused label does not stop turbo, only a `notClosed` does — so this is
   * absent for a project that is not turbo, for a clean review, which gets no
   * turbo comment at all, and for one whose comment posted fine.
   */
  notCommented?: NotCommented;
  /** As `Finished.discoveryReport`. */
  discoveryReport?: DiscoveryReport;
}

/**
 * Why turbo's own `APPLY_REVIEW_COMMENT` could not be posted on a review
 * ticket's pull request, and the error that stopped it. As `NotLabelled`: a
 * refusal here is reported rather than retried, and never reopens the ticket.
 */
export interface NotCommented {
  error: string;
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
 * Why a clean review's closed ticket could not have its pull request marked
 * ready for review, and the error that stopped it. Its own interface rather
 * than `NotLabelled`, as `NotCommented` already is: the glossary tells
 * "labelled" and "marked ready" apart, so source keeps them apart too.
 */
export interface NotReadied {
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
  /**
   * What the merge gate did, per `CONTEXT.md`'s "Turboable" and ADR 0009.
   * Present only on a turbo project, once the ticket has closed
   * (`notClosed` absent): a project that is not turbo never asks, so `merge`
   * is absent.
   */
  merge?: MergeGate;
  /** As `Finished.discoveryReport`. */
  discoveryReport?: DiscoveryReport;
}

/**
 * What the merge gate — the one pass right after a turbo project's
 * apply-review ticket finishes — came to. Per `CONTEXT.md`'s "Turboable" and
 * ADR 0009: fires once, no retry and no `/rebase`, whatever it finds.
 */
export type MergeGate =
  /**
   * The manager never merges: `reason` says why — the implementation ticket
   * did not carry `turboable` before its own run started, never ran at all
   * per the timeline this reads, could not be found, or its timeline could
   * not be read.
   */
  | { kind: "not-turboable"; reason: string }
  /**
   * Mergeable, green and free of declined threads: merged with a merge
   * commit, its branch deleted with it. `implementationTicket` is the ticket
   * `mergeGate` already resolved to check `turboable`'s own timeline, carried
   * along so the summary can name it beside the pull request.
   */
  | { kind: "merged"; implementationTicket: Ticket }
  /**
   * Failed one of the gate's own checks — a declined thread, checks not
   * green, or a merge the repo host refused as not mergeable — and so left
   * for the developer: `reason` says which, and
   * `READY_FOR_HUMAN_PULL_REQUEST_LABEL` is applied to the pull request. A
   * refusal labelling it is reported here too, never raised, the same as
   * `AppliedReview.notLabelled`.
   */
  | { kind: "left-for-human"; reason: string; notLabelled?: NotLabelled };

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
  /** As `Finished.discoveryReport`. */
  discoveryReport?: DiscoveryReport;
}

/** Why a rebase iteration left its ticket open, and the error that stopped it. */
export interface RebaseNotClosed {
  kind: "check-failed" | "label-failed" | "close-failed";
  error: string;
}

/**
 * A spec review ticket's own run that finished without the agent giving up.
 * Unlike a review, apply-review or rebase ticket's own success, this never
 * closes the ticket: a spec review is not bound to a pull request for a
 * `pullRequestState` check to ever resolve, and there is nowhere to post its
 * findings but the ticket itself — so it ends in hand-back exactly as a
 * gave-up run does, per CONTEXT.md's "Spec review ticket", with `review`'s
 * own output as the comment. A run that gave up is `Failed` instead.
 */
export interface SpecReviewed {
  kind: "spec-reviewed";
  review: ReviewFinished;
  /**
   * What the run spent. Always equal to `review.tokensUsed` — duplicated
   * here for the same reason as `Finished.tokensUsed`.
   */
  tokensUsed: TokenCount;
  /** What became of the ticket's own hand-back. */
  handedBack: HandBackRecord;
  /** As `Finished.discoveryReport`. */
  discoveryReport?: DiscoveryReport;
}

/**
 * An iteration whose run filed a correction or a prerequisite — a blocking
 * discovery, per CONTEXT.md's "Discovery" and "Hand back". The run's own
 * ticket is handed back exactly as a gave-up run's is, whatever the agent
 * went on to commit or would otherwise have finished: no pull request opens,
 * and no review, apply-review or rebase closes. For a pull request or a spec
 * review ticket, "the run's own ticket" is the pull request or spec review
 * ticket itself — `discoveryReport.crossTarget` names the implementation
 * ticket or supertask its discoveries landed on instead, absent for an
 * implementation run, whose target is its own ticket.
 */
export interface DiscoveryBlocked {
  kind: "discovery-blocked";
  /** What every discovery the run filed came to, blocking and advisory alike, and the ticket they landed on. */
  discoveryReport: DiscoveryReport;
  tokensUsed: TokenCount;
  transcript?: TranscriptPath;
  /** What became of the ticket's own hand-back. */
  handedBack: HandBackRecord;
  /**
   * The cut-off this iteration also carries, present only when a limit
   * refusal or a provider failure cut the run off before it filed the
   * blocking discovery — per CONTEXT.md's "Discovery": the invocation stands
   * down over it exactly as it would without the discovery, read by
   * `cutOffOf` alongside `LimitRefused` and `ProviderFailed`'s own kind.
   * Absent for a run that finished or gave up on its own before filing one.
   */
  cutOff?: DiscoveryBlockedCutOff;
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
 * Whether `iteration` handed its ticket back ahead of the gate — for
 * unusable model labels, or a size label naming no size the budget document
 * knows — and so never started a run: nothing was spent, and on no model.
 */
export function handedBackAheadOfGate(iteration: Iteration): boolean {
  switch (iteration.kind) {
    case "failed":
      return isAheadOfGateFailure(iteration.failure);
    case "finished":
    case "reviewed":
    case "applied-review":
    case "rebased":
    case "spec-reviewed":
    case "pull-request-resolved":
    case "limit-refused":
    case "provider-failed":
    case "budget-exhausted":
    case "discovery-blocked":
      return false;
  }
}

function isAheadOfGateFailure(
  failure: RunFailure,
): failure is AheadOfGateFailure {
  return (
    failure.kind === "conflicting-model-labels" ||
    failure.kind === "unusable-model-label" ||
    failure.kind === "unusable-size-label"
  );
}

/**
 * Whether `iteration` counts as work when classifying the invocation's
 * outcome: not a ticket handed back ahead of the gate, and not a run the
 * provider limit refused. A limit refusal never happened — CONTEXT.md's
 * "Limit refusal" says it leaves the ticket exactly as it found it — so it
 * counts for nothing here, the same way a hand-back ahead of the gate does
 * not. A provider failure still counts as work: the provider was reached and
 * the run was cut off, rather than refused before it started.
 *
 * A switch on every kind, so an iteration kind added later has to say which
 * it is — as `ranNothing` does. The two disagree on a limit refusal on
 * purpose: `ranNothing` says it ran (tokens were spent reaching the refusal),
 * while this one says it is not work (nothing landed against the ticket).
 */
export function countsAsWork(iteration: Iteration): boolean {
  switch (iteration.kind) {
    case "limit-refused":
      return false;
    case "failed":
      return !handedBackAheadOfGate(iteration);
    case "finished":
    case "reviewed":
    case "applied-review":
    case "rebased":
    case "spec-reviewed":
    case "pull-request-resolved":
    case "provider-failed":
    case "budget-exhausted":
    case "discovery-blocked":
      return true;
  }
}

/**
 * Whether `iteration` started no run: a ticket handed back before one could
 * start, or a pull request ticket that found nothing to do. A switch on every
 * kind, so an iteration kind added later has to say which it is.
 */
export function ranNothing(iteration: Iteration): boolean {
  switch (iteration.kind) {
    case "applied-review":
      return iteration.review === undefined;
    case "rebased":
      return iteration.rebase === undefined;
    case "pull-request-resolved":
      return true;
    case "failed":
      return (
        handedBackAheadOfGate(iteration) ||
        iteration.failure.kind === "unsettled-mergeability"
      );
    case "finished":
    case "reviewed":
    case "spec-reviewed":
    case "limit-refused":
    case "provider-failed":
    case "budget-exhausted":
    case "discovery-blocked":
      return false;
  }
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
  switch (iteration.kind) {
    case "failed":
      return iteration.failure.kind === "infrastructure";
    case "finished":
    case "reviewed":
    case "applied-review":
    case "rebased":
    case "spec-reviewed":
    case "pull-request-resolved":
    case "limit-refused":
    case "provider-failed":
    case "budget-exhausted":
    case "discovery-blocked":
      return false;
  }
}

/**
 * Whether `iteration` frees its ticket to be selected again today —
 * CONTEXT.md's "Worked today" rule: the persisted record protects only the
 * tickets the loop tried and failed to take off the queue itself.
 *
 * An infrastructure failure, a limit refusal or a provider failure says
 * nothing about the ticket at all, so it always frees it. A finished, a
 * spec-reviewed, a discovery-blocked or a failed run frees it exactly when
 * its own hand-back landed — `"handed-back"` or `"already-closed"` — and
 * leaves it recorded when the tracker refused the call. A review, an
 * apply-review, a rebase or a resolved pull request frees it exactly when it
 * closed without a `notClosed`, and leaves it recorded when one is set — the
 * ticket is still ready-for-agent, due to come round again on its own, so the
 * record still has something to protect.
 */
export function freesTicketToday(iteration: Iteration): boolean {
  switch (iteration.kind) {
    case "limit-refused":
    case "provider-failed":
    case "budget-exhausted":
      return true;
    case "finished":
    case "spec-reviewed":
    case "discovery-blocked":
      return iteration.handedBack.outcome !== "refused";
    case "failed":
      return (
        failedOnInfrastructure(iteration) ||
        (handedBackFailure(iteration) &&
          iteration.handedBack.outcome !== "refused")
      );
    case "reviewed":
    case "applied-review":
    case "rebased":
    case "pull-request-resolved":
      return iteration.notClosed === undefined;
  }
}
