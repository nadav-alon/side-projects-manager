import type {
  ApplyReviewAnswers,
  ApplyReviewGaveUp,
  ApplyReviewTicket,
  Checkout,
  Clock,
  Day,
  InvocationOutcome as JournaledInvocationOutcome,
  IssueTracker,
  IssueUrl,
  IterationLimit,
  ModelDefaults,
  ModelName,
  ModelRefusal,
  Progress,
  ProjectState,
  PullRequestLabel,
  PullRequestState,
  PullRequestTicket,
  PullRequestUrl,
  RebaseFinished,
  RebaseGaveUp,
  RebaseTicket,
  RepoHost,
  RepoSlug,
  ReviewFinished,
  ReviewGaveUp,
  ReviewTicket,
  RunFinished,
  RunModelRefused,
  RunOutcome,
  RunProviderFailed,
  Sandbox,
  State,
  Store,
  Ticket,
  TokenCount,
  TranscriptPath,
  UsageLedger,
  Usd,
} from "./ports/index.ts";
import {
  APPLIED_REVIEW_LABEL,
  MergeabilityUnknown,
  REVIEWED_LABEL,
  hasAnnouncedOn,
  isApplyReviewTicket,
  isRebaseTicket,
  isReviewTicket,
  localDay,
  notify,
  recordRun,
  ticketKind,
  tokenCount,
} from "./ports/index.ts";
import { invocationBudgetGate, type StandDown } from "./budget-gate.ts";
import {
  invocationSelection,
  type ProjectOutcome,
  type Selection,
} from "./selection.ts";
import { workedTickets } from "./worked-today.ts";
import {
  appliedReviewComment,
  pullRequestResolvedComment,
  rebasedComment,
} from "./close-comment.ts";
import {
  discardBranch,
  handBack,
  type Discard,
  type HandBackRecord,
} from "./hand-back.ts";
import { errorMessage } from "./error-message.ts";
import {
  cutOffReviewOutcome,
  cutOffRunOutcome,
  failedOnInfrastructure,
  handedBackFailure,
  handedBackForModelLabels,
  isCutOff,
  type AppliedReview,
  type CutOff,
  type Failed,
  type Finished,
  type GaveUp,
  type HandoverFailed,
  type HandoverReach,
  type Iteration,
  type IterationOutcome,
  type LimitRefused,
  type ModelRefused,
  type ModelSource,
  type NotLabelled,
  type ProviderFailed,
  type PullRequestResolved,
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
  /** Publishes the summary issue, and answers with where it landed. */
  publishSummary(title: string, body: string): Promise<IssueUrl>;
}

/**
 * The seven outside-world dependencies of the loop. Everything it knows about
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
  progress: Progress;
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

/**
 * Kept assignable to the store port's own copy of this union: a variant
 * added here without being added to `ports/journal.ts`'s `InvocationOutcome`
 * fails this line, rather than surfacing later as a runtime parse error when
 * the journal tries to read back an outcome it does not recognise.
 */
const _outcomeStaysInSyncWithJournal: JournaledInvocationOutcome =
  "dry-queue" as InvocationOutcome;

/** The model a ticket's run is started on, and what named it. */
export interface ResolvedModel {
  name: ModelName;
  source: ModelSource;
}

/**
 * A summary the invocation composed but could not publish: why, and the body
 * it had already put together. Carried as its own field rather than only
 * folded into `message`'s prose, so the entry point can write the body down
 * and the journal can record why — the one write meant to report the morning
 * is not allowed to be the one that loses its account of itself.
 */
