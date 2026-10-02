import type {
  ApplyReviewAnswers,
  ApplyReviewGaveUp,
  ApplyReviewTicket,
  Branch,
  Checkout,
  ChecksStatus,
  Clock,
  Day,
  DiscoveredTicketSummary,
  Discovery,
  Harness,
  IssueTracker,
  IterationLimit,
  ModelRefusal,
  OnRunStarted,
  OpenInvocation,
  Progress,
  PullRequestLabel,
  GrantRecord,
  PullRequestState,
  PullRequestTicket,
  PullRequestUrl,
  RebaseFinished,
  RebaseGaveUp,
  RebaseTicket,
  RegisteredProject,
  RepoHost,
  RepoSlug,
  ReviewFinished,
  ReviewGaveUp,
  ReviewOutcome,
  ReviewTicket,
  RunBudgetExhausted,
  RunFinished,
  RunGaveUp,
  RunLimitRefused,
  RunModelRefused,
  RunOutcome,
  RunSandboxFailed,
  RunStarted,
  Salvaged,
  Sandbox,
  SpecReviewTicket,
  UxReviewTicket,
  Store,
  Ticket,
  TokenCount,
  TranscriptPath,
  TurboableConsent,
  UniformFilesReverted,
  UsageLedger,
  Usd,
} from "./ports/index.ts";
import {
  APPLIED_REVIEW_LABEL,
  APPLY_REVIEW_COMMENT,
  MergeabilityUnknown,
  READY_FOR_HUMAN_PULL_REQUEST_LABEL,
  REVIEWED_LABEL,
  hasAnnouncedOn,
  isApplyReviewTicket,
  isBlocked,
  isRebaseTicket,
  isReviewTicket,
  isSpecReviewTicket,
  isUxReviewTicket,
  localDay,
  notify,
  parentTicketIn,
  runSpanFor,
  ticketKind,
  ticketReference,
  tokenCount,
  uniformFilesAmong,
} from "./ports/index.ts";
import {
  invocationBudgetGate,
  spendCeilingForTicket,
} from "./budget-gate.ts";
import {
  invocationSelection,
  type ProjectOutcome,
  type Selection,
} from "./selection.ts";
import { salvageRecords, type Salvages } from "./salvages.ts";
import {
  modelRefused,
  resolveModel,
  type ResolvedModel,
} from "./model-resolution.ts";
import { unusableSizeLabel } from "./size-resolution.ts";
import {
  invocationState,
  invocationStateRest,
  type CurrentInvocation,
  type FreedWorkedTicket,
  type InvocationState,
} from "./invocation-state.ts";
import {
  appliedReviewComment,
  pullRequestResolvedComment,
  rebasedComment,
} from "./close-comment.ts";
import {
  discardBranch,
  handBack,
  type Discard,
  type WorkedBranch,
} from "./hand-back.ts";
import {
  hasBlockingDiscovery,
  priorDiscoveriesFor,
  routeRunDiscoveries,
  type DiscoveryReport,
  type RoutedDiscoveries,
} from "./discovery-routing.ts";
import { errorMessage } from "./error-message.ts";
import {
  budgetExhaustedReviewOutcome,
  budgetExhaustedRunOutcome,
  cutOffOf,
  cutOffReviewOutcome,
  cutOffRunOutcome,
  type AheadOfGateFailure,
  type AppliedReview,
  type BlockedOnExisting,
  type BudgetExhausted,
  type CutOff,
  type CutOffRun,
  type DiscoveryBlocked,
  type DiscoveryBlockedCutOff,
  type Failed,
  type Finished,
  type GaveUp,
  type HandoverFailed,
  type HandoverReach,
  type Iteration,
  type IterationOutcome,
  type LimitRefused,
  type MergeGate,
  type NotCommented,
  type NotLabelled,
  type NotReadied,
  type ProviderFailed,
  type PullRequestResolved,
  type Rebased,
  type Reviewed,
  type SpecReviewed,
  type UxReviewed,
  type UniformFilesTouched,
  type UnsettledMergeability,
} from "./iteration-outcome.ts";
import {
  composeInvocationReport,
  type InvocationReport,
  type InvocationStandDown,
  type SummaryFacts,
  type SummaryTracker,
} from "./summary.ts";
import type { ConflictSweepOutcome } from "./conflict-sweep.ts";
import type { SpecReviewSweepOutcome } from "./spec-review-sweep.ts";
import { settledChecks } from "./settled-checks.ts";
import { grantSweep } from "./grant-sweep.ts";
import { uniformSyncSweep, type UniformSyncSweepOutcome } from "./uniform-sync-sweep.ts";

/**
 * The eight outside-world dependencies of the loop. Everything it knows about
 * GitHub, containers, session logs, the filesystem and the wall clock arrives
 * through these — `progress` alone carries nothing back: the loop only ever
 * writes through it, and reads nothing.
 */
export interface MorningLoopPorts {
  tracker: IssueTracker & SummaryTracker;
  repoHost: RepoHost;
  sandbox: Sandbox;
  ledger: UsageLedger;
  clock: Clock;
  store: Store;
  harness: Harness;
  progress: Progress;
}

/**
 * What every run, review or spec review needs of the invocation's own state:
 * recording a run's cost, the run itself in progress, and its own run span —
 * plus every span recorded so far, live, which only an apply-review run's
 * merge gate reads.
 */
type RunRecording = Pick<
  InvocationState,
  | "recordRunCost"
  | "recordRunStarted"
  | "recordRunEnded"
  | "recordRunSpanStarted"
  | "recordRunSpanEnded"
  | "runSpans"
  | "grants"
  | "consumeGrant"
>;

/**
 * `cutOff`'s own reason, as the stand-down it triggers on `ticket` — the same
 * stand-down whether `cutOff` came from a plain limit refusal or provider
 * failure, or from a discovery-blocked iteration that also carried one.
 * `handedBack` is `iteration`'s own, so the wording can say what became of
 * the ticket named.
 */
function cutOffStandDown(
  cutOff: DiscoveryBlockedCutOff,
  ticket: Ticket,
  handedBack: boolean,
): InvocationStandDown {
  return cutOff.kind === "limit-refused"
    ? { reason: "provider-limit", limitRefusal: cutOff.limitRefusal, ticket, handedBack }
    : { reason: "provider-failure", providerFailure: cutOff.providerFailure, ticket, handedBack };
}

/** What a trigger may hand the loop beyond its ports. */
export interface MorningLoopOptions {
  /**
   * Aborted to stop the invocation by hand: nothing further starts, and the
   * invocation finishes as any stand-down does — iterations in progress finish
   * and are reported, and the summary publishes.
   */
  stop?: AbortSignal;
  /**
   * This invocation's own journal record identity, given by whichever entry
   * point opened it — the loop does not know its own invocation record
   * otherwise. Used to free worked-today entries a dead in-flight invocation
   * recorded; see CONTEXT.md's "Worked today". Absent when no entry point
   * opened a journal record: nothing is freed.
   */
  invocation?: OpenInvocation;
}

/**
 * `invocation`'s own identity paired with the journal as it stands, for the
 * state session to tell a worked-today entry a dead in-flight invocation
 * recorded apart from one still protected. `undefined` when `invocation`
 * itself is absent — no lease, no journal identity at all. When the journal
 * cannot be read, `invocation`'s own identity is kept regardless — stamping
 * what this invocation records stays independent of freeing — but the
 * session still frees nothing; said on `progress` as `journal-unreadable`
 * rather than swallowed.
 */
async function currentInvocation(
  ports: MorningLoopPorts,
  invocation: OpenInvocation | undefined,
): Promise<CurrentInvocation | undefined> {
  if (invocation === undefined) {
    return undefined;
  }
  try {
    return { self: invocation, journal: await ports.store.loadJournal() };
  } catch (error: unknown) {
    notify(ports.progress, {
      kind: "journal-unreadable",
      error: errorMessage(error),
    });
    return { self: invocation };
  }
}

/**
 * One invocation of the morning loop: as many iterations as the registry has
 * eligible work for and the budget allows, each one project and one ticket.
 *
 * No run starts without the gate's say-so, and the gate is asked again before
 * every iteration rather than once at the top — what it reads is the state as
 * it stands when that run would start, every earlier run of the same morning
 * included, so a long morning stops mid-loop the moment headroom runs out.
 *
 * Up to the budget's `maxConcurrentIterations` iterations are in progress at
 * once: whenever fewer are, another is selected, gated and started. The gate
 * counts only the runs recorded so far, never those in progress. Once it
 * refuses, or the provider limit refuses a run, nothing further starts, and
 * the iterations already in progress finish and are reported. Tickets that
 * must not run together are kept apart only by blocking edges, which
 * selection already honours, since a blocker in progress is still open.
 *
 * A ticket worked today, by this invocation or an earlier one, is not selected
 * again until the next local calendar day — but only for as long as the loop
 * could not take its eligibility away itself: a hand-back the tracker
 * refused, or a review, an apply-review, a rebase or a resolved pull request
 * the loop could not close. Every other outcome either relabels or closes
 * the ticket, or says nothing about it at all, which already keeps selection
 * off it on its own; without the record, though, an unattended morning with
 * only one project registered would work that one write failure over and
 * over until the budget gate finally stopped it.
 *
 * The summary always publishes when the invocation worked something; a quiet
 * or broken invocation publishes only if none has been announced yet today,
 * so a loop firing every 15 minutes reports one quiet or broken morning rather than
 * up to ninety-six.
 *
 * A developer's stop is a stand-down like the other two: noticed wherever the
 * loop would otherwise start something, never by cutting short what is already
 * in progress, whose work is the very thing stopping by hand should keep.
 */
