import type { Branch } from "./branch.ts";
import type { Budget } from "./budget.ts";
import type { Day } from "./day.ts";
import type { IssueNumber } from "./issue-number.ts";
import {
  inFlight,
  sameInvocation,
  type InvocationClosing,
  type Journal,
  type OpenInvocation,
  type RunInProgress,
} from "./journal.ts";
import type { KeptSummaryPath } from "./kept-summary-path.ts";
import { type Milliseconds, milliseconds } from "./milliseconds.ts";
import type { ModelDefaults } from "./model-defaults.ts";
import type { Priority } from "./priority.ts";
import type { ReadOnlyMount } from "./read-only-mount.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { RunProgress } from "./sandbox.ts";
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
  /**
   * Set only on the manager's own entry — the one place `UNIFORM_FILES`
   * (`src/ports/harness.ts`) are the source, not a copy. Absent for every
   * other project, which is what the uniform-file checks (`morning-run.ts`'s
   * `handOver`, and `container-sandbox.ts`'s `pushingRunOnClone` for an
   * apply-review or rebase run's own push) read to tell them apart: a run
   * here that touches one is the source being updated, not drift.
   */
  manager?: true;
  /**
   * Host directories every run, review and apply-review in this project sees,
   * read-only, at their container paths. Absent for a project that declares
   * none, which is most of them.
   */
  mounts?: ReadOnlyMount[];
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
export function workedTicket({
  repo,
  number,
  recordedBy,
}: WorkedTicket): WorkedTicket {
  return { repo, number, ...(recordedBy !== undefined && { recordedBy }) };
}

/** A ticket as the state document names it: its project, and its number there. */
export interface WorkedTicket {
  repo: RepoSlug;
  number: IssueNumber;
  /**
   * The invocation that recorded this entry, using the journal's own
   * identity for an invocation record — see `findInvocationRecord`. Absent
   * for an entry written before this field existed, which reads the same as
   * one whose invocation is not in flight: still passed over for the rest of
   * the day, never freed. See CONTEXT.md's "Worked today".
   */
  recordedBy?: OpenInvocation;
}

/**
 * One ticket's salvaged branch, kept in the checkout rather than discarded:
 * see CONTEXT.md's "Salvage". `stopShorts` is how many times in a row the
 * ticket has been stopped short — a limit refusal or a budget exhaustion —
 * 1 for the first, one more each time a run on this same salvage is stopped
 * short again — and is left unchanged by a post-start infrastructure
 * failure, which salvages a branch without being one.
 */
export interface Salvage extends WorkedTicket {
  branch: Branch;
  stopShorts: number;
}

/** `Salvage`'s own fields, without the ticket — what a discard or a failure names once the ticket it belongs to is known from context. */
export type Salvaged = Pick<Salvage, "branch" | "stopShorts">;

/**
 * `ticket` as a salvage record names it: its project and its number there,
 * and nothing else. `recordedBy` belongs only to the worked-today record —
 * dropped here rather than trusted to be absent from every caller.
 */
function salvageTicket({ repo, number }: WorkedTicket): { repo: RepoSlug; number: IssueNumber } {
  return { repo, number };
}

/**
 * `previous` with `ticket`'s salvage recorded as a stop-short — a limit
 * refusal or a budget exhaustion — on `branch`: `stopShorts` one more than an
 * existing record for `ticket` already carried, or 1 for a ticket salvaged
 * for the first time.
 */
export function recordStopShortSalvage(
  previous: Salvage[] | undefined,
  ticket: WorkedTicket,
  branch: Branch,
): Salvage[] {
  const stopShorts = (salvageFor(previous, ticket)?.stopShorts ?? 0) + 1;
  return withSalvage(previous, { ...salvageTicket(ticket), branch, stopShorts });
}

/**
 * `previous` with `ticket`'s salvage recorded as a post-start infrastructure
 * failure on `branch`: `stopShorts` left exactly as an existing record for
 * `ticket` already carried, or 0 for a ticket salvaged for the first time —
 * an infrastructure failure salvages a branch without being a stop-short.
 */
