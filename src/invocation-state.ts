import type {
  Day,
  Journal,
  OpenInvocation,
  ProjectState,
  RepoSlug,
  RunCost,
  State,
  Store,
  WorkedTicket,
  WorkedToday,
} from "./ports/index.ts";
import {
  findInvocationRecord,
  isClosedInvocation,
  recordRun,
  recordWorked,
  sameInvocation,
  ticketKey,
  unrecordWorked,
} from "./ports/index.ts";
import { freesTicketToday, type Iteration } from "./iteration-outcome.ts";

/**
 * The invocation running now, and the journal as it stood when it started:
 * what an invocation's state needs to tell a worked-today entry recorded by
 * a dead in-flight invocation apart from one still protected. `self` is used
 * to stamp every entry this invocation records, whether or not `journal` is
 * available to free anything with. Absent entirely when the caller has no
 * lease and no journal identity at all — as in a test that builds an
 * `InvocationState` directly — in which case nothing is freed and nothing is
 * stamped either.
 */
export interface CurrentInvocation {
  self: OpenInvocation;
  /** Absent when the journal could not be read: frees nothing, same as an empty one would. */
  journal?: Journal;
}

/** One worked-today entry freed because the invocation that recorded it died. */
export interface FreedWorkedTicket {
  ticket: WorkedTicket;
  /** The dead invocation's own record: its opened-at instant and pid. */
  invocation: OpenInvocation;
}

/** The one port an invocation's state needs: writing the whole state document back. */
export interface InvocationStatePorts {
  store: Pick<Store, "saveState">;
}

/**
 * What a save is to fold into the state document besides the bookkeeping the
 * invocation's state itself owns: the salvage record, whose rules belong to
 * `salvages.ts`, and the day a summary was announced on, once the
 * invocation's own publish has succeeded. Read fresh from `foreignFields` at
 * every save, exactly as `record` and `projects` are, so a change either
 * makes between two saves is exactly what the next one writes.
 */
type ForeignStateFields = Pick<State, "announcedOn" | "salvages">;

/**
 * `ForeignStateFields` built from loose optional values, left out of the
 * document rather than carried as an explicit `undefined` — the shape every
 * other optional field on `State` is built in, and the one `exactOptionalPropertyTypes`
 * requires of anything assigned into `announcedOn`/`salvages` directly.
 */
export function invocationStateRest(
  announcedOn: Day | undefined,
  salvages: State["salvages"],
): ForeignStateFields {
  return {
    ...(announcedOn !== undefined && { announcedOn }),
    ...(salvages !== undefined && { salvages }),
  };
}

/**
 * One invocation's whole view of the state document: worked-today and
 * run-cost bookkeeping, the budget gate's view of recorded runs, and every
 * save the document needs. The loop tells it what happened; it decides what
 * to keep.
 *
 * A single instance is built once per invocation and lives for its whole
 * length, the same as `InvocationSelection` and `InvocationBudgetGate`: the
 * worked-today record and the project map it owns are read live by both, so
 * a change either makes between two calls is exactly what the next one sees.
 *
 * Safe with overlapping iterations: two calls that change the record or the
 * project map never lose each other's change, since both only ever run
 * synchronously between one `await` and the next. And every save is queued
 * onto the one before it, so two overlapping saves land in the order they
 * were made rather than whichever the runtime happens to settle first — a
 * newer snapshot never loses to a stale one still in flight.
 */
export interface InvocationState {
  /** Whether selection passes `ticket` over for the rest of this invocation. */
  passesOver(ticket: WorkedTicket): boolean;

  /**
   * Records `ticket` as worked on `day` and saves the whole state document at
   * once, resolving only once that save lands — so a ticket counts as worked
   * from the moment it is selected, and a run killed part way still counts.
   * If the save itself fails, `ticket` is taken back off the record before
   * the failure reaches the caller.
   */
  ticketSelected(ticket: WorkedTicket, day: Day): Promise<void>;

  /**
   * Records `ticket` as worked on `day`, in memory only — for a ticket handed
   * back ahead of the gate, whose iteration never reaches the sandbox and so
   * carries none of `ticketSelected`'s own save-at-once guarantee.
   */
  recordWorked(ticket: WorkedTicket, day: Day): void;

  /**
   * Takes `ticket` back off the worked-today record because the invocation
   * stopped between `ticketSelected`'s own save and the sandbox it was
   * saved ahead of — so the ticket was never actually worked, and a later
   * firing the same day should be free to pick it up again.
   */
  selectionAbandoned(ticket: WorkedTicket): void;

  /**
   * Takes `ticket` back off the worked-today record when `iteration`'s own
   * ending frees it — CONTEXT.md's "Worked today", `freesTicketToday` in
   * `iteration-outcome.ts`.
   */
  iterationEnded(ticket: WorkedTicket, iteration: Iteration): void;

  /** Records a finished run's cost against `repo`'s project. */
  recordRunCost(repo: RepoSlug, cost: RunCost): void;

  /**
   * Every project's recorded runs, live — the budget gate's own view of what
   * the mornings have spent, read fresh at every consultation rather than
   * copied.
   */
  projectStates(): ReadonlyMap<RepoSlug, ProjectState>;

  /**
   * Every ticket freed on construction because a dead in-flight invocation
   * had recorded it — CONTEXT.md's "Worked today". Fixed for the life of this
   * invocation's state: nothing recorded or unrecorded during the invocation
   * adds to it.
   */
  freed(): FreedWorkedTicket[];

