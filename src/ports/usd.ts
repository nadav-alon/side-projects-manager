declare const usdBrand: unique symbol;

/**
 * An amount of US dollars: what a single run is allowed to spend.
 *
 * Nothing is billed. Runs happen on a subscription, so no dollars change
 * hands and the budget is tokens everywhere else. This is dollars only
 * because the agent CLI's ceiling is: it prices the run's own token usage at
 * API rates as it goes and stops the run when that priced total crosses the
 * figure, whatever the token usage is actually drawn against. So it is a
 * token ceiling the manager has to state in the CLI's units, and it binds
 * under subscription auth: a run past it stops with `Exceeded USD budget`.
 * That it goes on being a flag the CLI accepts is what
 * `scripts/verify-harness.ts` holds the image to.
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
