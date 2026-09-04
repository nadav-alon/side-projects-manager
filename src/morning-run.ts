import type {
  Clock,
  IssueTracker,
  Sandbox,
  Store,
  Ticket,
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
  /** Work was found. Selecting and running it arrives with #11 and #7. */
  | "work-available";

/** What one invocation of the loop did. The summary issue (#14) is written from this. */
export interface MorningRunReport {
  startedAt: Date;
  outcome: MorningRunOutcome;
  /** `owner/repo` of every registered project the loop looked at. */
  projectsConsidered: string[];
  /** Every ready-for-agent ticket found across those projects. */
  ticketsAvailable: Ticket[];
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/**
 * One invocation of the morning loop.
 *
 * Today it establishes the seam and the quiet-morning path: it asks the store
 * which projects are registered, asks the tracker what each of them has ready,
 * and reports. Selection, the budget gate, sandbox runs, draft PRs, review
 * sub-issues and failure handling are all later tickets hanging off this
 * signature.
 */
export async function morningRun(
  ports: MorningRunPorts,
): Promise<MorningRunReport> {
  const startedAt = ports.clock.now();
  const projects = await ports.store.loadProjects();

  const ticketsAvailable: Ticket[] = [];
  for (const project of projects) {
    ticketsAvailable.push(...(await ports.tracker.listReadyTickets(project.slug)));
  }

  const projectsConsidered = projects.map((project) => project.slug);

  return {
    startedAt,
    projectsConsidered,
    ticketsAvailable,
    outcome: ticketsAvailable.length === 0 ? "no-work-available" : "work-available",
    message: describe(projectsConsidered.length, ticketsAvailable.length),
  };
}

function describe(projectCount: number, ticketCount: number): string {
  const projects = `${projectCount} ${plural(projectCount, "project")}`;
  if (ticketCount === 0) {
    return `Nothing to do: considered ${projects}, no ready-for-agent tickets available.`;
  }
  const tickets = `${ticketCount} ready-for-agent ${plural(ticketCount, "ticket")}`;
  return `Found ${tickets} across ${projects}; running them is not wired up yet.`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
