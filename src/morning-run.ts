import type {
  Clock,
  IssueTracker,
  RepoSlug,
  Sandbox,
  Store,
  UsageLedger,
} from "./ports/index.ts";

/**
 * The five outside-world dependencies of the loop. Everything the loop knows
 * about GitHub, containers, session logs, the filesystem and the wall clock
 * arrives through these, so the whole loop is exercised end to end with fakes.
 */
export interface MorningRunPorts {
  tracker: IssueTracker;
  sandbox: Sandbox;
  ledger: UsageLedger;
  clock: Clock;
  store: Store;
}

export type MorningRunOutcome =
  /** No registered project had a ready-for-agent ticket. A quiet morning. */
  | "no-work-available"
  /** A project had work. Choosing and running it arrives with #11 and #7. */
  | "work-available";

/** What one invocation of the loop did. The summary issue (#14) is written from this. */
export interface MorningRunReport {
  startedAt: Date;
  outcome: MorningRunOutcome;
  /** Every registered project the loop looked at, in the order it looked. */
  projectsConsidered: RepoSlug[];
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/**
 * One invocation of the morning loop.
 *
 * Today it establishes the seam and the quiet-morning path: it asks the store
 * which projects are registered and the tracker what each has ready, stopping
 * at the first project with work, since a morning works one project. Which
 * project that should be, whether the budget allows it, and everything that
 * follows from running it — sandbox, draft PR, review sub-issue, failure
 * handling, summary — are later tickets hanging off this signature.
 */
export async function morningRun(
  ports: MorningRunPorts,
): Promise<MorningRunReport> {
  const startedAt = ports.clock.now();
  const projects = await ports.store.loadProjects();

  const projectsConsidered: RepoSlug[] = [];
  let workAvailable = false;

  for (const project of projects) {
    projectsConsidered.push(project.repo);
    const readyTickets = await ports.tracker.listReadyTickets(project.repo);
    if (readyTickets.length > 0) {
      workAvailable = true;
      break;
    }
  }

  return {
    startedAt,
    projectsConsidered,
    outcome: workAvailable ? "work-available" : "no-work-available",
    message: summaryLine(projectsConsidered, workAvailable),
  };
}

function summaryLine(
  projectsConsidered: RepoSlug[],
  workAvailable: boolean,
): string {
  const count = projectsConsidered.length;
  const projects = `${count} ${count === 1 ? "project" : "projects"}`;
  if (!workAvailable) {
    return `Nothing to do: considered ${projects}, no ready-for-agent tickets available.`;
  }
  const project = projectsConsidered[count - 1];
  return `Work available in ${project}; running it is not wired up yet.`;
}
