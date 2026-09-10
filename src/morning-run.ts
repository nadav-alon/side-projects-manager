import type {
  Budget,
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
import { recordRun } from "./ports/index.ts";
import { budgetGate, type StandDown } from "./budget-gate.ts";

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
   * Why the gate refused, absent when it did not. A morning that stood down
   * had work to do and declined to do it, which is neither a dry queue nor a
   * failure, and says so rather than going quiet.
   */
  standDown?: StandDown;
  /**
   * The review ticket queued for that pull request. Absent wherever the pull
   * request is, since a review is only ever queued for one that exists.
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
 * What working one project came to, and everything the report says about it:
 * the run, the draft pull request its commits are waiting in, and the review
 * queued for that pull request.
 *
 * Named for the handover rather than for the work, because the work is the
 * run — this is how it reaches the developer.
 */
interface Handover {
  run: SandboxRunResult;
  /**
   * Absent when there was nothing to hand over: a run that committed nothing,
   * or one the agent did not finish.
   */
  pullRequest?: PullRequestUrl;
  /** Absent alongside the pull request, which is the thing it reviews. */
  reviewTicket?: Ticket;
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

  let handover: Handover | undefined;
  let standDown: StandDown | undefined;
  try {
    if (selection !== undefined) {
      const budget = await ports.store.loadBudget();
      standDown = await consultTheGate(ports, budget, state);
      if (standDown === undefined) {
        handover = await work(ports, selection, state, budget.spendCeiling);
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
    // Spread whole: a handover is exactly the run, pull request and review the
    // report owes, so re-splitting it field by field would be two places to
    // keep the same shape.
    ...handover,
    ...(standDown !== undefined && { standDown }),
    outcome: outcomeOf(selection, standDown),
    message: summaryLine(outcomes, handover, standDown),
  };
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
 * The second step: run the selected ticket, hand the work over as a draft
 * pull request, and record what that cost.
 *
 * The checkout comes from the repo host rather than from anything the loop
 * remembers, so a project whose clone has gone missing heals on the way into
 * the run instead of failing the morning.
 *
 * A run that committed nothing is handed over to nobody: the sandbox leaves no
 * branch behind for it, and a pull request with no commits in it is not
 * something to open and not something to review.
 */
async function work(
  ports: MorningRunPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
): Promise<Handover> {
  const repo = selection.project.repo;
  const checkout = await ports.repoHost.clone(repo);
  const run = await ports.sandbox.run({
    ticket: selection.ticket,
    checkout,
    spendCeiling,
  });

  const at = ports.clock.now();
  const cost = { at, tokensUsed: run.tokensUsed };
  state.set(repo, recordRun(state.get(repo), cost));

  // Only a run that finished and committed. A failed agent's commits are not
  // work to review, so they stay on the branch in the checkout rather than
  // becoming a pull request the developer has to judge.
  //
  // TODO[#13]: decide what becomes of them.
  if (run.commits.length === 0 || run.failure !== undefined) {
    return { run };
  }

  const pullRequest = await ports.repoHost.openDraftPullRequest(
    checkout,
    run.branch,
    selection.ticket,
  );

  // Queued here rather than asked of the agent that wrote the code: an agent
  // that ran out of steam cannot forget to, and the review it asks for is a
  // run of its own rather than the tail of the one being reviewed.
  //
  // TODO[#10]: until then the review is selected and run as an implementation,
  // which is what the ready-for-agent label makes it look like.
  //
  // TODO[#13]: report a review that could not be opened as a failed run, so
  // that a morning which did push a branch and open a pull request still says
  // where they are.
  const reviewTicket = await ports.tracker.createReviewTicket(
    selection.ticket,
    pullRequest,
  );

  return { run, pullRequest, reviewTicket };
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
  handover: Handover | undefined,
  standDown: StandDown | undefined,
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
    // A failed agent that committed still says what it landed, and then why it
    // stopped: the developer needs both to know whether to keep the branch.
    const stopped =
      handover?.run.failure === undefined
        ? ""
        : ` The agent failed: ${handover.run.failure}.`;
    return `Worked ${selected.repo}: ${landed(handover)}.${stopped}${aside}`;
  }
  if (skipped.length === 0) {
    return "Nothing to do: no projects registered. Add one to registry.json (see README).";
  }
  return `Nothing to do: skipped ${skipped.join(", ")}.`;
}

/**
 * Where the morning's work ended up.
 *
 * A run that committed nothing left no branch behind either — the sandbox
 * keeps one only for commits — so there is nothing to name. Commits without a
 * pull request are a failed agent's: the branch is in the checkout, and saying
 * where is how the developer decides whether to keep it.
 */
function landed(handover: Handover | undefined): string {
  if (handover === undefined || handover.run.commits.length === 0) {
    return "the run left nothing behind";
  }
  const where =
    handover.pullRequest === undefined
      ? handover.run.branch
      : `${handover.run.branch} (${handover.pullRequest})`;
  return `${commitCount(handover.run)} on ${where}`;
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
