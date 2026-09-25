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

/**
 * One usage report's raw field counts, before weighting — what a run's
 * envelope or a session log line carries under `input_tokens`,
 * `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`
 * (or `modelUsage`'s camelCase equivalents), read into one shape so
 * `weightedTokenCount` has one thing to weigh regardless of which the caller
 * started from.
 */
export interface UsageFields {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * A fresh input token, weighted 1. The provider publishes no weights for how
 * tokens count against a session or weekly limit, but it prices every current
 * model by the same ratios to a fresh input token, and those ratios are what
 * `weightedTokenCount` weighs by, in place of the equal weighting that let a
 * run's cache reads — priced, and so likely counted, far below a fresh token
 * — pass for most of its cost.
 */
const CACHE_CREATION_WEIGHT = 1.25;
const CACHE_READ_WEIGHT = 0.1;
const OUTPUT_WEIGHT = 5;

/**
 * `fields`, weighted by the provider's own price ratios — left unrounded, for
 * a caller summing several usage reports into one total, so rounding happens
 * once on the sum rather than once per report and drifting from it.
 */
export function weightedTokens(fields: UsageFields): number {
  return (
    fields.input +
    fields.output * OUTPUT_WEIGHT +
    fields.cacheCreation * CACHE_CREATION_WEIGHT +
    fields.cacheRead * CACHE_READ_WEIGHT
  );
}

/** `weightedTokens`, rounded to a whole number of tokens. */
export function weightedTokenCount(fields: UsageFields): TokenCount {
  return tokenCount(Math.max(0, Math.round(weightedTokens(fields))));
}
