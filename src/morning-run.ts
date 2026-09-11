import type {
  Budget,
  Checkout,
  Clock,
  IssueTracker,
  ProjectState,
  PullRequestUrl,
  RegisteredProject,
  RepoHost,
  RepoSlug,
  RunCost,
  Sandbox,
  SandboxRunResult,
  State,
  Store,
  Ticket,
  TokenCount,
  UsageLedger,
  Usd,
} from "./ports/index.ts";
import { READY_FOR_AGENT_LABEL, recordRun } from "./ports/index.ts";
import { budgetGate, type StandDown } from "./budget-gate.ts";
import { handbackComment, type Discard } from "./handback-comment.ts";
import { errorMessage } from "./error-message.ts";

/**
 * The six outside-world dependencies of the loop. Everything it knows about
 * GitHub, containers, session logs, the filesystem and the wall clock arrives
 * through these.
 */
export interface MorningRunPorts {
  tracker: IssueTracker;
  repoHost: RepoHost;
  sandbox: Sandbox;
  ledger: UsageLedger;
  clock: Clock;
  store: Store;
}

export type MorningRunOutcome =
  /** No registered project had an eligible ticket. A quiet morning. */
  | "dry-queue"
  /** There was work, and the budget gate refused to start it. */
  | "stood-down"
  /** An iteration selected a project with work. */
  | "work-selected";

/** What became of one registered project. */
export type ProjectVerdict =
  /** Paused in the registry, so not considered at all. */
  | "paused"
  /** Considered, and its backlog held nothing eligible. */
  | "no-eligible-tickets"
  /** Considered and selected: the project this iteration works. */
  | "selected";

/**
 * Whose problem a failed run is.
 *
 * The distinction is the one the developer acts on: a hard ticket is theirs to
 * rewrite or drop, a broken sandbox is theirs to fix, and a morning that says
 * only "it failed" makes them go and find out which.
 */
export type FailureKind =
  /** The agent ran and stopped short: it said it could not, or left the tests red. */
  | "gave-up"
  /** The sandbox or the repo host could not do its part, so nothing ran. */
  | "infrastructure";

/** Why an iteration's run did not finish. */
export interface RunFailure {
  kind: FailureKind;
  reason: string;
  /**
   * Whether the ticket made it back to the developer. False says the loop
   * could not comment or relabel, so the ticket is still eligible and will be
   * selected again — the one case where a morning needs the developer to go
   * and look at the ticket themselves.
   */
  handedBack: boolean;
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
}

