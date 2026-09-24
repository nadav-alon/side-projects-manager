declare const dayBrand: unique symbol;

const PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar day, `YYYY-MM-DD`: what worked today and the once-a-day summary
 * rule are scoped to.
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

/**
 * The calendar day `at` falls on, in the machine's local time — the same
 * timezone a developer's schedule and logon happen in, so a day boundary
 * lands where they'd expect it rather than at UTC midnight.
 */
export function localDay(at: Date): Day {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const date = `${at.getDate()}`.padStart(2, "0");
  return day(`${year}-${month}-${date}`);
}

/** `at`'s local time, as `HH:MM`. */
export function localTimeOfMinute(at: Date): string {
  const hours = `${at.getHours()}`.padStart(2, "0");
  const minutes = `${at.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** `at`'s local time, as `HH:MM:SS` — the grain a redraw needs to look alive within the same minute. */
export function localTimeOfSecond(at: Date): string {
  const seconds = `${at.getSeconds()}`.padStart(2, "0");
  return `${localTimeOfMinute(at)}:${seconds}`;
}