export async function morningLoop(
  ports: MorningLoopPorts,
  { stop, invocation }: MorningLoopOptions = {},
): Promise<InvocationReport> {
  const startedAt = ports.clock.now();
  const today = localDay(startedAt);
  // One slot per iteration, in the order they started. A slot is left empty
  // only by an iteration that threw.
  const outcomeSlots: (IterationOutcome | undefined)[] = [];
  // Populated from `selecting.verdicts()` once selecting exists to ask;
  // stays empty if the invocation never gets that far, the same as an
  // invocation that got that far but found an empty registry.
  let outcomes: ProjectOutcome[] = [];
  // Populated from `selecting.sweeps()` alongside `outcomes`: every conflict
  // sweep the invocation ran, one per non-paused project per selection.
  let sweepOutcomes: ConflictSweepOutcome[] = [];
  // Populated from `selecting.specReviewSweeps()` the same way: every spec
  // review sweep the invocation ran, one per non-paused project per
  // selection.
  let specReviewSweepOutcomes: SpecReviewSweepOutcome[] = [];
  // Populated from `uniformSyncSweepAll` below: one uniform sync sweep per
  // non-paused, non-manager registered project, run once for the whole
  // invocation rather than once per scan — whether a project's uniform files
  // are stale says nothing about ticket selection, and a clone is too heavy a
  // thing to repeat on every scan an invocation makes.
  let uniformSyncSweepOutcomes: UniformSyncSweepOutcome[] = [];
  // Populated from `worked.freed()` once `worked` exists: every ticket a dead
  // in-flight invocation had recorded, freed for this invocation to select.
  let freedTickets: FreedWorkedTicket[] = [];

  let standDown: InvocationStandDown | undefined;
  let invocationFailure: string | undefined;
  // Set once `loadState` has succeeded, since only then is there a state
  // document to fold a successful publish's announcement back into. Absent
  // when the loop's own plumbing broke before that point — there is nothing
  // to write back then, as the final `catch` below already notes.
  let announcedOn: Day | undefined;
  let saveState: (() => Promise<void>) | undefined;
  try {
    const stored = await ports.store.loadState();
    announcedOn = stored.announcedOn;
    const salvages = salvageRecords(stored.salvages);
    const state = invocationState(
      { store: ports.store },
      stored,
      today,
      () => invocationStateRest(announcedOn, salvages.record()),
      await currentInvocation(ports, invocation),
    );
    freedTickets = state.freed();
    saveState = () => state.save();
    const modelDefaults = await ports.store.loadModelDefaults();
    // Built once and kept for the whole invocation, not once per iteration:
    // it is what remembers a project's "selected" verdict across scans and
    // where each registered project first landed in registry order.
    const selecting = invocationSelection(ports, state.projectStates(), state);
    // Built once too, over the invocation's own live view of recorded runs: a
    // run recorded between two consultations is exactly what the next one
    // counts.
    const gate = invocationBudgetGate(ports, state.projectStates());
    // Run once, ahead of the first iteration: a registered project's uniform
    // files are either stale or they are not, regardless of which ticket, if
    // any, this invocation goes on to select.
    uniformSyncSweepOutcomes = await uniformSyncSweepAll(ports);
    // Pruned on the same once-per-invocation footing: a closed ticket's grant
    // record says nothing about which ticket is selected next.
    await grantSweep(ports.tracker, state);
    // Keyed by each iteration's own completion, so the tickets an in-progress
    // consultation names are exactly the ones still running when it asks —
    // never the one it is asking on behalf of, which is passed separately.
    const inProgress = new Map<Promise<void>, Ticket>();
    // What an iteration in progress threw, rethrown once the others finish:
    // only a port breaking its own contract gets here.
    const thrown: unknown[] = [];
    // Read from the budget before every start. Nothing is in progress before
    // the first, so there is no limit to wait on until then.
    let concurrencyLimit: IterationLimit | undefined;
    const stopped = (): boolean => {
      // Read here rather than from an abort listener, so a stop landing after
      // the loop has already finished never changes a report built without it.
      if (stop?.aborted === true) {
        standDown ??= { reason: "stopped" };
      }
      return standDown !== undefined || thrown.length > 0;
    };
    try {
      for (;;) {
        while (
          concurrencyLimit !== undefined &&
          inProgress.size >= concurrencyLimit
        ) {
          await Promise.race(inProgress.keys());
        }
        // A stop caught here, before the first `next`, means the invocation
        // sweeps nothing this run: a stop is a developer asking the loop to
        // do nothing further, and a conflict sweep — unlike the budget gate —
        // is one of the things it would otherwise do, its zero agent cost
        // notwithstanding.
        if (stopped()) {
          break;
        }

        const chosen = await selecting.next(
          new Set(
            [...inProgress.values()].flatMap((running) =>
              running.pullRequest === undefined ? [] : [running.pullRequest.url],
            ),
          ),
        );
        if (chosen === undefined) {
          // An iteration in progress can still queue work — a finished run's
          // review ticket — or release a ticket held back because it shares
          // that run's pull request, so nothing left means nothing left once
          // none is.
          if (inProgress.size === 0) {
            break;
          }
          await Promise.race(inProgress.keys());
          continue;
        }
        // A refusal can land while the registry was being read.
        if (stopped()) {
          break;
        }
        const { ticket } = chosen;
        // Announced as an iteration starts, before the sandbox is ever
        // invoked — the earliest point there is anything to narrate.
        notify(ports.progress, {
          kind: "iteration-selected",
          ticket,
        });

        // Ahead of the gate as well as of the run: handing a ticket back
        // spends nothing, so a morning the gate refuses still gives the
        // developer the ticket they need to fix.
        const resolution = resolveModel(ticket, modelDefaults);
        const unusableLabel =
          resolution.kind === "unusable" ? resolution.failure : unusableSizeLabel(ticket);
        if (unusableLabel !== undefined) {
          outcomeSlots.push(
            await handBackAheadOfGate(
              ports,
              chosen.project.repo,
              ticket,
              unusableLabel,
              state,
            ),
          );
          continue;
        }

        // Asked immediately before this run and never earlier, so the
        // windows it reads are the ones in force when the run would start,
        // not the state the invocation opened with.
        const {
          standDown: refusal,
          budget,
          estimateCharged,
          estimateBasis,
        } = await gate.consult(ticket, [...inProgress.values()]);
        concurrencyLimit = budget.maxConcurrentIterations;
        if (refusal !== undefined) {
          // The first refusal is the stand-down, whichever of the two it was.
          standDown ??= { ...refusal, refused: chosen.project.repo };
          // Announced before any work starts, not only in the invocation report.
          notify(ports.progress, {
            kind: "stood-down",
            ticket,
            ...refusal,
          });
          break;
        }

        // Saved before the sandbox starts, not only at the end: a process
        // killed mid-run never reaches the final save, and would otherwise
        // free the ticket for the next firing the same day. Recorded, too, is
        // what keeps a ticket in progress from being selected again.
        await state.ticketSelected(ticket, localDay(ports.clock.now()));
        if (stopped()) {
          state.selectionAbandoned(ticket);
          break;
        }

        const { repo } = chosen.project;
        const model = resolution.kind === "resolved" ? resolution.model : undefined;
        // Reported where it started, however long it then takes to finish.
        const slot = outcomeSlots.push(undefined) - 1;
        const completion: Promise<void> = work(
          ports,
          chosen,
          state,
          spendCeilingForTicket(ticket, budget),
          model,
          salvages,
        )
          .then(
            (iteration) => {
              outcomeSlots[slot] = {
                repo,
                ticket,
                ...(model !== undefined && { model: model.name }),
                estimateCharged,
                estimateBasis,
                ...iteration,
              } as IterationOutcome;

              // An infrastructure failure, a limit refusal, a provider
              // failure or a budget exhaustion says nothing about the ticket,
              // so it is left free for a later firing today — one that finds
              // the setup fixed, the provider limit reset, the provider
              // answering again, or simply enough of the ceiling left to
              // finish the job. So is a ticket whose own tracker write
              // landed: the loop already took its eligibility away, so the
              // record has nothing left to protect, and a developer who
              // re-applies ready-for-agent the same day gets a later firing
              // rather than silence.
              state.iterationEnded(ticket, iteration);

              // A cut-off run — a limit refusal or a provider failure,
              // direct or carried by a discovery-blocked iteration whose run
              // was cut off before it filed the blocking discovery — stops
              // every run after it the same way, so nothing further starts.
              // The iterations already in progress are left to finish on
              // their own.
              const cutOff = cutOffOf(iteration);
              if (cutOff !== undefined) {
                const handedBack =
                  iteration.kind === "discovery-blocked" &&
                  iteration.handedBack.outcome !== "refused";
                standDown ??= cutOffStandDown(cutOff, ticket, handedBack);
                if (cutOff.kind === "limit-refused") {
                  // Announced the instant the provider refuses, not only once
                  // the invocation report is written — the developer would
                  // otherwise hear nothing until every iteration still in
                  // progress finished on its own.
                  notify(ports.progress, {
                    kind: "provider-limited",
                    ticket,
                    limitRefusal: cutOff.limitRefusal,
                  });
                }
              }
            },
            (error: unknown) => {
              thrown.push(error);
            },
          )
          .finally(() => inProgress.delete(completion));
        inProgress.set(completion, ticket);
      }
    } finally {
      // Never rejects: each iteration's own settling catches what it threw.
      await Promise.all(inProgress.keys());
      // Read back out here rather than only on the happy path, so a for loop
      // that throws still reports every verdict scanned before that — the
      // same partial account `iterations` already carries for the runs made
      // before it.
      outcomes = selecting.verdicts();
      sweepOutcomes = selecting.sweeps();
      specReviewSweepOutcomes = selecting.specReviewSweeps();
      // State is written back at the end of every invocation, including one that
      // worked nothing and one whose run failed part way, so that a machine
      // which has run the loop always has a state document to read next morning.
      // A run that fell over still spent tokens, and the morning it spent them
      // on is exactly the one worth having recorded.
      await saveState();
    }
    if (thrown.length > 0) {
      throw thrown[0];
    }
  } catch (error: unknown) {
    // Nothing above this point throws by design — a run that fails is
    // described, not raised. Reaching here means the loop's own plumbing
    // broke instead: a registry that would not parse, a port that could
    // not be reached before a single iteration ran, or one that broke its
    // own contract. `loadState` failing this
    // way means there is nothing to write back, unlike a failure from inside
    // the loop, which the `finally` above already saved. Caught rather than
    // left to propagate, so the developer still gets a summary that says
    // what happened instead of losing the account of it to an invocation
    // that never reached the write below.
    invocationFailure = errorMessage(error);
  }

  const iterations = outcomeSlots.filter(
    (iteration): iteration is IterationOutcome => iteration !== undefined,
  );
  const facts: SummaryFacts = {
    projects: outcomes,
    iterations,
    standDown,
    invocationFailure,
    conflictSweeps: sweepOutcomes,
    specReviewSweeps: specReviewSweepOutcomes,
    uniformSyncSweeps: uniformSyncSweepOutcomes,
    freedFromDeadInvocation: freedTickets,
  };

  // Last, so a morning that worked something still gets its state recorded
  // above even if the tracker refuses to publish the summary these facts come
  // to.
  const report = await composeInvocationReport(ports.tracker, {
    startedAt,
    facts,
    alreadyAnnouncedToday: hasAnnouncedOn(announcedOn, today),
  });

  // Recorded only now that the publish is known to have succeeded, and only
  // when there is a state document to fold it back into. A fault saving it is
  // the state document's, not the publish's, and must never read back as a
  // publish that failed when the summary in fact went out.
  if (report.summaryLocation !== undefined && saveState !== undefined) {
    announcedOn = today;
    await saveState();
  }

  return report;
}

/**
 * Hands `ticket` back ahead of the gate, for `ending`: unusable model labels,
 * or a size label naming no size the budget document knows. Recorded as
 * worked today and saved before the hand-back is posted — `ticketSelected`'s
 * own save-at-once guarantee, so a process stopped mid-post still leaves the
 * ticket recorded, and a hand-back the tracker refuses still keeps a later
 * firing the same day from selecting the ticket again. One that landed frees
 * it per `freesTicketToday`. Nothing is cloned or spent, since no run ever
 * starts.
 *
 * Carries `ticketSelected`'s own failure contract along with its guarantee: a
 * save that fails takes the ticket back off the record and rethrows, so the
 * hand-back this call was about to post never goes out, and the throw
 * escapes to `morningLoop`'s own outer catch — a store fault here aborts the
 * whole invocation, the same as one on the pre-sandbox path.
 */
async function handBackAheadOfGate(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: Ticket,
  ending: AheadOfGateFailure,
  invocation: Pick<InvocationState, "ticketSelected" | "iterationEnded">,
): Promise<IterationOutcome> {
  await invocation.ticketSelected(ticket, localDay(ports.clock.now()));
  const handedBack = await handBack(ports, ticket, ending);
  const iteration: Failed = { kind: "failed", failure: ending, handedBack };
  invocation.iterationEnded(ticket, iteration);
  return { repo, ticket, ...iteration };
}

/** The `transcript` field a `handBack` ending wants, present only when `transcript` is. */
function transcriptField(transcript: TranscriptPath | undefined): { transcript?: TranscriptPath } {
  return transcript === undefined ? {} : { transcript };
}

/**
 * The second step: run the selected ticket and record what that cost. An
 * implementation ticket hands its work over as a draft pull request with a
 * review queued against it, or — when the agent gave up — puts the ticket back
 * in the developer's hands. An infrastructure failure, a limit refusal, a
 * provider failure or a budget exhaustion leaves the ticket untouched. A
 * review ticket's own run posts its findings itself and is closed once it
 * has; an apply-review
 * ticket's pushes and replies itself, and is closed once the repo host shows
 * every thread answered; a rebase ticket's force-pushes itself, and is closed
 * once the repo host no longer reports its pull request conflicting; and a
 * spec review ticket's run reviews the repo against its supertask and is
 * handed back with its findings, never closed.
 *
 * A failed run ends this iteration rather than the invocation: it is
 * reported, and the loop goes on to consider the next iteration.
 */
