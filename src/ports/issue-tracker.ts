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
 * `priority` is the level its own priority label names, from that same
 * listing. Absent means it carries none.
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
 * One open issue in a project, eligible or not, with every fact a ticket
 * carries and the facts ticket priority is worked out from.
 *
 * `eligible` is whether it carries ready-for-agent: only an eligible issue is
 * a ticket selection may choose, but any open issue passes on its priority
 * label.
 *
 * `parent` is the number of the issue it is a sub-issue of, only where that
 * parent is in the same repo. Absent for an issue that is no one's sub-issue
 * and for one whose parent lives elsewhere, since neither passes anything on.
 *
 * `openBlockerNumbers` are the numbers of the still-open issues blocking it in
 * the same repo, in the order the tracker lists them. Closed blockers and
 * blockers in other repos are left out; `openBlockers` still counts an open
 * one elsewhere, since it blocks the work all the same.
 */
export interface OpenIssue extends Ticket {
  eligible: boolean;
  parent?: number;
  openBlockerNumbers: readonly number[];
}

/**
 * Every open issue one morning reads in a project, newest first, and whether
 * it is a truncated backlog — more open issues than the loop reads in one
 * morning, so `issues` holds only the newest of them.
 */
export interface OpenIssues {
  issues: OpenIssue[];
  truncated: boolean;
}

/**
 * One project's backlog as one morning reads it: its eligible tickets, and
 * whether it is a truncated backlog, so `tickets` holds only the eligible
 * among the newest open issues.
 */
export interface Backlog {
  tickets: Ticket[];
  truncated: boolean;
}

/**
 * The backlog `open` holds: its eligible issues, each as the ticket it is,
 * without the facts only ticket priority reads.
 */
export function backlogIn(open: OpenIssues): Backlog {
  const tickets = open.issues
    .filter((issue) => issue.eligible)
    .map(({ eligible, parent, openBlockerNumbers, ...ticket }) => ticket);
  return { tickets, truncated: open.truncated };
}

/**
 * The ticket priority of each issue in `open` that has one, by issue number,
 * per `CONTEXT.md`'s "Ticket priority": the smallest of its own priority
 * label and that of every issue reaching it by stepping, in any mix, from a
 * parent to its sub-issues and from a blocked issue to its open blockers.
 * Never the other way. An issue absent from the map has no ticket priority.
 *
 * Only issues in `open` pass anything on: a parent or blocker number not
 * among them — closed, in another repo, or not read — contributes nothing.
 *
 * Labels are spread smallest level first, and an issue keeps the first level
 * that reaches it, so each issue is visited once and cycles end.
 */
export function ticketPrioritiesIn(
  open: OpenIssues,
): ReadonlyMap<number, TicketPriority> {
  const passesTo = new Map<number, number[]>();
  const read = new Set(open.issues.map((issue) => issue.number));
  const edge = (from: number, to: number) => {
    if (read.has(from) && read.has(to)) {
      const tos = passesTo.get(from) ?? [];
      tos.push(to);
      passesTo.set(from, tos);
    }
  };
  for (const issue of open.issues) {
    if (issue.parent !== undefined) {
      edge(issue.parent, issue.number);
    }
    for (const blocker of issue.openBlockerNumbers) {
      edge(issue.number, blocker);
    }
  }

  const labelled = open.issues
    .filter((issue) => issue.priority !== undefined)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const priorities = new Map<number, TicketPriority>();
  for (const { number, priority } of labelled) {
    if (priority === undefined || priorities.has(number)) {
      continue;
    }
    const reached = [number];
    priorities.set(number, priority);
    for (let next = reached.pop(); next !== undefined; next = reached.pop()) {
      for (const to of passesTo.get(next) ?? []) {
        if (!priorities.has(to)) {
          priorities.set(to, priority);
          reached.push(to);
        }
      }
    }
  }
  return priorities;
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
   * The project's open issues, whatever their labels, newest first and no
   * more than one morning reads. Eligible or not, since ticket priority can
   * reach a ticket through issues that are not themselves eligible; the
   * tracker reports facts, and selection is what judges them. A project with
   * no open issues returns an empty list; that is a normal morning, not an
   * error.
   */
  listOpenIssues(repo: RepoSlug): Promise<OpenIssues>;
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