/** What one invocation did. The summary issue is written from this. */
export interface MorningRunReport {
  /** When the invocation started. */
  startedAt: Date;
  outcome: MorningRunOutcome;
  /**
   * Every registered project the invocation reached, in registry order, with
   * why each was skipped. Projects behind the selected one are absent, since
   * an iteration stops once it has a project to work.
   */
  projects: ProjectOutcome[];
  /** What the run left behind. Absent on a morning that ran nothing. */
  run?: SandboxRunResult;
  /**
   * The draft pull request the run's work is waiting in. Absent when the
   * morning ran nothing, and when the run left no commits to open one for.
   */
  pullRequest?: PullRequestUrl;
  /**
   * Why the run did not finish, absent when it did or when nothing ran.
   *
   * A failure is reported rather than thrown: the iteration is over, but the
   * invocation is not, and a morning that ends in a stack trace tells the
   * developer nothing about the projects it never reached.
   */
  failure?: RunFailure;
  /**
   * Why the gate refused, absent when it did not. A morning that stood down
   * had work to do and declined to do it, which is neither a dry queue nor a
   * failure, and says so rather than going quiet.
   */
  standDown?: StandDown;
  /**
   * The review ticket queued for that pull request. Absent wherever the pull
   * request is absent, since a review is only ever queued for one that exists.
   */
  reviewTicket?: Ticket;
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/** The project an iteration works, and the ticket it works there. */
interface Selection {
  project: RegisteredProject;
  ticket: Ticket;
}

/**
 * What one iteration did with the ticket it selected: finished a run, or
 * failed one and handed the ticket back.
 *
 * Nothing here is thrown. A run that gave up, and one that never happened, are
 * described rather than raised, so the invocation still reports on the
 * projects behind them.
 */
type Iteration = Finished | Failed;

/** An iteration whose run finished, and how its work reached the developer. */
interface Finished {
  run: SandboxRunResult;
  /** Absent when the run committed nothing, so there was nothing to hand over. */
  handover?: Handover;
}

/**
 * What a finished run comes to for the developer: the draft pull request its
 * commits wait in, and the review queued against that pull request.
 */
interface Handover {
  pullRequest: PullRequestUrl;
  reviewTicket: Ticket;
}

/** An iteration whose run did not finish, and so handed its ticket back. */
interface Failed {
  failure: RunFailure;
  /** What the agent left behind. Absent when it never ran. */
  run?: SandboxRunResult;
}

/** What walking the registry came to: the verdicts, and any work found. */
interface RegistryScan {
  outcomes: ProjectOutcome[];
  /** Absent when no project had an eligible ticket. */
  selection?: Selection;
}

/**
 * One invocation of the morning loop: one project, one ticket, one run.
 *
 * No run starts without the gate's say-so. The gate is asked from inside the
 * run path rather than at the top of the invocation, so what it reads is the
 * state as it stands when a run would start, the previous run's cost included.
 *
 * TODO[#11]: iterate, and re-check the gate between iterations.
 */
export async function morningRun(
  ports: MorningRunPorts,
): Promise<MorningRunReport> {
  const startedAt = ports.clock.now();
  const state = new Map(await ports.store.loadState());
  const { outcomes, selection } = await considerProjects(ports, state);

  let iteration: Iteration | undefined;
  let standDown: StandDown | undefined;
  try {
    if (selection !== undefined) {
      const budget = await ports.store.loadBudget();
      standDown = await consultTheGate(ports, budget, state);
      if (standDown === undefined) {
        iteration = await work(ports, selection, state, budget.spendCeiling);
      }
    }
  } finally {
    // State is written back at the end of every invocation, including one that
    // worked nothing and one whose run failed part way, so that a machine
    // which has run the loop always has a state document to read next morning.
    // A run that fell over still spent tokens, and the morning it spent them
    // on is exactly the one worth having recorded.
    await ports.store.saveState(state);
  }

  return {
    startedAt,
    projects: outcomes,
    ...(iteration !== undefined && reported(iteration)),
    ...(standDown !== undefined && { standDown }),
    outcome: outcomeOf(selection, standDown),
    message: summaryLine(outcomes, iteration, standDown, selection?.ticket),
  };
}

/** What the report says about an iteration. */
function reported(
  iteration: Iteration,
): Pick<MorningRunReport, "run" | "pullRequest" | "reviewTicket" | "failure"> {
  if ("failure" in iteration) {
    const { failure, run } = iteration;
    return { failure, ...(run !== undefined && { run }) };
  }
  return { run: iteration.run, ...iteration.handover };
}

function outcomeOf(
  selection: Selection | undefined,
  standDown: StandDown | undefined,
): MorningRunOutcome {
  if (selection === undefined) {
    return "dry-queue";
  }
  return standDown === undefined ? "work-selected" : "stood-down";
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
 * A dry morning never gets here, so the loop reports a quiet queue as a quiet
 * queue rather than reading the ledger to decline work that did not exist.
 */
async function consultTheGate(
  ports: MorningRunPorts,
  budget: Budget,
  state: State,
): Promise<StandDown | undefined> {
  return budgetGate(
    await ports.ledger.read(ports.clock.now()),
    budget,
    runsRecorded(state),
  );
}

/** Every run the mornings have made, across every project, oldest first. */
function runsRecorded(state: State): RunCost[] {
  return [...state.values()]
    .flatMap((project) => project.runs)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * The first step of an iteration: walk the registry until a project has an
 * eligible ticket. A paused project is passed over without asking the tracker
 * anything, because paused means never considered.
 *
 * TODO[#11]: order by reviews before implementations, then explicit
 * priority, then least recently worked.
 */
async function considerProjects(
  ports: MorningRunPorts,
  state: State,
): Promise<RegistryScan> {
  const outcomes: ProjectOutcome[] = [];

  for (const project of await ports.store.loadRegistry()) {
    const projectState = state.get(project.repo);

    if (project.paused) {
      outcomes.push(outcome(project.repo, "paused", projectState));
      continue;
    }

    const backlog = await ports.tracker.listEligibleTickets(project.repo);
    const ticket = backlog[0];
    if (ticket !== undefined) {
      outcomes.push(outcome(project.repo, "selected", projectState));
      return { outcomes, selection: { project, ticket } };
    }

    outcomes.push(outcome(project.repo, "no-eligible-tickets", projectState));
  }

  return { outcomes };
}

/**
 * The second step: run the selected ticket, record what that cost, and then
 * either hand the work over as a draft pull request with a review queued
 * against it or — when the run failed — put the ticket back in the
 * developer's hands.
 *
 * A failed run is the iteration's business, not the invocation's: it ends this
 * iteration and is reported, so the projects behind it are still reachable and
 * the morning still writes a summary.
 */
async function work(
  ports: MorningRunPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
): Promise<Iteration> {
  const returned = await attemptRun(ports, selection, state, spendCeiling);
  if ("failure" in returned) {
    return handTicketBack(ports, selection.ticket, returned, { kind: "none" });
  }

  const { run, checkout } = returned;
  if (run.failure === undefined) {
    return handOver(ports, run, checkout, selection.ticket);
  }

  // The branch goes first, so the comment can say what became of it — but it
  // cannot cost the ticket its hand-back. Git refuses to delete a branch that
  // some worktree has checked out, and a ticket left eligible because of that
  // is the failure this whole policy exists to prevent.
  const discard = await discardBranch(ports, checkout, run);
  return handTicketBack(
    ports,
    selection.ticket,
    { run, failure: { kind: "gave-up", reason: run.failure, handedBack: false } },
    discard,
  );
}

/**
 * The draft pull request a finished run's commits wait in, and the review
 * queued against it.
 *
 * A run that committed nothing is handed over to nobody: the sandbox leaves no
 * branch behind for it, and a pull request with no commits in it is not
 * something to open and not something to review.
 *
 * Only a run that finished. A failed agent's commits never reach here — they
 * go to `discardBranch` instead, because they are not work to review.
 */
async function handOver(
  ports: MorningRunPorts,
  run: SandboxRunResult,
  checkout: Checkout,
  ticket: Ticket,
): Promise<Finished> {
  if (run.commits.length === 0) {
    return { run };
  }

  const pullRequest = await ports.repoHost.openDraftPullRequest(
    checkout,
    run.branch,
    ticket,
  );

  // Queued here rather than asked of the agent that wrote the code: an agent
  // that ran out of steam cannot forget to, and the review it asks for is a
  // run of its own rather than the tail of the one being reviewed.
  //
  // TODO[#10]: tell a review from an implementation when selecting one.
  //
  // TODO[#13]: report a review that could not be opened as a failed run, so
  // that a morning which did push a branch and open a pull request still says
  // where they are.
  const reviewTicket = await ports.tracker.createReviewTicket(
    ticket,
    pullRequest,
  );

  return { run, handover: { pullRequest, reviewTicket } };
}

/**
 * Puts a failed run's ticket back in the developer's hands, and says whether
 * it got there.
 *
 * Never throws. A tracker that could not be reached leaves the ticket eligible,
 * and saying so is the one thing still worth doing.
 */
async function handTicketBack(
  ports: MorningRunPorts,
  ticket: Ticket,
  failed: Failed,
  discard: Discard,
): Promise<Failed> {
  const { failure, run } = failed;
  try {
    await ports.tracker.handBack(ticket, handbackComment(failure, run, discard));
    return { ...failed, failure: { ...failure, handedBack: true } };
  } catch (error: unknown) {
    // The policy itself could not be carried out, which leaves the ticket
    // eligible and due to come round again. Saying so is what is left: a
    // silent failure here is the one that costs a morning every morning.
    return {
      ...failed,
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
  ports: MorningRunPorts,
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
  ports: MorningRunPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
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
    });
  } catch (error: unknown) {
    // Nothing comes back from a rejected run — no branch, no output, and no
    // token count — so there is nothing to record against the project, and no
    // branch to discard: fetching one back is the last thing a run does that
    // can fail. The sandbox can reject after the agent has already worked,
    // though, and that run's spend is lost to the ledger.
    // TODO[#35]: record what a run spent even when the sandbox rejects.
    return {
      failure: {
        kind: "infrastructure",
        reason: errorMessage(error),
        handedBack: false,
      },
    };
  }

  const at = ports.clock.now();
  const cost = { at, tokensUsed: run.tokensUsed };
  state.set(repo, recordRun(state.get(repo), cost));

  return { run, checkout };
}

function outcome(
  repo: RepoSlug,
  verdict: ProjectVerdict,
  state: ProjectState | undefined,
): ProjectOutcome {
  const lastWorkedAt = state?.lastWorkedAt;
  return {
    repo,
    verdict,
    ...(lastWorkedAt !== undefined && { lastWorkedAt }),
  };
}

function isSelected(project: ProjectOutcome): boolean {
  return project.verdict === "selected";
}

/** How a verdict reads to the developer. A selected project was not skipped. */
function skipReason(verdict: ProjectVerdict): string | undefined {
  switch (verdict) {
    case "paused":
      return "paused";
    case "no-eligible-tickets":
      return "no ready-for-agent tickets";
    case "selected":
      return undefined;
  }
}

function summaryLine(
  projects: ProjectOutcome[],
  iteration: Iteration | undefined,
  standDown: StandDown | undefined,
  ticket: Ticket | undefined,
): string {
  const selected = projects.find(isSelected);
  const skipped = projects.flatMap((project) => {
    const reason = skipReason(project.verdict);
    return reason === undefined ? [] : [`${project.repo} (${reason})`];
  });

  const aside = skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : "";

  if (selected !== undefined && standDown !== undefined) {
    return `Stood down: ${standDownReason(standDown)}. ${selected.repo} was ready to work; the window resets ${standDown.resetsAt.toISOString()}.${aside}`;
  }
  if (selected !== undefined) {
    if (iteration !== undefined && "failure" in iteration) {
      return `Attempted ${selected.repo}: ${stoppedBecause(iteration.failure, ticket)}${aside}`;
    }
    return `Worked ${selected.repo}: ${landed(iteration)}.${queued(iteration)}${aside}`;
  }
  if (skipped.length === 0) {
    return "Nothing to do: no projects registered. Add one to registry.json (see README).";
  }
  return `Nothing to do: skipped ${skipped.join(", ")}.`;
}

/**
 * The review waiting on the developer, named by number because that is how a
 * backlog is read. Nothing to say on a morning that opened no pull request,
 * which is the only morning that queues no review.
 */
function queued(finished: Finished | undefined): string {
  const review = finished?.handover?.reviewTicket;
  return review === undefined ? "" : ` Queued #${review.number} to review it.`;
}

/**
 * Why the morning stopped, in the half-sentence the summary carries.
 *
 * Names the ticket, because the developer's next move is to open it: the whole
 * of what happened is in the comment waiting there.
 */
function stoppedBecause(
  failure: RunFailure,
  ticket: Ticket | undefined,
): string {
  const what =
    failure.kind === "gave-up" ? "the agent gave up" : "the run would not start";
  const which = ticket === undefined ? "the ticket" : `#${ticket.number}`;
  // A ticket that could not be handed back is the one thing here the developer
  // has to act on themselves: it is still eligible, so it will come round and
  // cost another morning until somebody relabels it.
  const now = failure.handedBack
    ? "Handed back for a human."
    : `${which} is still ${READY_FOR_AGENT_LABEL} and will come round again — relabel it yourself.`;
  return `${what} on ${which}: ${failure.reason}. ${now}`;
}

/**
 * Where the morning's work ended up.
 *
 * A run that committed nothing left no branch behind either — the sandbox
 * keeps one only for commits — so there is nothing to name. A run that failed
 * never gets here: the summary says why it stopped instead.
 */
function landed(finished: Finished | undefined): string {
  if (finished === undefined || finished.run.commits.length === 0) {
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