async function work(
  ports: MorningLoopPorts,
  selection: Selection,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
  salvages: Salvages,
): Promise<Iteration> {
  if (isRebaseTicket(selection.ticket)) {
    return await runRebase(
      ports,
      selection.project,
      selection.ticket,
      invocation,
      spendCeiling,
      model,
    );
  }
  if (isApplyReviewTicket(selection.ticket)) {
    return await runApplyReview(
      ports,
      selection.project,
      selection.ticket,
      invocation,
      spendCeiling,
      model,
    );
  }
  if (isReviewTicket(selection.ticket)) {
    return await runReview(
      ports,
      selection.project.repo,
      selection.ticket,
      invocation,
      spendCeiling,
      model,
      selection.project.turbo,
    );
  }
  if (isSpecReviewTicket(selection.ticket)) {
    return await runSpecReview(
      ports,
      selection.project.repo,
      selection.ticket,
      invocation,
      spendCeiling,
      model,
    );
  }
  if (isUxReviewTicket(selection.ticket)) {
    return await runUxReview(
      ports,
      selection.project.repo,
      selection.ticket,
      invocation,
      spendCeiling,
      model,
    );
  }

  const returned = await attemptRun(
    ports,
    selection,
    invocation,
    spendCeiling,
    model,
    salvages.get(selection.ticket)?.branch,
  );
  // An infrastructure failure says nothing about the ticket, so the ticket is
  // left exactly as it was: the summary names the setup to fix instead.
  if (returned.kind === "failed") {
    return returned;
  }

  // A variant is exactly one kind, so nothing here turns on the order the
  // failing kinds are checked in.
  const { outcome: run, checkout } = returned;
  if (run.kind === "sandbox-failed") {
    // The agent already ran and spent — recorded against the project above,
    // same as any other run — but the sandbox is what failed, so the ticket
    // is left exactly as an infrastructure failure leaves it: not handed
    // back, and eligible to come round again.
    const salvage = await infrastructureFailureSalvage(
      ports,
      checkout,
      salvages,
      selection.ticket,
      run,
    );
    return {
      kind: "failed",
      tokensUsed: run.tokensUsed,
      failure: {
        kind: "infrastructure",
        reason: run.reason,
        tokensUsed: run.tokensUsed,
        ...(salvage !== undefined && { salvage }),
      },
    };
  }
  if (run.kind === "limit-refused") {
    // Salvaged rather than discarded, unlike a provider failure's branch
    // below: a next run for this ticket can still resume on it, per
    // CONTEXT.md's "Cut off" and "Salvage".
    return routeCutOffDiscoveriesOrBlock(
      ports,
      selection.ticket,
      run,
      (run) =>
        salvageableBranchOutcome(ports, checkout, salvages, selection.ticket, run).then((discard) =>
          cutOffRunOutcome(run, discard),
        ),
      { checkout, salvages, run },
    );
  }
  if (run.kind === "budget-exhausted") {
    // Salvaged exactly as a limit refusal's branch is — its own ceiling says
    // nothing about the ticket, only that this run ran out of room — but
    // never a `cutOffRunOutcome`: unlike a limit refusal, this run's own
    // ceiling says nothing about the next run's, so it must not stand the
    // invocation down.
    return budgetExhaustedRunOutcome(
      run,
      await salvageableBranchOutcome(ports, checkout, salvages, selection.ticket, run),
    );
  }
  if (run.kind === "provider-failed") {
    // Discarded, same as any other cut-off run's branch, per CONTEXT.md's
    // "Cut off" — unlike a limit refusal's above, kept as a salvage.
    return routeCutOffDiscoveriesOrBlock(
      ports,
      selection.ticket,
      run,
      (run) => discardBranch(ports.repoHost, checkout, run).then((discard) => cutOffRunOutcome(run, discard)),
      { checkout, salvages, run },
    );
  }
  if (run.kind === "model-refused") {
    // A model refusal ends the ticket's run on its own terms, whatever it
    // continued from, so it retires the ticket's salvage record. See
    // CONTEXT.md's "Salvage".
    await retireSalvage(ports, checkout, salvages, selection.ticket, run.branch);
    return handModelRefusedBack(
      ports,
      selection.ticket,
      run.refusal,
      run.tokensUsed,
      run.transcript,
      { checkout, run },
    );
  }
  // Routed before either of the run's own endings — finished or gave up — is
  // decided: a blocking discovery replaces both, per CONTEXT.md's "Discovery"
  // and "Hand back". Either way the ticket's salvage record is retired, the
  // same as any other gave-up run's branch; see CONTEXT.md's "Salvage".
  const routing = await routeOrBlock(ports, selection.ticket, run, {
    worked: { checkout, salvages, run },
  });
  if ("blocked" in routing) {
    return routing.blocked;
  }
  const { routed } = routing;
  // A prerequisite that named an already-ticketed, still-open issue blocked
  // it directly rather than opening a new one — `routeOrBlock` never treats
  // that as blocking, since the run itself is not the developer's problem —
  // but per CONTEXT.md's "Discovery" the ticket it named is not handed back
  // for it either: it keeps ready-for-agent, and the comment `fileDiscovery`
  // already posted is the only word it gets. This is the one call site
  // `routed.target` is ever this run's own ticket rather than a cross target,
  // so it is the one place that still has to check.
  if (routed !== undefined && blockedOnExistingOwnTicket(routed)) {
    await retireSalvage(ports, checkout, salvages, selection.ticket, run.branch);
    return blockedOnExistingOutcome(ports, checkout, run, routed);
  }
  if (run.kind === "finished") {
    await retireSalvage(ports, checkout, salvages, selection.ticket, run.branch);
    return withDiscoveries(
      await handOver(ports, run, checkout, selection.ticket, selection.project.manager),
      routed,
    );
  }

  await retireSalvage(ports, checkout, salvages, selection.ticket, run.branch);
  const failure: GaveUp = { kind: "gave-up", reason: run.reason };
  const handedBack = await handBack(ports, selection.ticket, {
    ...failure,
    ticketKind: "implementation",
    output: run.output,
    checkout,
    run,
  });
  const gaveUp: Failed = {
    kind: "failed",
    run,
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
  return withDiscoveries(gaveUp, routed);
}

/**
 * `iteration`, with `routed`'s own routing and cross-target attached.
 * Unchanged when there was nothing to route.
 */
function withDiscoveries<T extends { discoveryReport?: DiscoveryReport }>(
  iteration: T,
  routed: RoutedDiscoveries | undefined,
): T {
  if (routed === undefined) {
    return iteration;
  }
  return {
    ...iteration,
    discoveryReport: {
      routing: routed.routing,
      ...(routed.crossTarget !== undefined && { crossTarget: routed.crossTarget }),
    },
  };
}

/**
 * Whether `routed` carries a prerequisite that named an already-ticketed,
 * still-open issue and blocked it directly — `"blocked-on-existing"`, per
 * `FiledDiscovery`. Landed on `routed.target`, whatever ticket that is: the
 * run's own for an implementation run, or the implementation ticket it
 * cross-targets for a pull-request ticket's run. `routeOrBlock` already
 * answers `{ routed }` rather than `{ blocked }` for one of these, since it is
 * not blocking; this is what tells that apart from a run that filed nothing of
 * the kind at all, which still goes on to finish or give up exactly as before.
 */
function leavesBlockedOnExisting(routed: RoutedDiscoveries): boolean {
  return routed.routing.filed.some((filed) => filed.action === "blocked-on-existing");
}

/**
 * As `leavesBlockedOnExisting`, narrowed to a `Blocked on:` landed on the
 * run's own ticket rather than a cross target — true only for an
 * implementation run, whose target is its own ticket.
 */
function blockedOnExistingOwnTicket(routed: RoutedDiscoveries): boolean {
  return routed.crossTarget === undefined && leavesBlockedOnExisting(routed);
}

/**
 * The outcome for an implementation run whose ticket `blockedOnExistingOwnTicket`
 * found blocked on an existing issue instead: its branch discarded exactly as
 * a `DiscoveryBlocked` run's is, whatever it committed or would otherwise
 * have finished, and no call to `handBack` — the ticket keeps ready-for-agent,
 * per CONTEXT.md's "Discovery", and the comment `fileDiscovery` already
 * posted naming the blocker is the only word it gets.
 */
async function blockedOnExistingOutcome(
  ports: MorningLoopPorts,
  checkout: Checkout,
  run: RunFinished | RunGaveUp,
  routed: RoutedDiscoveries,
): Promise<BlockedOnExisting> {
  const discard = await discardBranch(ports.repoHost, checkout, run);
  return {
    kind: "blocked-on-existing",
    discoveryReport: { routing: routed.routing },
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    branch: run.branch,
    discard,
  };
}

/**
 * The discard a limit-refused or a budget-exhausted run's branch gets:
 * salvaged, when it carries commits of its own, past any salvage it resumed —
 * kept in the checkout, and recorded against `ticket`'s salvage record, so its
 * next run can continue on it (see CONTEXT.md's "Salvage") — or discarded as
 * any other cut-off run's branch otherwise, since a run that added no commit
 * left nothing to salvage and says nothing new about an existing record.
 * Shared by both: a budget exhaustion is kept exactly as a limit refusal's
 * branch is, even though it never stands the invocation down the way a limit
 * refusal does.
 */
async function salvageableBranchOutcome(
  ports: MorningLoopPorts,
  checkout: Checkout,
  salvages: Salvages,
  ticket: Ticket,
  run: RunLimitRefused | RunBudgetExhausted,
): Promise<Discard> {
  const resumed = new Set(run.resumedCommits);
  if (run.commits.every((commit) => resumed.has(commit))) {
    return { kind: "none" };
  }
  await discardStaleSalvage(ports, checkout, salvages, ticket, run.branch);
  const { branch, stopShorts } = salvages.recordStopShort(ticket, run.branch);
  return { kind: "salvaged", branch, stopShorts };
}

/**
 * The salvage a post-start infrastructure failure's branch gets, when it had
 * already reached the checkout and carries commits — kept where it landed,
 * and recorded against `ticket`'s salvage record with its existing count of
 * stop-shorts left untouched (see CONTEXT.md's "Salvage") — undefined
 * otherwise, since a branch never fetched back, or one that committed
 * nothing, left nothing to salvage.
 */
async function infrastructureFailureSalvage(
  ports: MorningLoopPorts,
  checkout: Checkout,
  salvages: Salvages,
  ticket: Ticket,
  run: RunSandboxFailed,
): Promise<Salvaged | undefined> {
  if (run.branch === undefined || run.commits === undefined || run.commits.length === 0) {
    return undefined;
  }
  await discardStaleSalvage(ports, checkout, salvages, ticket, run.branch);
  const { branch, stopShorts } = salvages.recordInfrastructureFailure(ticket, run.branch);
  return { branch, stopShorts };
}

/**
 * The draft pull request a finished run's commits wait in, and the review
 * queued against it.
 *
 * Either way the run finished, its ticket leaves the queue: relabelled
 * ready-for-human and commented on, so tomorrow's invocation cannot select it
 * again. A run that committed nothing has no pull request and no review to
 * name, so the comment says only that; a review ticket's own run never
 * reaches here — its handover is comments on the pull request it already
 * names, not a pull request of its own.
 *
 * A handover that fails part way is a failed iteration rather than a thrown
 * one, so the invocation goes on: see `HandoverFailed`.
 *
 * Only a run that finished. A failed agent's commits never reach here — they
 * go to `discardBranch` instead, because they are not work to review.
 *
 * `manager` skips the uniform-file check below: the manager's own registered
 * project (`RegisteredProject.manager`) is where `UNIFORM_FILES` are the
 * source, not a copy, so a run there touching one is legitimate work, not
 * drift.
 */
async function handOver(
  ports: MorningLoopPorts,
  run: RunFinished,
  checkout: Checkout,
  ticket: Ticket,
  manager: true | undefined,
): Promise<Finished | Failed> {
  if (run.commits.length === 0) {
    const handedBack = await handBack(ports, ticket, { kind: "finished", run });
    return { kind: "finished", run, tokensUsed: run.tokensUsed, handedBack };
  }

  if (manager === undefined) {
    let touched: string[];
    try {
      touched = await touchedUniformFiles(ports.repoHost, checkout, run.branch);
    } catch (error: unknown) {
      // The same checkout state (typically a detached HEAD) that would have
      // failed the push inside `openDraftPullRequest` below fails this read
      // first — handled the same way, so a run whose checkout cannot be
      // diffed is no worse off than one whose branch could not be pushed.
      return handoverFailed(
        ports,
        ticket,
        run,
        `its diff could not be read: ${errorMessage(error)}`,
        { kind: "unpushed", checkout },
      );
    }
    if (touched.length > 0) {
      return uniformFilesTouchedOutcome(ports, ticket, checkout, run, touched);
    }
  }

  const opening = await ports.repoHost.openDraftPullRequest(
    checkout,
    run.branch,
    ticket,
    run.gist,
    run.nits,
  );
  if (opening.kind === "unpushed") {
    return handoverFailed(
      ports,
      ticket,
      run,
      `it was not pushed: ${opening.failure}`,
      { kind: "unpushed", checkout },
    );
  }
  if (opening.kind === "pushed") {
    return handoverFailed(
      ports,
      ticket,
      run,
      `it was pushed, but ${opening.failure}`,
      { kind: "pushed" },
    );
  }
  const { pullRequest } = opening;

  // Queued here rather than asked of the agent that wrote the code: an agent
  // that ran out of steam cannot forget to, and the review it asks for is a
  // run of its own rather than the tail of the one being reviewed.
  let reviewTicket: Ticket;
  try {
    reviewTicket = await ports.tracker.createReviewTicket(ticket, pullRequest);
  } catch (error: unknown) {
    return handoverFailed(
      ports,
      ticket,
      run,
      `the review ticket could not be created: ${errorMessage(error)}`,
      { kind: "opened", pullRequest },
    );
  }

  const handover = { pullRequest, reviewTicket };
  const handedBack = await handBack(ports, ticket, { kind: "finished", run, handover });

  return { kind: "finished", run, tokensUsed: run.tokensUsed, handover, handedBack };
}

/**
 * The uniform files (`UNIFORM_FILES`) a run's own diff touches, in
 * `UNIFORM_FILES`'s own order — empty when it touches none.
 */
async function touchedUniformFiles(
  repoHost: RepoHost,
  checkout: Checkout,
  branch: Branch,
): Promise<string[]> {
  return uniformFilesAmong(await repoHost.readChangedPaths(checkout, branch));
}

/**
 * A uniform sync sweep of every non-paused, non-manager registered project —
 * paused the same reason a conflict sweep never sweeps a paused project
 * either: paused means never considered. The manager's own project is
 * excluded because its uniform files are the source, not a copy to bring
 * back in step.
 */
async function uniformSyncSweepAll(
  ports: MorningLoopPorts,
): Promise<UniformSyncSweepOutcome[]> {
  const outcomes: UniformSyncSweepOutcome[] = [];
  for (const project of await ports.store.loadRegistry()) {
    if (project.paused || project.manager === true) {
      continue;
    }
    outcomes.push(
      await uniformSyncSweep(
        ports,
        project.repo,
        project.turbo ? { clock: ports.clock } : undefined,
      ),
    );
  }
  return outcomes;
}

/**
 * A finished run whose diff touches a uniform file, as the failed iteration
 * it comes to: the branch is left unpushed, and the ticket is handed back
 * naming the files touched — see CONTEXT.md's "Uniform files". Never a
 * `Finished`, even though the run did: a project-local pull request is
 * exactly the drift a uniform file exists to prevent, so this is no more
 * delivered than a handover that failed part way.
 */
async function uniformFilesTouchedOutcome(
  ports: MorningLoopPorts,
  ticket: Ticket,
  checkout: Checkout,
  run: RunFinished,
  files: string[],
): Promise<Failed> {
  const failure: UniformFilesTouched = { kind: "uniform-files-touched", files };
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ticketKind: "implementation",
    checkout,
    run,
  });
  return {
    kind: "failed",
    run,
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
}

