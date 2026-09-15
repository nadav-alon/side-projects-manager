/**
 * The four sizes a size label may name, smallest first. `Budget.sizes` gives
 * each the tokens it is worth; `CONTEXT.md`'s "Size label" is what the label
 * itself means. The size label and the gate both name a run's estimate with
 * one of these.
 */
export const SIZES = ["S", "M", "L", "XL"] as const;

export type Size = (typeof SIZES)[number];

/**
 * Whether `value` is one of the four ticket sizes, matched exactly.
 * `sizeLabelOf` folds a size label's case before calling this, so the check
 * itself can stay strict rather than guessing which of its callers want case
 * folded and which don't.
 */
export function isSize(value: string): value is Size {
  return (SIZES as readonly string[]).includes(value);
}

/**
 * Which of two sizes is larger, per `SIZES`' order. What `sizeLabelOf` folds
 * a ticket's declared sizes with, kept here so the ordering contract is
 * tested beside the type it belongs to.
 */
export function largerSize(a: Size, b: Size): Size {
  return SIZES.indexOf(b) > SIZES.indexOf(a) ? b : a;
}
