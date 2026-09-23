import type {
  Day,
  ProjectState,
  RepoSlug,
  RunCost,
  State,
  Store,
  WorkedTicket,
} from "./ports/index.ts";
import { recordRun, recordWorked, ticketKey, unrecordWorked } from "./ports/index.ts";
import {
  failedOnInfrastructure,
  handedBackFailure,
  type Iteration,
} from "./iteration-outcome.ts";

/** The one port a state session needs: writing the whole state document back. */
export interface StateSessionPorts {
  store: Pick<Store, "saveState">;
}

/**
 * What a save is to fold into the state document besides the bookkeeping the
 * session itself owns: the salvage record, whose rules belong to
 * `salvages.ts`, and the day a summary was announced on, once the
 * invocation's own publish has succeeded. Absent fields are left out of the
 * document exactly as `State`'s own optional fields are.
 */
export type StateSessionRest = Pick<State, "announcedOn" | "salvages">;

/**
 * `StateSessionRest` built from loose optional values, left out of the
 * document rather than carried as an explicit `undefined` — the shape every
 * other optional field on `State` is built in.
 */
export function stateSessionRest(
  announcedOn: Day | undefined,
  salvages: State["salvages"],
): StateSessionRest {
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
 */
export interface StateSession {
  /** Whether selection passes `ticket` over for the rest of this invocation. */
  passesOver(ticket: WorkedTicket): boolean;

  /**
   * Records `ticket` as worked on `day` and saves the whole state document at
   * once, resolving only once that save lands — so a ticket counts as worked
   * from the moment it is selected, and a run killed part way still counts.
   * If the save itself fails, `ticket` is taken back off the record before
   * the failure reaches the caller.
   */
  ticketSelected(
    ticket: WorkedTicket,
    day: Day,
    rest?: StateSessionRest,
  ): Promise<void>;

  /**
   * Records `ticket` as worked on `day`, in memory only — for a ticket handed
   * back ahead of the gate, whose iteration never reaches the sandbox and so
   * carries none of `ticketSelected`'s own save-at-once guarantee.
   */
  recordWorked(ticket: WorkedTicket, day: Day): void;

  /** Takes `ticket` back off the worked-today record, in memory only. */
  unrecordWorked(ticket: WorkedTicket): void;

  /**
   * Takes `ticket` back off the worked-today record when `iteration`'s own
   * ending frees it — CONTEXT.md's "Worked today", `freesTicketToday` below.
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

  /** Saves the whole state document once, `rest` folded in as `ticketSelected` does. */
  save(rest?: StateSessionRest): Promise<void>;
}

/**
 * Builds one invocation's state session, starting from `stored` — the state
 * document as the invocation found it — and `today`, the local calendar day
 * it opened on. A worked-today record for any day but `today` says nothing
 * about today, so it reads as nothing worked yet: CONTEXT.md's "Worked
 * today".
 */
export function stateSession(
  ports: StateSessionPorts,
  stored: State,
  today: Day,
): StateSession {
  const projects = new Map(stored.projects);
  let record = stored.workedToday?.day === today ? stored.workedToday : undefined;
  // Never shrinks, unlike `record`: selection passes over every ticket the
  // record held when the invocation started and every ticket it recorded
  // since, for the whole invocation, even one later taken back off `record`.
  const passedOver = new Set(record?.tickets.map(ticketKey));

  const doRecord = (ticket: WorkedTicket, day: Day): void => {
    passedOver.add(ticketKey(ticket));
    record = recordWorked(record, ticket, day);
  };
  const doUnrecord = (ticket: WorkedTicket): void => {
    if (record !== undefined) {
      record = unrecordWorked(record, ticket);
    }
  };
  const buildState = (rest: StateSessionRest): State => ({
    projects,
    ...(record !== undefined && { workedToday: record }),
    ...(rest.announcedOn !== undefined && { announcedOn: rest.announcedOn }),
    ...(rest.salvages !== undefined && { salvages: rest.salvages }),
  });

  return {
    passesOver: (ticket) => passedOver.has(ticketKey(ticket)),
    recordWorked: doRecord,
    unrecordWorked: doUnrecord,
    ticketSelected: async (ticket, day, rest = {}) => {
      doRecord(ticket, day);
      try {
        await ports.store.saveState(buildState(rest));
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
    save: (rest = {}) => ports.store.saveState(buildState(rest)),
  };
}

/**
 * Whether `iteration` frees its ticket to be selected again today —
 * CONTEXT.md's "Worked today" rule: the persisted record protects only the
 * tickets the loop tried and failed to take off the queue itself.
 *
 * An infrastructure failure, a limit refusal or a provider failure says
 * nothing about the ticket at all, so it always frees it. A finished, a
 * spec-reviewed, a discovery-blocked or a failed run frees it exactly when
 * its own hand-back landed — `"handed-back"` or `"already-closed"` — and
 * leaves it recorded when the tracker refused the call. A review, an
 * apply-review, a rebase or a resolved pull request frees it exactly when it
 * closed without a `notClosed`, and leaves it recorded when one is set — the
 * ticket is still ready-for-agent, due to come round again on its own, so the
 * record still has something to protect.
 */
function freesTicketToday(iteration: Iteration): boolean {
  switch (iteration.kind) {
    case "limit-refused":
    case "provider-failed":
    case "budget-exhausted":
      return true;
    case "finished":
    case "spec-reviewed":
    case "discovery-blocked":
      return iteration.handedBack.outcome !== "refused";
    case "failed":
      return (
        failedOnInfrastructure(iteration) ||
        (handedBackFailure(iteration) &&
          iteration.handedBack.outcome !== "refused")
      );
    case "reviewed":
    case "applied-review":
    case "rebased":
    case "pull-request-resolved":
      return iteration.notClosed === undefined;
  }
}
