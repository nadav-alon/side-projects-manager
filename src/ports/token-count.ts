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

declare const weightedTokensBrand: unique symbol;

/**
 * A number of tokens weighted by `weighTokenFields`, left unrounded — a
 * caller summing several usage reports into one total sums these first, so
 * rounding happens once on the total rather than once per report and
 * drifting from it. `weightedTokenCount` is `roundedTokenCount` applied to
 * this.
 *
 * Branded apart from a bare `number` for the same reason `TokenCount` is,
 * and apart from `TokenCount` itself so a caller cannot pass an unrounded
 * figure where a whole token count is expected. Values enter through
 * `weightedTokens` or `isWeightedTokens`.
 */
export type WeightedTokens = number & { readonly [weightedTokensBrand]: true };

/** Whether `value` is a usable weighted-token figure: finite, 0 or greater. */
export function isWeightedTokens(value: number): value is WeightedTokens {
  return Number.isFinite(value) && value >= 0;
}

/** Narrows `value` to `WeightedTokens`, throwing if it is not one. */
export function weightedTokens(value: number): WeightedTokens {
  if (!isWeightedTokens(value)) {
    throw new TypeError(
      `Not a weighted token figure, expected 0 or greater: ${value}`,
    );
  }
  return value;
}

/** `value`, rounded to the nearest whole token and floored at 0. */
export function roundedTokenCount(value: number): TokenCount {
  return tokenCount(Math.max(0, Math.round(value)));
}

/**
 * One usage report's raw field counts, before weighting — what a run's
 * envelope or a session log line carries under `input_tokens`,
 * `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`
 * (or `modelUsage`'s camelCase equivalents), read into one shape so
 * `weighTokenFields` has one thing to weigh regardless of which the caller
 * started from.
 */
export interface UsageFields {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * The provider's own price ratios to a fresh input token — what
 * `weighTokenFields` weighs each field by, since the provider publishes no
 * weights of its own for what counts against a session or weekly limit.
 */
const INPUT_WEIGHT = 1;
const CACHE_CREATION_WEIGHT = 1.25;
const CACHE_READ_WEIGHT = 0.1;
const OUTPUT_WEIGHT = 5;

/** `value` if it is a number, 0 otherwise — a usage field that was never sent. */
export function numberField(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** `fields`, weighed by the provider's own price ratios. */
export function weighTokenFields(fields: UsageFields): WeightedTokens {
  return weightedTokens(
    fields.input * INPUT_WEIGHT +
      fields.output * OUTPUT_WEIGHT +
      fields.cacheCreation * CACHE_CREATION_WEIGHT +
      fields.cacheRead * CACHE_READ_WEIGHT,
  );
}

/** `weighTokenFields`, rounded to a whole number of tokens. */
export function weightedTokenCount(fields: UsageFields): TokenCount {
  return roundedTokenCount(weighTokenFields(fields));
}
