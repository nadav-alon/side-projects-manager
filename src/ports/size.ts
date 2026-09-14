/**
 * The four sizes a size label may name, smallest first. `Budget.sizes` gives
 * each the tokens it is worth; `CONTEXT.md`'s "Size label" is what the label
 * itself means. The size label and the gate both name a run's estimate with
 * one of these.
 */
export const SIZES = ["S", "M", "L", "XL"] as const;

export type Size = (typeof SIZES)[number];

/** Whether `value` is one of the four ticket sizes. */
export function isSize(value: string): value is Size {
  return (SIZES as readonly string[]).includes(value);
}
