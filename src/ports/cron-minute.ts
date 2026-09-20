declare const cronMinuteBrand: unique symbol;

/**
 * The minute of every hour a schedule fires, e.g. `"0"` or `"30"` — a cron
 * line's first field, restricted to what `install-triggers.sh` ever writes
 * there: a single whole number from 0 to 59. Never a list, a range, a step,
 * or `*`, so a hand-edited crontab carrying one of those cannot be rendered
 * as though it named a single minute.
 */
export type CronMinute = string & { readonly [cronMinuteBrand]: true };

const WHOLE_MINUTE = /^([0-9]|[1-5][0-9])$/;

/** Whether `value` is a single whole number from 0 to 59. */
export function isCronMinute(value: string): value is CronMinute {
  return WHOLE_MINUTE.test(value);
}

/** Narrows `value` to a `CronMinute`, throwing if it is not one. */
export function cronMinute(value: string): CronMinute {
  if (!isCronMinute(value)) {
    throw new TypeError(
      `Not a cron minute, expected a single whole number from 0 to 59: ${value}`,
    );
  }
  return value;
}
