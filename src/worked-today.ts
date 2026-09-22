import type { Day, Journal, OpenInvocation, WorkedTicket, WorkedToday } from "./ports/index.ts";
import {
  findInvocationRecord,
  isClosedInvocation,
  recordWorked,
  ticketKey,
  unrecordWorked,
} from "./ports/index.ts";

/**
 * The invocation running now, and the journal as it stood when it started:
 * what `workedTickets` needs to tell a worked-today entry recorded by a dead
 * in-flight invocation apart from one still protected. Absent when the
 * caller has no lease and no journal record — as in a test that builds
 * `workedTickets` directly — in which case nothing is freed.
 */
export interface CurrentInvocation {
  self: OpenInvocation;
  journal: Journal;
}

/** One worked-today entry freed because the invocation that recorded it died. */
export interface FreedWorkedTicket {
  ticket: WorkedTicket;
  /** The dead invocation's own record: its opened-at instant and pid. */
  invocation: OpenInvocation;
}

/**
 * What one invocation knows of the tickets worked today: which ones selection
 * passes over, and the record the state document is to keep.
 *
 * The two are kept together because they deliberately differ. Selection
 * passes over every ticket the record held when the invocation started and
 * every ticket it recorded since, for the whole invocation. The record, by
 * contrast, loses a ticket taken back off it — whenever the loop's own
 * tracker write for it landed, freeing its ticket for a later firing — and
 * starts over when the local day turns mid-invocation.
 */
export interface WorkedTickets {
  /** Whether selection passes `ticket` over for the rest of this invocation. */
  passesOver(ticket: WorkedTicket): boolean;
  /**
   * Records `ticket` as worked on `day`. A ticket counts from the moment it is
   * selected, whatever its iteration then comes to.
   */
  record(ticket: WorkedTicket, day: Day): void;
  /**
   * Takes `ticket` back off the record, so a later firing today may select
   * it. This invocation still passes it over.
   */
  unrecord(ticket: WorkedTicket): void;
  /** The record as the state document is to keep it; absent if nothing was recorded. */
  workedToday(): WorkedToday | undefined;
  /**
   * Every ticket freed on construction because a dead in-flight invocation
   * had recorded it — CONTEXT.md's "Worked today". Fixed for the life of this
   * `WorkedTickets`: nothing recorded or unrecorded during the invocation
   * adds to it.
   */
  freed(): FreedWorkedTicket[];
}

/**
 * Starts from `stored`, the record the state document held. A record for any
 * day but `today` says nothing about today, so it reads as nothing worked yet.
 *
 * `current`, when given, is used once, on construction, to free every entry
 * recorded by an invocation still in flight in its journal: the invocation
 * lease means only one invocation runs at a time, so any other in-flight
 * record belongs to one that died before it could close. `current` absent —
 * no lease, no journal record — frees nothing, same as an entry naming no
 * invocation, one whose invocation closed, one whose invocation is missing
 * from the journal, or one recorded by this same invocation.
 */
export function workedTickets(
  stored: WorkedToday | undefined,
  today: Day,
  current?: CurrentInvocation,
): WorkedTickets {
  const today0 = stored?.day === today ? stored : undefined;
  const { kept, freed } = freeDeadInvocations(today0, current);
  let record = kept;
  const passedOver = new Set(record?.tickets.map(ticketKey));

  return {
    passesOver: (ticket) => passedOver.has(ticketKey(ticket)),
    record: (ticket, day) => {
      passedOver.add(ticketKey(ticket));
      const recorded: WorkedTicket =
        current === undefined ? ticket : { ...ticket, recordedBy: current.self };
      record = recordWorked(record, recorded, day);
    },
    unrecord: (ticket) => {
      if (record !== undefined) {
        record = unrecordWorked(record, ticket);
      }
    },
    workedToday: () => record,
    freed: () => freed,
  };
}

/**
 * `stored` with every entry recorded by a dead in-flight invocation taken
 * off it, and those entries reported so the summary can name them.
 */
function freeDeadInvocations(
  stored: WorkedToday | undefined,
  current: CurrentInvocation | undefined,
): { kept: WorkedToday | undefined; freed: FreedWorkedTicket[] } {
  if (stored === undefined || current === undefined) {
    return { kept: stored, freed: [] };
  }
  const freed: FreedWorkedTicket[] = [];
  const kept = stored.tickets.filter((ticket) => {
    const dead = deadInvocationOf(ticket.recordedBy, current);
    if (dead === undefined) {
      return true;
    }
    freed.push({ ticket, invocation: dead });
    return false;
  });
  return { kept: { day: stored.day, tickets: kept }, freed };
}

/**
 * `recordedBy`, if it names an invocation still in flight in `current`'s
 * journal and is not `current.self` — the invocation's own record is in
 * flight while it runs, so it never counts as dead. `undefined` for an entry
 * naming no invocation, this invocation, one whose record has closed, or one
 * missing from the journal entirely (pruned, say): every one of those stays
 * passed over, as today.
 */
function deadInvocationOf(
  recordedBy: OpenInvocation | undefined,
  current: CurrentInvocation,
): OpenInvocation | undefined {
  if (recordedBy === undefined || findInvocationRecord([current.self], recordedBy) !== undefined) {
    return undefined;
  }
  const record = findInvocationRecord(current.journal.records, recordedBy);
  return record !== undefined && !isClosedInvocation(record) ? recordedBy : undefined;
}
