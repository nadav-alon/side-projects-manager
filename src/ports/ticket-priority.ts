declare const ticketPriorityBrand: unique symbol;

/**
 * The explicit rank an implementation ticket may carry, as a `priority:1`–
 * `priority:3` label in its own project's tracker: smaller is worked first,
 * and a ticket without one sorts after every ticket with one.
 *
 * Distinct from `Priority`, which ranks projects rather than tickets: the two
 * brands are never interchangeable, and a ticket priority never makes one
 * project outrank another.
 *
 * Branded, so a ticket number or token count cannot stand in for one. Values
 * enter through `ticketPriority` or `isTicketPriority`.
 */
export type TicketPriority = (1 | 2 | 3) & {
  readonly [ticketPriorityBrand]: true;
};

/** Whether `value` is a usable ticket priority: 1, 2, or 3. */
export function isTicketPriority(value: number): value is TicketPriority {
  return value === 1 || value === 2 || value === 3;
}

/** Narrows `value` to a `TicketPriority`, throwing if it is not one. */
export function ticketPriority(value: number): TicketPriority {
  if (!isTicketPriority(value)) {
    throw new TypeError(
      `Not a ticket priority, expected 1, 2 or 3: ${value}`,
    );
  }
  return value;
}
