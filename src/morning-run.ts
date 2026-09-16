import type {
  ApplyReviewAnswers,
  ApplyReviewGaveUp,
  ApplyReviewTicket,
  Budget,
  Checkout,
  Clock,
  Day,
  IssueTracker,
  IterationLimit,
  ModelDefaults,
  ModelName,
  ModelRefusal,
  ProjectState,
  RebaseFinished,
  RebaseGaveUp,
  RebaseTicket,
  RepoHost,
  RepoSlug,
  ReviewFinished,
  ReviewGaveUp,
  ReviewTicket,
  RunCost,
  RunFinished,
  RunGaveUp,
  RunLimitRefused,
  RunModelRefused,
  RunOutcome,
  Sandbox,
  State,
  Store,
  Ticket,
  TokenCount,
  UsageLedger,
  Usd,
} from "./ports/index.ts";
import {
  MergeabilityUnknown,
  isApplyReviewTicket,
  isRebaseTicket,
  isReviewTicket,
  localDay,
  recordRun,
  ticketKind,
} from "./ports/index.ts";
import { budgetGate, type StandDown } from "./budget-gate.ts";
import {
  invocationSelection,
  type ProjectOutcome,
  type Selection,
} from "./selection.ts";
import { workedTickets } from "./worked-today.ts";
import {
  appliedReviewComment,
  applyReviewHandbackComment,
  committedNothingComment,
  handbackComment,
  handoverComment,
  handoverFailureComment,
  modelRefusalComment,
  rebaseHandbackComment,
  rebasedComment,
  reviewHandbackComment,
  unsettledMergeabilityComment,
  unusableModelLabelComment,
  type Discard,
} from "./handback-comment.ts";
import { errorMessage } from "./error-message.ts";
import {
  failedOnInfrastructure,
  handedBackForModelLabels,
  type AppliedReview,
  type Failed,
  type Finished,
  type GaveUp,
  type HandedBackFailure,
  type HandoverFailed,
  type HandoverReach,
  type Iteration,
  type IterationOutcome,
  type LimitRefused,
  type ModelRefused,
  type ModelSource,
  type Rebased,
  type Reviewed,
  type UnsettledMergeability,
  type UnusableModelLabel,
} from "./iteration-outcome.ts";
import {
  summaryBody,
  summaryLine,
  summaryTitle,
  type SummaryFacts,
} from "./summary.ts";

/**
 * The one write on the tracker that `ports/issue-tracker.ts` deliberately
 * leaves undeclared: publishing the invocation's summary issue. Declared
 * here, by the code that needs it, per that port's own note.
 *
 * Every other tracker method writes into a project's repo, named by a ticket
 * it is handed. This one names nothing, because it always lands in the
 * tracker's own repo rather than a project's — the manager reports on itself.
 */
export interface SummaryTracker {
  publishSummary(title: string, body: string): Promise<void>;
}

/** What the state document records of each project, by repo slug. */
type ProjectStates = State["projects"];

/**
 * The six outside-world dependencies of the loop. Everything it knows about
 * GitHub, containers, session logs, the filesystem and the wall clock arrives
 * through these.
 */
export interface MorningLoopPorts {
  tracker: IssueTracker & SummaryTracker;
  repoHost: RepoHost;
  sandbox: Sandbox;
  ledger: UsageLedger;
  clock: Clock;
  store: Store;
}

export type InvocationOutcome =
  /** No registered project had an eligible ticket. A quiet morning. */
  | "dry-queue"
  /** There was work, and the budget gate refused to start it. */
  | "stood-down"
  /** An iteration selected a project with work. */
  | "work-selected"
  /**
   * The loop's own plumbing broke before it could finish — a registry that
   * would not parse, or a port that could not be reached before a single
   * iteration ran. Distinct from a run that gave up or an infrastructure
   * failure inside one iteration, both of which are reported as normal
   * iterations; this is the invocation itself never getting that far.
   */
  | "invocation-failed";

/** The model a ticket's run is started on, and what named it. */
export interface ResolvedModel {
  name: ModelName;
  source: ModelSource;
}

