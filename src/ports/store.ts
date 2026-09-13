import type { Budget } from "./budget.ts";
import type { Day } from "./day.ts";
import type { ModelDefaults } from "./model-defaults.ts";
import type { Priority } from "./priority.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TokenCount } from "./token-count.ts";

/**
 * One project as the developer registered it. The registry is hand-edited, so
 * everything here is intent: which projects exist, which are paused, which one
 * has the mornings.
 */
export interface RegisteredProject {
  repo: RepoSlug;
  /** Registered but never considered. */
  paused: boolean;
  /** Overrides least-recently-worked ordering. Absent for most projects. */
  priority?: Priority;
}

/** What one run cost, kept so the reserve can be calibrated against real spend. */
export interface RunCost {
  /** When the run finished. */
  at: Date;
  tokensUsed: TokenCount;
}

/** What the machine has recorded about one project. */
export interface ProjectState {
  /**
   * When an iteration last worked this project. Absent means never worked,
   * which is what a project registered this morning looks like.
   */
  lastWorkedAt?: Date;
  /** Every run made against this project, oldest first. */
  runs: RunCost[];
}

/**
 * `previous` with `cost` recorded against it: the run appended, and the
 * project marked worked at the moment the run finished.
 *
 * Lives beside `ProjectState` rather than in the loop, so that what one run
 * does to a project's state is written down once, whoever is recording it.
 * A project being worked for the first time has no previous entry, which
 * reads the same here as one that has been worked and has no runs.
 */
export function recordRun(
  previous: ProjectState | undefined,
  cost: RunCost,
): ProjectState {
  return {
    lastWorkedAt: cost.at,
    runs: [...(previous?.runs ?? []), cost],
  };
}

/**
 * `previous` with `ticket` recorded as worked on `day`. A record for any other
 * day is replaced rather than extended, since it says nothing about `day`.
 */
export function recordWorked(
  previous: WorkedToday | undefined,
  ticket: WorkedTicket,
  day: Day,
): WorkedToday {
  const earlier = previous?.day === day ? previous.tickets : [];
  return { day, tickets: [...earlier, { repo: ticket.repo, number: ticket.number }] };
}

/** A ticket as the state document names it: its project, and its number there. */
export interface WorkedTicket {
  repo: RepoSlug;
  number: number;
}

/**
 * The tickets the loop worked on one local calendar day, kept so a later
 * invocation the same day does not select them again. A record for any day
 * but today reads as nothing worked today.
 */
export interface WorkedToday {
  day: Day;
  tickets: WorkedTicket[];
}

/**
 * The machine-written state. A project with no entry has never been worked;
 * that is not an error, and neither is a state document that does not exist
 * yet.
 */
export interface State {
  projects: ReadonlyMap<RepoSlug, ProjectState>;
  /** Absent when no day's worked tickets have been recorded. */
  workedToday?: WorkedToday;
}

/**
 * Reads the developer's registry, budget and model defaults, and reads and
 * writes the state document alongside them.
 *
 * They are separate documents with separate methods because they have
 * different authors and different change rates: the registry, the budget and
 * the model defaults are the developer's, and the loop never touches any of
 * them, while the loop writes the state and the developer never has to. The
 * new-project command is the one machine writer of the registry, and it writes
 * it only to record a project the developer just asked for.
 */
export interface Store {
  /** Every registered project, in the order the registry lists them. */
  loadRegistry(): Promise<RegisteredProject[]>;
  /**
   * Replaces the registry with `projects`, in the order given.
   *
   * A replacement, not a merge: the document is rewritten from these entries
   * alone, so anything in it that no entry carries — a field nothing here
   * models — does not survive the write.
   */
  saveRegistry(projects: RegisteredProject[]): Promise<void>;
  /**
   * What the mornings are allowed to spend. A machine that has never been
   * told falls back to `DEFAULT_BUDGET` rather than to none at all, because an
   * absent budget document must never read as an absent budget.
   */
  loadBudget(): Promise<Budget>;
  /**
   * The model each kind of ticket runs on when it carries no model label.
   * Empty when the developer has named none, which leaves every kind on the
   * sandbox image's model.
   */
  loadModelDefaults(): Promise<ModelDefaults>;
  /** The state in force. Empty when nothing has been worked yet. */
  loadState(): Promise<State>;
  /** Replaces the state document with `state`. */
  saveState(state: State): Promise<void>;
}
