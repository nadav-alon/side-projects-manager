import type {
  Day,
  IssueNumber,
  Journal,
  OpenInvocation,
  ProjectState,
  RepoSlug,
  RunCost,
  RunInProgress,
  RunSpan,
  State,
  Store,
  WorkedTicket,
  WorkedToday,
} from "./ports/index.ts";
import {
  inFlight,
  recordRun,
  recordRunSpanEnded,
  recordRunSpanStarted,
  recordWorked,
  runSpanFor,
  runSpanInProgress,
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

/**
 * The ports an invocation's state needs: writing the whole state document
 * back, and recording its own runs in progress on the journal.
 */
export interface InvocationStatePorts {
  store: Pick<Store, "saveState" | "recordRunStarted" | "recordRunEnded">;
}

/**
 * What a save is to fold into the state document besides the bookkeeping the
 * invocation's state itself owns: the salvage record, whose rules belong to
 * `salvages.ts`, and the day a summary was announced on, once the
 * invocation's own publish has succeeded. Read fresh from `foreignFields` at
 * every save, exactly as `record` and `projects` are, so a change either
 * makes between two saves is exactly what the next one writes.
 */
export type ForeignStateFields = Pick<State, "announcedOn" | "salvages">;

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
 * run-cost bookkeeping, the budget gate's view of recorded runs, each
 * ticket's own run span, and every save the document needs. The loop
 * tells it what happened; it decides what to keep.
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
   * Adds `run` to this invocation's own record on the journal — CONTEXT.md's
   * "Run in progress", the moment the manager starts it. Does nothing when
   * this invocation has no journal identity to record it against, same as a
   * test that builds an `InvocationState` directly.
   */
  recordRunStarted(run: RunInProgress): Promise<void>;

  /**
   * Clears the run against `repo` and `number` from this invocation's own
   * record on the journal, whatever it came to. Does nothing when this
   * invocation has no journal identity, same as `recordRunStarted`.
   */
  recordRunEnded(repo: RepoSlug, number: IssueNumber): Promise<void>;

  /**
   * Records `ticket`'s own run span as started at `startedAt`, and saves the
   * whole state document at once, resolving once that save lands — but not
   * awaited by the run itself, which is already past the sandbox's own
   * start by the time this is called: CONTEXT.md's "Run span", durable
   * where `recordRunStarted`'s journal entry is not, but not saved with
   * `ticketSelected`'s before-the-sandbox-starts urgency, since nothing
   * calls this before the sandbox has already started. Replaces whatever
   * span `ticket` already carried, same as `recordRunSpanStarted` in
   * `ports/store.ts` — stamped with this invocation's own identity when it
   * has one, so a later reader can tell a span a crash left open apart from
   * one still going; absent for a caller with none, an `InvocationState`
   * built directly in a test, say.
   */
  recordRunSpanStarted(ticket: WorkedTicket, startedAt: Date): Promise<void>;

  /**
   * Closes `ticket`'s own run span at `endedAt`, saving the whole state
   * document the same way, but only when `openedAt` still names the span on
   * record: a run that never opened its own span, or whose span a later run
   * has since replaced, closes nothing — so a run that never started never
   * moves an earlier run's own `endedAt` forward. Not an error either way,
   * same as `recordRunSpanEnded` in `ports/store.ts` — and, since nothing
   * changes then, no save either.
   */
  recordRunSpanEnded(ticket: WorkedTicket, openedAt: Date, endedAt: Date): Promise<void>;

  /**
   * Every project's recorded runs, live — the budget gate's own view of what
   * the mornings have spent, read fresh at every consultation rather than
   * copied.
   */
  projectStates(): ReadonlyMap<RepoSlug, ProjectState>;

  /**
   * Every ticket's own run span recorded so far, live — CONTEXT.md's "Run
   * span". What the merge gate reads to find when a turboable ticket's
   * implementation run started, and every span in the same repo to check a
   * grant against — a span a crash left open read as `effectiveRunSpans`
   * reads it, not as stored.
   */
  runSpans(): readonly RunSpan[];

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
 *
 * `exposeRecorder`, when given, is handed this invocation's own in-memory
 * recorder once, on construction — the only way anything outside this
 * function reaches it, since no production caller ever passes it.
 * `src/testing/fake-invocation-state.ts` is the one caller: a test that
 * needs to seed a worked-today record against a live invocation mid-selection,
 * where `FakeStore.markWorkedOn`, which seeds the stored document before the
 * invocation opens, does not reach.
 */
export function invocationState(
  ports: InvocationStatePorts,
  stored: State,
  today: Day,
  foreignFields: () => ForeignStateFields,
  current?: CurrentInvocation,
  exposeRecorder?: (record: (ticket: WorkedTicket, day: Day) => void) => void,
): InvocationState {
  const projects = new Map(stored.projects);
  let runSpans = stored.runSpans;
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
    ...(runSpans !== undefined && { runSpans }),
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

  // A queue of its own, separate from `queued`: the journal is a different
  // document from the state, written by a different pair of calls, and two
  // runs starting or ending at once must still land as a read, modify and
  // write apiece rather than racing each other over the same record.
  let queuedRuns: Promise<unknown> = Promise.resolve();
  const queueRunWrite = (write: () => Promise<void>): Promise<void> => {
    const done = queuedRuns.then(write, write);
    queuedRuns = done.catch(() => {});
    return done;
  };

  const state: InvocationState = {
    passesOver: (ticket) => passedOver.has(ticketKey(ticket)),
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
    recordRunStarted: (run) => {
      if (current === undefined) {
        return Promise.resolve();
      }
      return queueRunWrite(() => ports.store.recordRunStarted(current.self, run));
    },
    recordRunEnded: (repo, number) => {
      if (current === undefined) {
        return Promise.resolve();
      }
      return queueRunWrite(() => ports.store.recordRunEnded(current.self, repo, number));
    },
    recordRunSpanStarted: (ticket, startedAt) => {
      runSpans = recordRunSpanStarted(runSpans, ticket, startedAt, current?.self);
      return doSave(buildState());
    },
    recordRunSpanEnded: (ticket, openedAt, endedAt) => {
      // Closes only the span this run itself opened: a span for a different
      // start — left by an earlier run, or already replaced by a later one
      // — is not this run's to touch, and there is then nothing here to
      // close, no save to make either.
      const current = runSpanFor(runSpans, ticket);
      if (current === undefined || current.startedAt.getTime() !== openedAt.getTime()) {
        return Promise.resolve();
      }
      runSpans = recordRunSpanEnded(runSpans, ticket, endedAt);
      return doSave(buildState());
    },
    iterationEnded: (ticket, iteration) => {
      if (freesTicketToday(iteration)) {
        doUnrecord(ticket);
      }
    },
    projectStates: () => projects,
    runSpans: () => effectiveRunSpans(runSpans, current),
    freed: () => freed,
    save: () => doSave(buildState()),
  };
  exposeRecorder?.(doRecord);
  return state;
}

/**
 * `spans` as the merge gate should read them: a span still missing
 * `endedAt` whose opening invocation is dead — `runSpanInProgress` false —
 * reads as ended at its own `startedAt` rather than covering everything
 * after it, so a run a crash left open does not go on blocking every later
 * turboable grant in its repo. `current` absent, or its journal unreadable,
 * leaves every span exactly as recorded: the same "frees nothing" fallback
 * `freeDeadInvocations` takes for the same reason, since dead and alive
 * cannot be told apart without a journal to check.
 */
function effectiveRunSpans(
  spans: RunSpan[] | undefined,
  current: CurrentInvocation | undefined,
): readonly RunSpan[] {
  if (spans === undefined) {
    return [];
  }
  if (current === undefined || current.journal === undefined) {
    return spans;
  }
  const { self, journal } = current;
  return spans.map((span) =>
    span.endedAt === undefined && !runSpanInProgress(span, self, journal)
      ? { ...span, endedAt: span.startedAt }
      : span,
  );
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
  return inFlight(recordedBy, journal) ? recordedBy : undefined;
}