/** What one invocation did. The summary issue is written from this. */
export interface InvocationReport {
  /** When the invocation started. */
  startedAt: Date;
  outcome: InvocationOutcome;
  /**
   * Every registered project, in registry order, with why it was skipped —
   * or, once it has been, that it was selected, which then sticks for the
   * rest of the invocation even on a later iteration that finds nothing left
   * of its backlog to select. What each one was actually worked on is in
   * `iterations`; this says only whether its turn came at all.
   */
  projects: ProjectOutcome[];
  /**
   * Every iteration the invocation made, in the order they started — not the
   * order they finished, since several can be in progress at once. Empty on a morning
   * that ran nothing — a dry queue, or a gate that refused before the first
   * run.
   */
  iterations: IterationOutcome[];
  /**
   * Why the invocation stood down, absent when it never did: the gate
   * refusing, before the first run of the morning or between two later ones,
   * the provider limit refusing a run that had already started, or the
   * developer stopping it by hand. Whichever, it is why the invocation stopped rather than having simply run
   * out of work.
   */
  standDown?: InvocationStandDown;
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/** The gate's refusal, and the project it turned away. */
export interface GateStandDown extends StandDown {
  /** The project that was ready to work when the gate refused. */
  refused: RepoSlug;
}

/**
 * A stand-down the gate never saw coming: a limit refusal. The allowance the
 * gate measures against is only the developer's declaration of the provider
 * limit, so the gate can say go while the provider says no — and every run
 * after the first refusal would be refused the same way.
 */
export interface ProviderLimitStandDown {
  reason: "provider-limit";
  /** What the provider said, reset time included, word for word. */
  limitRefusal: string;
  /** The ticket whose run it refused, left eligible exactly as it was. */
  ticket: Ticket;
}

/**
 * A stand-down the developer asked for, by stopping the invocation by hand.
 * Nothing about the budget or any ticket: every ticket not yet started is left
 * exactly as it was.
 */
export interface DeveloperStandDown {
  reason: "stopped";
}

/** Why an invocation stood down: the gate refused, the provider did, or the developer stopped it. */
export type InvocationStandDown =
  | GateStandDown
  | ProviderLimitStandDown
  | DeveloperStandDown;

/** What a trigger may hand the loop beyond its ports. */
export interface MorningLoopOptions {
  /**
   * Aborted to stop the invocation by hand: nothing further starts, and the
   * invocation finishes as any stand-down does — iterations in progress finish
   * and are reported, and the summary publishes.
   */
  stop?: AbortSignal;
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
 * again until the next local calendar day, even though nothing here closes it: a failed run's ticket is handed
 * back by relabelling it, but a finished run's is left exactly as it was, so
 * without this an unattended morning with only one project registered would
 * work its one ticket over and over until the budget gate finally stopped it.
 *
 * The summary always publishes when the invocation worked something; a quiet
 * or broken invocation publishes only if none has been announced yet today,
 * so a loop firing every hour reports one quiet or broken morning rather than
 * up to twenty-four.
 *
 * A developer's stop is a stand-down like the other two: noticed wherever the
 * loop would otherwise start something, never by cutting short what is already
 * in progress, whose work is the very thing stopping by hand should keep.
 */
export async function morningLoop(
  ports: MorningLoopPorts,
  { stop }: MorningLoopOptions = {},
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

  let standDown: InvocationStandDown | undefined;
  let invocationFailure: string | undefined;
  // Set once `loadState` has succeeded, since only then is there a state
  // document to fold a successful publish's announcement back into. Absent
  // when the loop's own plumbing broke before that point — there is nothing
  // to write back then, as the final `catch` below already notes.
  let announcedOn: Day | undefined;
  let stateToSave: (() => State) | undefined;
  try {
    const stored = await ports.store.loadState();
    announcedOn = stored.announcedOn;
    const projects = new Map(stored.projects);
    const worked = workedTickets(stored.workedToday, today);
    stateToSave = (): State => {
      const workedToday = worked.workedToday();
      return {
        projects,
        ...(workedToday !== undefined && { workedToday }),
        ...(announcedOn !== undefined && { announcedOn }),
      };
    };
    const modelDefaults = await ports.store.loadModelDefaults();
    // Built once and kept for the whole invocation, not once per iteration:
    // it is what remembers a project's "selected" verdict across scans and
    // where each registered project first landed in registry order.
    const selecting = invocationSelection(ports, projects, worked);
    const inProgress = new Set<Promise<void>>();
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
          await Promise.race(inProgress);
        }
        if (stopped()) {
          break;
        }

        const chosen = await selecting.next();
        if (chosen === undefined) {
          // An iteration in progress can still queue work — a finished run's
          // review ticket — so nothing left means nothing left once none is.
          if (inProgress.size === 0) {
            break;
          }
          await Promise.race(inProgress);
          continue;
        }
        // A refusal can land while the registry was being read.
        if (stopped()) {
          break;
        }
        const { ticket } = chosen;

        // Ahead of the gate as well as of the run: handing a ticket back
        // spends nothing, so a morning the gate refuses still gives the
        // developer the ticket they need to fix.
        const unusable = unusableModelLabel(ticket);
        if (unusable !== undefined) {
          worked.record(ticket, localDay(ports.clock.now()));
          outcomeSlots.push({
            repo: chosen.project.repo,
            ticket,
            ...(await handTicketBack(
              ports,
              ticket,
              unusable,
              unusableModelLabelComment(unusable),
            )),
          });
          continue;
        }

        const budget = await ports.store.loadBudget();
        concurrencyLimit = budget.maxConcurrentIterations;
        const refusal = await consultTheGate(ports, budget, projects);
        if (refusal !== undefined) {
          // The first refusal is the stand-down, whichever of the two it was.
          standDown ??= { ...refusal, refused: chosen.project.repo };
          break;
        }

        // Saved before the sandbox starts, not only at the end: a process
        // killed mid-run never reaches the final save, and would otherwise
        // free the ticket for the next firing the same day. Recorded, too, is
        // what keeps a ticket in progress from being selected again.
        worked.record(ticket, localDay(ports.clock.now()));
        await ports.store.saveState(stateToSave());
        if (stopped()) {
          worked.unrecord(ticket);
          break;
        }

        const { repo } = chosen.project;
        const model = resolveModel(ticket, modelDefaults);
        // Reported where it started, however long it then takes to finish.
        const slot = outcomeSlots.push(undefined) - 1;
        const completion: Promise<void> = work(
          ports,
          chosen,
          projects,
          budget.spendCeiling,
          model,
        )
          .then(
            (iteration) => {
              outcomeSlots[slot] = {
                repo,
                ticket,
                ...(model !== undefined && { model: model.name }),
                ...iteration,
              } as IterationOutcome;

              // An infrastructure failure or a limit refusal says nothing
              // about the ticket, so it is left free for a later firing today
              // — one that finds the setup fixed or the provider limit reset.
              if (leavesTicketUntouched(iteration)) {
                worked.unrecord(ticket);
              }

              // The provider limit refuses every run after this one the same
              // way, so nothing further starts. The iterations already in
              // progress are left to finish on their own.
              if (iteration.kind === "limit-refused") {
                standDown ??= {
                  reason: "provider-limit",
                  limitRefusal: iteration.limitRefusal,
                  ticket,
                };
              }
            },
            (error: unknown) => {
              thrown.push(error);
            },
          )
          .finally(() => inProgress.delete(completion));
        inProgress.add(completion);
      }
    } finally {
      // Never rejects: each iteration's own settling catches what it threw.
      await Promise.all(inProgress);
      // Read back out here rather than only on the happy path, so a for loop
      // that throws still reports every verdict scanned before that — the
      // same partial account `iterations` already carries for the runs made
      // before it.
      outcomes = selecting.verdicts();
      // State is written back at the end of every invocation, including one that
      // worked nothing and one whose run failed part way, so that a machine
      // which has run the loop always has a state document to read next morning.
      // A run that fell over still spent tokens, and the morning it spent them
      // on is exactly the one worth having recorded.
      await ports.store.saveState(stateToSave());
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
  };
  const line = summaryLine(facts);
  const outcome = outcomeOf(iterations, standDown, invocationFailure);