/**
 * A finished run whose handover failed, as the failed iteration it comes to:
 * its ticket handed back with a comment naming where the work is.
 */
async function handoverFailed(
  ports: MorningLoopPorts,
  ticket: Ticket,
  run: RunFinished,
  reason: string,
  where: HandoverReach,
): Promise<Failed> {
  const failure: HandoverFailed = {
    kind: "handover-failed",
    reason,
    branch: run.branch,
    where,
  };
  const handedBack = await handBack(ports, ticket, { ...failure, ...transcriptField(run.transcript) });
  return {
    kind: "failed",
    run,
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
}

/**
 * Hands a ticket back for a model the agent CLI refused: on an implementation
 * ticket, `worked` names the branch its run left, so its own hand-back
 * discards it; a review, apply-review or rebase ticket's own run never
 * creates one, so `worked` is left out.
 */
async function handModelRefusedBack(
  ports: MorningLoopPorts,
  ticket: Ticket,
  refusal: ModelRefusal,
  tokensUsed: TokenCount,
  transcript: TranscriptPath | undefined,
  worked?: { checkout: Checkout; run: RunModelRefused },
): Promise<Failed> {
  const failure = modelRefused(ticket, refusal);
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ...(worked !== undefined && { worked }),
    ...transcriptField(transcript),
  });
  return {
    kind: "failed",
    ...(worked !== undefined && { run: worked.run }),
    tokensUsed,
    ...(transcript !== undefined && { transcript }),
    failure,
    handedBack,
  };
}

/**
 * `run`'s own cut-off, as `DiscoveryBlocked.cutOff` carries it — the one
 * place a limit refusal or a provider failure's own words become the shape
 * `routeOrBlock` attaches when it blocks a cut-off run, for every run kind
 * that can hit one.
 */
function discoveryBlockedCutOff(run: {
  kind: "limit-refused" | "provider-failed";
  words: string;
}): DiscoveryBlockedCutOff {
  return run.kind === "limit-refused"
    ? { kind: "limit-refused", limitRefusal: run.words }
    : { kind: "provider-failed", providerFailure: run.words };
}

/**
 * Hands a ticket back for a blocking discovery — a correction or a
 * prerequisite the run filed — per CONTEXT.md's "Discovery" and "Hand back":
 * the run's own ticket is handed back exactly as a gave-up run's is, whatever
 * the agent went on to commit, would otherwise have finished, or was cut off
 * by the provider mid-run — the correction or prerequisite is no less true
 * for the provider having run out. `worked` names the branch an
 * implementation run left, so its own hand-back discards it; a review,
 * apply-review, rebase or spec review ticket's own run never creates one, so
 * `worked` is left out. `routed.crossTarget` is named on the hand-back only
 * when it is set — a pull request or a spec review ticket's run, whose
 * discoveries land on its implementation ticket or supertask rather than the
 * ticket handed back here. `cutOff` is set only when the run that filed the
 * discovery was also cut off, so the iteration still carries what stands the
 * invocation down. `output`, present only for a spec review ticket's own run,
 * is inlined on the hand-back too: a spec review has nowhere else to post its
 * report, so the discovery that blocked it would otherwise throw the rest of
 * the report away.
 */
async function discoveryBlockedOutcome(
  ports: MorningLoopPorts,
  ticket: Ticket,
  routed: RoutedDiscoveries,
  tokensUsed: TokenCount,
  transcript: TranscriptPath | undefined,
  worked?: WorkedBranch,
  cutOff?: DiscoveryBlockedCutOff,
  output?: string,
): Promise<DiscoveryBlocked> {
  const { crossTarget } = routed;
  const handedBack = await handBack(ports, ticket, {
    kind: "discovery-blocked",
    discoveries: routed.routing.blocking,
    ...(crossTarget !== undefined && { crossTarget }),
    ...(worked !== undefined && { worked }),
    ...(output !== undefined && { output }),
    ...transcriptField(transcript),
  });
  return {
    kind: "discovery-blocked",
    discoveryReport: {
      routing: routed.routing,
      ...(crossTarget !== undefined && { crossTarget }),
    },
    tokensUsed,
    ...(transcript !== undefined && { transcript }),
    handedBack,
    ...(cutOff !== undefined && { cutOff }),
  };
}

/**
 * Routes `outcome`'s own discoveries against `ticket` and, when one of them
 * blocks, hands the ticket back for it — shared by every run kind's own
 * gave-up, otherwise-successful and cut-off paths alike, each of which
 * replaces its ending with a blocking discovery's hand-back the same way, per
 * CONTEXT.md's "Discovery" and "Hand back". `worked` names the branch an
 * implementation run left — a review, apply-review, rebase or spec review run
 * never creates one, so its own calls leave it out — and, when given, is also
 * the salvage record a block retires: discarded and cleared exactly as any
 * other ending that leaves nothing to resume does, per CONTEXT.md's "Salvage".
 * `cutOff` is set only on a cut-off run's own call, so a block still carries
 * what stands the invocation down. `output`, passed only by a spec review
 * run, is its own report — see `discoveryBlockedOutcome`.
 */
async function routeOrBlock(
  ports: MorningLoopPorts,
  ticket: Ticket,
  outcome: {
    tokensUsed: TokenCount;
    transcript?: TranscriptPath;
    discoveries?: Discovery[];
    discoveriesDropped?: number;
  },
  options?: {
    worked?: WorkedBranch & { salvages: Salvages };
    cutOff?: DiscoveryBlockedCutOff;
    output?: string;
  },
): Promise<{ routed: RoutedDiscoveries | undefined } | { blocked: DiscoveryBlocked }> {
  const routed = await routeRunDiscoveries(
    ports.tracker,
    ticket,
    outcome.discoveries,
    outcome.discoveriesDropped,
  );
  if (routed !== undefined && hasBlockingDiscovery(routed.routing)) {
    const { worked } = options ?? {};
    if (worked !== undefined) {
      await retireSalvage(ports, worked.checkout, worked.salvages, ticket, worked.run.branch);
    }
    return {
      blocked: await discoveryBlockedOutcome(
        ports,
        ticket,
        routed,
        outcome.tokensUsed,
        outcome.transcript,
        worked !== undefined ? { checkout: worked.checkout, run: worked.run } : undefined,
        options?.cutOff,
        options?.output,
      ),
    };
  }
  return { routed };
}

/**
 * Routes a cut-off run's discoveries, or blocks on them — the one place the
 * convention is spelled out, routed through the same blocking check as the
 * run's own gave-up and otherwise-successful paths call `routeOrBlock` for:
 * a correction or prerequisite the run filed is no less true for the
 * provider having cut it off. Still carries its cut-off, so the invocation
 * stands down over it exactly as it would without the discovery. `worked`
 * names the branch an implementation run left, as `routeOrBlock`'s own does;
 * a review, apply-review, rebase or spec review run never creates one, so
 * its own calls leave it out. `toCutOffOutcome` builds `run`'s own cut-off
 * outcome once routing clears it to go ahead — async, since an
 * implementation run's still needs its branch's discard decided first.
 */
async function routeCutOffDiscoveriesOrBlock<Run extends CutOffRun>(
  ports: MorningLoopPorts,
  ticket: Ticket,
  run: Run,
  toCutOffOutcome: (run: Run) => CutOff | Promise<CutOff>,
  worked?: WorkedBranch & { salvages: Salvages },
): Promise<CutOff | DiscoveryBlocked> {
  const routing = await routeOrBlock(ports, ticket, run, {
    ...(worked !== undefined && { worked }),
    cutOff: discoveryBlockedCutOff(run),
  });
  if ("blocked" in routing) {
    return routing.blocked;
  }
  return withDiscoveries(await toCutOffOutcome(run), routing.routed);
}

/**
 * Discards `ticket`'s previously salvaged branch, if it names one other than
 * `keeping` — the branch the run just ending left, salvaged, discarded, or
 * handed over. Every write to a salvage record replaces or clears the branch
 * named there. A run that resumes on its ticket's salvage keeps `keeping` and
 * the record's own branch the same, and this discards nothing; a run that
 * could not resume it — started fresh, or the salvage itself gave up —
 * leaves the record's old branch unreachable by name, so it would otherwise
 * sit in the checkout forever: see CONTEXT.md's "Salvage".
 *
 * Best-effort and never throws, like `discardBranch`: a branch git refuses to
 * delete here is not worth costing the ticket its outcome over.
 */
async function discardStaleSalvage(
  ports: MorningLoopPorts,
  checkout: Checkout,
  salvages: Salvages,
  ticket: Ticket,
  keeping: Branch,
): Promise<void> {
  const stale = salvages.get(ticket)?.branch;
  if (stale === undefined || stale === keeping) {
    return;
  }
  try {
    await ports.repoHost.discardBranch(checkout, stale);
  } catch {
    // Best-effort cleanup of a branch nothing names any more: see above.
  }
}

/**
 * Retires `ticket`'s salvage record for a run ending that leaves nothing to
 * resume: `discardStaleSalvage`'s own discard of the branch it names, if any,
 * followed by clearing the record itself — the two always happen together,
 * since an ending that discards a stale salvage this way never has one worth
 * keeping either.
 */
