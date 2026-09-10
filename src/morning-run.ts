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
  /** The agent ran and stopped short: it gave up, or left the tests red. */
  | "agent"
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
 * What became of one iteration: the run, the draft pull request holding its
 * commits, the review queued against that pull request, and why it stopped
 * when it did.
 *
 * One type rather than a handover and a failure, because an iteration ends in
 * exactly one of the two and the report has to say which. Nothing here is
 * thrown: a run that failed is still an attempt, and it is described rather
 * than raised.
 */
interface Attempt {
  /** Absent when the run never started. */
  run?: SandboxRunResult;
  /**
   * Absent when there was nothing to hand over: a run that committed nothing,
   * or one the agent did not finish.
   */
  pullRequest?: PullRequestUrl;
  /**
   * Absent wherever the pull request is absent, which is the thing it
   * reviews.
   */
  reviewTicket?: Ticket;
  /** Absent when the run finished cleanly. */
  failure?: RunFailure;
  /**
   * The project checkout the run happened against, and the one holding any
   * branch to discard. Absent when the checkout itself could not be made.
   */
  checkout?: Checkout;
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

  let attempt: Attempt = {};
  let standDown: StandDown | undefined;
  try {
    if (selection !== undefined) {
      const budget = await ports.store.loadBudget();
      standDown = await consultTheGate(ports, budget, state);
      if (standDown === undefined) {
        attempt = await work(ports, selection, state, budget.spendCeiling);
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
    // Field by field rather than spread whole: an attempt carries the checkout
    // the iteration worked in, which is the loop's business and not the
    // report's.
    ...(attempt.run !== undefined && { run: attempt.run }),
    ...(attempt.pullRequest !== undefined && {
      pullRequest: attempt.pullRequest,
    }),
    ...(attempt.reviewTicket !== undefined && {
      reviewTicket: attempt.reviewTicket,
    }),
    ...(attempt.failure !== undefined && { failure: attempt.failure }),
    ...(standDown !== undefined && { standDown }),
    outcome: outcomeOf(selection, standDown),
    message: summaryLine(outcomes, attempt, standDown, selection?.ticket),
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
): Promise<Attempt> {
  const attempt = await attemptRun(ports, selection, state, spendCeiling);
  const { failure } = attempt;
  if (failure === undefined) {
    return handOver(ports, attempt, selection.ticket);
  }

  // The branch goes first, so the comment can say what became of it — but it
  // cannot cost the ticket its hand-back. Git refuses to delete a branch that
  // some worktree has checked out, and a ticket left eligible because of that
  // is the failure this whole policy exists to prevent.
  const remains = await discardBranch(ports, attempt);

  try {
    await ports.tracker.handBack(
      selection.ticket,
      handbackComment(failure, attempt.run, remains),
    );
    return { ...attempt, failure: { ...failure, handedBack: true } };
  } catch (error: unknown) {
    // The policy itself could not be carried out, which leaves the ticket
    // eligible and due to come round again. Saying so is what is left: a
    // silent failure here is the one that costs a morning every morning.
    return {
      ...attempt,
      failure: {
        ...failure,
        reason: `${failure.reason} — and the ticket could not be handed back: ${reasonFor(error)}`,
      },
    };
  }
}

/**
 * The draft pull request a finished run's commits wait in.
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
  attempt: Attempt,
  ticket: Ticket,
): Promise<Attempt> {
  const { run, checkout } = attempt;
  if (run === undefined || checkout === undefined || run.commits.length === 0) {
    return attempt;
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

  return { ...attempt, pullRequest, reviewTicket };
}

/** What became of the branch a failed run left in the checkout. */
type BranchOutcome =
  /** There was none: the agent committed nothing, or never started. */
  | { kind: "none" }
  /** Thrown away, as a failed run's branch should be. */
  | { kind: "discarded" }
  /** Still there, because git would not delete it. */
  | { kind: "kept"; reason: string };

/**
 * Throws the failed run's branch away, and says what became of it.
 *
 * Never throws. A branch that will not delete is worth telling the developer
 * about; it is not worth the ticket, which is what refusing to go on would
 * cost.
 */
async function discardBranch(
  ports: MorningRunPorts,
  attempt: Attempt,
): Promise<BranchOutcome> {
  const { checkout, run } = attempt;
  // The sandbox fetches a branch back only when the agent committed to it, and
  // an agent that gave up commonly committed nothing at all.
  if (checkout === undefined || run === undefined || run.commits.length === 0) {
    return { kind: "none" };
  }

  try {
    await ports.repoHost.discardBranch(checkout, run.branch);
    return { kind: "discarded" };
  } catch (error: unknown) {
    return { kind: "kept", reason: reasonFor(error) };
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
 * sandbox port rejects only when it could not set itself up or tear itself
 * down, and reports an agent that gave up as a result carrying `failure`.
 */
async function attemptRun(
  ports: MorningRunPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
  spendCeiling: Usd,
): Promise<Attempt> {
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
    // token count — so there is nothing to record against the project. The
    // sandbox can reject after the agent has already worked, and that run's
    // spend is lost to the ledger.
    // TODO[#35]: record what a run spent even when the sandbox rejects.
    return {
      failure: {
        kind: "infrastructure",
        reason: reasonFor(error),
        handedBack: false,
      },
    };
  }

  const at = ports.clock.now();
  const cost = { at, tokensUsed: run.tokensUsed };
  state.set(repo, recordRun(state.get(repo), cost));

  if (run.failure === undefined) {
    return { run, checkout };
  }
  return {
    run,
    checkout,
    failure: { kind: "agent", reason: run.failure, handedBack: false },
  };
}

/**
 * How much of the agent's output, and of one failure reason, the ticket
 * comment carries.
 *
 * A tracker takes a comment of bounded size, and a failed `execFile` carries
 * every byte the command wrote to stderr — so a comment that quoted either in
 * full would be rejected, and a rejected comment is a ticket that never gets
 * handed back. The tail is kept, because it holds whatever the thing was doing
 * when it stopped.
 */
const OUTPUT_QUOTED = 20_000;
const REASON_QUOTED = 4_000;

/** What the ticket is told about the morning that failed on it. */
function handbackComment(
  failure: RunFailure,
  run: SandboxRunResult | undefined,
  remains: BranchOutcome,
): string {
  const closing = `This ticket is yours again and will not be retried: add ${READY_FOR_AGENT_LABEL} back to send it round another morning.`;
  const reason = tail(failure.reason, REASON_QUOTED);

  if (failure.kind === "infrastructure") {
    return [
      `The morning loop could not carry this ticket through: the sandbox or the project checkout failed. It may never have started, or it may have stopped after the agent had already worked — the loop cannot tell which from here. Either way this is a setup to fix rather than a ticket to rewrite.`,
      `What went wrong: ${reason}`,
      ...branchNote(run, remains),
      closing,
    ].join("\n\n");
  }

  return [
    `The morning loop ran this ticket and the agent gave up.`,
    `Why it stopped: ${reason}`,
    `What it said:\n\n${quote(run?.output ?? "")}`,
    ...branchNote(run, remains),
    closing,
  ].join("\n\n");
}

/** What the developer will find in the checkout, when it is worth saying. */
function branchNote(
  run: SandboxRunResult | undefined,
  remains: BranchOutcome,
): string[] {
  switch (remains.kind) {
    case "none":
      return [];
    case "discarded":
      return [`The branch it worked on has been discarded.`];
    case "kept":
      return [
        `Its branch \`${run?.branch ?? ""}\` could not be discarded, so it is still in the checkout: ${tail(remains.reason, REASON_QUOTED)}`,
      ];
  }
}

/** The tail of `output`, fenced, and said to be a tail when it is one. */
function quote(output: string): string {
  const said = tail(output.trim(), OUTPUT_QUOTED);
  if (said === "") {
    return "_(it said nothing)_";
  }
  // A coding agent quotes code, so its output holds fences of its own. The
  // fence has to outrun the longest run of backticks inside it, or the rest of
  // the output stops being quoted and starts being Markdown — with every
  // `#123` in it becoming a cross-reference on somebody else's issue.
  const longest = Math.max(
    0,
    ...[...said.matchAll(/`+/g)].map((of) => of[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${said}\n${fence}`;
}

/** The last `limit` characters of `text`, marked as a tail when it is one. */
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  attempt: Attempt,
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
    if (attempt.failure !== undefined) {
      return `Attempted ${selected.repo}: ${stoppedBecause(attempt.failure, ticket)}${aside}`;
    }
    return `Worked ${selected.repo}: ${landed(attempt)}.${queued(attempt)}${aside}`;
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
function queued(attempt: Attempt): string {
  const review = attempt.reviewTicket;
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
    failure.kind === "agent" ? "the agent gave up" : "the run would not start";
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
function landed(attempt: Attempt): string {
  const { run, pullRequest } = attempt;
  if (run === undefined || run.commits.length === 0) {
    return "the run left nothing behind";
  }
  const where =
    pullRequest === undefined ? run.branch : `${run.branch} (${pullRequest})`;
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