export interface SummaryFailure {
  reason: string;
  body: string;
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
  /**
   * Where a published summary landed. Absent when none published this
   * invocation, or the publish failed.
   */
  summaryLocation?: IssueUrl;
  /**
   * The composed summary, kept because it could not be published. Absent
   * when one published, or none was composed this invocation.
   */
  summaryFailure?: SummaryFailure;
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
 * A stand-down the gate never saw coming either: a provider failure — down,
 * overloaded or unreachable. As `ProviderLimitStandDown`, every run after the
 * first would be stopped the same way.
 */
export interface ProviderFailureStandDown {
  reason: "provider-failure";
  /** What the CLI said, word for word. */
  providerFailure: string;
  /** The ticket whose run it stopped, left eligible exactly as it was. */
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
  | ProviderFailureStandDown
  | DeveloperStandDown;

/** `iteration`'s own cut-off reason, as the stand-down it triggers. */
function cutOffStandDown(iteration: CutOff, ticket: Ticket): InvocationStandDown {
  return iteration.kind === "limit-refused"
    ? { reason: "provider-limit", limitRefusal: iteration.limitRefusal, ticket }
    : { reason: "provider-failure", providerFailure: iteration.providerFailure, ticket };
}

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
    // Built once too, over the same live `projects` map: a run recorded
    // between two consultations is exactly what the next one counts.
    const gate = invocationBudgetGate(ports, projects);
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
        const unusable = unusableModelLabel(ticket);
        if (unusable !== undefined) {
          worked.record(ticket, localDay(ports.clock.now()));
          const handedBack = await handBack(ports, ticket, unusable);
          const iteration: Failed = {
            kind: "failed",
            failure: unusable,
            handedBack,
          };
          if (freesTicketToday(iteration)) {
            worked.unrecord(ticket);
          }
          outcomeSlots.push({
            repo: chosen.project.repo,
            ticket,
            ...iteration,
          });
          continue;
        }

        // Asked immediately before this run and never earlier, so the
        // windows it reads are the ones in force when the run would start,
        // not the state the invocation opened with.
        const { standDown: refusal, budget } = await gate.consult(
          ticket,
          [...inProgress.values()],
        );
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

              // An infrastructure failure, a limit refusal or a provider
              // failure says nothing about the ticket, so it is left free for
              // a later firing today — one that finds the setup fixed, the
              // provider limit reset, or the provider answering again. So is
              // a ticket whose own tracker write landed: the loop already
              // took its eligibility away, so the record has nothing left to
              // protect, and a developer who re-applies ready-for-agent the
              // same day gets a later firing rather than silence.
              if (freesTicketToday(iteration)) {
                worked.unrecord(ticket);
              }

