import type { Branch } from "./branch.ts";
import type { Budget } from "./budget.ts";
import type { Day } from "./day.ts";
import type { IssueNumber } from "./issue-number.ts";
import type { InvocationClosing, Journal, OpenInvocation } from "./journal.ts";
import type { KeptSummaryPath } from "./kept-summary-path.ts";
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
  /**
   * Standing consent to post `/apply-review` on this project's pull requests
   * once their review ticket closes, in place of the developer typing it
   * themselves. See CONTEXT.md's "Turbo" and ADR 0006.
   */
  turbo: boolean;
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
  return { day, tickets: [...earlier, workedTicket(ticket)] };
}

/** `previous` with `ticket` taken back off it, on the same day. */
export function unrecordWorked(
  previous: WorkedToday,
  ticket: WorkedTicket,
): WorkedToday {
  return {
    day: previous.day,
    tickets: previous.tickets.filter(
      (recorded) => ticketKey(recorded) !== ticketKey(ticket),
    ),
  };
}

/** The key a ticket is known by, unique across every project. */
export function ticketKey(ticket: WorkedTicket): string {
  return `${ticket.repo}#${ticket.number}`;
}

/**
 * `ticket` as the state document names it, and nothing more: a whole `Ticket`
 * passes for one, but its title and labels are not the record's to keep.
 */
export function workedTicket({ repo, number }: WorkedTicket): WorkedTicket {
  return { repo, number };
}

/** A ticket as the state document names it: its project, and its number there. */
export interface WorkedTicket {
  repo: RepoSlug;
  number: IssueNumber;
}

/**
 * One ticket's salvaged branch, kept in the checkout rather than discarded:
 * see CONTEXT.md's "Salvage". `limitRefusals` is how many limit refusals in a
 * row the ticket has had — 1 for the first, one more each time a run on this
 * same salvage is refused again — and is left unchanged by a post-start
 * infrastructure failure, which salvages a branch without being one.
 */
export interface Salvage extends WorkedTicket {
  branch: Branch;
  limitRefusals: number;
}

/** `Salvage`'s own fields, without the ticket — what a discard or a failure names once the ticket it belongs to is known from context. */
export type Salvaged = Pick<Salvage, "branch" | "limitRefusals">;

/**
 * `previous` with `ticket`'s salvage recorded as a limit refusal on `branch`:
 * `limitRefusals` one more than an existing record for `ticket` already
 * carried, or 1 for a ticket salvaged for the first time.
 */
export function recordLimitRefusalSalvage(
  previous: Salvage[] | undefined,
  ticket: WorkedTicket,
  branch: Branch,
): Salvage[] {
  const limitRefusals = (salvageFor(previous, ticket)?.limitRefusals ?? 0) + 1;
  return withSalvage(previous, { ...workedTicket(ticket), branch, limitRefusals });
}

/**
 * `previous` with `ticket`'s salvage recorded as a post-start infrastructure
 * failure on `branch`: `limitRefusals` left exactly as an existing record for
 * `ticket` already carried, or 0 for a ticket salvaged for the first time —
 * an infrastructure failure salvages a branch without being a limit refusal.
 */
export function recordInfrastructureFailureSalvage(
  previous: Salvage[] | undefined,
  ticket: WorkedTicket,
  branch: Branch,
): Salvage[] {
  const limitRefusals = salvageFor(previous, ticket)?.limitRefusals ?? 0;
  return withSalvage(previous, { ...workedTicket(ticket), branch, limitRefusals });
}

/** `previous` with `salvage` recorded in place of any earlier one for the same ticket. */
function withSalvage(previous: Salvage[] | undefined, salvage: Salvage): Salvage[] {
  return [
    ...(previous ?? []).filter((recorded) => ticketKey(recorded) !== ticketKey(salvage)),
    salvage,
  ];
}

/**
 * `previous` with `ticket`'s salvage record taken off it, absent if that
 * leaves nothing: a run that finished, gave up, or had its model refused
 * clears the ticket's salvage record, whatever it carried.
 */
export function clearSalvage(
  previous: Salvage[] | undefined,
  ticket: WorkedTicket,
): Salvage[] | undefined {
  const remaining = (previous ?? []).filter(
    (recorded) => ticketKey(recorded) !== ticketKey(ticket),
  );
  return remaining.length > 0 ? remaining : undefined;
}

/** The salvage record `salvages` carries for `ticket`, absent if it has none. */
export function salvageFor(
  salvages: Salvage[] | undefined,
  ticket: WorkedTicket,
): Salvage | undefined {
  return salvages?.find((salvage) => ticketKey(salvage) === ticketKey(ticket));
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
  /**
   * The local calendar day a summary was last published, set only once a
   * publish has actually succeeded. Absent, or naming any day but today,
   * reads as not yet announced today.
   */
  announcedOn?: Day;
  /**
   * Every ticket with a salvaged branch kept in the checkout. Absent when
   * nothing is salvaged. See CONTEXT.md's "Salvage".
   */
  salvages?: Salvage[];
}

/**
 * Whether `day` is already claimed: a summary has been announced on it. A
 * read-only query onto `announcedOn` — asking never claims a day, and every
 * caller that claims one still does it by setting `announcedOn` itself.
 */
export function hasAnnouncedOn(
  announcedOn: Day | undefined,
  day: Day,
): boolean {
  return announcedOn === day;
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
  /**
   * Opens an invocation record and writes it immediately, so a process that
   * dies before closing it leaves an in-flight record rather than no trace at
   * all. Returns whatever closing the record later needs to find it again.
   */
  openInvocation(opened: OpenInvocation): Promise<OpenInvocation>;
  /**
   * Closes the record `opened` identifies with what the invocation came to.
   *
   * An error, not a silent no-op, when no such record is open — it was never
   * opened, or it already carries a `closedAt` — since either would otherwise
   * lose an invocation's account of itself without saying so.
   */
  closeInvocation(
    opened: OpenInvocation,
    closing: InvocationClosing,
  ): Promise<void>;
  /**
   * The journal in force, oldest record first. Empty when nothing has ever
   * been recorded — a machine the loop has never run on, same as an absent
   * state document.
   */
  loadJournal(): Promise<Journal>;
  /**
   * Writes a summary that could not be published into the manager home as a
   * readable document, named for when the invocation that composed it
   * started. Answers with where it landed.
   *
   * Behind the same port as every other manager-home write, rather than the
   * entry point reaching the filesystem directly, so the write is atomic
   * like the rest and exercisable through a fake.
   */
  keepSummary(startedAt: Date, body: string): Promise<KeptSummaryPath>;
}
