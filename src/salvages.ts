import type { Branch, Salvage, WorkedTicket } from "./ports/index.ts";
import {
  clearSalvage,
  recordInfrastructureFailureSalvage,
  recordLimitRefusalSalvage,
  salvageFor,
} from "./ports/index.ts";

/**
 * What one invocation knows of tickets' salvaged branches: the record the
 * state document is to keep, updated in place as runs land. See CONTEXT.md's
 * "Salvage": a limit-refused run, or a post-start infrastructure failure,
 * that leaves commits on its branch keeps that branch rather than discarding
 * it, and this is where the loop remembers which ticket it belongs to.
 */
export interface Salvages {
  /** The salvage record `ticket` carries, absent if it has none. */
  get(ticket: WorkedTicket): Salvage | undefined;
  /** Records `ticket`'s branch as salvaged from a limit refusal, and returns the record written. */
  recordLimitRefusal(ticket: WorkedTicket, branch: Branch): Salvage;
  /** Records `ticket`'s branch as salvaged from a post-start infrastructure failure, and returns the record written. */
  recordInfrastructureFailure(ticket: WorkedTicket, branch: Branch): Salvage;
  /** Clears `ticket`'s salvage record, absent if it had none. */
  clear(ticket: WorkedTicket): void;
  /** The record as the state document is to keep it; absent if nothing is salvaged. */
  record(): Salvage[] | undefined;
}

/** Starts from `stored`, the record the state document held. */
export function salvageRecords(stored: Salvage[] | undefined): Salvages {
  let record = stored;

  return {
    get: (ticket) => salvageFor(record, ticket),
    recordLimitRefusal: (ticket, branch) => {
      record = recordLimitRefusalSalvage(record, ticket, branch);
      // Just written above, so always present.
      return salvageFor(record, ticket)!;
    },
    recordInfrastructureFailure: (ticket, branch) => {
      record = recordInfrastructureFailureSalvage(record, ticket, branch);
      // Just written above, so always present.
      return salvageFor(record, ticket)!;
    },
    clear: (ticket) => {
      record = clearSalvage(record, ticket);
    },
    record: () => record,
  };
}
