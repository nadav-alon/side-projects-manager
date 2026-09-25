import type { IssueNumber } from "./issue-number.ts";
import { isModelName, type ModelName } from "./model-name.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";
import { isSize, largerSize, type Size } from "./size.ts";
import type { RunSpan } from "./store.ts";
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
 * The triage label a freshly discovered ticket is born with, as
 * `docs/agents/triage-labels.md` spells it: the maintainer, not the loop,
 * decides whether it ever becomes ready-for-agent.
 */
export const NEEDS_TRIAGE_LABEL = "needs-triage";

/**
 * The label a freshly discovered ticket is born with, beside
 * `NEEDS_TRIAGE_LABEL`: it says the ticket is new work rather than a report
 * against existing behavior. The one place the literal lives.
 */
export const ENHANCEMENT_LABEL = "enhancement";

/**
 * What `IssueTracker.createDiscoveredTicket` opens a ticket from: a title
 * and body the caller supplies, whether the ticket it names should be
 * blocked by the new one, and whether the new ticket is itself a **ready
 * discovery**. `blocking` absent or false opens the ticket with no edge at
 * all; `ready` absent or false opens it needs-triage and enhancement.
 *
 * `ready` is the caller's own decision, already weighed against
 * `discovery-routing.ts`'s bar (an agent-brief body, and the chain guard) —
 * this request carries only the answer, not the discovery's `ready` flag
 * or its body, so a caller that skipped that check cannot open a ready
 * ticket by accident.
 *
 * Not itself a `Ticket` — nothing has been opened yet — so it is named for
 * the glossary's own **Discovery**, the thing the caller is reporting. Named
 * `DiscoveredTicketRequest` rather than `Discovery` itself so it does not
 * collide with `./discovery.ts`'s `Discovery` — the sandbox's own shape for
 * what a run's agent found — which a caller routing one into the other needs
 * in scope at once.
 */
export interface DiscoveredTicketRequest {
  title: string;
  body: string;
  blocking?: boolean;
  ready?: boolean;
}

/**
 * The body a discovered ticket carries: `body`, followed by a line naming
 * the ticket it was discovered while working, so the discovery reads in
 * context wherever it later surfaces.
 *
 * Beside the verb that opens one rather than in the adapter, so the real
 * tracker and the fake write the same body.
 */
export function discoveredBody(ticket: Ticket, body: string): string {
  return `${body}\n\nDiscovered while working #${ticket.number}.`;
}

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
 * `kind` names the three pull-request-bound kinds explicitly, rather than
 * `Exclude<TicketKind, "implementation">`: a spec review ticket is not bound
 * to a pull request either, so that shorthand would wrongly admit it too.
 */
