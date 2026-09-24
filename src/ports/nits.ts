declare const nitsBrand: unique symbol;

/**
 * The fixed heading a pull request body's nit section sits under, named once
 * so the implementation prompt's instruction to write it, the review
 * prompt's instruction to read it, and the draft pull request body's own
 * rendering of it can only ever agree with each other.
 */
export const NIT_SECTION_HEADING = "## Nits";

/**
 * Nits an implementation run noticed but did not cause, in its own words —
 * what a finished run's output carries under {@link NIT_SECTION_HEADING} for
 * the draft pull request body to render, and the review prompt to turn into
 * findings. See the glossary entry "Nit" in `CONTEXT.md`.
 *
 * Branded so raw agent output cannot stand in for the text actually read
 * back off the fixed heading. Values enter through `nits` or `isNits`.
 */
export type Nits = string & { readonly [nitsBrand]: true };

/** Whether `value` is non-empty once trimmed. */
export function isNits(value: string): value is Nits {
  return value.trim() !== "";
}

/** Narrows `value` to `Nits`, throwing if it is blank. */
export function nits(value: string): Nits {
  if (!isNits(value)) {
    throw new TypeError(`Not a nit list, expected non-blank text: ${JSON.stringify(value)}`);
  }
  return value;
}
