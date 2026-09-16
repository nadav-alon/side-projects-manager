declare const ticketGistBrand: unique symbol;

/**
 * One sentence saying what an implementation ticket asked for — not what its
 * diff did. See the glossary entry in `CONTEXT.md` for where it is headed;
 * this port only carries it off a finished run.
 *
 * Branded, so a raw agent-output string cannot stand in for the one line
 * that was actually picked out of it. Values enter through `ticketGist` or
 * `isTicketGist`.
 */
export type TicketGist = string & { readonly [ticketGistBrand]: true };

/** Whether `value` is a non-empty single line, trimmed of nothing itself. */
export function isTicketGist(value: string): value is TicketGist {
  return value !== "" && !value.includes("\n");
}

/** Narrows `value` to a `TicketGist`, throwing if it is empty or multi-line. */
export function ticketGist(value: string): TicketGist {
  if (!isTicketGist(value)) {
    throw new TypeError(
      `Not a ticket gist, expected one non-empty line: ${JSON.stringify(value)}`,
    );
  }
  return value;
}
