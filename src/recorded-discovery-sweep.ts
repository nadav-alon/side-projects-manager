import { errorMessage } from "./error-message.ts";
import type { IssueNumber, IssueTracker, RepoSlug, Store } from "./ports/index.ts";
import { ticketReference } from "./ports/index.ts";

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
  store: Pick<Store, "loadRecordedDiscoveries" | "forgetDiscoveries">,
): Promise<void> {
  try {
    const tickets = new Map<string, { repo: RepoSlug; number: IssueNumber }>();
    for (const { repo, number } of await store.loadRecordedDiscoveries()) {
      tickets.set(ticketReference({ repo, number }), { repo, number });
    }
    const settled: { repo: RepoSlug; number: IssueNumber }[] = [];
    for (const [reference, ticket] of tickets) {
      try {
        if (!(await tracker.isWaitingOnDeveloper(ticket))) {
          settled.push(ticket);
        }
      } catch (error: unknown) {
        console.warn(`Could not read ${reference} to prune its recorded discoveries: ${errorMessage(error)}`);
      }
    }
    if (settled.length > 0) {
      await store.forgetDiscoveries(settled);
    }
  } catch (error: unknown) {
    console.warn(`Could not prune the recorded discoveries: ${errorMessage(error)}`);
  }
}
