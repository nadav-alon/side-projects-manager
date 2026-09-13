declare const ticketPriorityBrand: unique symbol;

/**
 * The explicit priority an implementation ticket may carry, as a label in its
 * own project's tracker: one of three levels, where the smaller is worked
 * first. Orders tickets within one project only; a project's own rank is
 * `Priority`.
 *
 * Branded, so a ticket priority cannot be handed a project's priority or an
 * issue number. Values enter through `ticketPriority` or `isTicketPriority`.
 */
export type TicketPriority = (1 | 2 | 3) & { readonly [ticketPriorityBrand]: true };

/** Whether `value` is one of the three ticket priority levels. */
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
