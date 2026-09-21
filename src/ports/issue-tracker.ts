import type { IssueNumber } from "./issue-number.ts";
import { isModelName, type ModelName } from "./model-name.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";
import { isSize, largerSize, type Size } from "./size.ts";
import type { TicketPriority } from "./ticket-priority.ts";

/**
 * Whether `labels` include `name`, matched without regard to case, as GitHub
 * matches label names. What `carriesReadyForAgent` and `carriesSupertaskLabel`
 * both check, so the case rule is said once.
 */
function carriesLabel(labels: Iterable<string>, name: string): boolean {
  for (const label of labels) {
    if (label.toLowerCase() === name) {
      return true;
    }
  }
  return false;
}

/**
 * The triage label that makes a ticket eligible, as `docs/agents/triage-labels.md`
 * spells it. The one place the literal lives; every adapter reads it from here.
 */
export const READY_FOR_AGENT_LABEL = "ready-for-agent";

/**
 * Whether `labels` include ready-for-agent — what makes an issue eligible.
 * Beside the port so the real tracker and the fake read eligibility alike.
 */
export function carriesReadyForAgent(labels: Iterable<string>): boolean {
  return carriesLabel(labels, READY_FOR_AGENT_LABEL);
}

/**
 * The triage label a ticket carries once it is the developer's again, as
 * `docs/agents/triage-labels.md` spells it.
 */
export const READY_FOR_HUMAN_LABEL = "ready-for-human";

/**
 * What `IssueTracker.handBack` found: the ticket was open, so it was
 * commented on and relabelled, or it was already closed, so it was left
 * exactly as it is.
 */
export type HandBackOutcome = "handed-back" | "already-closed";

/**
 * What a label starts with when it is a model label, per `CONTEXT.md`: the
 * rest of the label is the model's name. The one place the literal lives.
 */
export const MODEL_LABEL_PREFIX = "model:";

/**
 * What a label starts with when it is a size label, per `CONTEXT.md`: the
 * rest of the label names one of the four recognised sizes. The one place
 * the literal lives.
 */
export const SIZE_LABEL_PREFIX = "size:";

/**
 * Every label in `labels` starting with `prefix`, matched without regard to
 * case the way GitHub matches label names, paired with what follows the
 * prefix — kept in the case it was written, since folding that further is
 * each prefix's own rule to apply. What `modelLabelOf` and `sizeLabelOf`
 * both filter their labels down to before applying their own.
 */
