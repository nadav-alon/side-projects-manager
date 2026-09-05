import type {
  Clock,
  IssueTracker,
  ProjectState,
  RegisteredProject,
  RepoHost,
  RepoSlug,
  Sandbox,
  SandboxRunResult,
  State,
  Store,
  Ticket,
  UsageLedger,
} from "./ports/index.ts";

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
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/** The project an iteration works, and the ticket it works there. */
interface Selection {
  project: RegisteredProject;
  ticket: Ticket;
}

/** What considering the registry came to: the verdicts, and any work found. */
interface Consideration {
  outcomes: ProjectOutcome[];
  /** Absent when no project had an eligible ticket. */
  selection?: Selection;
}

/**
 * One invocation of the morning loop.
 *
 * An invocation iterates until the queue is dry or the gate stands down. Each
 * iteration works one project and one ticket, so a project with a single
 * eligible ticket costs one iteration, not the morning.
 *
 * TODO[#12]: check the gate before each run, and again between iterations.
 * TODO[#11]: iterate — an invocation currently stops after the first run.
 */
export async function morningRun(
  ports: MorningRunPorts,
): Promise<MorningRunReport> {
  const startedAt = ports.clock.now();
  const state = new Map(await ports.store.loadState());
  const { outcomes, selection } = await considerProjects(ports, state);

  let run: SandboxRunResult | undefined;
  try {
    if (selection !== undefined) {
      run = await work(ports, selection, state);
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
    ...(run !== undefined && { run }),
    outcome: selection === undefined ? "dry-queue" : "work-selected",
    message: summaryLine(outcomes, run),
  };
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
): Promise<Consideration> {
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
 * The second step: run the selected ticket, and record what that cost.
 *
 * The checkout comes from the repo host rather than from anything the loop
 * remembers, so a project whose clone has gone missing heals on the way into
 * the run instead of failing the morning.
 */
async function work(
  ports: MorningRunPorts,
  selection: Selection,
  state: Map<RepoSlug, ProjectState>,
): Promise<SandboxRunResult> {
  const repo = selection.project.repo;
  const checkout = await ports.repoHost.clone(repo);
  const run = await ports.sandbox.run(selection.ticket, checkout);

  const at = ports.clock.now();
  const worked = state.get(repo);
  state.set(repo, {
    lastWorkedAt: at,
    runs: [...(worked?.runs ?? []), { at, tokensUsed: run.tokensUsed }],
  });

  return run;
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
  run: SandboxRunResult | undefined,
): string {
  const selected = projects.find(isSelected);
  const skipped = projects.flatMap((project) => {
    const reason = skipReason(project.verdict);
    return reason === undefined ? [] : [`${project.repo} (${reason})`];
  });

  if (selected !== undefined) {
    const aside = skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : "";
    const landed =
      run === undefined
        ? "the run left nothing behind"
        : `${commitCount(run)} on ${run.branch}`;
    return `Worked ${selected.repo}: ${landed}.${aside}`;
  }
  if (skipped.length === 0) {
    return "Nothing to do: no projects registered. Add one to registry.json (see README).";
  }
  return `Nothing to do: skipped ${skipped.join(", ")}.`;
}

/** How many commits the run left, said the way a person would say it. */
function commitCount(run: SandboxRunResult): string {
  const count = run.commits.length;
  return count === 1 ? "1 commit" : `${count} commits`;
}
