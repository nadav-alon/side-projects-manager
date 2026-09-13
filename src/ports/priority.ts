declare const priorityBrand: unique symbol;

/**
 * The explicit priority a project may carry in the registry, overriding
 * least-recently-worked ordering.
 *
 * A whole number from 1 upwards, where the smaller number is worked first, so
 * that the project the developer cares about right now is priority 1. A
 * project without one sorts after every project that has one.
 *
 * Always a project's; the rank a ticket carries is `TicketPriority`, a
 * separate brand.
 *
 * Branded, so a priority cannot be handed a token count or an issue number.
 * Values enter through `priority` or `isPriority`.
 */
export type Priority = number & { readonly [priorityBrand]: true };

/** Whether `value` is a usable priority: a whole number, 1 or greater. */
export function isPriority(value: number): value is Priority {
  return Number.isSafeInteger(value) && value >= 1;
}

/** Narrows `value` to a `Priority`, throwing if it is not one. */
export function priority(value: number): Priority {
  if (!isPriority(value)) {
    throw new TypeError(
      `Not a priority, expected a whole number of 1 or more: ${value}`,
    );
  }
  return value;
}
