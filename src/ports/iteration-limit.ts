declare const iterationLimitBrand: unique symbol;

/**
 * The most iterations one invocation may have in progress at once.
 *
 * A whole number from 1 upwards. Never 0: a limit of nothing would start no
 * work while reading as a budget that allows some.
 *
 * Branded, so a limit cannot be handed a priority or a token count. Values
 * enter through `iterationLimit` or `isIterationLimit`.
 */
export type IterationLimit = number & { readonly [iterationLimitBrand]: true };

/** Whether `value` is a usable limit: a whole number, 1 or greater. */
export function isIterationLimit(value: number): value is IterationLimit {
  return Number.isSafeInteger(value) && value >= 1;
}

/** Narrows `value` to an `IterationLimit`, throwing if it is not one. */
export function iterationLimit(value: number): IterationLimit {
  if (!isIterationLimit(value)) {
    throw new TypeError(
      `Not an iteration limit, expected a whole number of 1 or more: ${value}`,
    );
  }
  return value;
}
