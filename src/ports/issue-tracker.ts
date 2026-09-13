import { isModelName, type ModelName } from "./model-name.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TicketPriority } from "./ticket-priority.ts";

/**
 * The triage label that makes a ticket eligible, as `docs/agents/triage-labels.md`
 * spells it. The one place the literal lives; every adapter reads it from here.
 */
export const READY_FOR_AGENT_LABEL = "ready-for-agent";

/**
 * The triage label a ticket carries once it is the developer's again, as
 * `docs/agents/triage-labels.md` spells it.
 */
export const READY_FOR_HUMAN_LABEL = "ready-for-human";

/**
 * What a label starts with when it is a model label, per `CONTEXT.md`: the
 * rest of the label is the model's name. The one place the literal lives.
 */
export const MODEL_LABEL_PREFIX = "model:";

/**
 * What a ticket's model labels say, where it carries any: one model by name,
 * several that disagree, or a label whose name no run could be handed. Absent
 * from a ticket that names no model.
 *
 * `conflicting` still carries every name, in label order, and each label as
 * written, so a hand-back can quote the labels the ticket actually carries.
 * `unusable` carries each model label
 * whose name `isModelName` refuses — a bare `model:`, a name with a space in
 * it, one that reads as an option — as written, so a hand-back can quote it.
 * It wins over the other two: the developer asked for a model, and running
 * the ticket on another one is not what they asked for. Whether to work
 * either kind of ticket is the loop's decision; the tracker only reports it.
 */
export type ModelLabel =
  | { kind: "named"; name: ModelName }
  | {
      kind: "conflicting";
      names: readonly ModelName[];
      labels: readonly string[];
    }
  | { kind: "unusable"; labels: readonly string[] };

/**
 * The model label a ticket carrying `labels` declares, or undefined where it
 * names no model.
 *
 * Beside the port rather than in an adapter, so the real tracker and the fake
 * read labels identically. The prefix is matched without regard to case, the
 * way GitHub matches label names, so `Model:opus` is a model label too; the
 * name after it is kept as written.
 */
export function modelLabelOf(labels: Iterable<string>): ModelLabel | undefined {
  const names: ModelName[] = [];
  const named: string[] = [];
  const unusable: string[] = [];
  for (const label of labels) {
    if (!label.toLowerCase().startsWith(MODEL_LABEL_PREFIX)) {
      continue;
    }
    const name = label.slice(MODEL_LABEL_PREFIX.length);
    if (isModelName(name)) {
      names.push(name);
      named.push(label);
    } else {
      unusable.push(label);
    }
  }

  if (unusable.length > 0) {
    return { kind: "unusable", labels: unusable };
  }
  const [name, ...others] = names;
  if (name === undefined) {
    return undefined;
  }
  return others.length === 0
    ? { kind: "named", name }
    : { kind: "conflicting", names, labels: named };
}

/**
 * An issue in a project's own repo that the loop may work on.
 *
 * `pullRequest` is what tells a review ticket from an implementation ticket:
 * present only on a review, it names the draft pull request the review asks
 * about — the one thing a reviewing run cannot work out for itself, since the
 * sandbox's clone has no GitHub remote to infer it from. Absent on every
 * implementation ticket, which is what selection reads to choose which kind
 * of run to start.
 *
 * `openSubIssues` is the fact `isBrokenOut` reads: how many of the ticket's
 * sub-issues are still open, straight from the same listing that already
 * carries the labels selection filters on, so it costs no extra tracker call.
 * Absent or zero means the ticket has none open — indistinguishable from a
 * ticket with no sub-issues at all, since neither is workable any
 * differently from the other.
 *
 * `openBlockers` is the fact `isBlocked` reads: how many of the tickets
 * marked as blocking this one are still open, from that same listing. Absent
 * or zero means nothing open blocks it.
 *
 * `modelLabel` is what the ticket's own model labels say, read from that same
 * listing on every call, so a label changed since yesterday is what today
 * reads. Absent means the ticket names no model. A review ticket reads its
 * own labels, never its parent's.
 *
 * `priority` is the ticket priority it carries, from that same listing.
 * Absent means it carries none.
 */
export interface Ticket {
  /** The project the ticket lives in. */
  repo: RepoSlug;
  number: number;
  title: string;
  pullRequest?: PullRequestUrl;
  openSubIssues?: number;
  openBlockers?: number;
  modelLabel?: ModelLabel;
  priority?: TicketPriority;
}