async function retireSalvage(
  ports: MorningLoopPorts,
  checkout: Checkout,
  salvages: Salvages,
  ticket: Ticket,
  keeping: Branch,
): Promise<void> {
  await discardStaleSalvage(ports, checkout, salvages, ticket, keeping);
  salvages.clear(ticket);
}

/** What `runInSandbox` came back with, before its caller reads what kind of outcome it was. */
interface SandboxResult<Outcome> {
  kind: "ran";
  outcome: Outcome;
  checkout: Checkout;
}

/**
 * What `runInSandbox` hands a run's request beside the checkout: the open
 * issues already discovered against the ticket its discoveries land on, to
 * spread into the request — absent, rather than empty, where there are none.
 */
type PriorDiscoveries = { discovered?: readonly DiscoveredTicketSummary[] };

/**
 * The one step an implementation run and a review share: make the throwaway
 * clone, run the sandbox, and record what it cost against the project —
 * before either kind goes on to read what its own outcome came back as.
 *
 * The checkout comes from the repo host rather than from anything the loop
 * remembers, so a project whose clone has gone missing heals on the way into
 * the run instead of failing the morning.
 *
 * The ways a run ends badly are told apart by where they surface: the sandbox
 * port rejects only when it could not set itself up or start the agent, and
 * reports everything past that point as a result — an agent that gave up
 * carries the `"gave-up"` variant, and a sandbox that failed once the agent
 * had already run carries `"sandbox-failed"`, still spending what `outcome`
 * carries below.
 *
 * Narrates the container it starts, naming `spendCeiling`, and the run it
 * ends, naming what `outcome` spent — the two announcements every kind of
 * run shares, whatever it goes on to make of its own result.
 *
 * Records the run on the invocation's own journal entry the moment
 * `sandboxCall` reports its transcript directory — CONTEXT.md's "Run in
 * progress", what `status` names — and clears it, in a `finally`, once
 * `sandboxCall` settles, whatever it came to: a run that never got as far as
 * recording itself clears as a no-op, per `InvocationState.recordRunEnded`.
 * Recording and clearing each log their own failure rather than raising it,
 * so a journal write this loop does not otherwise depend on can never take
 * the process down or change what the run itself comes to.
 *
 * Opens the ticket's own run span at the same moment, and closes it in the
 * same `finally` — CONTEXT.md's "Run span" — durable where the journal
 * entry above is not: a review or an apply-review run started days after
 * this one ended can still read when it began.
 */
async function runInSandbox<Outcome extends { tokensUsed: TokenCount }>(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: Ticket,
  spendCeiling: Usd,
  invocation: RunRecording,
  sandboxCall: (
    checkout: Checkout,
    onStarted: OnRunStarted,
    prior: PriorDiscoveries,
  ) => Promise<Outcome>,
): Promise<SandboxResult<Outcome> | Failed> {
  let checkout: Checkout;
  try {
    checkout = await ports.repoHost.clone(repo);
  } catch (error: unknown) {
    // The clone never happened, so no container was ever announced started
    // — there is nothing for `run-ended` to close out.
    return infrastructureFailure(error);
  }
  // Announced once the checkout is ready and the container is genuinely
  // about to start — before `sandboxCall`, never after.
  notify(ports.progress, {
    kind: "container-started",
    ticket,
    spendCeiling,
    checkout,
  });
  // Set only once `onStarted` actually fires, so the `finally` below can
  // tell a run that opened its own span apart from one that never reached
  // the sandbox — a clone or a checkout failure, say.
  let openedAt: Date | undefined;
  const onStarted = ({ transcriptDirectory }: RunStarted): void => {
    const startedAt = ports.clock.now();
    openedAt = startedAt;
    void invocation
      .recordRunStarted({
        kind: ticketKind(ticket),
        repo,
        number: ticket.number,
        startedAt,
        transcriptDirectory,
        ...(ticket.pullRequest !== undefined && {
          pullRequest: ticket.pullRequest.url,
        }),
      })
      .catch((error: unknown) => {
        console.warn(
          `Could not record the run started for ${repo} #${ticket.number}: ${errorMessage(error)}`,
        );
      });
    void invocation
      .recordRunSpanStarted({ repo, number: ticket.number }, startedAt)
      .catch((error: unknown) => {
        console.warn(
          `Could not record the run span started for ${repo} #${ticket.number}: ${errorMessage(error)}`,
        );
      });
  };
  try {
    let outcome: Outcome;
    try {
      const discovered = await priorDiscoveriesFor(ports.tracker, ticket);
      outcome = await sandboxCall(
        checkout,
        onStarted,
        discovered.length > 0 ? { discovered } : {},
      );
    } catch (error: unknown) {
      // Nothing comes back from a rejected run — no branch, no output, and no
      // token count — so there is nothing to record against the project, and no
      // branch to discard. The sandbox rejects only when it could not set
      // itself up or start the agent, before any of that existed to lose: a
      // failure once the agent has already run comes back as a result instead
      // (`RunOutcome`'s `"sandbox-failed"` case), carrying its spend, so it
      // reaches `recordRun` below like any other.
      //
      // The container this started was announced, so it is announced ended
      // too — with nothing spent, matching what actually came back — rather
      // than leaving a terminal adapter believing it is still running.
      notify(ports.progress, {
        kind: "run-ended",
        ticket,
        tokensUsed: tokenCount(0),
      });
      return infrastructureFailure(error);
    }
    notify(ports.progress, {
      kind: "run-ended",
      ticket,
      tokensUsed: outcome.tokensUsed,
    });

    invocation.recordRunCost(repo, {
      at: ports.clock.now(),
      tokensUsed: outcome.tokensUsed,
    });

    return { kind: "ran", outcome, checkout };
  } finally {
    // Cleared last, and never let to change what this run comes to: a
    // failed clear would otherwise replace the sandbox's own error, or skip
    // `recordRunCost` on the path that already returned successfully.
    await invocation.recordRunEnded(repo, ticket.number).catch((error: unknown) => {
      console.warn(
        `Could not clear the run in progress for ${repo} #${ticket.number}: ${errorMessage(error)}`,
      );
    });
    // Closed rather than cleared: unlike the run in progress above, the span
    // survives this run for good — see CONTEXT.md's "Run span". Skipped
    // when `onStarted` never fired, so a clone or a checkout failure that
    // never reached the sandbox never touches a span it did not open —
    // `openedAt` also lets `recordRunSpanEnded` itself refuse to close a
    // span some other run opened.
    if (openedAt !== undefined) {
      await invocation
        .recordRunSpanEnded({ repo, number: ticket.number }, openedAt, ports.clock.now())
        .catch((error: unknown) => {
          console.warn(
            `Could not close the run span for ${repo} #${ticket.number}: ${errorMessage(error)}`,
          );
        });
    }
  }
}

/** A checkout or a sandbox that could not do its part, as the iteration it comes to. */
function infrastructureFailure(error: unknown): Failed {
  return {
    kind: "failed",
    failure: { kind: "infrastructure", reason: errorMessage(error) },
  };
}

/**
 * An implementation run: works `selection`'s ticket in the sandbox, held to
 * `spendCeiling` and started on `model` — or, given none, on whatever model
 * the sandbox image itself is pinned to, which can never come back refused.
 *
 * `salvageBranch`, when the ticket carries a salvage record, is passed
 * through to the request unchanged — the sandbox resumes the run on it
 * rather than a fresh branch, per CONTEXT.md's "Salvage".
 */
async function attemptRun(
  ports: MorningLoopPorts,
  selection: Selection,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
  salvageBranch: Branch | undefined,
): Promise<SandboxResult<RunOutcome> | Failed> {
  const { ticket } = selection;
  const repo = selection.project.repo;

  return runInSandbox(ports, repo, ticket, spendCeiling, invocation, (checkout, onStarted, prior) =>
    // Built as two distinct calls rather than one call with `model` spread in
    // conditionally: `Sandbox.run` is overloaded on whether `model` is
    // present precisely so that a run given none can never come back with a
    // model refusal, and only a call whose own argument is plainly one shape
    // or the other resolves to the right overload.
    model === undefined
      ? ports.sandbox.run(
          {
            ticket,
            checkout,
            spendCeiling,
            ...prior,
            ...(salvageBranch !== undefined && { salvageBranch }),
          },
          onStarted,
        )
      : ports.sandbox.run(
          {
            ticket,
            checkout,
            spendCeiling,
            model: model.name,
            ...prior,
            ...(salvageBranch !== undefined && { salvageBranch }),
          },
          onStarted,
        ),
  );
}

/**
 * Checked before anything else a pull request ticket's iteration would
 * otherwise do: whether `ticket`'s own pull request is already merged or
 * closed, and if so, closes it with `close` and returns the outcome.
 * `close` is the ticket kind's own close call — `closeReviewTicket`,
 * `closeApplyReviewTicket` or `closeRebaseTicket` — already bound to
 * `ticket`, since each answers to its own port method.
 *
 * Undefined when the pull request is still open, which every ticket's
 * iteration then handles as it always has. A repo host that could not answer
 * is an infrastructure failure, read the same way here as anywhere else a
 * run never got to start; a close that then fails is reported on the
 * iteration instead, the ticket left open — still ready-for-agent, due to
 * come round again.
 */
async function resolvedPullRequestOutcome(
  ports: MorningLoopPorts,
  ticket: PullRequestTicket,
  close: (comment: string) => Promise<void>,
): Promise<PullRequestResolved | Failed | undefined> {
  let state: PullRequestState;
  try {
    state = await ports.repoHost.pullRequestState(ticket.pullRequest.url);
  } catch (error: unknown) {
    return infrastructureFailure(error);
  }
  if (state === "open") {
    return undefined;
  }
  try {
    await close(pullRequestResolvedComment(ticket.pullRequest.url, state));
    return { kind: "pull-request-resolved", resolution: state };
  } catch (error: unknown) {
    return {
      kind: "pull-request-resolved",
      resolution: state,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
  }
}

/**
 * Labels `pullRequest` with `label`, once its ticket has already closed. The
 * fields returned fold straight into `Reviewed` or `AppliedReview`: empty on
 * success, `notLabelled` naming the error otherwise.
 *
 * Never throws: a refused label is reported rather than raised, since it is
 * the last step and the ticket closing is what matters. `summary.ts` renders
 * `notLabelled` to the developer.
 */
async function labelClosedPullRequest(
  ports: MorningLoopPorts,
  pullRequest: PullRequestUrl,
  label: PullRequestLabel,
): Promise<{ notLabelled?: NotLabelled }> {
  try {
    await ports.repoHost.labelPullRequest(pullRequest, label);
    return {};
  } catch (error: unknown) {
    return { notLabelled: { error: errorMessage(error) } };
  }
}

/**
 * Posts `APPLY_REVIEW_COMMENT` on `pullRequest`, once a turbo project's
 * review ticket has already closed — CONTEXT.md's "Turbo", ADR 0006. The
 * fields returned fold straight into `Reviewed`: empty on success,
 * `notCommented` naming the error otherwise.
 *
 * Never throws, same as `labelClosedPullRequest`: best effort, tried whether
 * or not the label itself landed, since the ticket having closed is what
 * matters. `summary.ts` renders `notCommented` to the developer.
 */
async function postTurboComment(
  ports: MorningLoopPorts,
  pullRequest: PullRequestUrl,
): Promise<{ notCommented?: NotCommented }> {
  try {
    await ports.repoHost.postComment(pullRequest, APPLY_REVIEW_COMMENT);
    return {};
  } catch (error: unknown) {
    return { notCommented: { error: errorMessage(error) } };
  }
}

/**
 * Marks `pullRequest` ready for review, once a clean review's ticket has
 * already closed — CONTEXT.md's "Clean review". The fields returned fold
 * straight into `Reviewed`: empty on success, `notReadied` naming the error
 * otherwise.
 *
 * Never throws, same as `labelClosedPullRequest`: best effort, since the
 * ticket having closed is what matters. `summary.ts` renders `notReadied` to
 * the developer.
 */
async function markCleanReviewReady(
  ports: MorningLoopPorts,
  pullRequest: PullRequestUrl,
): Promise<{ notReadied?: NotReadied }> {
  try {
    await ports.repoHost.markPullRequestReady(pullRequest);
    return {};
  } catch (error: unknown) {
    return { notReadied: { error: errorMessage(error) } };
  }
}

/**
 * A review ticket's own run: the reviewer examines the pull request the
 * ticket names and posts its findings, or a clean review with none —
 * CONTEXT.md's "Clean review" — there itself, in a container with no write
 * access to its clone. The loop's only remaining part is closing the ticket
 * once that finished, then labelling its pull request `reviewed`, and either
 * marking it ready for review, for a clean review, or, for a turbo project
 * (CONTEXT.md's "Turbo", ADR 0006), posting `/apply-review` on it as the
 * developer would have typed — a review that posted needs nobody to close
 * it, mark it ready, or act on it, by hand.
 *
 * Closing rests on the pull request actually carrying a posted review, not on
 * the sandbox process merely exiting clean: an agent can run the review skill
 * fine and still fail its own last step, submitting the review, and a ticket
 * closed on process success alone would tell the developer a review happened
 * when nothing was ever posted. Either way nothing did — an agent that gave
 * up, or a clean exit that posted nothing — the ticket is handed back, as an
 * implementation ticket's is. A review posted with no finding on it is not
 * this: it is a clean review, which closes the ticket exactly as one with
 * findings does.
 *
 * A pull request already merged or closed by the time the iteration starts is
 * checked for first, before any of that: there is nothing left to review, so
 * the ticket is closed with a comment naming which, and no run starts.
 *
 * A checkout or a sandbox that could not do its part is an infrastructure
 * failure here exactly as for an implementation run: reported, the ticket left
 * as it was, and the invocation carries on. A check, a close, a label, a
 * ready-mark or a turbo comment that fails after the review ran is reported
 * on the iteration, never raised — the ready-mark and the turbo comment are
 * each tried whether or not the label landed, since it is the ticket having
 * closed that matters, but neither is ever tried when closing itself failed.
 *
 * On a turbo project, a clean review runs the same merge gate an apply-review
 * ticket's own finish does, once, right after its ticket has closed —
 * `CONTEXT.md`'s "Turboable", ADR 0009: same turboable-timeline check against
 * its implementation ticket, same mergeable-and-green checks, same
 * merge-or-`ready-for-human` outcome. A review with findings never gets
 * it directly: turbo posts `/apply-review` instead, and the gate fires after
 * that ticket's own finish.
 */
async function runReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: ReviewTicket,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
  turbo: boolean,
): Promise<
  | Reviewed
  | LimitRefused
  | ProviderFailed
  | BudgetExhausted
  | Failed
  | PullRequestResolved
  | DiscoveryBlocked
