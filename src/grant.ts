import type { Clock, IssueReference, IssueTracker, RegisteredProject, Store } from "./ports/index.ts";
import type { GrantLabel } from "./ports/index.ts";
import {
  LIVE_WRITE_LABEL,
  TURBOABLE_LABEL,
  isGrantLabel,
  isIssueNumber,
  isRepoSlug,
  recordGrant,
  ticketReference,
} from "./ports/index.ts";

/** Reads `text` as the label to grant: `turboable` or `live-write`. Throws naming `text` otherwise. */
export function parseGrantLabel(text: string): GrantLabel {
  if (!isGrantLabel(text)) {
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
 * The developer's own grant of `label` on `ticket` (ADR 0012): adds the label
 * through `tracker`, then writes a grant record to the state document, which
 * no sandbox run can reach. Refuses, writing and labelling nothing, when
 * `ticket`'s project is unregistered, or when `check` refuses it.
 *
 * The label goes first, so the record's `grantedAt` is never earlier than
 * the event it vouches for. A failed label leaves no record.
 */
async function grant(
  label: GrantLabel,
  ports: { store: Pick<Store, "loadRegistry" | "loadState" | "saveState">; clock: Clock },
  tracker: Pick<IssueTracker, "labelGranted">,
  ticket: IssueReference,
  check: (project: RegisteredProject) => void,
): Promise<string> {
  const project = (await ports.store.loadRegistry()).find((entry) => entry.repo === ticket.repo);
  if (project === undefined) {
    throw new Error(`${ticket.repo} is not a registered project.`);
  }
  check(project);
  await tracker.labelGranted(ticket, label);
  const state = await ports.store.loadState();
  const grants = recordGrant(state.grants, ticket, ports.clock.now(), label);
  await ports.store.saveState({ ...state, grants });
  return `Granted ${label} on ${ticketReference(ticket)}.`;
}

/**
 * The developer's own grant of `turboable` on `ticket`. Refuses when its
 * project's `turbo` is off.
 */
export function grantTurboable(
  ports: { store: Pick<Store, "loadRegistry" | "loadState" | "saveState">; clock: Clock },
  tracker: Pick<IssueTracker, "labelGranted">,
  ticket: IssueReference,
): Promise<string> {
  return grant(TURBOABLE_LABEL, ports, tracker, ticket, (project) => {
    if (!project.turbo) {
      throw new Error(`${ticket.repo} is not a turbo project: turn turbo on in registry.json first.`);
    }
  });
}

/**
 * The developer's own grant of `live-write` on `ticket`. The run of a ticket
 * carrying it is started with its project's mounts writable. Needs no turbo
 * project: the consent is about the run's mounts, not its merge.
 */
export function grantLiveWrite(
  ports: { store: Pick<Store, "loadRegistry" | "loadState" | "saveState">; clock: Clock },
  tracker: Pick<IssueTracker, "labelGranted">,
  ticket: IssueReference,
): Promise<string> {
  return grant(LIVE_WRITE_LABEL, ports, tracker, ticket, () => {});
}
