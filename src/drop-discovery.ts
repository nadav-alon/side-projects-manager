import type { IssueReference, Store } from "./ports/index.ts";
import { ticketReference } from "./ports/index.ts";

/**
 * Drops every recorded discovery against `ticket` from the store, whatever
 * state the ticket is in, and returns the line to print: how many it dropped.
 * A ticket with no recorded discovery drops nothing.
 */
export async function dropDiscoveryOf(
  store: Pick<Store, "loadRecordedDiscoveries" | "dropDiscoveries">,
  ticket: IssueReference,
): Promise<string> {
  const before = await store.loadRecordedDiscoveries();
  const dropped = before.filter(({ repo, number }) => repo === ticket.repo && number === ticket.number).length;
  if (dropped > 0) {
    await store.dropDiscoveries([ticket]);
  }
  return `Dropped ${dropped} recorded ${dropped === 1 ? "discovery" : "discoveries"} on ${ticketReference(ticket)}.`;
}