> {
  const resolved = await resolvedPullRequestOutcome(ports, ticket, (comment) =>
    ports.tracker.closeReviewTicket(ticket, comment),
  );
  if (resolved !== undefined) {
    return resolved;
  }

  // Used only if the review turns out clean; a review with findings never
  // reads it, but the lookup runs all the same, the same waste
  // `runApplyReview` already accepts for the identical reason.
  const mergeGateContext = await mergeGateContextFor(ports, ticket, invocation, turbo);

  const startedAt = ports.clock.now();
  const result = await runInSandbox(ports, repo, ticket, spendCeiling, invocation, (checkout, onStarted, prior) =>
    // As `attemptRun`: two distinct calls so each resolves the `Sandbox.review`
    // overload that actually matches, rather than one call TypeScript could
    // not resolve to either.
    model === undefined
      ? ports.sandbox.review({ ticket, checkout, spendCeiling, ...prior }, onStarted)
      : ports.sandbox.review(
          { ticket, checkout, spendCeiling, model: model.name, ...prior },
          onStarted,
        ),
  );
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: review } = result;

  if (review.kind === "limit-refused" || review.kind === "provider-failed") {
    return routeCutOffDiscoveriesOrBlock(ports, ticket, review, cutOffReviewOutcome);
  }
  if (review.kind === "budget-exhausted") {
    return budgetExhaustedReviewOutcome(review);
  }
  // Handed back rather than left to come round again, as an implementation
  // ticket's is: every later morning would refuse the same model the same way.
  if (review.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, review.refusal, review.tokensUsed, review.transcript);
  }

  // Routed before either of the run's own endings is decided: a blocking
  // discovery replaces both the gave-up and the found-nothing-posted path
  // below, per CONTEXT.md's "Discovery" and "Hand back".
  const routing = await routeOrBlock(ports, ticket, review);
  if ("blocked" in routing) {
    return routing.blocked;
  }
  const { routed } = routing;

  if (review.kind === "gave-up") {
    return withDiscoveries(await handReviewBack(ports, ticket, review, review.reason), routed);
  }

  let findings: boolean;
  let clean: boolean;
  try {
    findings = await ports.repoHost.hasReviewFindings(
      ticket.pullRequest.url,
      startedAt,
    );
    // A clean review — CONTEXT.md's "Clean review" — is only worth asking
    // about once findings themselves come up empty: a finding is itself
    // proof a review was posted, and asking again would be a second `gh`
    // round trip for an answer already known.
    clean = !findings &&
      (await ports.repoHost.hasPostedReview(ticket.pullRequest.url, startedAt));
  } catch (error: unknown) {
    const checkFailed: Reviewed = {
      kind: "reviewed",
      review,
      tokensUsed: review.tokensUsed,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
    return withDiscoveries(checkFailed, routed);
  }
  if (!findings && !clean) {
    return withDiscoveries(
      await handReviewBack(
        ports,
        ticket,
        review,
        `the agent ran but posted nothing to ${ticket.pullRequest.url}`,
      ),
      routed,
    );
  }

  try {
    await ports.tracker.closeReviewTicket(ticket);
  } catch (error: unknown) {
    const closeFailed: Reviewed = {
      kind: "reviewed",
      review,
      tokensUsed: review.tokensUsed,
      clean,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
    return withDiscoveries(closeFailed, routed);
  }
  const labelled = await labelClosedPullRequest(
    ports,
    ticket.pullRequest.url,
    REVIEWED_LABEL,
  );
  // A clean review has nothing on it for the developer to apply, turbo or
  // not — CONTEXT.md's "Clean review" — so it is marked ready for review
  // instead of getting `APPLY_REVIEW_COMMENT`.
  const readied = clean
    ? await markCleanReviewReady(ports, ticket.pullRequest.url)
    : {};
  const commented = turbo && !clean
    ? await postTurboComment(ports, ticket.pullRequest.url)
    : {};
  // A clean review is the other place, besides an apply-review ticket's own
  // finish, the merge gate ever fires — CONTEXT.md's "Turboable", ADR 0009.
  // A review with findings reaches turbo's own comment above instead, and
  // gets the gate only once its apply-review ticket later finishes. Never
  // asked when the ready-mark itself failed: the ticket has already closed
  // by then, so nothing will come back to run the gate later, and the pull
  // request is left a draft, without `ready-for-human` — `notReadied`'s own
  // note is what tells the developer to mark it ready and take it from
  // there by hand.
  const merge = mergeGateContext !== undefined && clean && readied.notReadied === undefined
    ? await mergeGate(ports, ticket, mergeGateContext)
    : undefined;
  const reviewed: Reviewed = {
    kind: "reviewed",
    review,
    tokensUsed: review.tokensUsed,
    clean,
    ...labelled,
    ...readied,
    ...commented,
    ...(merge !== undefined && { merge }),
  };
  return withDiscoveries(reviewed, routed);
}

/**
 * Hands back a review that left no findings on its pull request, or a spec
 * review that gave up, as an agent that gave up. Shared by both: neither has
 * anywhere else its findings could have gone.
 */
async function handReviewBack(
  ports: MorningLoopPorts,
  ticket: ReviewTicket | SpecReviewTicket | UxReviewTicket,
  review: ReviewFinished | ReviewGaveUp,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason };
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ticketKind: ticketKind(ticket),
    output: review.output,
    ...transcriptField(review.transcript),
  });
  return {
    kind: "failed",
    tokensUsed: review.tokensUsed,
    ...(review.transcript !== undefined && { transcript: review.transcript }),
    failure,
    handedBack,
  };
}

/**
 * A spec review ticket's own run: the agent reviews the whole repository
 * against the supertask it names, and reports what it found. There is no
 * pull request to post that report to, so the loop's only remaining part is
 * handing the ticket back with the report as its own comment — always,
 * whether the run finished or gave up, since a spec review never closes its
 * ticket the way a review, apply-review or rebase ticket's own success does:
 * per CONTEXT.md's "Spec review ticket", it ends in hand-back like every
 * other kind.
 *
 * Unlike `runReview`, there is no pull request to check already resolved, and
 * no posted-findings check to make: the run's own output is the whole of its
 * findings, whatever it is. Its discoveries are routed exactly as a review's
 * are, per CONTEXT.md's "Discovery" — against the supertask this ticket
 * reviews rather than against the ticket itself — and a correction or a
 * prerequisite among them hands the ticket back discovery-blocked rather
 * than as a finished spec review, the same way a blocking discovery replaces
 * a review's own success.
 *
 * A checkout or a sandbox that could not do its part is an infrastructure
 * failure here exactly as for an implementation run: reported, the ticket
 * left as it was, and the invocation carries on.
 */
async function runSpecReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: SpecReviewTicket,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<ReportedReviewEnding> {
  const result = await runInSandbox(ports, repo, ticket, spendCeiling, invocation, (checkout, onStarted, prior) =>
    // As `attemptRun`: two distinct calls so each resolves the
    // `Sandbox.specReview` overload that actually matches.
    model === undefined
      ? ports.sandbox.specReview({ ticket, checkout, spendCeiling, ...prior }, onStarted)
      : ports.sandbox.specReview(
          { ticket, checkout, spendCeiling, model: model.name, ...prior },
          onStarted,
        ),
  );
  return endReportedReview(ports, ticket, result);
}

/**
 * A ux review ticket's own run, ended as a spec review's is: the agent drives
 * the project's app in a browser and reports what it found, and the loop
 * hands the ticket back with that report as its comment — see
 * `runSpecReview`, whose ending it shares, and CONTEXT.md's "UX review
 * ticket". Its discoveries are routed against the ticket itself, as an
 * implementation ticket's are: it names no supertask to file them on.
 */
async function runUxReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: UxReviewTicket,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<ReportedReviewEnding> {
  const result = await runInSandbox(ports, repo, ticket, spendCeiling, invocation, (checkout, onStarted, prior) =>
    // As `attemptRun`: two distinct calls so each resolves the
    // `Sandbox.uxReview` overload that actually matches.
    model === undefined
      ? ports.sandbox.uxReview({ ticket, checkout, spendCeiling, ...prior }, onStarted)
      : ports.sandbox.uxReview(
          { ticket, checkout, spendCeiling, model: model.name, ...prior },
          onStarted,
        ),
  );
  return endReportedReview(ports, ticket, result);
}

/** What a spec review or ux review iteration can end as. */
type ReportedReviewEnding =
  | SpecReviewed
  | UxReviewed
  | LimitRefused
  | ProviderFailed
  | BudgetExhausted
  | Failed
  | DiscoveryBlocked;

/**
 * Everything `runSpecReview` and `runUxReview` share once the sandbox has
 * answered: refusals and cut-offs as a review's are, a blocking discovery
 * replacing the ending, and otherwise the hand-back — always, finished or
 * gave up — with the run's own report as the ticket's comment.
 */
