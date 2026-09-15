declare const ticketGistBrand: unique symbol;

/**
 * One sentence saying what a ticket asked for — not what its diff did.
 *
 * Branded, because a gist, a ticket title and a pull request body are all
 * strings, and only a guard can tell a real one-sentence gist from the empty
 * or multi-line text an agent's raw output can just as easily contain.
 * Values enter through `ticketGist` or `isTicketGist`.
 */
export type TicketGist = string & { readonly [ticketGistBrand]: true };

/** Whether `value` is one non-empty line, already trimmed. */
export function isTicketGist(value: string): value is TicketGist {
  return value !== "" && value.trim() === value && !value.includes("\n");
}

/** Narrows `value` to a `TicketGist`, throwing if it is not one. */
export function ticketGist(value: string): TicketGist {
  if (!isTicketGist(value)) {
    throw new TypeError(
      `Not a ticket gist: expected one non-empty, trimmed line, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
