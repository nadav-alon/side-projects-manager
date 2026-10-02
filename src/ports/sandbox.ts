import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import type { CommitSha } from "./commit-sha.ts";
import type { Discovery } from "./discovery.ts";
import type {
  ApplyReviewTicket,
  DiscoveredTicketSummary,
  RebaseTicket,
  ReviewTicket,
  SpecReviewTicket,
  UxReviewTicket,
  Ticket,
} from "./issue-tracker.ts";
import type { ModelName } from "./model-name.ts";
import type { Nits } from "./nits.ts";
import type { TicketGist } from "./ticket-gist.ts";
import type { TokenCount } from "./token-count.ts";
import type { TranscriptDirectory } from "./transcript-directory.ts";
import type { TranscriptPath } from "./transcript-path.ts";
import type { Usd } from "./usd.ts";

/**
 * What a `Sandbox` method calls `onStarted` back with, as soon as a run's
 * transcript directory is known — long before the run itself resolves, so a
 * caller can record CONTEXT.md's "Run in progress" on the journal while the
 * agent is still going, rather than only once it has already ended.
 */
export interface RunStarted {
  transcriptDirectory: TranscriptDirectory;
}

/** The callback every `Sandbox` method takes `onStarted` as. */
export type OnRunStarted = (started: RunStarted) => void;

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
  /**
   * The ticket's own salvage record's branch, absent when it carries none.
   * See CONTEXT.md's "Salvage": a limit refusal, or a post-start
   * infrastructure failure, that left commits keeps its branch for the
   * ticket's next run to continue on. Passed through unchanged — starting the
   * run on it, rather than a fresh branch, is not this port's job.
   */
  salvageBranch?: Branch;
  /**
   * The open issues already discovered against the ticket this run's
   * discoveries land on, absent when there are none: listed in the prompt so
   * the run does not file a suggestion one of them already covers. Passed
   * through unchanged — finding them is not this port's job.
   */
  discovered?: readonly DiscoveredTicketSummary[];
}

/** One review ticket, and the project checkout it is to be worked against. */
export interface ReviewRequest {
  ticket: ReviewTicket;
  /** The project's managed clone, read from but never written to. */
  checkout: Checkout;
  spendCeiling: Usd;
  /** As `RunRequest.model`. */
  model?: ModelName;
  /** As `RunRequest.discovered`. */
  discovered?: readonly DiscoveredTicketSummary[];
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
  /**
   * As `RegisteredProject.manager` (`store.ts`): set only for the manager's
   * own project, where `UNIFORM_FILES` are the source rather than a copy, so
   * a push touching one here is never forced back.
   */
  manager?: true;
  /** As `RunRequest.discovered`. */
  discovered?: readonly DiscoveredTicketSummary[];
}

/**
 * One ticket to be reviewed, and the project checkout the run is to be worked
 * against. The kind of ticket is all that tells one review request from another.
 */
export interface ReviewRequestFor<T extends Ticket> {
  ticket: T;
  /**
   * The project's managed clone. A run that gets a writable throwaway clone
   * makes it from this; the checkout itself is never written to, nor fetched
   * back into.
   */
  checkout: Checkout;
  spendCeiling: Usd;
  /** As `RunRequest.model`. */
  model?: ModelName;
  /** As `RunRequest.discovered`. */
  discovered?: readonly DiscoveredTicketSummary[];
}

/** One spec review ticket, and the project checkout it is to be worked against. */
export type SpecReviewRequest = ReviewRequestFor<SpecReviewTicket>;