export function recordInfrastructureFailureSalvage(
  previous: Salvage[] | undefined,
  ticket: WorkedTicket,
  branch: Branch,
): Salvage[] {
  const stopShorts = salvageFor(previous, ticket)?.stopShorts ?? 0;
  return withSalvage(previous, { ...salvageTicket(ticket), branch, stopShorts });
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
 * When a ticket's own run last started, and when it ended — CONTEXT.md's
 * "Run span": durable in the state document, unlike `RunInProgress`, which
 * the journal clears the moment the run ends. `endedAt` absent while that
 * run is still going, or if the invocation that opened the span died
 * before it could close it — `runSpanInProgress` tells the two apart.
 */
export interface RunSpan extends WorkedTicket {
  startedAt: Date;
  endedAt?: Date;
  /**
   * The invocation that opened this span, checked by `runSpanInProgress`
   * against the journal and the invocation now holding the invocation
   * lease, the way `WorkedToday` frees a dead invocation's entries. Absent
   * for a span recorded before this field existed, or opened by a caller
   * with no journal identity of its own — an `InvocationState` built
   * directly in a test, say — which reads the same as one opened by the
   * invocation now running, since nothing here says otherwise.
   */
  openedBy?: OpenInvocation;
}

/**
 * `previous` with `ticket`'s run span recorded as started at `startedAt`,
 * opened by `openedBy` when given, in place of whatever span it carried
 * before: a ticket run more than once keeps only its latest run's span.
 */
export function recordRunSpanStarted(
  previous: RunSpan[] | undefined,
  ticket: WorkedTicket,
  startedAt: Date,
  openedBy?: OpenInvocation,
): RunSpan[] {
  return [
    ...(previous ?? []).filter((span) => ticketKey(span) !== ticketKey(ticket)),
    {
      repo: ticket.repo,
      number: ticket.number,
      startedAt,
      ...(openedBy !== undefined && { openedBy }),
    },
  ];
}

/**
 * `previous` with `ticket`'s own run span closed at `endedAt`, its
 * `startedAt` left as it was. Not an error when no such span is open —
 * `recordRunSpanStarted` never wrote one, say — since there is then
 * nothing here to close.
 */
export function recordRunSpanEnded(
  previous: RunSpan[] | undefined,
  ticket: WorkedTicket,
  endedAt: Date,
): RunSpan[] | undefined {
  return previous?.map((span) =>
    ticketKey(span) === ticketKey(ticket) ? { ...span, endedAt } : span,
  );
}

/** The run span `spans` carries for `ticket`, absent if it has none. */
export function runSpanFor(
  spans: readonly RunSpan[] | undefined,
  ticket: WorkedTicket,
): RunSpan | undefined {
  return spans?.find((span) => ticketKey(span) === ticketKey(ticket));
}

/**
 * Whether `span` covers `instant`. Bounds are inclusive: `instant` at
 * exactly `startedAt` or `endedAt` counts as covered. A `span` with no
 * `endedAt` covers everything from its `startedAt` on — true of one whose
 * run is still going. A dead opener's span reaching here with no `endedAt`
 * too, covering everything the same way, is possible only when no journal
 * was available to read it as ended first: the merge gate's own spans
 * already have `effectiveRunSpans` close a dead opener's span at its own
 * `startedAt` before this is ever called on them.
 */
export function runSpanCovers(span: RunSpan, instant: Date): boolean {
  const at = instant.getTime();
  return (
    span.startedAt.getTime() <= at &&
    (span.endedAt === undefined || at <= span.endedAt.getTime())
  );
}

/**
 * Whether `span`'s own run reads as still going: false once it carries its
 * own `endedAt`, whatever `journal` says. One still missing `endedAt` reads
 * as false too — ended, its own end instant left unknown rather than
 * assumed to be the journal's last-seen one — once `openedBy` names an
 * invocation that died before it could close the span: still in flight on
 * `journal`, the same test `WorkedToday` uses to free a dead invocation's
 * entries, but not `self`. A span naming no opening invocation, or one that
 * is `self`, reads as still in progress — CONTEXT.md's "Run span".
 */
export function runSpanInProgress(
  span: RunSpan,
  self: OpenInvocation,
  journal: Journal,
): boolean {
  if (span.endedAt !== undefined) {
    return false;
  }
  if (span.openedBy === undefined) {
    return true;
  }
  return sameInvocation(span.openedBy, self) && inFlight(span.openedBy, journal);
}

/**
 * The developer's own grant of `turboable` on a ticket, as the `grant`
 * command wrote it: host-only, since no sandbox run mounts the manager home
 * to write the state document. How far from the label's own `labeled` event
 * `grantedAt` may lie and still match it is `GRANT_MATCH_WINDOW`.
 */
export interface GrantRecord extends WorkedTicket {
  grantedAt: Date;
}

/** How far a `GrantRecord`'s `grantedAt` may lie from the `labeled` event it vouches for. */
export const GRANT_MATCH_WINDOW: Milliseconds = milliseconds(2 * 60 * 1000);

/**
 * Whether `grants` carries a record for `ticket` whose `grantedAt` lies
 * within `GRANT_MATCH_WINDOW` of `labeledAt`, inclusive. A record for
 * another ticket never matches, nor does one outside the window, however
 * near.
 */
export function grantMatches(
  grants: readonly GrantRecord[] | undefined,
  ticket: WorkedTicket,
  labeledAt: Date,
): boolean {
  return (grants ?? []).some(
    (grant) =>
      ticketKey(grant) === ticketKey(ticket) &&
      Math.abs(grant.grantedAt.getTime() - labeledAt.getTime()) <= GRANT_MATCH_WINDOW,
  );
}

/**
 * `previous` with `ticket`'s grant recorded at `grantedAt`, in place of any
 * record it already carried.
 */
export function recordGrant(
  previous: readonly GrantRecord[] | undefined,
  ticket: WorkedTicket,
  grantedAt: Date,
): GrantRecord[] {
  return [
    ...(withoutGrant(previous, ticket) ?? []),
    { repo: ticket.repo, number: ticket.number, grantedAt },
  ];
}

/**
 * Whether `a` and `b` are the same record: the same ticket, granted at the
 * same instant. A re-grant of a ticket is a different record.
 */
export function sameGrant(a: GrantRecord, b: GrantRecord): boolean {
  return ticketKey(a) === ticketKey(b) && a.grantedAt.getTime() === b.grantedAt.getTime();
}

/** `previous` without `ticket`'s grant record; undefined once none is left. */
export function withoutGrant(
  previous: readonly GrantRecord[] | undefined,
  ticket: WorkedTicket,
): GrantRecord[] | undefined {
  const kept = (previous ?? []).filter((grant) => ticketKey(grant) !== ticketKey(ticket));
  return kept.length === 0 ? undefined : kept;
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
  /**
   * Every ticket's own run span: when its own run last started, and when
   * it ended. Absent when nothing has ever run. See CONTEXT.md's "Run
   * span".
   */
  runSpans?: RunSpan[];
  /**
   * Every grant record the `grant` command wrote and the merge gate has not
   * yet used up. Absent when none stands. See ADR 0012.
   */
  grants?: GrantRecord[];
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
   * Adds `run` to the invocation record `opened` identifies — CONTEXT.md's
   * "Run in progress", the moment the manager starts it.
   *
   * An error when no such record is open, as `closeInvocation`'s is: an
   * invocation always opens its own record before it can start a run, so
   * finding none open is a bug worth failing loudly on rather than a run
   * silently going unrecorded.
   */
  recordRunStarted(opened: OpenInvocation, run: RunInProgress): Promise<void>;
  /**
   * Replaces the progress of the run against `repo` and `number` on the
   * invocation record `opened` identifies.
   *
   * Not an error when no such run is found — it already ended, or the record
   * closed: a late event has nothing left to report on.
   */
  recordRunProgress(
    opened: OpenInvocation,
    repo: RepoSlug,
    number: IssueNumber,
    progress: RunProgress,
  ): Promise<void>;
  /**
   * Removes the run against `repo` and `number` from the invocation record
   * `opened` identifies, whatever it came to.
   *
   * Not an error when no such run is found — the record already closed, or
   * never carried it: the run is over either way, so there is nothing left
   * to clear.
   */
  recordRunEnded(
    opened: OpenInvocation,
    repo: RepoSlug,
    number: IssueNumber,
  ): Promise<void>;
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