export interface PullRequestBinding {
  kind: "review" | "apply-review" | "rebase";
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
 * `specReview` is the fact `isSpecReviewTicket` reads alongside `pullRequest`:
 * whether the ticket carries the spec review label, from that same listing.
 * Read only where `pullRequest` is absent — a pull-request-bound ticket's own
 * kind always wins, per `ticketKind`. Absent, never `false`, where it carries
 * none.
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
 *
 * `readyDiscovery` is the fact the chain guard reads: whether the ticket
 * carries the ready discovery label, from that same listing — per
 * `CONTEXT.md`'s "Ready discovery", it was itself born from a ready
 * discovery, so a discovery filed while working it may not declare itself
 * ready in turn. Absent, never `false`, where it carries none.
 */
export interface Ticket {
  /** The project the ticket lives in. */
  repo: RepoSlug;
  number: IssueNumber;
  title: string;
  pullRequest?: PullRequestBinding;
  supertask?: true;
  specReview?: true;
  openBlockers?: number;
  modelLabel?: ModelLabel;
  priority?: TicketPriority;
  sizeLabel?: SizeLabel;
  readyDiscovery?: true;
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
 * The label that records a human's per-ticket consent for the merge gate to
 * merge that ticket's pull request without asking again. Applied and
 * removed by a human on the tracker's own UI — never by the manager, which
 * opens every ticket it opens (a discovery, a review, an apply-review, a
 * rebase, a spec review, a pull request) without it, whatever was asked.
 * The one place the literal lives; every adapter reads it from here.
 */
export const TURBOABLE_LABEL = "turboable";

/** Whether a label timeline event added or removed the label. */
export type LabelAction = "labeled" | "unlabeled";

/**
 * One `labeled` or `unlabeled` event from an issue's own label timeline —
 * what {@link IssueTracker.wasTurboableAt} replays in place of an issue's
 * current labels, since whether a label is on an issue right now says
 * nothing about whether it was there at some earlier instant.
 */
export interface LabelTimelineEvent {
  label: string;
  action: LabelAction;
  at: Date;
}

/**
 * The most recent `label` event at or before `instant`, replaying `events` —
 * that issue's full label timeline, in any order — up to and including
 * `instant`. Undefined where none match. What `labelWasPresentAt` reads the
 * action from, and `turboableConsentAt` reads the timestamp from.
 * Matched without regard to case, the way every other label here is.
 */
function mostRecentLabelEvent(
  events: readonly LabelTimelineEvent[],
  label: string,
  instant: Date,
): LabelTimelineEvent | undefined {
  return events
    .filter(
      (event) =>
        event.label.toLowerCase() === label.toLowerCase() &&
        event.at.getTime() <= instant.getTime(),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .at(-1);
}

/**
 * Whether `label` was present on an issue at `instant`, replaying `events` —
 * that issue's full label timeline, in any order — up to and including
 * `instant`. The most recent matching event at or before `instant` decides
 * it, so a label added after `instant`, or added and then removed again
 * before it, both answer `false`; a label added and never removed answers
 * `true`.
 * Matched without regard to case, the way every other label here is.
 *
 * Beside the port so the real tracker's own timeline read and the fake
 * replay the same events the same way.
 */
export function labelWasPresentAt(
  events: readonly LabelTimelineEvent[],
  label: string,
  instant: Date,
): boolean {
  return mostRecentLabelEvent(events, label, instant)?.action === "labeled";
}

/**
 * Whether `ticket` had turboable consent at `instant`, replaying `events` —
 * its full label timeline — and checking the granting event against
 * `spans`, every run span recorded for any ticket. Per `CONTEXT.md`'s
 * "Turboable", the timeline check alone (`labelWasPresentAt`) and stripping
 * `turboable` from every ticket the manager opens cover two gaps, but not a
 * third: a run on one ticket, posting with the developer's own identity, can
 * label a *different*, not-yet-run ticket `turboable` before that ticket's
 * own run starts, which a timeline check alone cannot tell from a human's
 * grant.
 *
 * Consent holds only where both are true:
 * 1. `turboable` was present at `instant` per `labelWasPresentAt` —
 *    unchanged.
 * 2. The latest `labeled` event for `turboable` at or before `instant` —
 *    the grant — falls inside no run span of any ticket in `ticket`'s own
 *    repo. `spans` for another repo never count, whatever they cover.
 *
 * A span's bounds are inclusive: a grant at exactly a span's `startedAt` or
 * `endedAt` falls inside it. A span with no `endedAt` — its run still going,
 * or the manager died before it closed one — covers everything from its
 * `startedAt` on, so a grant after that counts as inside it until the span
 * closes. This includes `ticket`'s own span: a grant at exactly its own
 * `startedAt` is rejected.
 *
 * Beside the port, like `labelWasPresentAt`, so the real tracker and the
 * fake apply the very same rule to the events and spans each replays.
 */
export function turboableConsentAt(
  ticket: Ticket,
  events: readonly LabelTimelineEvent[],
  instant: Date,
  spans: readonly RunSpan[],
): boolean {
  const grant = mostRecentLabelEvent(events, TURBOABLE_LABEL, instant);
  if (grant?.action !== "labeled") {
    return false;
  }
  const grantedAt = grant.at.getTime();
  return !spans.some(
    (span) =>
      span.repo === ticket.repo &&
      span.startedAt.getTime() <= grantedAt &&
      (span.endedAt === undefined || grantedAt <= span.endedAt.getTime()),
  );
}

/**
 * The label that declares a ticket a spec review, per `CONTEXT.md`'s "Spec
 * review ticket" and as `docs/agents/triage-labels.md` spells it. The one
 * place the literal lives; every adapter reads it from here.
 */
export const SPEC_REVIEW_LABEL = "spec-review";

/**
 * Whether `labels` include the spec review label. Beside the port so the real
 * tracker and the fake read it alike.
 */
export function carriesSpecReviewLabel(labels: Iterable<string>): boolean {
  return carriesLabel(labels, SPEC_REVIEW_LABEL);
}

/**
 * The label that marks a ticket as born from a ready discovery, per
 * `CONTEXT.md`'s "Ready discovery": what the chain guard reads to tell that
 * a ticket's own run declaring another discovery ready is one hop into a
 * chain of unreviewed work, so that discovery falls back to needs-triage.
 * Applied once, at creation, and never removed — even once the ticket's own
 * ready-for-agent comes off, the ticket's origin does not change. The one
 * place the literal lives; every adapter reads it from here.
 */
export const READY_DISCOVERY_LABEL = "ready-discovery";

/**
 * Whether `labels` include the ready discovery label. Beside the port so the
 * real tracker and the fake read it alike.
 */
export function carriesReadyDiscoveryLabel(labels: Iterable<string>): boolean {
  return carriesLabel(labels, READY_DISCOVERY_LABEL);
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
 * One sub-issue of a supertask, open or closed alike — what {@link
 * IssueTracker.listSubIssues} answers with. Per `CONTEXT.md`'s "Spec review
 * sweep", the guard that stops a supertask ever getting a second spec review
 * reads closed sub-issues on purpose: a spec review that closed is still a
 * sub-issue that existed, and only a read that sees it can tell "closed" from
 * "never opened".
 */
export interface SubIssue {
  ticket: Ticket;
  closed: boolean;
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

/**
 * Whether an open issue in `open` is a rebase ticket bound to `pullRequest`,
 * whatever that issue's own labels — a rebase ticket handed back to the
 * developer still counts, per `CONTEXT.md`'s "Conflict sweep".
 *
 * Only as complete as `open` itself: a truncated backlog (`open.truncated`)
 * can leave an existing rebase ticket out of `issues`, in which case this
 * reads `false` for a pull request that does have one open.
 */
export function openRebaseTicketFor(
  open: OpenIssues,
  pullRequest: PullRequestUrl,
): boolean {
  return open.issues.some(
    ({ ticket }) => isRebaseTicket(ticket) && ticket.pullRequest.url === pullRequest,
  );
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

/** A ticket narrowed to the spec review kind, once `isSpecReviewTicket` has said so. */
export type SpecReviewTicket = Ticket & {
  pullRequest?: undefined;
  specReview: true;
};

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
 * Whether `ticket` is a spec review ticket: bound to no pull request, and
 * carrying the spec review label. Per `CONTEXT.md`'s "Spec review ticket",
 * the first ticket kind that is not bound to a pull request.
 */
export function isSpecReviewTicket(
  ticket: Ticket,
): ticket is SpecReviewTicket {
  return ticket.pullRequest === undefined && ticket.specReview === true;
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
  "spec-review",
] as const;

export type TicketKind = (typeof TICKET_KINDS)[number];

/** Whether `value` is one of the five ticket kinds. */
export function isTicketKind(value: string): value is TicketKind {
  return (TICKET_KINDS as readonly string[]).includes(value);
}

/**
 * Which kind `ticket` is, decided in order: its pull request binding's kind,
 * else a spec review where it carries the spec review label, else an
 * implementation.
 */
export function ticketKind<T extends Ticket>(
  ticket: T,
): T extends ReviewTicket
  ? "review"
  : T extends ApplyReviewTicket
    ? "apply-review"
    : T extends RebaseTicket
      ? "rebase"
      : T extends SpecReviewTicket
        ? "spec-review"
        : TicketKind;
export function ticketKind(ticket: Ticket): TicketKind {
  if (ticket.pullRequest !== undefined) {
    return ticket.pullRequest.kind;
  }
  return ticket.specReview === true ? "spec-review" : "implementation";
}

/**
 * What `ticket`'s discoveries land on, named for a developer-facing comment:
 * a spec review ticket's is its supertask, every other kind's is its
 * implementation ticket. The one place this two-way choice is made, so
 * `discoveryTargetFor` and a discovery-blocked hand-back's comment can never
 * disagree on the noun.
 */
export function targetNoun(ticket: Ticket): "supertask" | "implementation ticket" {
  return ticketKind(ticket) === "spec-review" ? "supertask" : "implementation ticket";
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
   * Every sub-issue of `ticket`, open or closed alike — see {@link SubIssue}.
   *
   * What the spec review sweep (`spec-review-sweep.ts`) reads a supertask
   * with before opening a spec review for it: the guard that fires at most
   * once per supertask, ever, and the sub-issues its body names. Unlike
   * {@link listOpenIssues}, which only ever sees a project's open issues, this
   * is the one read that reaches a closed one — per `CONTEXT.md`'s "Spec
   * review ticket", nothing else in the loop needs to.
   */
  listSubIssues(ticket: Ticket): Promise<SubIssue[]>;
  /**
   * Whether `ticket` had turboable consent at `instant`, read from its label
   * timeline rather than its current labels, and checked against `spans` —
   * see {@link turboableConsentAt}, which does the replaying and the span
   * check both.
   *
   * What the merge gate checks against the instant a ticket's implementation
   * run started: a label added only after that instant, added and then
   * removed again before it, or added by a run on a different ticket before
   * this one's own run started, must not count as consent given in time —
   * and only a read of history, rather than the present, can tell any of
   * those from a human's grant.
   */
  wasTurboableAt(
    ticket: Ticket,
    instant: Date,
    spans: readonly RunSpan[],
  ): Promise<boolean>;
  /**
   * Opens a spec review ticket against `ticket`, a supertask — a sub-issue
   * carrying `body` — and answers with it.
   *
   * Born carrying ready-for-agent, the spec review label and `size:L`, the
   * same way {@link createReviewTicket}'s review is born eligible: a spec
   * review nobody labelled is one that never runs on a morning nobody is
   * around. `body` is composed by the caller, not here — per `CONTEXT.md`'s
   * "Spec review sweep", it names the supertask and every sub-issue in
   * scope, with a fact (a pull request's branch and state) this port alone
   * cannot read, since that comes from the repo host rather than the
   * tracker.
   *
   * `ticket` is read, never written: the spec review is queued beside the
   * supertask it reviews, and closing or relabelling that one stays the
   * developer's.
   */
  createSpecReviewTicket(ticket: Ticket, body: string): Promise<Ticket>;
  /**
   * Links `specReview` — a spec review ticket for `supertask` that a prior
   * sweep already opened but could not link, found unlinked by its title and
   * its spec-review label rather than by any sub-issue relation — as
   * `supertask`'s sub-issue now, in place of opening a duplicate.
   *
   * `body` is `specReviewBody`'s own text, the same {@link
   * createSpecReviewTicket} would compose for a new one — but lazy, since it
   * is needed only where the tracker has no native sub-issue relation, in
   * which case it replaces `specReview`'s own body outright, the same
   * fallback {@link createSpecReviewTicket} takes. Where sub-issues are
   * native, as they ordinarily are, `body` is never called: the caller is
   * spared composing it, and the ticket the caller found floating keeps
   * whatever text it already carried.
   *
   * `supertask` is read, never written, same as {@link createSpecReviewTicket}.
   */
  linkSpecReviewTicket(
    specReview: Ticket,
    supertask: Ticket,
    body: () => Promise<string>,
  ): Promise<void>;
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
   * Posts `comment` on `ticket` and touches no label — the plain half of
   * what `handBack` does alongside a relabel, for a note that is not itself
   * a hand-back: nothing about it is specific to a run ending.
   */
  comment(ticket: Ticket, comment: string): Promise<void>;

  /**
   * Opens an issue in the same repo as `ticket` — a ticket discovered while
   * working `ticket`, not a sub-issue of it. Its body is `discovery.body`
   * followed by a line naming `ticket`, per `discoveredBody`.
   *
   * `discovery.ready` decides which state and size it is born carrying, per
   * `CONTEXT.md`'s "Ready discovery": absent or false, it is labelled
   * needs-triage and enhancement, never ready-for-agent — the maintainer
   * triages it like any other report. `true` labels it
   * ready-for-agent, size:S and enhancement instead, skipping needs-triage
   * outright, and also marks it with the ready discovery label — never
   * removed — so a later run working it is told, through `Ticket.readyDiscovery`,
   * that it was itself born this way, for the chain guard.
   *
   * `discovery.blocking` also adds a native `blocked_by` edge, so `ticket`
   * is blocked by the new issue until it closes — for a discovery serious
   * enough that `ticket`'s own work should wait on it. Left unset or false,
   * no edge is added. Independent of `ready`: a ready prerequisite still
   * blocks its ticket, same as any other prerequisite.
   *
   * Answers with the new ticket either way. Where the edge is asked for and
   * refused, the created issue is not lost: the rejection names it, since a
   * discovery that exists but nobody was told to look for is worse than one
   * this simply failed to open.
   */
  createDiscoveredTicket(
    ticket: Ticket,
    discovery: DiscoveredTicketRequest,
  ): Promise<Ticket>;

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

/**
 * The size label a spec review ticket is born carrying, per `CONTEXT.md`'s
 * "Spec review ticket": `size:L` suits the scope of a whole-repo review. The
 * one place the literal lives; `createSpecReviewTicket`'s every
 * implementation applies it.
 */
export const SPEC_REVIEW_SIZE_LABEL = `${SIZE_LABEL_PREFIX}L`;

/**
 * The size label a ready discovery's ticket is born carrying, per
 * `CONTEXT.md`'s "Ready discovery": `size:S`, since a discovery declares
 * itself ready only when its work is that small. The one place the literal
 * lives.
 */
export const SIZE_S_LABEL = `${SIZE_LABEL_PREFIX}S`;

/**
 * The labels `IssueTracker.createDiscoveredTicket` opens a ticket with, per
 * `ready`: needs-triage and enhancement where it is not, ready-for-agent,
 * size:S, enhancement and the ready discovery label where it is. Beside the
 * port so the real tracker and the fake open a ticket carrying the very same
 * set, in the very same order, rather than each restating it by hand where
 * the two could drift apart unnoticed.
 */
export function discoveredTicketLabels(
  ready: boolean,
): readonly [string, string, ...string[]] {
  return ready
    ? [READY_FOR_AGENT_LABEL, SIZE_S_LABEL, ENHANCEMENT_LABEL, READY_DISCOVERY_LABEL]
    : [NEEDS_TRIAGE_LABEL, ENHANCEMENT_LABEL];
}

/**
 * The title a spec review ticket carries. Names the supertask it reviews, the
 * way `reviewTitle` names the ticket its review is for, so a backlog is read
 * as a list of titles that already tells a spec review apart from anything
 * else in it.
 */
export function specReviewTitle(ticket: Ticket): string {
  return `Spec review for #${ticket.number}`;
}