async function endReportedReview(
  ports: MorningLoopPorts,
  ticket: SpecReviewTicket | UxReviewTicket,
  result: SandboxResult<ReviewOutcome> | Failed,
): Promise<ReportedReviewEnding> {
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: review } = result;

  if (review.kind === "limit-refused" || review.kind === "provider-failed") {
    return routeCutOffDiscoveriesOrBlock(ports, ticket, review, cutOffReviewOutcome);
  }
  if (review.kind === "budget-exhausted") {
    return budgetExhaustedReviewOutcome(review);
  }
  // Handed back rather than left to come round again, as a review's is: every
  // later morning would refuse the same model the same way.
  if (review.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, review.refusal, review.tokensUsed, review.transcript);
  }

  // Routed before either of the run's own endings is decided: a blocking
  // discovery replaces both the gave-up and the finished path below, per
  // CONTEXT.md's "Discovery" and "Hand back". `review.output` is passed
  // through so a blocking discovery does not throw the rest of the report
  // away: a spec review has nowhere else to post it.
  const routing = await routeOrBlock(ports, ticket, review, { output: review.output });
  if ("blocked" in routing) {
    return routing.blocked;
  }
  const { routed } = routing;

  if (review.kind === "gave-up") {
    return withDiscoveries(await handReviewBack(ports, ticket, review, review.reason), routed);
  }

  const finished = {
    output: review.output,
    ...transcriptField(review.transcript),
  };
  const reported = {
    review,
    tokensUsed: review.tokensUsed,
  };
  if (isUxReviewTicket(ticket)) {
    const handedBack = await handBack(ports, ticket, { kind: "ux-review-finished", ...finished });
    const uxReviewed: UxReviewed = { kind: "ux-reviewed", ...reported, handedBack };
    return withDiscoveries(uxReviewed, routed);
  }
  const handedBack = await handBack(ports, ticket, { kind: "spec-review-finished", ...finished });
  const specReviewed: SpecReviewed = { kind: "spec-reviewed", ...reported, handedBack };
  return withDiscoveries(specReviewed, routed);
}

/**
 * An apply-review ticket's own run: the agent answers every open thread on the
 * pull request the ticket names, pushing and replying itself from a clone on
 * that pull request's branch. What it did is read back from the repo host,
 * never taken from the agent's say-so: the ticket closes, and the pull request
 * is marked ready for review, only once no thread is left unanswered.
 *
 * A pull request with no open thread when the iteration starts has nothing to
 * apply, so no run is started: the ticket closes and the pull request is
 * marked ready all the same. The pull request is marked ready before the
 * ticket closes, so a ticket left open by a pull request that would not be
 * marked comes round again and finds nothing to apply.
 *
 * An agent that gave up — a push the repo host rejected included — or a run
 * that left a thread unanswered is handed back, the pull request left a
 * draft. A repo host or sandbox that could not do its part before the agent
 * started is an infrastructure failure, and a limit or model refusal reads as
 * for a review. A read, mark, close or label that fails after the run is
 * reported on the iteration, never raised.
 *
 * A pull request already merged or closed by the time the iteration starts is
 * checked for before any of that: its branch is commonly gone with it, which
 * is what made a run started on one fail checkout every time. The ticket is
 * closed with a comment naming which, and no run starts.
 *
 * On a turbo project, a ticket that closes runs one more check, the merge
 * gate: per `CONTEXT.md`'s "Turboable" and ADR 0009: whether its implementation
 * ticket carried `turboable` before that ticket's own run started, and, only
 * then, whether the pull request is mergeable and green. See
 * `finishApplyReview`.
 */

/**
 * What `finishApplyReview` and `runReview` need to run the merge gate, built
 * once by their own callers before the ticket closes: `implementation`,
 * resolved while it was still open, and `invocation`, read for its run spans
 * and grant records.
 * Absent on a project that is not turbo — the merge gate never asks there.
 */
interface MergeGateContext {
  implementation: Ticket | undefined;
  invocation: Pick<RunRecording, "runSpans" | "grants" | "consumeGrant">;
}

/**
 * Builds `MergeGateContext` for `ticket`, resolved here, before the ticket
 * itself is ever closed: `listOpenIssues` only ever reports an open issue,
 * and `ticket` is exactly that until the caller closes it. Shared by
 * `runApplyReview` and `runReview`, which each build it the same way right
 * before their own close. Skipped outright on a project that is not turbo,
 * per `mergeGate`'s own doc — the merge gate never asks there.
 *
 * The lookup is caught rather than left to raise: it exists only to feed a
 * gate that fires after this run, so a transient tracker failure here must
 * not sink the run itself — it reads the same as an implementation ticket
 * the lookup found none for, and `mergeGate` reports it as such.
 */
async function mergeGateContextFor(
  ports: MorningLoopPorts,
  ticket: PullRequestTicket,
  invocation: RunRecording,
  turbo: boolean,
): Promise<MergeGateContext | undefined> {
  return turbo
    ? {
        implementation: await implementationTicketFor(ports.tracker, ticket).catch(
          () => undefined,
        ),
        invocation,
      }
    : undefined;
}

async function runApplyReview(
  ports: MorningLoopPorts,
  project: RegisteredProject,
  ticket: ApplyReviewTicket,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<
  | AppliedReview
  | LimitRefused
  | ProviderFailed
  | BudgetExhausted
  | Failed
  | PullRequestResolved
  | DiscoveryBlocked
> {
  const { repo, turbo, manager } = project;
  const pullRequest = ticket.pullRequest.url;

  const resolved = await resolvedPullRequestOutcome(ports, ticket, (comment) =>
    ports.tracker.closeApplyReviewTicket(ticket, comment),
  );
  if (resolved !== undefined) {
    return resolved;
  }

  const mergeGateContext = await mergeGateContextFor(ports, ticket, invocation, turbo);

  const startedAt = ports.clock.now();
  let before: ApplyReviewAnswers;
  try {
    before = await ports.repoHost.readApplyReviewAnswers(
      pullRequest,
      startedAt,
    );
  } catch (error: unknown) {
    return infrastructureFailure(error);
  }
  if (before.unanswered === 0) {
    // No sandbox runs on this branch, so there is no fresh `routed` to read a
    // `Blocked on:` off — including on a retry right after `finishApplyReview`
    // itself failed to demote one. `implementation.openBlockers` (`isBlocked`)
    // reports the same fact independently of this call: it still counts the
    // edge an earlier pass's `blockOnIfOpen` added, for as long as the
    // blocker stays open.
    const implementation = await implementationTicketFor(ports.tracker, ticket).catch(
      () => undefined,
    );
    return finishApplyReview(
      ports,
      ticket,
      { kind: "applied-review" },
      mergeGateContext,
      implementation !== undefined && isBlocked(implementation) ? implementation : undefined,
    );
  }

  const result = await runInSandbox(ports, repo, ticket, spendCeiling, invocation, (checkout, onStarted, prior) =>
    // As `attemptRun`: two distinct calls so each resolves the overload that
    // actually matches.
    model === undefined
      ? ports.sandbox.applyReview(
          { ticket, checkout, spendCeiling, ...prior, ...(manager !== undefined && { manager }) },
          onStarted,
        )
      : ports.sandbox.applyReview(
          {
            ticket,
            checkout,
            spendCeiling,
            model: model.name,
            ...prior,
            ...(manager !== undefined && { manager }),
          },
          onStarted,
        ),
  );
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: run } = result;

  if (run.kind === "limit-refused" || run.kind === "provider-failed") {
    return routeCutOffDiscoveriesOrBlock(ports, ticket, run, cutOffReviewOutcome);
  }
  if (run.kind === "budget-exhausted") {
    return budgetExhaustedReviewOutcome(run);
  }
  if (run.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, run.refusal, run.tokensUsed, run.transcript);
  }

  // Routed before either of the run's own endings is decided: a blocking
  // discovery replaces both the gave-up and the thread-left-unanswered path
  // below, per CONTEXT.md's "Discovery" and "Hand back".
  const routing = await routeOrBlock(ports, ticket, run);
  if ("blocked" in routing) {
    return routing.blocked;
  }
  const { routed } = routing;

  if (run.kind === "gave-up") {
    return withDiscoveries(await handApplyReviewBack(ports, ticket, run, run.reason), routed);
  }
  if (run.kind === "uniform-files-reverted") {
    return withDiscoveries(
      await handPushUniformFilesBack(ports, ticket, "apply-review", run),
      routed,
    );
  }

  let answers: ApplyReviewAnswers;
  try {
    answers = await ports.repoHost.readApplyReviewAnswers(
      pullRequest,
      startedAt,
    );
  } catch (error: unknown) {
    const checkFailed: AppliedReview = {
      kind: "applied-review",
      review: run,
      tokensUsed: run.tokensUsed,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
    return withDiscoveries(checkFailed, routed);
  }
  if (answers.unanswered > 0) {
    const threads =
      answers.unanswered === 1 ? "1 thread" : `${answers.unanswered} threads`;
    return withDiscoveries(
      await handApplyReviewBack(
        ports,
        ticket,
        run,
        `the agent finished with ${threads} left unanswered on ${pullRequest}`,
      ),
      routed,
    );
  }

  const finished = await finishApplyReview(
    ports,
    ticket,
    {
      kind: "applied-review",
      review: run,
      tokensUsed: run.tokensUsed,
      answers: { applied: answers.appliedSince, declined: answers.declinedSince },
    },
    mergeGateContext,
    routed !== undefined && leavesBlockedOnExisting(routed) ? routed.target : undefined,
  );
  return withDiscoveries(finished, routed);
}

/**
 * Marks `ticket`'s pull request ready for review, closes the ticket with a
 * comment saying what `applied` came to, then labels the pull request
 * `applied-review`. Never throws: a failure marking it ready or closing the
 * ticket is reported on the iteration and leaves the ticket open; a refused
 * label is reported too, but by then the ticket has already closed.
 *
 * `stillBlocked`, when given, is the implementation ticket a `Blocked on:` the
 * run left still open belongs to (per CONTEXT.md's "Discovery"): the pull
 * request's own closing reference for it is demoted from `Closes #N.` to
 * `Part of #N.` first, so merging it does not close a ticket whose criterion
 * behind the blocker is still unmet. A failure demoting it is reported the
 * same way a failure marking the pull request ready is, and for the same
 * reason: the ticket must not close on the strength of a stale reference this
 * call could not rewrite.
 *
 * On a turbo project, once the ticket has closed, this also runs the merge
 * gate (`mergeGate`) — `mergeGateContext.implementation` read by the caller
 * before the ticket closed — and folds its own verdict in as `merge` — never
 * when closing itself failed, the same as the label above. The merge gate is
 * unaffected by `stillBlocked`: a pull request it merges no longer closes the
 * ticket either, per the demotion above, so merging it is still the right
 * outcome.
 */
