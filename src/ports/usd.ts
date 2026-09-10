declare const usdBrand: unique symbol;

/**
 * An amount of US dollars: what a single run is allowed to spend.
 *
 * The manager's budget is denominated in tokens everywhere else, because runs
 * happen on a subscription rather than metered billing. The spend ceiling is
 * the exception, and it is in dollars because the agent CLI is what enforces
 * it and dollars are the only ceiling it accepts.
 *
 * Branded, so a dollar amount cannot be handed to a parameter asking for
 * tokens. Values enter through `usd` or `isUsd`.
 */
export type Usd = number & { readonly [usdBrand]: true };

/** Whether `value` is a usable amount: a finite number above 0. */
export function isUsd(value: number): value is Usd {
  return Number.isFinite(value) && value > 0;
}

/** Narrows `value` to a `Usd`, throwing if it is not one. */
export function usd(value: number): Usd {
  if (!isUsd(value)) {
    throw new TypeError(
      `Not a dollar amount, expected a finite number above 0: ${value}`,
    );
  }
  return value;
}
