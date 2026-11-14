import type { IssueReference, Store } from "./ports/index.ts";
import { ticketReference } from "./ports/index.ts";

/**
 * Drops every recorded discovery against `ticket` from the store, whatever
 * state the ticket is in, and returns the line to print: how many it dropped.
 * A ticket with no recorded discovery drops nothing.
 */
export async function dropDiscoveryOf(
  store: Pick<Store, "dropDiscoveries">,
  ticket: IssueReference,
): Promise<string> {
  const dropped = await store.dropDiscoveries([ticket]);
  return `Dropped ${dropped} recorded ${dropped === 1 ? "discovery" : "discoveries"} on ${ticketReference(ticket)}.`;
}