  /** Saves the whole state document once, `foreignFields` folded in as every save's is. */
  save(): Promise<void>;
}

/**
 * Builds one invocation's state, starting from `stored` — the state
 * document as the invocation found it — and `today`, the local calendar day
 * it opened on. A worked-today record for any day but `today` says nothing
 * about today, so it reads as nothing worked yet: CONTEXT.md's "Worked
 * today".
 *
 * `foreignFields` supplies, at every save, the document fields this module
 * does not itself own — see `ForeignStateFields`. Read once here rather than
 * passed to `save`/`ticketSelected` on every call, so no call can save a
 * partial document by only some of its callers remembering to pass it.
 *
 * `current`, when given, is used once, on construction, to free every entry
 * a dead in-flight invocation recorded — see CONTEXT.md's "Worked today".
 * `current` absent, or its journal unreadable, frees nothing, same as an
 * entry naming no invocation, one whose invocation closed, one whose
 * invocation is missing from the journal, or one recorded by this same
 * invocation.
 */
export function invocationState(
  ports: InvocationStatePorts,
  stored: State,
  today: Day,
  foreignFields: () => ForeignStateFields,
  current?: CurrentInvocation,
): InvocationState {
  const projects = new Map(stored.projects);
  const storedToday =
    stored.workedToday?.day === today ? stored.workedToday : undefined;
  const { kept, freed } = freeDeadInvocations(storedToday, current);
  let record = kept;
  // Never shrinks, unlike `record`: selection passes over every ticket the
  // record held when the invocation started and every ticket it recorded
  // since, for the whole invocation, even one later taken back off `record`.
  const passedOver = new Set(record?.tickets.map(ticketKey));

  const doRecord = (ticket: WorkedTicket, day: Day): void => {
    passedOver.add(ticketKey(ticket));
    const recorded: WorkedTicket =
      current === undefined ? ticket : { ...ticket, recordedBy: current.self };
    record = recordWorked(record, recorded, day);
  };
  const doUnrecord = (ticket: WorkedTicket): void => {
    if (record !== undefined) {
      record = unrecordWorked(record, ticket);
    }
  };
  const buildState = (): State => ({
    projects,
    ...(record !== undefined && { workedToday: record }),
    ...foreignFields(),
  });

  // Every save is chained onto this, so two overlapping calls always write
  // in the order they were made rather than whichever the runtime happens
  // to settle first — `state` itself is still built eagerly, at call time,
  // so each save's own snapshot is exactly what its caller saw.
  let queued: Promise<unknown> = Promise.resolve();
  const doSave = (state: State): Promise<void> => {
    const saved = queued.then(
      () => ports.store.saveState(state),
      () => ports.store.saveState(state),
    );
    queued = saved.catch(() => {});
    return saved;
  };

  return {
    passesOver: (ticket) => passedOver.has(ticketKey(ticket)),
    recordWorked: doRecord,
    selectionAbandoned: doUnrecord,
    ticketSelected: async (ticket, day) => {
      doRecord(ticket, day);
      try {
        await doSave(buildState());
      } catch (error: unknown) {
        doUnrecord(ticket);
        throw error;
      }
    },
    recordRunCost: (repo, cost) => {
      projects.set(repo, recordRun(projects.get(repo), cost));
    },
    iterationEnded: (ticket, iteration) => {
      if (freesTicketToday(iteration)) {
        doUnrecord(ticket);
      }
    },
    projectStates: () => projects,
    freed: () => freed,
    save: () => doSave(buildState()),
  };
}

/**
 * `stored` with every entry recorded by a dead in-flight invocation taken
 * off it, and those entries reported so the summary can name them.
 *
 * Removed rather than merely left unpassed-over: it keeps the ticket free
 * even if the dead record is later pruned past the journal limit, and avoids
 * a duplicate entry once the ticket is re-selected and re-recorded under
 * this invocation's own identity.
 */
function freeDeadInvocations(
  stored: WorkedToday | undefined,
  current: CurrentInvocation | undefined,
): { kept: WorkedToday | undefined; freed: FreedWorkedTicket[] } {
  if (stored === undefined || current === undefined || current.journal === undefined) {
    return { kept: stored, freed: [] };
  }
  const { self, journal } = current;
  const freed: FreedWorkedTicket[] = [];
  const kept = stored.tickets.filter((ticket) => {
    const dead = deadInvocationOf(ticket.recordedBy, self, journal);
    if (dead === undefined) {
      return true;
    }
    freed.push({ ticket, invocation: dead });
    return false;
  });
  return { kept: { day: stored.day, tickets: kept }, freed };
}

/**
 * `recordedBy`, if it names an invocation still in flight in `journal` and
 * is not `self` — the invocation's own record is in flight while it runs, so
 * it never counts as dead. `undefined` for an entry naming no invocation,
 * this invocation, one whose record has closed, or one missing from the
 * journal entirely (pruned, say): every one of those stays passed over, as
 * today.
 */
function deadInvocationOf(
  recordedBy: OpenInvocation | undefined,
  self: OpenInvocation,
  journal: Journal,
): OpenInvocation | undefined {
  if (recordedBy === undefined || sameInvocation(self, recordedBy)) {
    return undefined;
  }
  const record = findInvocationRecord(journal.records, recordedBy);
  return record !== undefined && !isClosedInvocation(record) ? recordedBy : undefined;
}