  // An invocation that worked something always publishes. A quiet or broken
  // one — dry queue, stand-down, invocation failure — publishes only if
  // nothing has been announced yet today, so a firing every hour reports one
  // quiet morning rather than up to twenty-four.
  let publishFailure: string | undefined;
  if (outcome === "work-selected" || announcedOn !== today) {
    // Last, so a morning that worked something still gets its state recorded
    // above even if the tracker refuses this. Never thrown: a summary issue
    // that could not be written must not cost the developer the account of
    // everything else the invocation did, which is exactly the account this
    // write exists to carry — said in the message instead, the same way a
    // tracker that refuses `handBack` is said rather than thrown.
    try {
      await ports.tracker.publishSummary(
        summaryTitle(startedAt),
        summaryBody(facts, line),
      );
      // Recorded only now that the publish is known to have succeeded, and
      // only when there is a state document to fold it back into.
      if (stateToSave !== undefined) {
        announcedOn = today;
        await ports.store.saveState(stateToSave());
      }
    } catch (error: unknown) {
      publishFailure = errorMessage(error);
    }
  }

  return {
    startedAt,
    projects: outcomes,
    iterations,
    ...(standDown !== undefined && { standDown }),
    outcome,
    message:
      publishFailure === undefined
        ? line
        : `${line} The summary issue could not be published: ${publishFailure}.`,
  };
}

function outcomeOf(
  iterations: IterationOutcome[],
  standDown: InvocationStandDown | undefined,
  invocationFailure: string | undefined,
): InvocationOutcome {
  if (invocationFailure !== undefined) {
    return "invocation-failed";
  }
  // A ticket handed back for its model labels was never run, so it does not
  // count as work when the morning then stood down: a stand-down that ran
  // nothing reads as one, whatever was handed back before it. Without a
  // stand-down, that hand-back is still work an iteration selected.
  const worked = iterations.some(
    (iteration) => !handedBackForModelLabels(iteration),
  );
  if (worked) {
    return "work-selected";
  }
  if (standDown !== undefined) {
    return "stood-down";
  }
  return iterations.length > 0 ? "work-selected" : "dry-queue";
}

