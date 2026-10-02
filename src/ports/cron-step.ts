declare const cronStepBrand: unique symbol;

/**
 * The minutes between a schedule's firings, e.g. `"15"` — the `N` of the
 * step a cron line's first field names (star, slash, `N`), restricted to what
 * keeps firings evenly spaced across the hour: a whole number from 1 to 30
 * that divides 60. Never a single minute, a list or a range, so a hand-edited
 * crontab carrying one of those cannot be rendered as though it named a
 * steady interval.
 */
export type CronStep = string & { readonly [cronStepBrand]: true };

const DIVISORS_OF_SIXTY = new Set(["1", "2", "3", "4", "5", "6", "10", "12", "15", "20", "30"]);

/** Whether `value` is a whole number from 1 to 30 that divides 60. */
export function isCronStep(value: string): value is CronStep {
  return DIVISORS_OF_SIXTY.has(value);
}

/** Narrows `value` to a `CronStep`, throwing if it is not one. */
export function cronStep(value: string): CronStep {
  if (!isCronStep(value)) {
    throw new TypeError(
      `Not a cron step, expected a whole number from 1 to 30 that divides 60: ${value}`,
    );
  }
  return value;
}
