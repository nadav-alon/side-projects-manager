import type { Day, WorkedTicket, WorkedToday } from "./ports/index.ts";
import { recordWorked, ticketKey, unrecordWorked } from "./ports/index.ts";

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
}

/**
 * Starts from `stored`, the record the state document held. A record for any
 * day but `today` says nothing about today, so it reads as nothing worked yet.
 */
export function workedTickets(
  stored: WorkedToday | undefined,
  today: Day,
): WorkedTickets {
  let record = stored?.day === today ? stored : undefined;
  const passedOver = new Set(record?.tickets.map(ticketKey));

  return {
    passesOver: (ticket) => passedOver.has(ticketKey(ticket)),
    record: (ticket, day) => {
      passedOver.add(ticketKey(ticket));
      record = recordWorked(record, ticket, day);
    },
    unrecord: (ticket) => {
      if (record !== undefined) {
        record = unrecordWorked(record, ticket);
      }
    },
    workedToday: () => record,
  };
}