/**
 * The budget gate, asked immediately before a run and never earlier: the
 * windows it reads are the ones in force when the run would start, not the
 * ones the invocation opened with.
 *
 * The state goes in with them. The ledger reads this machine's session logs
 * and a run writes its log inside a container that is then thrown away, so
 * what the mornings have spent is in the state document and nowhere else. A
 * gate handed only the ledger would ration the developer and never the loop.
 *
 * The budget's observed reset goes in too, since the developer declares it
 * and only the ledger can act on it.
 *
 * A dry morning never gets here, so the loop reports a quiet queue as a quiet
 * queue rather than reading the ledger to decline work that did not exist.
 */
async function consultTheGate(
  ports: MorningLoopPorts,
  budget: Budget,
  projects: ProjectStates,
): Promise<StandDown | undefined> {
  return budgetGate(
    await ports.ledger.read(ports.clock.now(), budget.observedResetAt),
    budget,
    runsRecorded(projects),
  );
}

/** Every run the mornings have made, across every project, oldest first. */
function runsRecorded(projects: ProjectStates): RunCost[] {
  return [...projects.values()]
    .flatMap((project) => project.runs)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * The model `ticket`'s run is started on: the one its own model label names,
 * else the model defaults' entry for its kind, else none, which leaves the
 * sandbox image's pin in force.
 */
function resolveModel(
  ticket: Ticket,
  modelDefaults: ModelDefaults,
): ResolvedModel | undefined {
  if (ticket.modelLabel?.kind === "named") {
    return { name: ticket.modelLabel.name, source: "model label" };
  }
  const name = modelDefaults[ticketKind(ticket)];
  return name === undefined ? undefined : { name, source: "model defaults" };
}

/**
 * Why no run can be started on `ticket`'s model labels, absent when they
 * name one model or none. Never falls back to the model defaults: the
 * developer asked for a model, and another one is not what they asked for.
 */
function unusableModelLabel(ticket: Ticket): UnusableModelLabel | undefined {
  const label = ticket.modelLabel;
  switch (label?.kind) {
    case undefined:
    case "named":
      return undefined;
    case "conflicting":
      return {
        kind: "conflicting-model-labels",
        reason: `it carries more than one model label (${label.labels.join(", ")})`,
        labels: label.labels,
        handedBack: false,
      };
    case "unusable":
      return {
        kind: "unusable-model-label",
        reason: `its model label names no usable model (${label.labels.join(", ")})`,
        labels: label.labels,
        handedBack: false,
      };
  }
}

/**
 * A model refusal, as the failure its ticket is handed back with.
 *
 * `source` is worked out again from `ticket` rather than threaded through
 * from `resolveModel`'s own answer: a `"model-refused"` outcome can only come
 * back from a run the sandbox was actually given a model for (`Sandbox.run`'s
 * own overload rules that out for a run given none), and the model it names
 * is always the one that run was given — so which of the ticket's own model
 * label or the model defaults that was is a fact of `ticket`, not something
 * this needs handed to it separately, and there is no "given no model" case
 * left here to guard against.
 */
function modelRefused(ticket: Ticket, refusal: ModelRefusal): ModelRefused {
  const source: ModelSource =
    ticket.modelLabel?.kind === "named" && ticket.modelLabel.name === refusal.model
      ? "model label"
      : "model defaults";
  return {
    kind: "model-refused",
    reason: `the agent CLI refused the model ${refusal.model} (from the ${source}): ${refusal.words}`,
    refusal,
    source,
    handedBack: false,
  };
}

/**
 * Whether `iteration` was one of the two that say nothing about its ticket —
 * an infrastructure failure or a limit refusal — and so, as `work` leaves it,
 * leaves the ticket exactly as it was.
 */
function leavesTicketUntouched(iteration: Iteration): boolean {
  return (
    iteration.kind === "limit-refused" || failedOnInfrastructure(iteration)
  );
}

/**
 * The second step: run the selected ticket and record what that cost. An
 * implementation ticket hands its work over as a draft pull request with a
 * review queued against it, or — when the agent gave up — puts the ticket back
 * in the developer's hands. An infrastructure failure or a limit refusal
 * leaves the ticket untouched. A review ticket's own run posts its findings
 * itself and is closed once it has; an apply-review ticket's pushes and
 * replies itself, and is closed once the repo host shows every thread
 * answered; a rebase ticket's force-pushes itself, and is closed once the repo
 * host no longer reports its pull request conflicting.
 *
 * A failed run ends this iteration rather than the invocation: it is
 * reported, and the loop goes on to consider the next iteration.
 */
async function work(
  ports: MorningLoopPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<Iteration> {
  if (isRebaseTicket(selection.ticket)) {
    return await runRebase(
      ports,
      selection.project.repo,
      selection.ticket,
      state,
      spendCeiling,
      model,
    );
  }
  if (isApplyReviewTicket(selection.ticket)) {
    return await runApplyReview(
      ports,
      selection.project.repo,
      selection.ticket,
      state,
      spendCeiling,
      model,
    );
  }
  if (isReviewTicket(selection.ticket)) {
    return await runReview(
      ports,
      selection.project.repo,
      selection.ticket,
      state,
      spendCeiling,
      model,
    );
  }

  const returned = await attemptRun(
    ports,
    selection,
    state,
    spendCeiling,
    model,
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
    return {
      kind: "failed",
      tokensUsed: run.tokensUsed,
      failure: {
        kind: "infrastructure",
        reason: run.reason,
        tokensUsed: run.tokensUsed,
      },
    };
  }
  if (run.kind === "limit-refused") {
    return {
      kind: "limit-refused",
      limitRefusal: run.words,
      tokensUsed: run.tokensUsed,
      run,
      discard: await discardBranch(ports, checkout, run),
    };
  }
  if (run.kind === "model-refused") {
    const failure = modelRefused(selection.ticket, run.refusal);
    const discard = await discardBranch(ports, checkout, run);
    return handTicketBack(
      ports,
      selection.ticket,
      failure,
      modelRefusalComment(selection.ticket, failure, run, discard),
      { run },
    );
  }
  if (run.kind === "finished") {
    return handOver(ports, run, checkout, selection.ticket);
  }

  // The branch goes first, so the comment can say what became of it — but it
  // cannot cost the ticket its hand-back. Git refuses to delete a branch that
  // some worktree has checked out, and a ticket left eligible because of that
  // is the failure this whole policy exists to prevent.
  const discard = await discardBranch(ports, checkout, run);
  const failure: GaveUp = {
    kind: "gave-up",
    reason: run.reason,
    handedBack: false,
  };
  return handTicketBack(
    ports,
    selection.ticket,
    failure,
    handbackComment(failure, run, discard),
    { run },
  );
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
 */
async function handOver(
  ports: MorningLoopPorts,
  run: RunFinished,
  checkout: Checkout,
  ticket: Ticket,
): Promise<Finished | Failed> {
  if (run.commits.length === 0) {
    const handbackFailure = await handFinishedTicketBack(
      ports,
      ticket,
      committedNothingComment(run),
    );
    return {
      kind: "finished",
      run,
      tokensUsed: run.tokensUsed,
      ...(handbackFailure !== undefined && { handbackFailure }),
    };
  }

  const opening = await ports.repoHost.openDraftPullRequest(
    checkout,
    run.branch,
    ticket,
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

  const handbackFailure = await handFinishedTicketBack(
    ports,
    ticket,
    handoverComment(pullRequest, reviewTicket),
  );

  return {
    kind: "finished",
    run,
    tokensUsed: run.tokensUsed,
    handover: { pullRequest, reviewTicket },
    ...(handbackFailure !== undefined && { handbackFailure }),
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
    handedBack: false,
  };
  return handTicketBack(
    ports,
    ticket,
    failure,
    handoverFailureComment(failure),
    { run },
  );
}

/**
 * Takes a finished run's ticket out of the queue: the same comment-and-relabel
 * primitive a failed run's hand-back uses, so a project the developer never
 * triaged by hand still gets ready-for-human created for it.
 *
 * Never throws. A tracker that refuses the relabel is reported in the
 * summary instead, the same way a refused hand-back is today — the one thing
 * still worth doing is saying so, since the ticket is left eligible and due
 * to come round again.
 */
async function handFinishedTicketBack(
  ports: MorningLoopPorts,
  ticket: Ticket,
  comment: string,
): Promise<string | undefined> {
  try {
    await ports.tracker.handBack(ticket, comment);
    return undefined;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

/**
 * What a failed ticket's hand-back carries into `Failed`: an implementation
 * run's own outcome, whose `tokensUsed` is taken as the spend too, or — for a
 * review, which has no `RunOutcome` of its own — the spend directly.
 */
type Spend = { run: RunOutcome } | { tokensUsed: TokenCount };

/**
 * Puts the ticket of a run that failed on the ticket's account — an agent
 * that gave up, or a model it could not use — back in the developer's hands
 * with `comment`, and says whether it got there.
 *
 * Never throws. A tracker that could not be reached leaves the ticket eligible,
 * and saying so is the one thing still worth doing.
 */
async function handTicketBack(
  ports: MorningLoopPorts,
  ticket: Ticket,
  failure: HandedBackFailure,
  comment: string,
  spend?: Spend,
): Promise<Failed> {
  const run = spend !== undefined && "run" in spend ? spend.run : undefined;
  const tokensUsed =
    spend === undefined
      ? undefined
      : "run" in spend
        ? spend.run.tokensUsed
        : spend.tokensUsed;
  try {
    await ports.tracker.handBack(ticket, comment);
    return {
      kind: "failed",
      ...(run !== undefined && { run }),
      ...(tokensUsed !== undefined && { tokensUsed }),
      failure: { ...failure, handedBack: true },
    };
  } catch (error: unknown) {
    // The policy itself could not be carried out, which leaves the ticket
    // eligible and due to come round again. Saying so is what is left: a
    // silent failure here is the one that costs a morning every morning.
    return {
      kind: "failed",
      ...(run !== undefined && { run }),
      ...(tokensUsed !== undefined && { tokensUsed }),
      failure: {
        ...failure,
        reason: `${failure.reason} — and the ticket could not be handed back: ${errorMessage(error)}`,
      },
    };
  }
}

/**
 * Throws the failed run's branch away, and says what became of it.
 *
 * Never throws. A branch that will not delete is worth telling the developer
 * about; it is not worth the ticket, which is what refusing to go on would
 * cost.
 */
async function discardBranch(
  ports: MorningLoopPorts,
  checkout: Checkout,
  run: RunGaveUp | RunLimitRefused | RunModelRefused,
): Promise<Discard> {
  // The sandbox fetches a branch back only when the agent committed to it, and
  // an agent that gave up commonly committed nothing at all.
  if (run.commits.length === 0) {
    return { kind: "none" };
  }

  try {
    await ports.repoHost.discardBranch(checkout, run.branch);
    return { kind: "discarded" };
  } catch (error: unknown) {
    return { kind: "kept", reason: errorMessage(error) };
  }
}

/** What `runInSandbox` came back with, before its caller reads what kind of outcome it was. */
interface SandboxResult<Outcome> {
  kind: "ran";
  outcome: Outcome;
  checkout: Checkout;
}

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
 */
async function runInSandbox<Outcome extends { tokensUsed: TokenCount }>(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  state: Map<RepoSlug, ProjectState>,
  sandboxCall: (checkout: Checkout) => Promise<Outcome>,
): Promise<SandboxResult<Outcome> | Failed> {
  let checkout: Checkout;
  let outcome: Outcome;
  try {
    checkout = await ports.repoHost.clone(repo);
    outcome = await sandboxCall(checkout);
  } catch (error: unknown) {
    // Nothing comes back from a rejected run — no branch, no output, and no
    // token count — so there is nothing to record against the project, and no
    // branch to discard. The sandbox rejects only when it could not set
    // itself up or start the agent, before any of that existed to lose: a
    // failure once the agent has already run comes back as a result instead
    // (`RunOutcome`'s `"sandbox-failed"` case), carrying its spend, so it
    // reaches `recordRun` below like any other.
    return infrastructureFailure(error);
  }

  state.set(
    repo,
    recordRun(state.get(repo), {
      at: ports.clock.now(),
      tokensUsed: outcome.tokensUsed,
    }),
  );

  return { kind: "ran", outcome, checkout };
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
 */
async function attemptRun(
  ports: MorningLoopPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<SandboxResult<RunOutcome> | Failed> {
  const { ticket } = selection;
  const repo = selection.project.repo;

  return runInSandbox(ports, repo, state, (checkout) =>
    // Built as two distinct calls rather than one call with `model` spread in
    // conditionally: `Sandbox.run` is overloaded on whether `model` is
    // present precisely so that a run given none can never come back with a
    // model refusal, and only a call whose own argument is plainly one shape
    // or the other resolves to the right overload.
    model === undefined
      ? ports.sandbox.run({ ticket, checkout, spendCeiling })
      : ports.sandbox.run({ ticket, checkout, spendCeiling, model: model.name }),
  );
}

/**
 * A review ticket's own run: the reviewer examines the pull request the
 * ticket names and posts its findings there itself, in a container with no
 * write access to its clone. The loop's only remaining part is closing the
 * ticket once that finished — a review that posted needs nobody to close it
 * by hand.
 *
 * Closing rests on the pull request actually carrying a new comment, not on
 * the sandbox process merely exiting clean: an agent can run the review skill
 * fine and still fail its own last step, `gh pr comment`, and a ticket closed
 * on process success alone would tell the developer a review happened when
 * nothing was ever posted. Either way nothing did — an agent that gave up, or
 * a clean exit that posted nothing — the ticket is handed back, as an
 * implementation ticket's is.
 *
 * A checkout or a sandbox that could not do its part is an infrastructure
 * failure here exactly as for an implementation run: reported, the ticket left
 * as it was, and the invocation carries on. A check or a close that fails
 * after the review ran is reported on the iteration, never raised.
 */
async function runReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: ReviewTicket,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<Reviewed | LimitRefused | Failed> {
  const startedAt = ports.clock.now();
  const result = await runInSandbox(ports, repo, state, (checkout) =>
    // As `attemptRun`: two distinct calls so each resolves the `Sandbox.review`
    // overload that actually matches, rather than one call TypeScript could
    // not resolve to either.
    model === undefined
      ? ports.sandbox.review({ ticket, checkout, spendCeiling })
      : ports.sandbox.review({ ticket, checkout, spendCeiling, model: model.name }),
  );
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: review } = result;

  if (review.kind === "limit-refused") {
    return {
      kind: "limit-refused",
      limitRefusal: review.words,
      tokensUsed: review.tokensUsed,
      discard: { kind: "none" },
    };
  }
  // Handed back rather than left to come round again, as an implementation
  // ticket's is: every later morning would refuse the same model the same way.
  if (review.kind === "model-refused") {
    const failure = modelRefused(ticket, review.refusal);
    return handTicketBack(
      ports,
      ticket,
      failure,
      modelRefusalComment(ticket, failure, undefined, { kind: "none" }),
      { tokensUsed: review.tokensUsed },
    );
  }

  if (review.kind === "gave-up") {
    return handReviewBack(ports, ticket, review, review.reason);
  }

  let posted: boolean;
  try {
    posted = await ports.repoHost.hasReviewFindings(
      ticket.pullRequest.url,
      startedAt,
    );
  } catch (error: unknown) {
    return {
      kind: "reviewed",
      review,
      tokensUsed: review.tokensUsed,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
  }
  if (!posted) {
    return handReviewBack(
      ports,
      ticket,
      review,
      `the agent ran but posted nothing to ${ticket.pullRequest.url}`,
    );
  }

  try {
    await ports.tracker.closeReviewTicket(ticket);
  } catch (error: unknown) {
    return {
      kind: "reviewed",
      review,
      tokensUsed: review.tokensUsed,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
  }
  return { kind: "reviewed", review, tokensUsed: review.tokensUsed };
}

/** Hands back a review that left no findings on its pull request, as an agent that gave up. */
async function handReviewBack(
  ports: MorningLoopPorts,
  ticket: ReviewTicket,
  review: ReviewFinished | ReviewGaveUp,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason, handedBack: false };
  return handTicketBack(
    ports,
    ticket,
    failure,
    reviewHandbackComment(failure, review),
    { tokensUsed: review.tokensUsed },
  );
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
 * for a review. A read, mark or close that fails after the run is reported on
 * the iteration, never raised.
 */
async function runApplyReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: ApplyReviewTicket,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<AppliedReview | LimitRefused | Failed> {
  const pullRequest = ticket.pullRequest.url;
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
    return finishApplyReview(ports, ticket, { kind: "applied-review" });
  }

  const result = await runInSandbox(ports, repo, state, (checkout) =>
    // As `attemptRun`: two distinct calls so each resolves the overload that
    // actually matches.
    model === undefined
      ? ports.sandbox.applyReview({ ticket, checkout, spendCeiling })
      : ports.sandbox.applyReview({
          ticket,
          checkout,
          spendCeiling,
          model: model.name,
        }),
  );
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: run } = result;

  if (run.kind === "limit-refused") {
    return {
      kind: "limit-refused",
      limitRefusal: run.words,
      tokensUsed: run.tokensUsed,
      discard: { kind: "none" },
    };
  }
  if (run.kind === "model-refused") {
    const failure = modelRefused(ticket, run.refusal);
    return handTicketBack(
      ports,
      ticket,
      failure,
      modelRefusalComment(ticket, failure, undefined, { kind: "none" }),
      { tokensUsed: run.tokensUsed },
    );
  }
  if (run.kind === "gave-up") {
    return handApplyReviewBack(ports, ticket, run, run.reason);
  }

  let answers: ApplyReviewAnswers;
  try {
    answers = await ports.repoHost.readApplyReviewAnswers(
      pullRequest,
      startedAt,
    );
  } catch (error: unknown) {
    return {
      kind: "applied-review",
      review: run,
      tokensUsed: run.tokensUsed,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
  }
  if (answers.unanswered > 0) {
    const threads =
      answers.unanswered === 1 ? "1 thread" : `${answers.unanswered} threads`;
    return handApplyReviewBack(
      ports,
      ticket,
      run,
      `the agent finished with ${threads} left unanswered on ${pullRequest}`,
    );
  }

  return finishApplyReview(ports, ticket, {
    kind: "applied-review",
    review: run,
    tokensUsed: run.tokensUsed,
    answers: { applied: answers.appliedSince, declined: answers.declinedSince },
  });
}

/**
 * Marks `ticket`'s pull request ready for review, then closes the ticket with
 * a comment saying what `applied` came to. Never throws: whichever step fails
 * is reported on the iteration, and the ticket is left open.
 */
async function finishApplyReview(
  ports: MorningLoopPorts,
  ticket: ApplyReviewTicket,
  applied: AppliedReview,
): Promise<AppliedReview> {
  const pullRequest = ticket.pullRequest.url;
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
      appliedReviewComment(pullRequest, applied.answers),
    );
  } catch (error: unknown) {
    return {
      ...applied,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
  }
  return applied;
}

/** Hands back an apply-review run that gave up or left a thread unanswered. */
async function handApplyReviewBack(
  ports: MorningLoopPorts,
  ticket: ApplyReviewTicket,
  run: ReviewFinished | ApplyReviewGaveUp,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason, handedBack: false };
  return handTicketBack(
    ports,
    ticket,
    failure,
    applyReviewHandbackComment(failure, run, ticket.pullRequest.url),
    { tokensUsed: run.tokensUsed },
  );
}

/**
 * A rebase ticket's own run: the agent replays the pull request the ticket
 * names onto its base branch and force-pushes it itself, from a clone on that
 * pull request's branch. Whether it worked is read back from the repo host,
 * never taken from the agent's say-so: the ticket closes only once the pull
 * request no longer conflicts. Its draft state is never touched — a rebase
 * promotes nothing.
 *
 * A pull request that needs no rebase when the iteration starts has nothing to
 * rebase, so no run is started: the ticket closes all the same.
 *
 * An agent that gave up — a force-push the repo host rejected included — or a
 * run that left the pull request still conflicting is handed back, and so,
 * with no run, is a pull request whose mergeability never settles: that is
 * the pull request's doing, commonly one merged or closed since, and left
 * eligible it would come round every firing ahead of the project's other
 * work. A repo host or sandbox that could not otherwise do its part before
 * the agent started is an infrastructure failure, and a limit or model
 * refusal reads as for an apply-review ticket. A read or close that fails after the run is reported on
 * the iteration, never raised.
 */
async function runRebase(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: RebaseTicket,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<Rebased | LimitRefused | Failed> {
  const pullRequest = ticket.pullRequest.url;
  let needsRebase: boolean;
  try {
    needsRebase = await ports.repoHost.needsRebase(pullRequest);
  } catch (error: unknown) {
    if (error instanceof MergeabilityUnknown) {
      const failure: UnsettledMergeability = {
        kind: "unsettled-mergeability",
        reason: errorMessage(error),
        handedBack: false,
      };
      return handTicketBack(
        ports,
        ticket,
        failure,
        unsettledMergeabilityComment(failure, pullRequest),
      );
    }
    return infrastructureFailure(error);
  }
  if (!needsRebase) {
    return finishRebase(ports, ticket, { kind: "rebased" });
  }

  const result = await runInSandbox(ports, repo, state, (checkout) =>
    // As `attemptRun`: two distinct calls so each resolves the overload that
    // actually matches.
    model === undefined
      ? ports.sandbox.rebase({ ticket, checkout, spendCeiling })
      : ports.sandbox.rebase({
          ticket,
          checkout,
          spendCeiling,
          model: model.name,
        }),
  );
  if (result.kind === "failed") {
    return result;
  }
  const { outcome: run } = result;

  if (run.kind === "limit-refused") {
    return {
      kind: "limit-refused",
      limitRefusal: run.words,
      tokensUsed: run.tokensUsed,
      discard: { kind: "none" },
    };
  }
  if (run.kind === "model-refused") {
    const failure = modelRefused(ticket, run.refusal);
    return handTicketBack(
      ports,
      ticket,
      failure,
      modelRefusalComment(ticket, failure, undefined, { kind: "none" }),
      { tokensUsed: run.tokensUsed },
    );
  }
  if (run.kind === "gave-up") {
    return handRebaseBack(ports, ticket, run, run.reason);
  }

  try {
    needsRebase = await ports.repoHost.needsRebase(pullRequest);
  } catch (error: unknown) {
    return {
      kind: "rebased",
      rebase: run,
      tokensUsed: run.tokensUsed,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
  }
  if (needsRebase) {
    return handRebaseBack(
      ports,
      ticket,
      run,
      `the agent finished, but ${pullRequest} still conflicts with its base branch`,
    );
  }

  return finishRebase(ports, ticket, {
    kind: "rebased",
    rebase: run,
    tokensUsed: run.tokensUsed,
  });
}

/**
 * Closes `ticket` with a comment saying what `rebased` came to. Never throws:
 * a close that fails is reported on the iteration, and the ticket left open.
 */
async function finishRebase(
  ports: MorningLoopPorts,
  ticket: RebaseTicket,
  rebased: Rebased,
): Promise<Rebased> {
  try {
    await ports.tracker.closeRebaseTicket(
      ticket,
      rebasedComment(ticket.pullRequest.url, rebased),
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
  const failure: GaveUp = { kind: "gave-up", reason, handedBack: false };
  return handTicketBack(
    ports,
    ticket,
    failure,
    rebaseHandbackComment(failure, run, ticket.pullRequest.url),
    { tokensUsed: run.tokensUsed },
  );
}
