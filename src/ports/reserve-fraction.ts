declare const reserveFractionBrand: unique symbol;

/**
 * The reserve: the fraction of the weekly window held back for the
 * developer's own interactive work, so the mechanical half of the work can
 * never starve the expensive half.
 *
 * At least 0 and less than 1. A reserve of 0 holds nothing back, which is a
 * choice the developer is allowed to make; a reserve of 1 would hold back the
 * whole window and no run could ever start, which is not a configuration but
 * a typo.
 *
 * Branded, because the loop passes several unrelated numbers around and a
 * bare `number` would let a token count or a priority arrive here. Values
 * enter through `reserveFraction` or `isReserveFraction`.
 */
export type ReserveFraction = number & {
  readonly [reserveFractionBrand]: true;
};

/** Whether `value` is a usable reserve: at least 0, and less than 1. */
export function isReserveFraction(value: number): value is ReserveFraction {
  return Number.isFinite(value) && value >= 0 && value < 1;
}

/** Narrows `value` to a `ReserveFraction`, throwing if it is not one. */
export function reserveFraction(value: number): ReserveFraction {
  if (!isReserveFraction(value)) {
    throw new TypeError(
      `Not a reserve fraction, expected at least 0 and less than 1: ${value}`,
    );
  }
  return value;
}