              // A cut-off run — a limit refusal or a provider failure —
              // stops every run after it the same way, so nothing further
              // starts. The iterations already in progress are left to
              // finish on their own.
              if (isCutOff(iteration)) {
                standDown ??= cutOffStandDown(iteration, ticket);
                if (iteration.kind === "limit-refused") {
                  // Announced the instant the provider refuses, not only once
                  // the invocation report is written — the developer would
                  // otherwise hear nothing until every iteration still in
                  // progress finished on its own.
                  notify(ports.progress, {
                    kind: "provider-limited",
                    ticket,
                    limitRefusal: iteration.limitRefusal,
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
  let summaryLocation: IssueUrl | undefined;
  let summaryFailure: SummaryFailure | undefined;
  if (outcome === "work-selected" || !hasAnnouncedOn(announcedOn, today)) {
    const body = summaryBody(facts, line);
    // Last, so a morning that worked something still gets its state recorded
    // above even if the tracker refuses this. Never thrown: a summary issue
    // that could not be written must not cost the developer the account of
    // everything else the invocation did — said in the message, and kept
    // whole in `summaryFailure`, the same way a tracker that refuses
    // `handBack` is said rather than thrown.
    try {
      summaryLocation = await ports.tracker.publishSummary(
        summaryTitle(startedAt),
        body,
      );
    } catch (error: unknown) {
      summaryFailure = { reason: errorMessage(error), body };
    }
    // Recorded only now that the publish is known to have succeeded, and
    // only when there is a state document to fold it back into. Kept out of
    // the try above: a fault here is the state document's, not the
    // publish's, and must never read back as a publish that failed when the
    // summary in fact went out.
    if (summaryLocation !== undefined && stateToSave !== undefined) {
      announcedOn = today;
      await ports.store.saveState(stateToSave());
    }
  }

  return {
    startedAt,
    projects: outcomes,
    iterations,
    ...(standDown !== undefined && { standDown }),
    outcome,
    ...(summaryLocation !== undefined && { summaryLocation }),
    ...(summaryFailure !== undefined && { summaryFailure }),
    message:
      summaryFailure === undefined
        ? line
        : `${line} The summary issue could not be published: ${summaryFailure.reason}.`,
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
      };
    case "unusable":
      return {
        kind: "unusable-model-label",
        reason: `its model label names no usable model (${label.labels.join(", ")})`,
        labels: label.labels,
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
  };
}

/**
 * Whether `iteration` frees its ticket to be selected again today —
 * CONTEXT.md's narrowed "Worked today" rule: the persisted record protects
 * only the tickets the loop tried and failed to take off the queue itself.
 *
 * An infrastructure failure, a limit refusal or a provider failure says
 * nothing about the ticket at all, so it always frees it. A finished or a
 * failed run frees it exactly when its own hand-back landed — `"handed-back"`
 * or `"already-closed"` — and leaves it recorded when the tracker refused the
 * call. A review, an apply-review, a rebase or a resolved pull request frees
 * it exactly when it closed without a `notClosed`, and leaves it recorded
 * when one is set — the ticket is still ready-for-agent, due to come round
 * again on its own, so the record still has something to protect.
 */
function freesTicketToday(iteration: Iteration): boolean {
  if (isCutOff(iteration) || failedOnInfrastructure(iteration)) {
    return true;
  }
  if (iteration.kind === "finished") {
    return iteration.handedBack.outcome !== "refused";
  }
  if (iteration.kind === "failed") {
    return (
      handedBackFailure(iteration) && iteration.handedBack.outcome !== "refused"
    );
  }
  return iteration.notClosed === undefined;
}

/**
 * The second step: run the selected ticket and record what that cost. An
 * implementation ticket hands its work over as a draft pull request with a
 * review queued against it, or — when the agent gave up — puts the ticket back
 * in the developer's hands. An infrastructure failure, a limit refusal or a
 * provider failure leaves the ticket untouched. A review ticket's own run
 * posts its findings itself and is closed once it has; an apply-review
 * ticket's pushes and replies itself, and is closed once the repo host shows
 * every thread answered; a rebase ticket's force-pushes itself, and is closed
 * once the repo host no longer reports its pull request conflicting.
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
  if (run.kind === "limit-refused" || run.kind === "provider-failed") {
    return cutOffRunOutcome(run, await discardBranch(ports.repoHost, checkout, run));
  }
  if (run.kind === "model-refused") {
    return handModelRefusedBack(
      ports,
      selection.ticket,
      run.refusal,
      run.tokensUsed,
      run.transcript,
      { checkout, run },
    );
  }
  if (run.kind === "finished") {
    return handOver(ports, run, checkout, selection.ticket);
  }

  const failure: GaveUp = { kind: "gave-up", reason: run.reason };
  const handedBack = await handBack(ports, selection.ticket, {
    ...failure,
    ticketKind: "implementation",
    output: run.output,
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
    const handedBack = await handBack(ports, ticket, { kind: "finished", run });
    return { kind: "finished", run, tokensUsed: run.tokensUsed, handedBack };
  }

  const opening = await ports.repoHost.openDraftPullRequest(
    checkout,
    run.branch,
    ticket,
    run.gist,
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
  const handedBack = await handBack(ports, ticket, failure);
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
 *
 * Narrates the container it starts, naming `spendCeiling`, and the run it
 * ends, naming what `outcome` spent — the two announcements every kind of
 * run shares, whatever it goes on to make of its own result.
 */
async function runInSandbox<Outcome extends { tokensUsed: TokenCount }>(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: Ticket,
  spendCeiling: Usd,
  state: Map<RepoSlug, ProjectState>,
  sandboxCall: (checkout: Checkout) => Promise<Outcome>,
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
  let outcome: Outcome;
  try {
    outcome = await sandboxCall(checkout);
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

  return runInSandbox(ports, repo, ticket, spendCeiling, state, (checkout) =>
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
 * the last step and the ticket closing is what matters. TODO[#407]: render
 * `notLabelled` to the developer; it is only recorded on the iteration today.
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
 * A review ticket's own run: the reviewer examines the pull request the
 * ticket names and posts its findings there itself, in a container with no
 * write access to its clone. The loop's only remaining part is closing the
 * ticket once that finished, then labelling its pull request `reviewed` — a
 * review that posted needs nobody to close it by hand.
 *
 * Closing rests on the pull request actually carrying a new comment, not on
 * the sandbox process merely exiting clean: an agent can run the review skill
 * fine and still fail its own last step, `gh pr comment`, and a ticket closed
 * on process success alone would tell the developer a review happened when
 * nothing was ever posted. Either way nothing did — an agent that gave up, or
 * a clean exit that posted nothing — the ticket is handed back, as an
 * implementation ticket's is.
 *
 * A pull request already merged or closed by the time the iteration starts is
 * checked for first, before any of that: there is nothing left to review, so
 * the ticket is closed with a comment naming which, and no run starts.
 *
 * A checkout or a sandbox that could not do its part is an infrastructure
 * failure here exactly as for an implementation run: reported, the ticket left
 * as it was, and the invocation carries on. A check, a close or a label that
 * fails after the review ran is reported on the iteration, never raised.
 */
async function runReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: ReviewTicket,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<Reviewed | LimitRefused | ProviderFailed | Failed | PullRequestResolved> {
  const resolved = await resolvedPullRequestOutcome(ports, ticket, (comment) =>
    ports.tracker.closeReviewTicket(ticket, comment),
  );
  if (resolved !== undefined) {
    return resolved;
  }

  const startedAt = ports.clock.now();
  const result = await runInSandbox(ports, repo, ticket, spendCeiling, state, (checkout) =>
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

  if (review.kind === "limit-refused" || review.kind === "provider-failed") {
    return cutOffReviewOutcome(review);
  }
  // Handed back rather than left to come round again, as an implementation
  // ticket's is: every later morning would refuse the same model the same way.
  if (review.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, review.refusal, review.tokensUsed, review.transcript);
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
  const labelled = await labelClosedPullRequest(
    ports,
    ticket.pullRequest.url,
    REVIEWED_LABEL,
  );
  return { kind: "reviewed", review, tokensUsed: review.tokensUsed, ...labelled };
}

/** Hands back a review that left no findings on its pull request, as an agent that gave up. */
async function handReviewBack(
  ports: MorningLoopPorts,
  ticket: ReviewTicket,
  review: ReviewFinished | ReviewGaveUp,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason };
  const handedBack = await handBack(ports, ticket, {
    ...failure,
    ticketKind: "review",
    output: review.output,
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
 */
async function runApplyReview(
  ports: MorningLoopPorts,
  repo: RepoSlug,
  ticket: ApplyReviewTicket,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<AppliedReview | LimitRefused | ProviderFailed | Failed | PullRequestResolved> {
  const pullRequest = ticket.pullRequest.url;

  const resolved = await resolvedPullRequestOutcome(ports, ticket, (comment) =>
    ports.tracker.closeApplyReviewTicket(ticket, comment),
  );
  if (resolved !== undefined) {
    return resolved;
  }

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

  const result = await runInSandbox(ports, repo, ticket, spendCeiling, state, (checkout) =>
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

  if (run.kind === "limit-refused" || run.kind === "provider-failed") {
    return cutOffReviewOutcome(run);
  }
  if (run.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, run.refusal, run.tokensUsed, run.transcript);
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
 * Marks `ticket`'s pull request ready for review, closes the ticket with a
 * comment saying what `applied` came to, then labels the pull request
 * `applied-review`. Never throws: a failure marking it ready or closing the
 * ticket is reported on the iteration and leaves the ticket open; a refused
 * label is reported too, but by then the ticket has already closed.
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
  const labelled = await labelClosedPullRequest(
    ports,
    pullRequest,
    APPLIED_REVIEW_LABEL,
  );
  return { ...applied, ...labelled };
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
  repo: RepoSlug,
  ticket: RebaseTicket,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<Rebased | LimitRefused | ProviderFailed | Failed | PullRequestResolved> {
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

  const result = await runInSandbox(ports, repo, ticket, spendCeiling, state, (checkout) =>
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

  if (run.kind === "limit-refused" || run.kind === "provider-failed") {
    return cutOffReviewOutcome(run);
  }
  if (run.kind === "model-refused") {
    return handModelRefusedBack(ports, ticket, run.refusal, run.tokensUsed, run.transcript);
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
  });
  return {
    kind: "failed",
    tokensUsed: run.tokensUsed,
    ...(run.transcript !== undefined && { transcript: run.transcript }),
    failure,
    handedBack,
  };
}
