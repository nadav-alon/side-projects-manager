import type {
  Branch,
  Budget,
  Checkout,
  Clock,
  IssueTracker,
  IterationLimit,
  ModelDefaults,
  ModelName,
  ModelRefusal,
  Priority,
  ProjectState,
  PullRequestUrl,
  RegisteredProject,
  RepoHost,
  RepoSlug,
  ReviewRunResult,
  ReviewTicket,
  RunCost,
  Sandbox,
  SandboxRunResult,
  State,
  Store,
  Ticket,
  TicketPriority,
  TokenCount,
  UsageLedger,
  Usd,
} from "./ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  isBlocked,
  isBrokenOut,
  isReviewTicket,
  localDay,
  recordRun,
  ticketKind,
} from "./ports/index.ts";
import { budgetGate, type StandDown } from "./budget-gate.ts";
import { workedTickets, type WorkedTickets } from "./worked-today.ts";
import {
  committedNothingComment,
  handbackComment,
  handoverComment,
  handoverFailureComment,
  modelRefusalComment,
  reviewHandbackComment,
  unusableModelLabelComment,
  workLocation,
  type Discard,
} from "./handback-comment.ts";
import { errorMessage } from "./error-message.ts";

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

/** What became of one registered project. */
export type ProjectVerdict =
  /** Paused in the registry, so not considered at all. */
  | "paused"
  /** Considered, and its backlog held nothing eligible. */
  | "no-eligible-tickets"
  /**
   * Had an eligible ticket, but another project outranked it this iteration —
   * a review elsewhere, an explicit priority, or simply having waited longer.
   * Not skipped for good: a later iteration in the same invocation, or
   * tomorrow's, may still pick it.
   */
  | "deferred"
  /** Considered and selected: the project this iteration works. */
  | "selected";

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

/** The model a ticket's run is started on, and what named it. */
export interface ResolvedModel {
  name: ModelName;
  source: ModelSource;
}

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
 * The sandbox or the repo host could not do its part, so nothing ran. Never
 * handed back: the ticket is left eligible on purpose, since the setup is the
 * problem.
 */
export interface InfrastructureFailure {
  kind: "infrastructure";
  reason: string;
}

