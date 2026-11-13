import { errorMessage } from "./error-message.ts";
import type { IssueReference, IssueTracker, Store } from "./ports/index.ts";
import { ticketKey, ticketReference } from "./ports/index.ts";

/**
 * Drops the recorded discoveries whose ticket no longer waits on the
 * developer — closed, or no longer carrying `ready-for-human`. A ticket is
 * read once however many discoveries are recorded against it.
 *
 * Never throws: a ticket that cannot be read keeps its discoveries until a
 * sweep that can tell, and a failed write is reported on the console and
 * leaves them for the next sweep.
 */
export async function recordedDiscoverySweep(
  tracker: Pick<IssueTracker, "isWaitingOnDeveloper">,
  store: Pick<Store, "loadRecordedDiscoveries" | "dropDiscoveries">,
): Promise<void> {
  try {
    const tickets = new Map<string, IssueReference>();
    for (const { repo, number } of await store.loadRecordedDiscoveries()) {
      tickets.set(ticketKey({ repo, number }), { repo, number });
    }
    const settled: IssueReference[] = [];
    for (const ticket of tickets.values()) {
      try {
        if (!(await tracker.isWaitingOnDeveloper(ticket))) {
          settled.push(ticket);
        }
      } catch (error: unknown) {
        console.warn(`Could not read ${ticketReference(ticket)} to drop its recorded discoveries: ${errorMessage(error)}`);
      }
    }
    if (settled.length > 0) {
      await store.dropDiscoveries(settled);
    }
  } catch (error: unknown) {
    console.warn(`Could not drop the recorded discoveries: ${errorMessage(error)}`);
  }
}
