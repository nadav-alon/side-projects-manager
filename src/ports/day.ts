declare const dayBrand: unique symbol;

const PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar day, `YYYY-MM-DD`: a trigger-lock key and, in the file-backed
 * lock, a filename.
 *
 * Branded, so a day cannot be handed a branch name or any other string of
 * the same shape. Values enter through `day` or `isDay`.
 */
export type Day = string & { readonly [dayBrand]: true };

/** Whether `value` is a well-formed calendar day. */
export function isDay(value: string): value is Day {
  return PATTERN.test(value);
}

/** Narrows `value` to a `Day`, throwing if it is not `YYYY-MM-DD`. */
export function day(value: string): Day {
  if (!isDay(value)) {
    throw new TypeError(`Not a day, expected YYYY-MM-DD: ${value}`);
  }
  return value;
}