/**
 * Whether an open ticket still blocks `ticket`, per `CONTEXT.md`'s "Blocked
 * ticket": its work builds on work not yet done, so a run started now would
 * build on nothing. The tracker only reports the count; this is the judgment
 * selection makes from it.
 */
export function isBlocked(ticket: Ticket): boolean {
  return (ticket.openBlockers ?? 0) > 0;
}

/**
 * Whether `ticket`'s work has been broken out into sub-issues that are still
 * open — a container for that work rather than work of its own, per
 * `CONTEXT.md`'s "Broken-out ticket". The tracker only reports the count;
 * this is the judgment selection makes from it, so it can be exercised
 * against the fake rather than buried in an adapter's query string.
 */
export function isBrokenOut(ticket: Ticket): boolean {
  return (ticket.openSubIssues ?? 0) > 0;
}

/**
 * One project's backlog as one morning reads it: its eligible tickets, and
 * whether it is a truncated backlog — longer than the loop reads in one
 * morning, so `tickets` holds only the newest of it.
 */
export interface Backlog {
  tickets: Ticket[];
  truncated: boolean;
}

/** A ticket narrowed to the review kind, once `isReviewTicket` has said so. */
export type ReviewTicket = Ticket & { pullRequest: PullRequestUrl };

/** Whether `ticket` is a review ticket rather than an implementation ticket. */
export function isReviewTicket(ticket: Ticket): ticket is ReviewTicket {
  return ticket.pullRequest !== undefined;
}

/** The kinds of ticket the loop runs, each of which may have its own model. */
export const TICKET_KINDS = ["implementation", "review"] as const;

export type TicketKind = (typeof TICKET_KINDS)[number];

/** Which kind `ticket` is, read the way `isReviewTicket` reads it. */
export function ticketKind(ticket: Ticket): TicketKind {
  return isReviewTicket(ticket) ? "review" : "implementation";
}

/**
 * Reads and writes the tickets the loop works from.
 *
 * Only the read path, the hand-back and the review are declared. The rest of
 * the write path — the summary — is declared by the code that needs it.
 */
export interface IssueTracker {
  /**
   * The project's backlog: its open issues carrying the ready-for-agent
   * label, which are the only tickets the loop may select. A project with an
   * empty backlog returns an empty list; that is a normal morning, not an
   * error.
   */
  listEligibleTickets(repo: RepoSlug): Promise<Backlog>;
  /**
   * Opens a review ticket against `ticket` — a sub-issue asking for the draft
   * pull request at `pullRequest` to be reviewed — and answers with it.
   *
   * Born carrying ready-for-agent, the one place anything but the developer
   * applies that label. Safe here because the ticket it creates is bounded by
   * a pull request that already exists, and necessary because a review nobody
   * labelled is a review that never happens on a morning nobody is around.
   *
   * `ticket` is read, never written: the review is queued beside the ticket
   * that earned it, and closing or relabelling that one stays the developer's.
   */
  createReviewTicket(
    ticket: Ticket,
    pullRequest: PullRequestUrl,
  ): Promise<Ticket>;

  /**
   * Gives `ticket` back to the developer once the loop has stopped working on
   * it — whether the run failed or finished: comments `comment` on it, and
   * moves it from ready-for-agent to ready-for-human.
   *
   * The comment and the relabel are one operation, because a ticket the loop
   * has stopped working on that nobody has been told about is the failure this
   * exists to prevent. Relabelling is also the whole of the no-retry rule: a
   * ticket without ready-for-agent is not eligible, so tomorrow's invocation
   * cannot select it and spend another morning on it — the same rule that
   * keeps a finished run's ticket from being reselected once its work is
   * waiting in a draft pull request, or once it committed nothing at all.
   */
  handBack(ticket: Ticket, comment: string): Promise<void>;

  /**
   * Closes `ticket`, once its review has been posted. The one ticket the loop
   * ever closes itself: a review that finished needs nobody to close it by
   * hand, and the ticket it reviews stays the developer's either way.
   */
  closeReviewTicket(ticket: ReviewTicket): Promise<void>;
}

/**
 * The title a review ticket carries. Says what it is and which ticket earned
 * it, because a backlog is read as a list of titles and selection has to be
 * able to tell a review from an implementation.
 *
 * Beside the verb that opens one rather than in the adapter, so that every
 * implementation of the port — and the fake the loop is tested against —
 * names a review the same way.
 */
export function reviewTitle(ticket: Ticket): string {
  return `Review the draft pull request for #${ticket.number}`;
}
