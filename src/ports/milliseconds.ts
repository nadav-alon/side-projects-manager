declare const millisecondsBrand: unique symbol;

/**
 * A span of time in milliseconds: a window's length, not an instant.
 *
 * Branded, because the loop passes several unrelated numbers around and a
 * bare `number` would let a token count or a priority stand in for a
 * duration. Values enter through `milliseconds` or `isMilliseconds`.
 */
export type Milliseconds = number & { readonly [millisecondsBrand]: true };

/** Whether `value` is a usable duration: a whole number, 0 or greater. */
export function isMilliseconds(value: number): value is Milliseconds {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Narrows `value` to `Milliseconds`, throwing if it is not one. */
export function milliseconds(value: number): Milliseconds {
  if (!isMilliseconds(value)) {
    throw new TypeError(
      `Not a duration in milliseconds, expected a whole number of 0 or more: ${value}`,
    );
  }
  return value;
}