/** One ux review ticket, and the project checkout it is to be worked against. */
export type UxReviewRequest = ReviewRequestFor<UxReviewTicket>;

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
  /** As `ApplyReviewRequest.manager`. */
  manager?: true;
  /** As `RunRequest.discovered`. */
  discovered?: readonly DiscoveredTicketSummary[];
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
  /**
   * Where the container's own session transcript landed on the host, absent
   * when none was ever found there — a container that never reached the
   * agent CLI leaves nothing to name. See `container-sandbox.ts`'s `attempt`.
   */
  transcript?: TranscriptPath;
  /**
   * What the agent filed through its per-run `/discoveries` mount, in the
   * order it wrote them — see CONTEXT.md's "Discovery". Present for every
   * outcome where the agent started, gave-up and cut-off runs included, since
   * a discovery filed before the run stopped is still true; empty rather than
   * absent when it filed none. Absent only when the agent never started at
   * all, which never reaches an `Ended` outcome in the first place.
   */
  discoveries?: Discovery[];
  /**
   * How many files under `/discoveries` were dropped rather than carried into
   * `discoveries` — not valid JSON, or valid JSON of an unknown `kind` — so
   * the caller can report them. Never fails the run on its own.
   */
  discoveriesDropped?: number;
}

/**
 * The branch an implementation run worked on, and what it committed there.
 * True of every variant but `RunSandboxFailed`: the branch is created before
 * the agent starts, so even a run refused before the agent did anything
 * still leaves one, empty of commits. `RunSandboxFailed` carries both, or
 * neither — see its own doc comment. A review has neither for a different
 * reason: it never creates a branch at all.
 */
interface Worked {
  /** Branch the agent worked on. */
  branch: Branch;
  commits: CommitSha[];
  /**
   * The commits already on `branch` when the run started, absent for a run
   * that began on a fresh branch. A resumed run's `commits` include these —
   * they are everything on the branch since it left the checkout — so a run
   * added work only if `commits` holds something not listed here.
   */
  resumedCommits?: CommitSha[];
}

