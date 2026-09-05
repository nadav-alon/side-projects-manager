declare const tokenCountBrand: unique symbol;

/**
 * A number of Claude tokens: what a run cost, and what a window has consumed.
 *
 * Branded, because the loop passes several unrelated numbers around — a
 * priority, an issue number, a reserve fraction — and the compiler would hand
 * any of them to a parameter asking for tokens. Values enter through
 * `tokenCount` or `isTokenCount`.
 */
export type TokenCount = number & { readonly [tokenCountBrand]: true };

/** Whether `value` is a usable token count: a whole number, 0 or greater. */
export function isTokenCount(value: number): value is TokenCount {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Narrows `value` to a `TokenCount`, throwing if it is not one. */
export function tokenCount(value: number): TokenCount {
  if (!isTokenCount(value)) {
    throw new TypeError(
      `Not a token count, expected a whole number of 0 or more: ${value}`,
    );
  }
  return value;
}