async function finishApplyReview(
  ports: MorningLoopPorts,
  ticket: ApplyReviewTicket,
  applied: AppliedReview,
  mergeGateContext: MergeGateContext | undefined,
  stillBlocked?: Ticket,
): Promise<AppliedReview> {
  const pullRequest = ticket.pullRequest.url;
  if (stillBlocked !== undefined) {
    try {
      await ports.repoHost.demoteClosingReference(pullRequest, stillBlocked);
    } catch (error: unknown) {
      return {
        ...applied,
        notClosed: { kind: "demote-failed", error: errorMessage(error), ticket: stillBlocked },
      };
    }
  }
  try {
    await ports.repoHost.markPullRequestReady(pullRequest);
  } catch (error: unknown) {
    return {
      ...applied,
      notClosed: { kind: "ready-failed", error: errorMessage(error) },
    };
  }
  try {
    await ports.tracker.closeApplyReviewTicket(
      ticket,
      appliedReviewComment(pullRequest, applied.answers, stillBlocked),
    );
  } catch (error: unknown) {
    return {
      ...applied,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
  }
  const labelled = await labelClosedPullRequest(
    ports,
    pullRequest,
    APPLIED_REVIEW_LABEL,
  );
  const closed: AppliedReview = {
    ...applied,
    ...labelled,
    ...(stillBlocked !== undefined && { demoted: stillBlocked }),
  };
  if (mergeGateContext === undefined) {
    return closed;
  }
  const merge = await mergeGate(ports, ticket, mergeGateContext);
  return { ...closed, merge };
}

/**
 * The merge gate: whether `context.implementation` — `ticket`'s own
 * implementation ticket, resolved by the caller while it was still open —
 * carried `turboable` before its own run started — `CONTEXT.md`'s
 * "Turboable", ADR 0009 — and, only then, whether the pull request's own
 * checks read green — waiting out a pending read, up to `CHECKS_WAIT` —
 * attempting the merge itself to settle mergeable. Fires once, right after
 * the one apply-review run, or the one clean review, already in the loop: no
 * retry beyond that wait, no `/rebase`, whatever it finds. Never throws:
 * every read this makes past `implementation` and `span` is guarded, so a
 * tracker or repo host failure comes back as a verdict rather than sinking a
 * ticket that has already closed.
 *
 * `context.implementation` absent, or carrying no run span, reads the same
 * as never labelled `turboable`: none of the three is a grant the gate
 * rejected, so the verdict's own `declinedGrant` reads `false` for all
 * three, and `CONTEXT.md`'s "Turboable" already documents the first two as
 * known gaps.
 */
async function mergeGate(
  ports: MorningLoopPorts,
  ticket: PullRequestTicket,
  context: MergeGateContext,
): Promise<MergeGate> {
  // Read before the verdict and used up after it, whatever it is: a record
  // vouches for one firing of the gate (ADR 0012).
  const grants = await context.invocation.grants().catch(() => []);
  const verdict = await decideMerge(ports, ticket, context, grants);
  const { implementation } = context;
  if (implementation !== undefined) {
    await context.invocation.consumeGrant(implementation).catch((error: unknown) => {
      console.warn(
        `Could not use up the grant record for ${ticketReference(implementation)}: ${errorMessage(error)}`,
      );
    });
  }
  return verdict;
}

async function decideMerge(
  ports: MorningLoopPorts,
  ticket: PullRequestTicket,
  context: MergeGateContext,
  grants: readonly GrantRecord[],
): Promise<MergeGate> {
  const { implementation } = context;
  if (implementation === undefined) {
    return {
      kind: "not-turboable",
      reason: "could not find its implementation ticket",
      declinedGrant: false,
    };
  }
  const span = runSpanFor(context.invocation.runSpans(), implementation);
  if (span === undefined) {
    return {
      kind: "not-turboable",
      reason: "its implementation ticket carries no run span",
      declinedGrant: false,
    };
  }
  let consent: TurboableConsent;
  try {
    consent = await ports.tracker.wasTurboableAt(
      implementation,
      span.startedAt,
      context.invocation.runSpans(),
      grants,
    );
  } catch (error: unknown) {
    return { kind: "timeline-unreadable", error: errorMessage(error) };
  }
  if (!consent.consented) {
    if (consent.reason === "never-labeled") {
      return { kind: "not-turboable", reason: "never labelled turboable", declinedGrant: false };
    }
    const reason =
      consent.reason === "not-labeled-in-time"
        ? "not turboable before its own run started"
        : "turboable granted inside a run span";
    return { kind: "not-turboable", reason, declinedGrant: true };
  }

  const pullRequest = ticket.pullRequest.url;
  let checks: ChecksStatus;
  try {
    checks = await settledChecks(ports.repoHost, ports.clock, pullRequest);
  } catch (error: unknown) {
    return leftForHuman(ports, pullRequest, errorMessage(error));
  }
  if (checks !== "green") {
    return leftForHuman(
      ports,
      pullRequest,
      checks === "pending" ? "checks still running" : "checks failing",
    );
  }
  try {
    await ports.repoHost.mergePullRequest(pullRequest);
    return { kind: "merged", implementationTicket: implementation };
  } catch (error: unknown) {
    return leftForHuman(ports, pullRequest, errorMessage(error));
  }
}

/**
 * `pullRequest` left for the developer: labelled
 * `READY_FOR_HUMAN_PULL_REQUEST_LABEL`, `reason` carried along for the
 * summary. As `labelClosedPullRequest`: a refused label is reported on the
 * outcome, never raised.
 */
async function leftForHuman(
  ports: MorningLoopPorts,
  pullRequest: PullRequestUrl,
  reason: string,
): Promise<MergeGate> {
  const labelled = await labelClosedPullRequest(
    ports,
    pullRequest,
    READY_FOR_HUMAN_PULL_REQUEST_LABEL,
  );
  return { kind: "left-for-human", reason, ...labelled };
}

/**
 * `ticket`'s own implementation ticket: `tracker.listOpenIssues`'s own parent
 * lookup (`parentTicketIn`) — the same one `discoveryTargetFor` in
 * `discovery-routing.ts` does for a pull request ticket's discoveries.
 * `undefined` where either read misses: a truncated backlog, most likely,
 * since the implementation ticket stays open, relabelled `ready-for-human`,
 * once its own run hands off.
 */
async function implementationTicketFor(
  tracker: Pick<IssueTracker, "listOpenIssues">,
  ticket: PullRequestTicket,
): Promise<Ticket | undefined> {
  const open = await tracker.listOpenIssues(ticket.repo);
  return parentTicketIn(open, ticket);
}

/** Hands back an apply-review run that gave up or left a thread unanswered. */
async function handApplyReviewBack(
  ports: MorningLoopPorts,
  ticket: ApplyReviewTicket,
  run: ReviewFinished | ApplyReviewGaveUp,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason };
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ticketKind: "apply-review",
    output: run.output,
    pullRequest: ticket.pullRequest.url,
    ...(run.kind === "gave-up" && run.movedHead !== undefined && { movedHead: run.movedHead }),
    ...transcriptField(run.transcript),
  });
  return {
    kind: "failed",
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
}

/**
 * Hands back an apply-review or rebase run whose push touched a uniform
 * file: the sandbox has already tried forcing it back
 * (`container-sandbox.ts`'s `revertPushIfUniformFilesTouched`), so there is
 * no branch here to discard — only the ticket to hand back, naming which
 * files, and, when the force-back itself failed, why.
 */
async function handPushUniformFilesBack(
  ports: MorningLoopPorts,
  ticket: ApplyReviewTicket | RebaseTicket,
  ticketKind: "apply-review" | "rebase",
  run: UniformFilesReverted,
): Promise<Failed> {
  const failure: UniformFilesTouched = { kind: "uniform-files-touched", files: run.files };
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ticketKind,
    pullRequest: ticket.pullRequest.url,
    ...(run.notReverted !== undefined && { notReverted: run.notReverted }),
    ...transcriptField(run.transcript),
  });
  return {
    kind: "failed",
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
}

/**
 * A rebase ticket's own run: the agent replays the pull request the ticket
 * names onto its base branch and force-pushes it itself, from a clone on that
 * pull request's branch. Whether it worked is read back from the repo host,
 * never taken from the agent's say-so: the ticket closes, and `needs-rebase`
 * comes off the pull request, only once it no longer conflicts. Its draft
 * state is never touched — a rebase promotes nothing, and removing the label
 * is the whole signal that it no longer needs one.
 *
 * A pull request that needs no rebase when the iteration starts has nothing to
 * rebase, so no run is started: the ticket closes all the same.
 *
 * An agent that gave up — a force-push the repo host rejected included — or a
 * run that left the pull request still conflicting is handed back, and so,
 * with no run, is a pull request whose mergeability never settles once it is
 * confirmed still open. Either way `needs-rebase` is left on. A repo host or
 * sandbox that could not otherwise do its part before the agent started is an
 * infrastructure failure, and a limit or model refusal reads as for an
 * apply-review ticket. A read, label removal or close that fails after the
 * run is reported on the iteration, never raised.
 *
 * A pull request already merged or closed by the time the iteration starts is
 * checked for before any of that, ahead of even asking whether it needs a
 * rebase: it is commonly the reason mergeability would never have settled,
 * and its branch is commonly gone too. The ticket is closed with a comment
 * naming which, and no run starts.
 */
async function runRebase(
  ports: MorningLoopPorts,
  project: RegisteredProject,
  ticket: RebaseTicket,
  invocation: RunRecording,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<
  | Rebased
  | LimitRefused
  | ProviderFailed
  | BudgetExhausted
  | Failed
  | PullRequestResolved
  | DiscoveryBlocked
> {
  const { repo, manager } = project;
  const pullRequest = ticket.pullRequest.url;

  const resolved = await resolvedPullRequestOutcome(ports, ticket, (comment) =>
    ports.tracker.closeRebaseTicket(ticket, comment),
  );
  if (resolved !== undefined) {
    return resolved;
  }

  let needsRebase: boolean;
  try {
    needsRebase = await ports.repoHost.needsRebase(pullRequest);
  } catch (error: unknown) {
    if (error instanceof MergeabilityUnknown) {
      const reason = errorMessage(error);
      const failure: UnsettledMergeability = { kind: "unsettled-mergeability", reason };
      const handedBack = await handBack(ports, ticket, { ...failure, pullRequest });
      return { kind: "failed", failure, handedBack };
    }
    return infrastructureFailure(error);
  }
  if (!needsRebase) {
    return finishRebase(ports, ticket, { kind: "rebased" });
  }

  const result = await runInSandbox(ports, repo, ticket, spendCeiling, invocation, (checkout, onStarted, prior) =>
    // As `attemptRun`: two distinct calls so each resolves the overload that
    // actually matches.
    model === undefined
      ? ports.sandbox.rebase(
          { ticket, checkout, spendCeiling, ...prior, ...(manager !== undefined && { manager }) },
          onStarted,
        )
      : ports.sandbox.rebase(
          {
            ticket,
            checkout,
            spendCeiling,
            model: model.name,
            ...prior,
            ...(manager !== undefined && { manager }),
          },
          onStarted,
        ),
  );
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: run } = result;

  if (run.kind === "limit-refused" || run.kind === "provider-failed") {
    return routeCutOffDiscoveriesOrBlock(ports, ticket, run, cutOffReviewOutcome);
  }
  if (run.kind === "budget-exhausted") {
    return budgetExhaustedReviewOutcome(run);
  }
  if (run.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, run.refusal, run.tokensUsed, run.transcript);
  }

  // Routed before either of the run's own endings is decided: a blocking
  // discovery replaces both the gave-up and the still-conflicting path
  // below, per CONTEXT.md's "Discovery" and "Hand back".
  const routing = await routeOrBlock(ports, ticket, run);
  if ("blocked" in routing) {
    return routing.blocked;
  }
  const { routed } = routing;

  if (run.kind === "gave-up") {
    return withDiscoveries(await handRebaseBack(ports, ticket, run, run.reason), routed);
  }
  if (run.kind === "uniform-files-reverted") {
    return withDiscoveries(await handPushUniformFilesBack(ports, ticket, "rebase", run), routed);
  }

  try {
    needsRebase = await ports.repoHost.needsRebase(pullRequest);
  } catch (error: unknown) {
    const checkFailed: Rebased = {
      kind: "rebased",
      rebase: run,
      tokensUsed: run.tokensUsed,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
    return withDiscoveries(checkFailed, routed);
  }
  if (needsRebase) {
    return withDiscoveries(
      await handRebaseBack(
        ports,
        ticket,
        run,
        `the agent finished, but ${pullRequest} still conflicts with its base branch`,
      ),
      routed,
    );
  }

  const finished = await finishRebase(ports, ticket, {
    kind: "rebased",
    rebase: run,
    tokensUsed: run.tokensUsed,
  });
  return withDiscoveries(finished, routed);
}

/**
 * Takes `needs-rebase` off `ticket`'s pull request, then closes the ticket
 * with a comment saying what `rebased` came to. Never throws: whichever step
 * fails is reported on the iteration, and the ticket left open.
 *
 * The label comes off before the ticket closes, and closing is skipped if it
 * doesn't: a comment claiming the label is gone would be wrong if it were
 * posted first and the removal then failed.
 */
async function finishRebase(
  ports: MorningLoopPorts,
  ticket: RebaseTicket,
  rebased: Rebased,
): Promise<Rebased> {
  const pullRequest = ticket.pullRequest.url;
  try {
    await ports.repoHost.removeNeedsRebaseLabel(pullRequest);
  } catch (error: unknown) {
    return {
      ...rebased,
      notClosed: { kind: "label-failed", error: errorMessage(error) },
    };
  }
  try {
    await ports.tracker.closeRebaseTicket(
      ticket,
      rebasedComment(pullRequest, rebased),
    );
  } catch (error: unknown) {
    return {
      ...rebased,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
  }
  return rebased;
}

/**
 * Hands back a rebase ticket whose run gave up or left its pull request
 * conflicting.
 */
async function handRebaseBack(
  ports: MorningLoopPorts,
  ticket: RebaseTicket,
  run: RebaseFinished | RebaseGaveUp,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason };
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ticketKind: "rebase",
    output: run.output,
    pullRequest: ticket.pullRequest.url,
    ...(run.kind === "gave-up" && run.movedHead !== undefined && { movedHead: run.movedHead }),
    ...transcriptField(run.transcript),
  });
  return {
    kind: "failed",
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
}

