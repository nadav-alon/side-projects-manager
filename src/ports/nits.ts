declare const nitsBrand: unique symbol;

/**
 * The nits an implementation run listed under `NIT_SECTION_HEADING` but did
 * not fix, off its own final output. See the glossary entry "Nit" in
 * `CONTEXT.md` for what one is; this port only carries the run's own list.
 *
 * Branded, so a raw agent-output string cannot stand in for the one section
 * that was actually picked out of it — nor be swapped with the sibling
 * `TicketGist` it travels beside through `AgentRun`, `RunFinished` and
 * `openDraftPullRequest`, since both are otherwise bare strings read off the
 * same output. Values enter through `nits` or `isNits`.
 */
export type Nits = string & { readonly [nitsBrand]: true };

/** Whether `value` is non-empty and already trimmed of surrounding whitespace. */
export function isNits(value: string): value is Nits {
  return value !== "" && value.trim() === value;
}

/** Narrows `value` to `Nits`, throwing if it is empty or not already trimmed. */
export function nits(value: string): Nits {
  if (!isNits(value)) {
    throw new TypeError(
      `Not nits, expected a trimmed non-empty string: ${JSON.stringify(value)}`,
    );
  }
  return value;
}