/** The agent ran to completion. */
export interface RunFinished extends Ended, Worked {
  kind: "finished";
  /** The agent's own output, for the ticket comment when it committed nothing. */
  output: string;
  /**
   * The ticket gist the agent gave, absent when it gave none, an empty one,
   * or more than one line. Its absence never changes `kind`: a run missing
   * one is `"finished"` exactly as one that has it.
   */
  gist?: TicketGist;
  /**
   * The nits the agent listed under `NIT_SECTION_HEADING` but did not fix,
   * off its own output, absent when it gave none. Its absence never changes
   * `kind`: a run missing one is `"finished"` exactly as one that has it.
   */
  nits?: Nits;
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

/**
 * The provider itself failed the run: the agent started but the provider
 * never answered — down, overloaded, or otherwise unreachable — so the agent
 * CLI exited without an answer to give.
 */
export interface RunProviderFailed extends Ended, Worked {
  kind: "provider-failed";
  /**
   * What the CLI said, word for word — the envelope's `result`, its prose
   * line, or, when the envelope names a failure but gives no `result` to
   * quote, a fixed line saying so.
   */
  words: string;
}

/** As `RunProviderFailed`, for a review. */
export interface ReviewProviderFailed extends Ended {
  kind: "provider-failed";
  words: string;
}

/**
 * The run's own spend ceiling stopped it: the agent CLI's envelope carried
 * `subtype: "error_max_budget_usd"`. Distinct from `RunLimitRefused` — this
 * ceiling is the developer's own declaration, enforced by the CLI itself, not
 * a refusal from the provider — and from `RunGaveUp` — the run was stopped
 * from outside, not abandoned on its own account.
 */
export interface RunBudgetExhausted extends Ended, Worked {
  kind: "budget-exhausted";
  /**
   * What the CLI said, word for word — the envelope's own `result`, or, when
   * it gave no `result` to quote, a fixed line saying so.
   */
  words: string;
}

/** As `RunBudgetExhausted`, for a review. */
export interface ReviewBudgetExhausted extends Ended {
  kind: "budget-exhausted";
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
 * The sandbox failed after the agent had already run: reading its commits
 * back, or fetching its branch into the checkout, threw. Only an
 * implementation run reaches either step, so no `ReviewOutcome` or
 * `ApplyReviewOutcome` needs a variant like this one.
 *
 * The agent's spend is real whatever git did afterwards, so it travels with
 * this result instead of being lost to a rejection — a rejection stays
 * reserved for a sandbox that never got the agent running at all.
 *
 * `branch` and `commits` carry what `Worked` does, present together exactly
 * when the branch had already reached the checkout before the failure, so a
 * caller can still salvage it (see CONTEXT.md's "Salvage") — absent together
 * otherwise, since a branch never fetched back is gone with the clone.
 */
export type RunSandboxFailed = Ended & {
  kind: "sandbox-failed";
  /** Why the sandbox failed, once the agent had already run. */
  reason: string;
} & (Worked | { branch?: undefined; commits?: undefined });

/**
 * How a run in the container ended, as exactly one variant: finished, gave
 * up, was refused by the provider limit, was refused the model it was asked
 * to run on, or ran and spent before the sandbox itself failed. Told apart by
 * `kind`, and nothing else — a caller that matches on it exhaustively needs no
 * other field to know which is which.
 */
export type RunOutcome =
  | RunBudgetExhausted
  | RunFinished
  | RunGaveUp
  | RunLimitRefused
  | RunModelRefused
  | RunProviderFailed
  | RunSandboxFailed;

/** As `RunOutcome`, for a review — with no branch or commits on any variant. */
export type ReviewOutcome =
  | ReviewBudgetExhausted
  | ReviewFinished
  | ReviewGaveUp
  | ReviewLimitRefused
  | ReviewModelRefused
  | ReviewProviderFailed;

/**
 * As `ReviewGaveUp`, for an apply-review or a rebase run — either of which
 * also gives up when the repo host rejects its push, plain or forced,
 * because the pull request's branch moved under it. Shared by both, and
 * named `RebaseGaveUp` where a rebase run is meant, rather than given a
 * rebase-specific sibling: the two runs give up on a moved branch for
 * exactly the same reason.
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
 * An apply-review or rebase run whose push touched a file the manager keeps
 * uniform across every project (`UNIFORM_FILES`, `src/ports/harness.ts`) —
 * caught, and forced back, by the sandbox itself:
 * `container-sandbox.ts`'s `revertPushIfUniformFilesTouched` forces the pull
 * request's branch back to where it stood before the run, since nothing but
 * the repo host ever saw the push land. See `UniformFilesTouched` in
 * `iteration-outcome.ts` for the same response to an implementation run's
 * diff, reached by a different door — this push never goes through
 * `openDraftPullRequest` for that check to catch it first. Named apart from
 * `UniformFilesTouched`, and given its own `kind`, rather than sharing its
 * shape: the two are told apart by more than which door caught them — one
 * names a branch still sitting unpushed in the checkout, the other a push
 * already forced back on the repo host, and a `kind` two differently shaped
 * types share would leave a narrowing unable to tell which it had reached.
 */
export interface UniformFilesReverted extends Ended {
  kind: "uniform-files-reverted";
  /** The uniform files the run's push touched, in `UNIFORM_FILES`'s own order. */
  files: string[];
  /**
   * Present, naming why, when the force-with-lease push meant to force the
   * pull request's branch back failed: the diff this run's push touched is
   * still on the pull request, for the developer to force back themselves.
   * Absent otherwise — the common case — including when the agent's own
   * push never reached the repo host to begin with, and so needed no push of
   * this run's to undo.
   */
  notReverted?: { reason: string };
}

/**
 * As `ReviewOutcome`, for an apply-review run. No branch or commits on any
 * variant: the agent pushes to the pull request's branch itself, and what it
 * pushed and answered is read back from the repo host, never from here.
 */
export type ApplyReviewOutcome =
  | ReviewBudgetExhausted
  | ReviewFinished
  | ApplyReviewGaveUp
  | ReviewLimitRefused
  | ReviewModelRefused
  | ReviewProviderFailed
  | UniformFilesReverted;

/**
 * As `ReviewOutcome`, for a spec review run: no branch or commits on any
 * variant, and no pull request either — a spec review is not bound to one.
 * There is nowhere to post findings to, so `ReviewFinished.output` is what
 * becomes the ticket's own hand-back comment instead of a pull request
 * comment.
 */
export type SpecReviewOutcome = ReviewOutcome;

/**
 * As `SpecReviewOutcome`, for a ux review run: no branch, commits or pull
 * request, and `ReviewFinished.output` is the report that becomes the
 * ticket's own hand-back comment.
 */
export type UxReviewOutcome = ReviewOutcome;

/** A rebase run that ran to completion: a review's shape, named for what ran. */
export type RebaseFinished = ReviewFinished;

/** A rebase run that stopped short: an apply-review's shape, named for what ran. */
export type RebaseGaveUp = ApplyReviewGaveUp;

/**
 * As `ApplyReviewOutcome`, for a rebase run. No branch or commits on any
 * variant: the agent force-pushes to the pull request's branch itself, and
 * whether it worked is read back from the repo host, never from here.
 */
export type RebaseOutcome =
  | ReviewBudgetExhausted
  | RebaseFinished
  | RebaseGaveUp
  | ReviewLimitRefused
  | ReviewModelRefused
  | ReviewProviderFailed
  | UniformFilesReverted;

/**
 * Runs a coding agent against one ticket, in a container, on a checkout of its
 * own. The loop never runs an agent on the host.
 *
 * Runs and reviews run side by side, on one checkout or several: an
 * implementation does not wait for another implementation, or for a review,
 * to finish first. See ADR-0004 for how the budget gate charges each one
 * still in progress its own run estimate, rather than accepting the
 * overshoot ADR-0003 once did, and the container adapter's own doc comment
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
   * Rejects only when the sandbox could not be set up before the agent ever
   * started: a container that could not start it at all, or a clone whose
   * commit hashes are not ones a `CommitSha` can hold. An agent that ran and
   * failed comes back as a result carrying `"gave-up"`, because its commits,
   * its output and its spend are all still the morning's — and git failing to
   * read its commits back or fetch its branch into the checkout, once it has
   * already run, comes back the same way, carrying `"sandbox-failed"`
   * (`RunSandboxFailed`): its spend is real whatever git did afterwards.
   *
   * A request naming no model can never come back refused for one: that
   * variant of `RunOutcome` is excluded from what this overload returns,
   * since nothing was asked of the agent CLI for it to refuse.
   */
  run(
    request: RunRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<RunOutcome>;
  run(
    request: RunRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<RunOutcome, RunModelRefused>>;

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
  review(
    request: ReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<ReviewOutcome>;
  review(
    request: ReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<ReviewOutcome, ReviewModelRefused>>;

  /**
   * Runs a spec-reviewing agent against `request.ticket`, in a container with
   * no write access to its clone, exactly as `review` sets one up: a fresh
   * `docker run`, a separately scoped credential, and a clone mounted
   * read-only. Unlike `review`, `request.ticket` names no pull request — the
   * agent finds the supertask it reviews against for itself, as the parent
   * issue the ticket is a sub-issue of — and there is nowhere for it to post
   * its findings, so they travel back in the outcome's own output instead,
   * for the caller to hand back as the ticket's comment.
   *
   * As `run`, a spec review naming no model can never come back refused for
   * one.
   */
  specReview(
    request: SpecReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<SpecReviewOutcome>;
  specReview(
    request: SpecReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<SpecReviewOutcome, ReviewModelRefused>>;

  /**
   * Runs the `ux-review` skill against `request.ticket`, in a container on a
   * throwaway clone of its own that is mounted writable — the app it drives is
   * built and served from it — but credentialled as a review is, with the
   * separately scoped review token, and never fetched back into the checkout.
   * Alone among the kinds, the run is given a browser through Playwright MCP.
   * Like `specReview`, there is nowhere to post findings, so they travel back
   * in the outcome's own output, for the caller to hand back as the ticket's
   * comment.
   *
   * As `run`, a ux review naming no model can never come back refused for one.
   */
  uxReview(
    request: UxReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<UxReviewOutcome>;
  uxReview(
    request: UxReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<UxReviewOutcome, ReviewModelRefused>>;

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
    onStarted?: OnRunStarted,
  ): Promise<ApplyReviewOutcome>;
  applyReview(
    request: ApplyReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
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
  rebase(
    request: RebaseRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<RebaseOutcome>;
  rebase(
    request: RebaseRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<RebaseOutcome, ReviewModelRefused>>;
}
