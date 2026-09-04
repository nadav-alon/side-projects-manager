import type {
  Clock,
  IssueTracker,
  RepoSlug,
  Sandbox,
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

/** What one invocation did. The summary issue is written from this. */
export interface MorningRunReport {
  /** When the invocation started. */
  startedAt: Date;
  outcome: MorningRunOutcome;
  /** Every registered project the invocation looked at, in the order it looked. */
  projectsConsidered: RepoSlug[];
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
  const selection = await selectProject(ports);

  return {
    startedAt,
    projectsConsidered: selection.considered,
    outcome: selection.selected === undefined ? "dry-queue" : "work-selected",
    message: summaryLine(selection),
  };
}

interface Selection {
  /** The projects looked at before settling, in order. */
  considered: RepoSlug[];
  /** The project this iteration would work, or undefined for a dry queue. */
  selected: RepoSlug | undefined;
}

/**
 * The first step of an iteration: find a project with an eligible ticket.
 * Registry order, and the first project with a backlog wins.
 *
 * TODO[#11]: order by reviews before implementations, then explicit
 * priority, then least recently worked.
 */
async function selectProject(ports: MorningRunPorts): Promise<Selection> {
  const considered: RepoSlug[] = [];

  for (const project of await ports.store.loadProjects()) {
    considered.push(project.repo);
    const backlog = await ports.tracker.listEligibleTickets(project.repo);
    if (backlog.length > 0) {
      return { considered, selected: project.repo };
    }
  }

  return { considered, selected: undefined };
}

function summaryLine({ considered, selected }: Selection): string {
  if (selected !== undefined) {
    return `Work available in ${selected}; running it is not wired up yet.`;
  }
  const count = considered.length;
  const projects = `${count} ${count === 1 ? "project" : "projects"}`;
  return `Nothing to do: considered ${projects}, no ready-for-agent tickets available.`;
}
