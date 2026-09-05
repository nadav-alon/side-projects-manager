import type {
  Clock,
  IssueTracker,
  ProjectState,
  RepoSlug,
  Sandbox,
  State,
  Store,
  UsageLedger,
} from "./ports/index.ts";

/**
 * The five outside-world dependencies of the loop. Everything it knows about
 * GitHub, containers, session logs, the filesystem and the wall clock arrives
 * through these.
 */
export interface MorningRunPorts {
  tracker: IssueTracker;
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
  /** When an iteration last worked it. Absent means never worked. */
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
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/**
 * One invocation of the morning loop.
 *
 * An invocation iterates until the queue is dry or the gate stands down. Each
 * iteration works one project and one ticket, so a project with a single
 * eligible ticket costs one iteration, not the morning.
 *
 * TODO[#12]: check the gate before each run, and again between iterations.
 * TODO[#7]: run the selected ticket, then iterate — an invocation currently
 * stops after the first selection.
 */
export async function morningRun(
  ports: MorningRunPorts,
): Promise<MorningRunReport> {
  const startedAt = ports.clock.now();
  const state = await ports.store.loadState();
  const projects = await considerProjects(ports, state);

  // State is written back at the end of every invocation, including one that
  // worked nothing, so that a machine which has run the loop always has a
  // state document to read next morning.
  // TODO[#7]: record the project as worked, and what its run cost.
  await ports.store.saveState(state);

  return {
    startedAt,
    projects,
    outcome: projects.some(isSelected) ? "work-selected" : "dry-queue",
    message: summaryLine(projects),
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
): Promise<ProjectOutcome[]> {
  const outcomes: ProjectOutcome[] = [];

  for (const project of await ports.store.loadRegistry()) {
    const projectState = state.get(project.repo);

    if (project.paused) {
      outcomes.push(outcome(project.repo, "paused", projectState));
      continue;
    }

    const backlog = await ports.tracker.listEligibleTickets(project.repo);
    if (backlog.length > 0) {
      outcomes.push(outcome(project.repo, "selected", projectState));
      return outcomes;
    }

    outcomes.push(outcome(project.repo, "no-eligible-tickets", projectState));
  }

  return outcomes;
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

function summaryLine(projects: ProjectOutcome[]): string {
  const selected = projects.find(isSelected);
  const skipped = projects.flatMap((project) => {
    const reason = skipReason(project.verdict);
    return reason === undefined ? [] : [`${project.repo} (${reason})`];
  });

  if (selected !== undefined) {
    const aside = skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : "";
    return `Work available in ${selected.repo}; running it is not wired up yet.${aside}`;
  }
  if (skipped.length === 0) {
    return "Nothing to do: no projects registered.";
  }
  return `Nothing to do: skipped ${skipped.join(", ")}.`;
}
