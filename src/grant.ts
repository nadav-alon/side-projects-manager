import type { Clock, IssueReference, IssueTracker, Store } from "./ports/index.ts";
import { TURBOABLE_LABEL, isIssueNumber, isRepoSlug, recordGrant, ticketReference } from "./ports/index.ts";

/**
 * Reads `owner/repo#n` — the shape `ticketReference` writes — as the ticket
 * it names. Throws naming `text` when it is not one.
 */
export function parseTicketReference(text: string): IssueReference {
  const match = /^([^#\s]+)#(\d+)$/.exec(text);
  const repo = match?.[1];
  const number = Number(match?.[2]);
  if (repo === undefined || !isRepoSlug(repo) || !isIssueNumber(number)) {
    throw new Error(`Not a ticket reference, as owner/repo#n: ${JSON.stringify(text)}`);
  }
  return { repo, number };
}

/**
 * The developer's own grant of `turboable` on `ticket` (ADR 0012): adds the
 * label through `tracker`, then writes a grant record to the state document,
 * which no sandbox run can reach. Refuses, writing and labelling nothing,
 * when `ticket`'s project is unregistered or its `turbo` is off.
 *
 * The label goes first, so the record's `grantedAt` is never earlier than
 * the event it vouches for. A failed label leaves no record.
 */
export async function grantTurboable(
  ports: { store: Pick<Store, "loadRegistry" | "loadState" | "saveState">; clock: Clock },
  tracker: Pick<IssueTracker, "labelTurboable">,
  ticket: IssueReference,
): Promise<string> {
  const project = (await ports.store.loadRegistry()).find((entry) => entry.repo === ticket.repo);
  if (project === undefined) {
    throw new Error(`${ticket.repo} is not a registered project.`);
  }
  if (!project.turbo) {
    throw new Error(`${ticket.repo} is not a turbo project: turn turbo on in registry.json first.`);
  }
  await tracker.labelTurboable(ticket);
  const state = await ports.store.loadState();
  const grants = recordGrant(state.grants, ticket, ports.clock.now());
  await ports.store.saveState({ ...state, grants });
  return `Granted ${TURBOABLE_LABEL} on ${ticketReference(ticket)}.`;
}
