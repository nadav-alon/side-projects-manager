import type { Clock, IssueReference, IssueTracker, Store } from "./ports/index.ts";
import type { GrantLabel } from "./ports/index.ts";
import {
  LIVE_WRITE_LABEL,
  TURBOABLE_LABEL,
  isIssueNumber,
  isRepoSlug,
  recordGrant,
  ticketReference,
} from "./ports/index.ts";

/** Reads `text` as the label to grant: `turboable` or `live-write`. Throws naming `text` otherwise. */
export function parseGrantLabel(text: string): GrantLabel {
  if (text !== TURBOABLE_LABEL && text !== LIVE_WRITE_LABEL) {
    throw new Error(`Not a label to grant, ${TURBOABLE_LABEL} or ${LIVE_WRITE_LABEL}: ${JSON.stringify(text)}`);
  }
  return text;
}

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

/**
 * The developer's own grant of `live-write` on `ticket`, the way
 * `grantTurboable` grants `turboable`: the label, then a host-only record
 * vouching for it. The run of a ticket carrying it is started with its
 * project's mounts writable. Refuses, writing and labelling nothing, when
 * `ticket`'s project is unregistered. Needs no turbo project: the consent is
 * about the run's mounts, not its merge.
 */
export async function grantLiveWrite(
  ports: { store: Pick<Store, "loadRegistry" | "loadState" | "saveState">; clock: Clock },
  tracker: Pick<IssueTracker, "labelGranted">,
  ticket: IssueReference,
): Promise<string> {
  const project = (await ports.store.loadRegistry()).find((entry) => entry.repo === ticket.repo);
  if (project === undefined) {
    throw new Error(`${ticket.repo} is not a registered project.`);
  }
  await tracker.labelGranted(ticket, LIVE_WRITE_LABEL);
  const state = await ports.store.loadState();
  const grants = recordGrant(state.grants, ticket, ports.clock.now(), LIVE_WRITE_LABEL);
  await ports.store.saveState({ ...state, grants });
  return `Granted ${LIVE_WRITE_LABEL} on ${ticketReference(ticket)}.`;
}