/** One registered project, and what the invocation made of it. */
export interface ProjectOutcome {
  repo: RepoSlug;
  verdict: ProjectVerdict;
  /**
   * When an iteration last worked it, as the invocation found it. A project
   * this invocation went on to work still reads as it did beforehand, so the
   * report says what was true when the decision was made.
   */
  lastWorkedAt?: Date;
  /**
   * Tickets this scan found carrying ready-for-agent but passed over for
   * being broken out, in backlog order. What makes a backlog that looked
   * full but yielded nothing explicable, rather than indistinguishable from
   * one that was simply empty.
   */
  brokenOut?: Ticket[];
  /**
   * Tickets this scan found carrying ready-for-agent but passed over because
   * an open ticket blocks them, in backlog order — for the same reason as
   * `brokenOut`.
   */
  blocked?: Ticket[];
  /**
   * Set when this project's backlog held more eligible tickets than the read
   * kept — regardless of verdict, since a project outranked this morning can
   * still be the one whose backlog needs thinning.
   */
  backlogTruncated?: true;
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
   * or the provider limit refusing a run that had already started.
   * Either way it is why the invocation stopped rather than having simply run
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

/** Why an invocation stood down: the gate refused, or the provider did. */
export type InvocationStandDown = GateStandDown | ProviderLimitStandDown;

/** The project an iteration works, and the ticket it works there. */
interface Selection {
  project: RegisteredProject;
  ticket: Ticket;
}

/**
 * What one iteration did with the ticket it selected: finished a run, failed
 * one, worked a review ticket's own run, or had either kind of run refused by
 * the provider limit. Told apart by `kind`, and nothing else.
 *
 * Nothing here is thrown. A run that gave up, and one that never happened, are
 * described rather than raised, so the invocation still reports on the
 * projects behind them.
 */
type Iteration = Finished | Failed | Reviewed | LimitRefused;

/**
 * A limit refusal: an implementation or review run the provider limit
 * refused. Not a failure: the ticket is nobody's problem, so it is neither
 * commented on nor relabelled, and stays eligible for a morning with limit
 * left to spend.
 */
interface LimitRefused {
  kind: "limit-refused";
  /** What the provider said. */
  limitRefusal: string;
  tokensUsed: TokenCount;
  /** What the implementation run left behind. Absent for a review. */
  run?: SandboxRunResult;
  /** What became of any branch the run left, discarded as a failed run's is. */
  discard: Discard;
}

/** An iteration whose run finished, and how its work reached the developer. */
interface Finished {
  kind: "finished";
  run: SandboxRunResult;
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
interface Handover {
  pullRequest: PullRequestUrl;
  reviewTicket: Ticket;
}

/**
 * An iteration whose run did not finish: an agent that gave up, whose ticket
 * is handed back, or an infrastructure failure, whose ticket is left as it was.
 */
interface Failed {
  kind: "failed";
  failure: RunFailure;
  /** What the agent left behind. Absent when it never ran, and for a review. */
  run?: SandboxRunResult;
  /** What a review that ran spent, since it has no `run`. */
  tokensUsed?: TokenCount;
}

/**
 * The project and ticket an iteration worked, and the model its run was
 * started on — absent when the sandbox image's pin decided, and when no run
 * was started because the ticket's model labels were unusable.
 */
interface Attempt<T extends Ticket = Ticket> {
  repo: RepoSlug;
  ticket: T;
  model?: ModelName;
}

/** One iteration's outcome, and the project and ticket that earned it. */
export type IterationOutcome =
  | (Attempt & Finished)
  | (Attempt & Failed)
  | (Attempt<ReviewTicket> & Reviewed)
  | (Attempt & LimitRefused);

/**
 * One project with an eligible ticket, as far as selection is concerned: the
 * project itself, the ticket selection would work on its behalf, and whether
 * that ticket is a review — everything the ordering rule needs and nothing
 * it has to ask the tracker twice for.
 */
interface Candidate {
  project: RegisteredProject;
  ticket: Ticket;
  isReview: boolean;
  priority?: Priority;
  lastWorkedAt?: Date;
}

/**
 * A review ticket's own run that finished without the agent giving up. There
 * is no pull request to name here — the review ticket already names the one
 * it is about — and no further review to queue, since nothing reviews a
 * review. A review that gave up or posted nothing is `Failed` instead.
 */
interface Reviewed {
  kind: "reviewed";
  review: ReviewRunResult;
  /**
   * Set when the loop could not finish the ticket off: the pull request could
   * not be checked for the posted comment, or the ticket could not be closed.
   * Either way it is still ready-for-agent, and the developer checks the pull
   * request and closes it by hand.
   */
  notClosed?: NotClosed;
}

/** Why a review that ran left its ticket open, and the error that stopped it. */
interface NotClosed {
  kind: "check-failed" | "close-failed";
  error: string;
}

/** What walking the registry came to: the verdicts, and any work found. */
interface RegistryScan {
  outcomes: ProjectOutcome[];
  /** Absent when no project had an eligible, not-yet-worked ticket. */
  selection?: Selection;
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
 */
export async function morningLoop(
  ports: MorningLoopPorts,
): Promise<InvocationReport> {
  const startedAt = ports.clock.now();
  // One slot per iteration, in the order they started. A slot is left empty
  // only by an iteration that threw.
  const outcomeSlots: (IterationOutcome | undefined)[] = [];
  const outcomesByRepo = new Map<RepoSlug, ProjectOutcome>();
  // Registry order as each repo is first seen. Read fresh every iteration
  // rather than snapshotted from the first scan, so a project the developer
  // adds mid-invocation still lands in the report instead of being silently
  // dropped from it.
  const registryOrder: RepoSlug[] = [];

  let standDown: InvocationStandDown | undefined;
  let invocationFailure: string | undefined;
  try {
    const stored = await ports.store.loadState();
    const projects = new Map(stored.projects);
    const worked = workedTickets(stored.workedToday, localDay(startedAt));
    const stateToSave = (): State => {
      const workedToday = worked.workedToday();
      return {
        projects,
        ...(workedToday !== undefined && { workedToday }),
      };
    };
    const modelDefaults = await ports.store.loadModelDefaults();
    const inProgress = new Set<Promise<void>>();
    // What an iteration in progress threw, rethrown once the others finish:
    // only a port breaking its own contract gets here.
    const thrown: unknown[] = [];
    // Read from the budget before every start. Nothing is in progress before
    // the first, so there is no limit to wait on until then.
    let concurrencyLimit: IterationLimit | undefined;
    const stopped = (): boolean =>
      standDown !== undefined || thrown.length > 0;
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

        const scan = await considerProjects(ports, projects, worked);
        // A project keeps its "selected" verdict once it has one: a later scan
        // in the same invocation, run after its ticket is excluded, would
        // otherwise read it right back to "no eligible tickets" and hide that
        // its turn already came.
        for (const project of scan.outcomes) {
          if (!registryOrder.includes(project.repo)) {
            registryOrder.push(project.repo);
          }
          if (outcomesByRepo.get(project.repo)?.verdict !== "selected") {
            outcomesByRepo.set(project.repo, project);
          }
        }

        if (scan.selection === undefined) {
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
        const { ticket } = scan.selection;

        // Ahead of the gate as well as of the run: handing a ticket back
        // spends nothing, so a morning the gate refuses still gives the
        // developer the ticket they need to fix.
        const unusable = unusableModelLabel(ticket);
        if (unusable !== undefined) {
          worked.record(ticket, localDay(ports.clock.now()));
          outcomeSlots.push({
            repo: scan.selection.project.repo,
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
          standDown ??= { ...refusal, refused: scan.selection.project.repo };
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

        const { repo } = scan.selection.project;
        const model = resolveModel(ticket, modelDefaults);
        // Reported where it started, however long it then takes to finish.
        const slot = outcomeSlots.push(undefined) - 1;
        const completion: Promise<void> = work(
          ports,
          scan.selection,
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
  const outcomes = registryOrder.map(
    // Set for every repo named in `registryOrder`, which is read from the
    // very outcomes this populates.
    (repo) => outcomesByRepo.get(repo) as ProjectOutcome,
  );
  const facts: SummaryFacts = {
    projects: outcomes,
    iterations,
    standDown,
    invocationFailure,
  };
  const line = summaryLine(facts);

  // Last, so a morning that worked something still gets its state recorded
  // above even if the tracker refuses this. Never thrown: a summary issue
  // that could not be written must not cost the developer the account of
  // everything else the invocation did, which is exactly the account this
  // write exists to carry — said in the message instead, the same way a
  // tracker that refuses `handBack` is said rather than thrown.
  let publishFailure: string | undefined;
  try {
    await ports.tracker.publishSummary(
      summaryTitle(startedAt),
      summaryBody(facts, line),
    );
  } catch (error: unknown) {
    publishFailure = errorMessage(error);
  }

  return {
    startedAt,
    projects: outcomes,
    iterations,
    ...(standDown !== undefined && { standDown }),
    outcome: outcomeOf(iterations, standDown, invocationFailure),
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
    (iteration) =>
      !(iteration.kind === "failed" && isModelLabelFailure(iteration.failure)),
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
 * The first step of an iteration: ask every non-paused project's backlog for
 * a candidate ticket, then hand the best one to `bestCandidate`. A paused
 * project is passed over without asking the tracker anything, because paused
 * means never considered; a project this invocation has exhausted — every
 * eligible ticket already in `worked` — reads the same as an empty backlog.
 *
 * Every non-paused project is asked, never just enough to find one: priority
 * can make a project registered last outrank one registered first, so the
 * only way to know which project wins is to have looked at all of them.
 */
async function considerProjects(
  ports: MorningLoopPorts,
  projects: ProjectStates,
  worked: WorkedTickets,
): Promise<RegistryScan> {
  const outcomes: ProjectOutcome[] = [];
  const candidates: Candidate[] = [];
  // Where each candidate's placeholder verdict lives in `outcomes`, so the
  // winner's can be swapped for "selected" once every project has been seen.
  const outcomeIndexByRepo = new Map<RepoSlug, number>();

  for (const project of await ports.store.loadRegistry()) {
    const projectState = projects.get(project.repo);

    if (project.paused) {
      outcomes.push(outcome(project.repo, "paused", projectState));
      continue;
    }

    const { tickets, truncated: backlogTruncated } =
      await ports.tracker.listEligibleTickets(project.repo);
    const backlog = tickets.filter((ticket) => !worked.passesOver(ticket));
    // A ticket whose work has moved into open sub-issues is a container, not
    // work of its own — set aside here rather than in the tracker's query, so
    // the rule can be exercised against the fake and the summary can still
    // name what it passed over. A ticket an open ticket blocks is set aside
    // the same way: its work builds on work not yet done.
    const brokenOut: Ticket[] = [];
    const blocked: Ticket[] = [];
    const selectable: Ticket[] = [];
    for (const ticket of backlog) {
      if (isBrokenOut(ticket)) {
        brokenOut.push(ticket);
      } else if (isBlocked(ticket)) {
        blocked.push(ticket);
      } else {
        selectable.push(ticket);
      }
    }
    const findings: ScanFindings = { brokenOut, blocked, backlogTruncated };
    // A review in the same backlog as its parent ticket is worked before it.
    const ticket = bestTicket(selectable);

    if (ticket === undefined) {
      outcomes.push(
        outcome(project.repo, "no-eligible-tickets", projectState, findings),
      );
      continue;
    }

    candidates.push({
      project,
      ticket,
      isReview: isReviewTicket(ticket),
      ...(project.priority !== undefined && { priority: project.priority }),
      ...(projectState?.lastWorkedAt !== undefined && {
        lastWorkedAt: projectState.lastWorkedAt,
      }),
    });
    outcomeIndexByRepo.set(project.repo, outcomes.length);
    outcomes.push(outcome(project.repo, "deferred", projectState, findings));
  }

  const winner = bestCandidate(candidates);
  if (winner === undefined) {
    return { outcomes };
  }

  // Set by the loop above for every candidate, this one included.
  const winnerIndex = outcomeIndexByRepo.get(winner.project.repo) as number;
  const scanned = outcomes[winnerIndex] as ProjectOutcome;
  // Only the verdict changes: what the scan found, passed-over tickets and a
  // truncated backlog included, is as true of the winner as of any project it
  // outranked.
  outcomes[winnerIndex] = { ...scanned, verdict: "selected" };

  return {
    outcomes,
    selection: { project: winner.project, ticket: winner.ticket },
  };
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
 * Throws when the run was given no model: the sandbox reports a refusal only
 * for a model it was handed, so one arriving without is the port breaking its
 * contract, not something to read as any other kind of run.
 */
function modelRefused(
  refusal: ModelRefusal,
  model: ResolvedModel | undefined,
): ModelRefused {
  if (model === undefined) {
    throw new Error(
      `the sandbox reported the model ${refusal.model} refused for a run given no model`,
    );
  }
  const { source } = model;
  return {
    kind: "model-refused",
    reason: `the agent CLI refused the model ${refusal.model} (from the ${source}): ${refusal.words}`,
    refusal,
    source,
    handedBack: false,
  };
}

/**
 * The one ticket `backlog` offers selection, within a single project: a
 * review ticket before any implementation ticket, since finishing beats
 * starting; among implementation tickets, `Ticket.priority` ascending, with
 * an absent priority sorting after every ticket that has one; and, ties still
 * standing, the oldest ticket — the lowest issue number — so the order the
 * tracker happened to return them in never matters. Two review tickets, open
 * on two different implementation tickets, fall to the oldest ticket the same
 * way.
 */
function bestTicket(backlog: Ticket[]): Ticket | undefined {
  return [...backlog].sort(compareTickets)[0];
}

function compareTickets(a: Ticket, b: Ticket): number {
  if (isReviewTicket(a) !== isReviewTicket(b)) {
    return isReviewTicket(a) ? -1 : 1;
  }
  const byPriority = absentLast(a.priority, b.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  return a.number - b.number;
}

/**
 * Selection's ordering rule, applied as one comparison rather than as
 * separate passes: reviews before implementations, then explicit priority,
 * then least recently worked. Each level only breaks ties the level before it
 * left standing, so a review is never outranked by priority and priority is
 * never outranked by how long a project has waited.
 *
 * A project without a priority sorts after every project that has one, and a
 * project never worked sorts before every project that has been — it is, by
 * definition, the one that has waited longest.
 */
function bestCandidate(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort(compareCandidates)[0];
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.isReview !== b.isReview) {
    return a.isReview ? -1 : 1;
  }
  const byPriority = absentLast(a.priority, b.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  return leastRecentlyWorkedFirst(a.lastWorkedAt, b.lastWorkedAt);
}

/**
 * Ascending by a project's `Priority` or by a ticket's `TicketPriority`, never
 * one against the other, with an absent value sorting after every present
 * one. Not via arithmetic on a sentinel, since `Infinity - Infinity` is `NaN`,
 * and a comparator that can return `NaN` leaves `Array.prototype.sort` free to
 * return either order.
 */
function absentLast(a: Priority | undefined, b: Priority | undefined): number;
function absentLast(
  a: TicketPriority | undefined,
  b: TicketPriority | undefined,
): number;
function absentLast(
  a: Priority | TicketPriority | undefined,
  b: Priority | TicketPriority | undefined,
): number {
  if (a === undefined) {
    return b === undefined ? 0 : 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a - b;
}

function leastRecentlyWorkedFirst(
  a: Date | undefined,
  b: Date | undefined,
): number {
  if (a === undefined) {
    return b === undefined ? 0 : -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a.getTime() - b.getTime();
}

/**
 * Whether `iteration` was one of the two that say nothing about its ticket —
 * an infrastructure failure or a limit refusal — and so, as `work` leaves it,
 * leaves the ticket exactly as it was.
 */
function leavesTicketUntouched(iteration: Iteration): boolean {
  return (
    iteration.kind === "limit-refused" ||
    (iteration.kind === "failed" && iteration.failure.kind === "infrastructure")
  );
}

/**
 * The second step: run the selected ticket and record what that cost. An
 * implementation ticket hands its work over as a draft pull request with a
 * review queued against it, or — when the agent gave up — puts the ticket back
 * in the developer's hands. An infrastructure failure or a limit refusal
 * leaves the ticket untouched. A review ticket's own run posts its findings
 * itself and is closed once it has.
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
  if ("failure" in returned) {
    return returned;
  }

  const { run, checkout } = returned;
  if (run.limitRefusal !== undefined) {
    return {
      kind: "limit-refused",
      limitRefusal: run.limitRefusal,
      tokensUsed: run.tokensUsed,
      run,
      discard: await discardBranch(ports, checkout, run),
    };
  }
  if (run.modelRefusal !== undefined) {
    const failure = modelRefused(run.modelRefusal, model);
    const discard = await discardBranch(ports, checkout, run);
    return handTicketBack(
      ports,
      selection.ticket,
      failure,
      modelRefusalComment(selection.ticket, failure, run, discard),
      run,
    );
  }
  if (run.failure === undefined) {
    return handOver(ports, run, checkout, selection.ticket);
  }

  // The branch goes first, so the comment can say what became of it — but it
  // cannot cost the ticket its hand-back. Git refuses to delete a branch that
  // some worktree has checked out, and a ticket left eligible because of that
  // is the failure this whole policy exists to prevent.
  const discard = await discardBranch(ports, checkout, run);
  const failure: GaveUp = {
    kind: "gave-up",
    reason: run.failure,
    handedBack: false,
  };
  return handTicketBack(
    ports,
    selection.ticket,
    failure,
    handbackComment(failure, run, discard),
    run,
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
  run: SandboxRunResult,
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
  run: SandboxRunResult,
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
    run,
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
  run?: SandboxRunResult,
): Promise<Failed> {
  try {
    await ports.tracker.handBack(ticket, comment);
    return {
      kind: "failed",
      ...(run !== undefined && { run }),
      failure: { ...failure, handedBack: true },
    };
  } catch (error: unknown) {
    // The policy itself could not be carried out, which leaves the ticket
    // eligible and due to come round again. Saying so is what is left: a
    // silent failure here is the one that costs a morning every morning.
    return {
      kind: "failed",
      ...(run !== undefined && { run }),
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
  run: SandboxRunResult,
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

/**
 * The run itself, and what it cost.
 *
 * The checkout comes from the repo host rather than from anything the loop
 * remembers, so a project whose clone has gone missing heals on the way into
 * the run instead of failing the morning.
 *
 * The two ways a run ends badly are told apart by where they surface: the
 * sandbox port rejects only when it could not set itself up, start the agent,
 * or tear itself down, and reports an agent that gave up as a result carrying
 * `failure`.
 */
async function attemptRun(
  ports: MorningLoopPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
  model: ResolvedModel | undefined,
): Promise<{ run: SandboxRunResult; checkout: Checkout } | Failed> {
  const repo = selection.project.repo;

  let checkout: Checkout;
  let run: SandboxRunResult;
  try {
    checkout = await ports.repoHost.clone(repo);
    run = await ports.sandbox.run({
      ticket: selection.ticket,
      checkout,
      spendCeiling,
      ...(model !== undefined && { model: model.name }),
    });
  } catch (error: unknown) {
    // Nothing comes back from a rejected run — no branch, no output, and no
    // token count — so there is nothing to record against the project, and no
    // branch to discard: fetching one back is the last thing a run does that
    // can fail. The sandbox can reject after the agent has already worked,
    // though, and that run's spend is lost to the ledger.
    // TODO[#35]: record what a run spent even when the sandbox rejects.
    return infrastructureFailure(error);
  }

  const at = ports.clock.now();
  const cost = { at, tokensUsed: run.tokensUsed };
  state.set(repo, recordRun(state.get(repo), cost));

  return { run, checkout };
}

/** A checkout or a sandbox that could not do its part, as the iteration it comes to. */
function infrastructureFailure(error: unknown): Failed {
  return {
    kind: "failed",
    failure: { kind: "infrastructure", reason: errorMessage(error) },
  };
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
  let review: ReviewRunResult;
  try {
    const checkout = await ports.repoHost.clone(repo);
    review = await ports.sandbox.review({
      ticket,
      checkout,
      spendCeiling,
      ...(model !== undefined && { model: model.name }),
    });
  } catch (error: unknown) {
    return infrastructureFailure(error);
  }

  state.set(
    repo,
    recordRun(state.get(repo), {
      at: ports.clock.now(),
      tokensUsed: review.tokensUsed,
    }),
  );

  if (review.limitRefusal !== undefined) {
    return {
      kind: "limit-refused",
      limitRefusal: review.limitRefusal,
      tokensUsed: review.tokensUsed,
      discard: { kind: "none" },
    };
  }
  // Handed back rather than left to come round again, as an implementation
  // ticket's is: every later morning would refuse the same model the same way.
  if (review.modelRefusal !== undefined) {
    const failure = modelRefused(review.modelRefusal, model);
    return {
      ...(await handTicketBack(
        ports,
        ticket,
        failure,
        modelRefusalComment(ticket, failure, undefined, { kind: "none" }),
      )),
      tokensUsed: review.tokensUsed,
    };
  }

  if (review.failure !== undefined) {
    return handReviewBack(ports, ticket, review, review.failure);
  }

  let posted: boolean;
  try {
    posted = await ports.repoHost.hasNewComment(ticket.pullRequest, startedAt);
  } catch (error: unknown) {
    return {
      kind: "reviewed",
      review,
      notClosed: { kind: "check-failed", error: errorMessage(error) },
    };
  }
  if (!posted) {
    return handReviewBack(
      ports,
      ticket,
      review,
      `the agent ran but posted nothing to ${ticket.pullRequest}`,
    );
  }

  try {
    await ports.tracker.closeReviewTicket(ticket);
  } catch (error: unknown) {
    return {
      kind: "reviewed",
      review,
      notClosed: { kind: "close-failed", error: errorMessage(error) },
    };
  }
  return { kind: "reviewed", review };
}

/** Hands back a review that left no findings on its pull request, as an agent that gave up. */
async function handReviewBack(
  ports: MorningLoopPorts,
  ticket: ReviewTicket,
  review: ReviewRunResult,
  reason: string,
): Promise<Failed> {
  const failure: GaveUp = { kind: "gave-up", reason, handedBack: false };
  return {
    ...(await handTicketBack(
      ports,
      ticket,
      failure,
      reviewHandbackComment(failure, review),
    )),
    tokensUsed: review.tokensUsed,
  };
}

/**
 * What scanning one project's backlog found, whatever its verdict: the tickets
 * passed over, and whether the listing was truncated.
 */
interface ScanFindings {
  brokenOut: Ticket[];
  blocked: Ticket[];
  backlogTruncated: boolean;
}

function outcome(
  repo: RepoSlug,
  verdict: ProjectVerdict,
  state: ProjectState | undefined,
  {
    brokenOut = [],
    blocked = [],
    backlogTruncated = false,
  }: Partial<ScanFindings> = {},
): ProjectOutcome {
  const lastWorkedAt = state?.lastWorkedAt;
  return {
    repo,
    verdict,
    ...(lastWorkedAt !== undefined && { lastWorkedAt }),
    ...(brokenOut.length > 0 && { brokenOut }),
    ...(blocked.length > 0 && { blocked }),
    ...(backlogTruncated && { backlogTruncated: true }),
  };
}

/** How a verdict reads to the developer. A selected project was not skipped. */
function skipReason(verdict: ProjectVerdict): string | undefined {
  switch (verdict) {
    case "paused":
      return "paused";
    case "no-eligible-tickets":
      return "no ready-for-agent tickets";
    case "deferred":
      return "outranked this morning";
    case "selected":
      return undefined;
  }
}

/**
 * Names every ticket a scan passed over for being broken out or blocked,
 * whatever its project's verdict: a project can be selected for one ticket
 * while another in its backlog is passed over, and a backlog that looks full
 * but yields nothing is only explicable if the summary says so.
 */
function passedOverAside(projects: ProjectOutcome[]): string {
  const passedOver = projects.flatMap(({ repo, brokenOut, blocked }) => {
    const reasons = [
      ...(brokenOut === undefined
        ? []
        : [`${numbers(brokenOut)} broken out into sub-issues`]),
      ...(blocked === undefined
        ? []
        : [`${numbers(blocked)} blocked by an open ticket`]),
    ];
    return reasons.length > 0 ? [`${repo} (${reasons.join("; ")})`] : [];
  });
  return passedOver.length > 0 ? ` Passed over ${passedOver.join(", ")}.` : "";
}

/** Tickets as the summary names them: `#1, #2`. */
function numbers(tickets: Ticket[]): string {
  return tickets.map((ticket) => `#${ticket.number}`).join(", ");
}

/**
 * Everything the summary is built from: the outcome of every registered
 * project, every attempt this invocation made, why it stood down, if it did,
 * and whether the invocation itself broke before finishing. One type rather
 * than four parameters, since `summaryLine` and `summaryBody` both need
 * exactly these facts and nothing else.
 */
interface SummaryFacts {
  projects: ProjectOutcome[];
  iterations: IterationOutcome[];
  standDown: InvocationStandDown | undefined;
  invocationFailure: string | undefined;
}

function summaryLine(facts: SummaryFacts): string {
  if (facts.invocationFailure !== undefined) {
    return `The invocation did not finish: ${facts.invocationFailure}.`;
  }

  const { projects, iterations, standDown } = facts;
  const skipped = projects.flatMap((project) => {
    const reason = skipReason(project.verdict);
    return reason === undefined ? [] : [`${project.repo} (${reason})`];
  });

  const passedOver = passedOverAside(projects);
  const aside = `${skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : ""}${passedOver}`;

  if (iterations.length > 0) {
    // A stand-down after the morning had already done some good is said after
    // what was worked, since the developer still needs both.
    const worked = iterations.map(describeIteration).join(" ");
    const stopped =
      standDown === undefined
        ? ""
        : ` Stood down after that: ${whyStoodDown(standDown, "next")}`;
    return `${worked}${stopped}${aside}`;
  }
  // The gate refused before a single run this morning: there is work waiting,
  // named by the project the gate turned away, but none of it ran.
  if (standDown !== undefined) {
    return `Stood down: ${whyStoodDown(standDown, "first")}${aside}`;
  }
  if (skipped.length === 0) {
    return "Nothing to do: no projects registered. Add one to registry.json (see README).";
  }
  return `Nothing to do: skipped ${skipped.join(", ")}.${passedOver}`;
}

/**
 * Why the invocation stood down, and what that left waiting. The gate names
 * the project it turned away and when the window resets; a limit refusal
 * names the ticket it refused, which is still eligible, and quotes the reset
 * the provider gave.
 *
 * `when` is whether any run came before the stand-down, which only changes
 * how the gate's refused project is introduced.
 */
function whyStoodDown(
  standDown: InvocationStandDown,
  when: "first" | "next",
): string {
  if (standDown.reason === "provider-limit") {
    const { ticket, limitRefusal } = standDown;
    return `${limitRefusal}. ${ticket.repo} #${ticket.number} is still ${READY_FOR_AGENT_LABEL} and will come round again.`;
  }
  const ready =
    when === "next" ? "was ready to work next" : "was ready to work";
  return `${standDownReason(standDown)}. ${standDown.refused} ${ready}; the window resets ${standDown.resetsAt.toISOString()}.`;
}

/** The summary issue's title: dated, so a string of mornings reads in order. */
function summaryTitle(startedAt: Date): string {
  return `Morning loop summary — ${startedAt.toISOString().slice(0, 10)}`;
}

/**
 * The summary issue's body: CONTEXT.md's "Summary" entry, written out in
 * full. `message` stays the one line a terminal or a trigger's own log wants;
 * this is the fuller account — every attempt with its cost, and what is now
 * waiting on the developer — the issue itself carries. `line` is passed in
 * rather than recomputed from `facts`: the caller already built it for
 * `message`, and it reads the same either way.
 */
function summaryBody(facts: SummaryFacts, line: string): string {
  return [
    line,
    facts.iterations.length === 0
      ? undefined
      : attemptsSection(facts.iterations),
    waitingSection(facts.iterations),
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

/**
 * One bullet per attempt this invocation made, its outcome, its cost, and the
 * model it was started on. A ticket handed back for its model labels was never
 * started, so it names neither.
 */
function attemptsSection(iterations: IterationOutcome[]): string {
  const lines = iterations.map((iteration) => {
    if (
      iteration.kind === "failed" &&
      isModelLabelFailure(iteration.failure)
    ) {
      return `- ${describeIteration(iteration)} — nothing run`;
    }
    const spent = costOf(iteration);
    const cost =
      spent === undefined ? " — cost unknown" : ` — ${tokens(spent)} tokens`;
    return `- ${describeIteration(iteration)}${cost} on ${iteration.model ?? "the image's model"}`;
  });
  return ["## Attempts", ...lines].join("\n");
}

function isModelLabelFailure(
  failure: RunFailure,
): failure is UnusableModelLabel {
  return (
    failure.kind === "conflicting-model-labels" ||
    failure.kind === "unusable-model-label"
  );
}

/** A ticket whose hand-back itself failed: still eligible, still waiting on a human to relabel it by hand. */
function stillEligibleLine(iteration: {
  repo: RepoSlug;
  ticket: Ticket;
}): string {
  return `- ${iteration.repo} #${iteration.ticket.number}: still ${READY_FOR_AGENT_LABEL} — the hand-back itself failed, relabel it yourself`;
}

/**
 * What now needs the developer: a draft pull request to review, a ticket
 * relabelled for human attention, a setup that broke under a ticket it left
 * eligible, or — the one case a failed run can leave
 * behind that is the developer's alone, per `RunFailure.handedBack`'s own
 * note — a ticket the hand-back itself could not reach, still eligible and
 * due to come round again until somebody relabels it by hand. A review the
 * loop could not close is there for the same reason.
 */
function waitingSection(iterations: IterationOutcome[]): string | undefined {
  const lines = iterations.flatMap((iteration): string[] => {
    switch (iteration.kind) {
      case "reviewed":
        return iteration.notClosed === undefined
          ? []
          : [notClosedLine(iteration, iteration.notClosed)];
      // A limit refusal's ticket waits on the provider, not the developer.
      case "limit-refused":
        return [];
      case "failed":
        return [
          waitingOnFailure(iteration.repo, iteration.ticket, iteration.failure),
        ];
      case "finished": {
        // A finished run's own hand-back, covering the two cases a queued
        // review does not: a run that committed nothing, which has nothing to
        // name but the relabel itself, and a run whose hand-back — of either
        // kind — was refused by the tracker.
        const { handover, handbackFailure } = iteration;
        return [
          ...(handover === undefined
            ? []
            : [
                `- ${iteration.repo}: ${handover.pullRequest} — review queued as #${handover.reviewTicket.number}`,
              ]),
          ...(handbackFailure !== undefined
            ? [stillEligibleLine(iteration)]
            : handover === undefined
              ? [
                  `- ${iteration.repo} #${iteration.ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the run committed nothing`,
                ]
              : []),
        ];
      }
    }
  });

  return lines.length === 0
    ? undefined
    : ["## Waiting on you", ...lines].join("\n");
}

/** What a failed run leaves waiting on the developer. */
function waitingOnFailure(
  repo: RepoSlug,
  ticket: Ticket,
  failure: RunFailure,
): string {
  switch (failure.kind) {
    case "infrastructure":
      return `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL} — the sandbox or checkout failed, so fix the setup: ${failure.reason}`;
    case "gave-up":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL}`
        : stillEligibleLine({ repo, ticket });
    case "handover-failed":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — its work is on ${workLocation(failure)}, but ${failure.reason}`
        : stillEligibleLine({ repo, ticket });
    case "model-refused":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the model ${failure.refusal.model} was refused, so fix the ${failure.source}`
        : stillEligibleLine({ repo, ticket });
    case "conflicting-model-labels":
    case "unusable-model-label":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — fix its model labels (${failure.labels.join(", ")})`
        : stillEligibleLine({ repo, ticket });
  }
}

/**
 * What one iteration's run or review cost. Absent only for a run that never
 * started — an infrastructure failure before the sandbox spent anything.
 */
function costOf(iteration: IterationOutcome): TokenCount | undefined {
  switch (iteration.kind) {
    case "reviewed":
      return iteration.review.tokensUsed;
    case "limit-refused":
      return iteration.tokensUsed;
    case "failed":
      return iteration.run?.tokensUsed ?? iteration.tokensUsed;
    case "finished":
      return iteration.run.tokensUsed;
  }
}

/** One line for one iteration: what it landed, why it did not finish, or what it found. */
function describeIteration(iteration: IterationOutcome): string {
  switch (iteration.kind) {
    case "limit-refused": {
      const kept =
        iteration.discard.kind === "kept"
          ? ` Its branch ${iteration.run?.branch ?? ""} could not be discarded: ${iteration.discard.reason}.`
          : "";
      return `The provider limit refused the run on ${iteration.repo} #${iteration.ticket.number}.${kept}`;
    }
    case "failed":
      return `Attempted ${iteration.repo}: ${stoppedBecause(iteration.failure, iteration.ticket)}`;
    case "reviewed":
      return reviewSummary(iteration);
    case "finished":
      return `Worked ${iteration.repo}: ${landed(iteration)}.${queued(iteration)}${handbackNote(iteration)}`;
  }
}

/**
 * Says when a finished run's own hand-back — the relabel that takes its
 * ticket out of the queue — was refused. Empty when it succeeded, since
 * `landed` and `queued` already say what became of the run itself, and a
 * ticket successfully handed back needs nothing more said about it here.
 */
function handbackNote(finished: Finished): string {
  if (finished.handbackFailure === undefined) {
    return "";
  }
  return ` The ticket could not be handed back: ${finished.handbackFailure} — still ${READY_FOR_AGENT_LABEL} and will come round again; relabel it yourself.`;
}

/**
 * How a review ticket's own run reads to the developer: where its findings
 * landed, or why the loop could not finish the ticket off.
 */
function reviewSummary(
  iteration: { repo: RepoSlug; ticket: ReviewTicket } & Reviewed,
): string {
  const { repo, ticket, notClosed } = iteration;
  switch (notClosed?.kind) {
    case undefined:
      return `Reviewed ${repo} #${ticket.number}: posted findings on ${ticket.pullRequest}.`;
    case "check-failed":
      return `Reviewed ${repo} #${ticket.number}, but ${ticket.pullRequest} could not be checked for its findings: ${notClosed.error}. Still ${READY_FOR_AGENT_LABEL}: check ${ticket.pullRequest} and close it yourself.`;
    case "close-failed":
      return `Reviewed ${repo} #${ticket.number}: posted findings on ${ticket.pullRequest}, but the ticket could not be closed: ${notClosed.error}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
  }
}

/** The Waiting-on-you line for a review that ran but left its ticket open. */
function notClosedLine(
  { repo, ticket }: { repo: RepoSlug; ticket: ReviewTicket },
  notClosed: NotClosed,
): string {
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed.kind) {
    case "check-failed":
      return `${still} — ${ticket.pullRequest} could not be checked for its findings: ${notClosed.error}; check it and close the ticket yourself`;
    case "close-failed":
      return `${still} — its findings are on ${ticket.pullRequest}, but it could not be closed: ${notClosed.error}; close it yourself`;
  }
}

/**
 * The review waiting on the developer, named by number because that is how a
 * backlog is read. Nothing to say on a morning that opened no pull request,
 * which is the only morning that queues no review.
 */
function queued(finished: Finished): string {
  const review = finished.handover?.reviewTicket;
  return review === undefined ? "" : ` Queued #${review.number} to review it.`;
}

/**
 * Why the morning stopped, in the half-sentence the summary carries.
 *
 * Names the ticket, because the developer's next move is to open it: the whole
 * of what happened is in the comment waiting there.
 */
function stoppedBecause(failure: RunFailure, ticket: Ticket): string {
  const which = `#${ticket.number}`;
  if (failure.kind === "infrastructure") {
    return `the run would not start on ${which}: ${failure.reason}. ${which} is still ${READY_FOR_AGENT_LABEL}; fix the setup and it will come round again.`;
  }
  // A ticket that could not be handed back is the one thing here the developer
  // has to act on themselves: it is still eligible, so it will come round and
  // cost another morning until somebody relabels it.
  const now = failure.handedBack
    ? "Handed back for a human."
    : `${which} is still ${READY_FOR_AGENT_LABEL} and will come round again — relabel it yourself.`;
  switch (failure.kind) {
    case "gave-up":
      return `the agent gave up on ${which}: ${failure.reason}. ${now}`;
    case "handover-failed":
      return `${which} finished on ${workLocation(failure)}, but its work could not be handed over: ${failure.reason}. ${now}`;
    case "model-refused":
      return `${which} was not worked, because ${failure.reason}. ${now}`;
    case "conflicting-model-labels":
    case "unusable-model-label":
      return `${which} was not run, because ${failure.reason}. ${now}`;
  }
}

/**
 * Where one run's work ended up.
 *
 * A run that committed nothing left no branch behind either — the sandbox
 * keeps one only for commits — so there is nothing to name. A run that failed
 * never gets here: the summary says why it stopped instead.
 */
function landed(finished: Finished): string {
  if (finished.run.commits.length === 0) {
    return "the run left nothing behind";
  }
  const { run, handover } = finished;
  const where =
    handover === undefined
      ? run.branch
      : `${run.branch} (${handover.pullRequest})`;
  return `${commitCount(run)} on ${where}`;
}

/**
 * Why the gate refused, in the developer's terms: what was spent, against
 * what it was measured, and which of the two windows said no.
 */
function standDownReason(standDown: StandDown): string {
  const spent = `${tokens(standDown.tokensUsed)} of ${tokens(standDown.spendable)} tokens`;
  return standDown.reason === "weekly-reserve"
    ? `spending more of the week would eat into the reserve (${spent} spendable this week)`
    : `the 5-hour window is spent (${spent})`;
}

function tokens(count: TokenCount): string {
  return count.toLocaleString("en-US");
}

/** How many commits the run left, said the way a person would say it. */
function commitCount(run: SandboxRunResult): string {
  const count = run.commits.length;
  return count === 1 ? "1 commit" : `${count} commits`;
}