function labelsWithPrefix(
  labels: Iterable<string>,
  prefix: string,
): Array<{ label: string; value: string }> {
  const matches: Array<{ label: string; value: string }> = [];
  for (const label of labels) {
    if (label.toLowerCase().startsWith(prefix)) {
      matches.push({ label, value: label.slice(prefix.length) });
    }
  }
  return matches;
}

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
  for (const { label, value } of labelsWithPrefix(labels, MODEL_LABEL_PREFIX)) {
    if (isModelName(value)) {
      names.push(value);
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
 * What a ticket's size labels say, where it carries any: one recognised
 * size, or a label whose name none of the four recognised sizes match.
 * Absent from a ticket that names no size — an unsized ticket, per
 * `CONTEXT.md`'s "Size label".
 *
 * `unusable` carries each size label whose name `isSize` refuses — as
 * written, so a hand-back can quote it. It wins even beside a recognised
 * size: the developer named a size, and running the ticket unsized or under
 * the other size is not what they asked for. Two recognised sizes are not an
 * error the same way: overestimating is the safe direction, so the larger
 * one counts instead.
 */
export type SizeLabel =
  | { kind: "declared"; size: Size }
  | { kind: "unusable"; labels: readonly string[] };

/**
 * The size label a ticket carrying `labels` declares, or undefined where it
 * names no size.
 *
 * Beside the port rather than in an adapter, so the real tracker and the fake
 * read labels identically. The prefix is matched without regard to case, the
 * way `modelLabelOf` matches `MODEL_LABEL_PREFIX`, and so is the size itself:
 * `size:s` and `size:S` declare the same size. Unlike a model name, which is
 * open-ended and so passed through as written, a size is one of four known
 * spellings with no meaning in its case — folding it here, before `isSize`
 * ever sees it, is what lets `isSize` stay the strict, exact check the rest
 * of the codebase can rely on.
 */
export function sizeLabelOf(labels: Iterable<string>): SizeLabel | undefined {
  const declared: Size[] = [];
  const unusable: string[] = [];
  for (const { label, value } of labelsWithPrefix(labels, SIZE_LABEL_PREFIX)) {
    const candidate = value.toUpperCase();
    if (isSize(candidate)) {
      declared.push(candidate);
    } else {
      unusable.push(label);
    }
  }

  if (unusable.length > 0) {
    return { kind: "unusable", labels: unusable };
  }
  const [first, ...rest] = declared;
  if (first === undefined) {
    return undefined;
  }
  return { kind: "declared", size: rest.reduce(largerSize, first) };
}

/**
 * The pull request a ticket is bound to, and why: `review` binds a review
 * ticket to the draft it was opened to review; `apply-review` binds an
 * apply-review ticket to the draft the apply-review workflow asks the loop to
 * revise; `rebase` binds a rebase ticket to the draft the `/rebase` workflow
 * asks the loop to put back on top of its base branch. Each names the one
 * thing a run cannot work out for itself, since the sandbox's clone has no
 * GitHub remote to infer it from.
 *
 * `kind` is the ticket's kind itself, which is why it is spelled from
 * `TicketKind`: every kind but an implementation is bound to a pull request.
 *
 * TODO[#295]: the `/rebase` workflow itself.
 */
export interface PullRequestBinding {
  kind: Exclude<TicketKind, "implementation">;
  url: PullRequestUrl;
}

/**
 * An issue in a project's own repo that the loop may work on.
 *
 * `pullRequest` is what tells a review, an apply-review or a rebase ticket
 * from an implementation ticket, and the three apart from each other: present
 * only on those three kinds, its `kind` names which, and its `url` names the
 * draft pull request the ticket is bound to. Absent on every implementation
 * ticket, which is what selection reads to choose which kind of run to
 * start.
 *
 * `supertask` is the fact `isSupertask` reads: whether the ticket carries the
 * supertask label, from that same listing. Declared, not inferred — per
 * `CONTEXT.md`'s "Supertask", a ticket's sub-issue count says nothing about
 * whether it is a container. Absent, never `false`, where it carries none.
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
 *
 * `sizeLabel` is what the ticket's own size labels say, read from that same
 * listing on every call. Absent means the ticket names no size — an unsized
 * ticket, per `CONTEXT.md`'s "Size label". A review ticket reads its own
 * labels, never its parent's, and never inherits a size from it.
 */
export interface Ticket {
  /** The project the ticket lives in. */
  repo: RepoSlug;
  number: IssueNumber;
  title: string;
  pullRequest?: PullRequestBinding;
  supertask?: true;
  openBlockers?: number;
  modelLabel?: ModelLabel;
  priority?: TicketPriority;
  sizeLabel?: SizeLabel;
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
 * The label that declares a ticket a supertask, per `CONTEXT.md`'s
 * "Supertask" and as `docs/agents/triage-labels.md` spells it. The one place
 * the literal lives; every adapter reads it from here.
 */
export const SUPERTASK_LABEL = "supertask";

/**
 * Whether `labels` include the supertask label. Beside the port so the real
 * tracker and the fake read it alike.
 */
export function carriesSupertaskLabel(labels: Iterable<string>): boolean {
  return carriesLabel(labels, SUPERTASK_LABEL);
}

/**
 * Whether `ticket` is a supertask: declared by the supertask label, per
 * `CONTEXT.md`'s "Supertask", never inferred from its sub-issue count — a
 * container for its work rather than work of its own until the ticket
 * itself is closed.
 */
export function isSupertask(ticket: Ticket): boolean {
  return ticket.supertask === true;
}

/**
 * One open issue in a project, eligible or not, and the facts ticket priority
 * is worked out from.
 *
 * `ticket` is every fact the issue would carry as a ticket. Held rather than
 * inherited, so an issue that is not eligible cannot be handed anywhere a
 * ticket is asked for.
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
export interface OpenIssue {
  ticket: Ticket;
  eligible: boolean;
  parent?: IssueNumber;
  openBlockerNumbers: readonly IssueNumber[];
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

/** The backlog `open` holds: its eligible issues, each as the ticket it is. */
export function backlogIn(open: OpenIssues): Backlog {
  const tickets = open.issues
    .filter((issue) => issue.eligible)
    .map((issue) => issue.ticket);
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
): ReadonlyMap<IssueNumber, TicketPriority> {
  const passesTo = new Map<IssueNumber, IssueNumber[]>();
  const read = new Set(open.issues.map((issue) => issue.ticket.number));
  const edge = (from: IssueNumber, to: IssueNumber) => {
    if (read.has(from) && read.has(to)) {
      const tos = passesTo.get(from) ?? [];
      tos.push(to);
      passesTo.set(from, tos);
    }
  };
  for (const issue of open.issues) {
    if (issue.parent !== undefined) {
      edge(issue.parent, issue.ticket.number);
    }
    for (const blocker of issue.openBlockerNumbers) {
      edge(issue.ticket.number, blocker);
    }
  }

  const labelled = open.issues
    .flatMap(({ ticket: { number, priority } }) =>
      priority === undefined ? [] : [{ number, priority }],
    )
    .sort((a, b) => a.priority - b.priority);
  const priorities = new Map<IssueNumber, TicketPriority>();
  for (const { number, priority } of labelled) {
    if (priorities.has(number)) {
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
export type ReviewTicket = Ticket & {
  pullRequest: PullRequestBinding & { kind: "review" };
};

/** A ticket narrowed to the apply-review kind, once `isApplyReviewTicket` has said so. */
export type ApplyReviewTicket = Ticket & {
  pullRequest: PullRequestBinding & { kind: "apply-review" };
};

/** A ticket narrowed to the rebase kind, once `isRebaseTicket` has said so. */
export type RebaseTicket = Ticket & {
  pullRequest: PullRequestBinding & { kind: "rebase" };
};

/** A ticket narrowed to any pull-request-bound kind, once `isPullRequestTicket` has said so. */
export type PullRequestTicket = Ticket & { pullRequest: PullRequestBinding };

/** Whether `ticket` is a review ticket. */
export function isReviewTicket(ticket: Ticket): ticket is ReviewTicket {
  return ticket.pullRequest?.kind === "review";
}

/** Whether `ticket` is an apply-review ticket. */
export function isApplyReviewTicket(
  ticket: Ticket,
): ticket is ApplyReviewTicket {
  return ticket.pullRequest?.kind === "apply-review";
}

/** Whether `ticket` is a rebase ticket. */
export function isRebaseTicket(ticket: Ticket): ticket is RebaseTicket {
  return ticket.pullRequest?.kind === "rebase";
}

/** Whether `ticket` is bound to a pull request at all. */
export function isPullRequestTicket(
  ticket: Ticket,
): ticket is PullRequestTicket {
  return ticket.pullRequest !== undefined;
}

/**
 * The size `ticket` itself declares, or `undefined` where it names none: an
 * unsized ticket, or any pull request ticket, which never inherits its
 * parent's size, per `CONTEXT.md`'s "Size label". Resolved once here so the
 * run estimate and the developer-facing size flag apply their own fallback
 * to the same fact rather than to two copies of it.
 */
export function declaredSize(ticket: Ticket): Size | undefined {
  return !isPullRequestTicket(ticket) && ticket.sizeLabel?.kind === "declared"
    ? ticket.sizeLabel.size
    : undefined;
}

/** The kinds of ticket the loop runs, each of which may have its own model. */
export const TICKET_KINDS = [
  "implementation",
  "review",
  "apply-review",
  "rebase",
] as const;

export type TicketKind = (typeof TICKET_KINDS)[number];

/**
 * Which kind `ticket` is: its pull request binding's kind, or an
 * implementation where it is bound to none.
 */
export function ticketKind(ticket: Ticket): TicketKind {
  return ticket.pullRequest?.kind ?? "implementation";
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
   *
   * Checked against the tracker before either write: a ticket already closed —
   * by an overlapping run that finished it first, most commonly — is left
   * exactly as it is, no comment and no label touched, and the answer says so.
   * Closing is itself the no-retry rule for the ticket kinds the loop closes;
   * relabelling a closed ticket ready-for-human would put it back in front of
   * the developer for work that is already done.
   */
  handBack(ticket: Ticket, comment: string): Promise<HandBackOutcome>;

  /**
   * Closes `ticket`, once its review has been posted, and takes
   * ready-for-agent off it. One of the two tickets the loop ever closes
   * itself, both pull request tickets: a review that finished needs nobody
   * to close it by hand, and the ticket it reviews stays the developer's
   * either way.
   *
   * The label matters even though a closed ticket is already ineligible:
   * without it, reopening the ticket would silently put it back in the
   * queue, and a label query would find a closed review still marked ready
   * for an agent. Best effort on the label alone — the close is what makes
   * the ticket un-selectable, so a caller told this failed still finds it
   * closed and just missing the label.
   *
   * `comment` is absent for a review that posted its findings straight to the
   * pull request, which needs nothing further said on the ticket itself; a
   * review closed for a pull request already merged or closed carries one
   * naming why.
   */
  closeReviewTicket(ticket: ReviewTicket, comment?: string): Promise<void>;

  /**
   * Closes `ticket` with `comment`, once every thread on its pull request is
   * answered — or none was open to answer — and the pull request is marked
   * ready for review, or once the pull request itself was already merged or
   * closed, in which case nothing is marked. The comment says which, since an
   * apply-review ticket that closed with nothing applied reads, without one,
   * like work lost.
   */
  closeApplyReviewTicket(
    ticket: ApplyReviewTicket,
    comment: string,
  ): Promise<void>;

  /**
   * Closes `ticket` with `comment`, once its pull request no longer needs a
   * rebase — or needed none when the run started — or once the pull request
   * itself was already merged or closed, in which case mergeability is never
   * asked. Its own call rather than `closeApplyReviewTicket` reused: what the
   * comment says differs, a rebase promotes nothing, and a rebase ticket is
   * never the one an apply-review close's promotion is about.
   */
  closeRebaseTicket(ticket: RebaseTicket, comment: string): Promise<void>;
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
