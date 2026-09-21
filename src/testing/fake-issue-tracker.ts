import type {
  ApplyReviewTicket,
  DiscoveredTicket,
  HandBackOutcome,
  IssueTracker,
  IssueUrl,
  OpenIssue,
  OpenIssues,
  PullRequestUrl,
  RebaseTicket,
  RepoSlug,
  ReviewTicket,
  Ticket,
} from "../ports/index.ts";
import {
  ENHANCEMENT_LABEL,
  NEEDS_TRIAGE_LABEL,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  SPEC_REVIEW_LABEL,
  SUPERTASK_LABEL,
  carriesReadyForAgent,
  carriesSpecReviewLabel,
  carriesSupertaskLabel,
  discoveredBody,
  issueNumber,
  issueUrl,
  modelLabelOf,
  reviewTitle,
  sizeLabelOf,
} from "../ports/index.ts";
import type { SummaryTracker } from "../morning-run.ts";

/** One summary issue the fake was asked to publish, in the order asked. */
export interface FakeSummary {
  title: string;
  body: string;
  url: IssueUrl;
}

/** One review ticket the loop opened, in the order the fake received it. */
export interface FakeReviewTicket {
  /** The implementation ticket the review is a sub-issue of. */
  parent: Ticket;
  /** The draft pull request the review is for. */
  pullRequest: PullRequestUrl;
  /** The review ticket itself, as the fake numbered it. */
  ticket: Ticket;
}

/** One ticket given back to the developer, and what it was told. */
export interface FakeHandback {
  ticket: Ticket;
  comment: string;
}

/** One plain comment the fake was given, in the order it was posted. */
export interface FakeComment {
  ticket: Ticket;
  comment: string;
}

/** One discovered ticket the loop opened, in the order it was opened. */
export interface FakeDiscoveredTicket {
  /** The ticket it was discovered while working. */
  parent: Ticket;
  title: string;
  /** `discoveredBody(parent, …)`: the given body, naming `parent`. */
  body: string;
  /** Whether a `blocked_by` edge from `parent` to `ticket` was asked for. */
  blocking: boolean;
  /** The discovered ticket itself, as the fake numbered it. */
  ticket: Ticket;
}

/**
 * An open issue as the fake holds it: its ticket facts and its links, flat,
 * without what the fake works out on each listing — no `eligible`,
 * `modelLabel`, `sizeLabel`, `supertask` or `specReview`, which come from the
 * labels it carries — and `openBlockerNumbers` optional, since most tests
 * give none.
 */
type StoredIssue = Omit<
  Ticket,
  "modelLabel" | "sizeLabel" | "supertask" | "specReview"
> &
  Partial<Pick<OpenIssue, "parent" | "openBlockerNumbers">>;

/**
 * A ticket as a test hands it to the fake. No `modelLabel`, `sizeLabel`,
 * `supertask` or `specReview`, not even on a wider `Ticket`: the fake reads
 * all four from the labels a ticket holds, the way the real tracker does.
 */
type TicketInput = Omit<StoredIssue, "repo"> & {
  modelLabel?: never;
  sizeLabel?: never;
  supertask?: never;
  specReview?: never;
};

/** One entry the fake holds: the open issue, and the labels it carries. */
interface Stored {
  issue: StoredIssue;
  labels: Set<string>;
  /**
   * Set once one of the close calls has closed this issue. Kept, rather than
   * dropped from `#issues` outright, so a closed ticket's labels stay
   * inspectable through `carriesLabel` — a real close leaves the label state
   * behind for a reopen or a label query to find, and a fake that discarded
   * the entry could never get that wrong.
   */
  closed?: boolean;
}

/**
 * An in-memory set of open issues per project, modelling the real tracker's
 * own notion of eligibility: every open issue is listed, and an issue is
 * eligible only while it carries `READY_FOR_AGENT_LABEL`.
 *
 * Tests that care which repos were asked about spy on `listOpenIssues`
 * with `t.mock.method`; the fake does not record calls itself.
 */
export class FakeIssueTracker implements IssueTracker, SummaryTracker {
  readonly #issues = new Map<RepoSlug, Stored[]>();
  readonly #truncated = new Set<RepoSlug>();

  /** The review tickets opened, in the order they were opened. */
  readonly reviewTickets: FakeReviewTicket[] = [];
  /** Tickets handed back, in the order they were handed back. */
  readonly handbacks: FakeHandback[] = [];

  /** Plain comments posted, in the order they were posted. */
  readonly comments: FakeComment[] = [];

  /** Discovered tickets opened, in the order they were opened. */
  readonly discoveredTickets: FakeDiscoveredTicket[] = [];

  /** The review tickets closed, in the order they were closed. */
  readonly closedReviewTickets: ReviewTicket[] = [];

  /**
   * The comment a closed review ticket carried, in close order — only a
   * review closed for a pull request already merged or closed carries one.
   */
  readonly closedReviewTicketComments: { ticket: ReviewTicket; comment: string }[] =
    [];

  /** The apply-review tickets closed, in the order closed, with what each was told. */
  readonly closedApplyReviewTickets: {
    ticket: ApplyReviewTicket;
    comment: string;
  }[] = [];

  /** The rebase tickets closed, in the order closed, with what each was told. */
  readonly closedRebaseTickets: {
    ticket: RebaseTicket;
    comment: string;
  }[] = [];

  /** The summary issues published, in the order they were published. */
  readonly summaries: FakeSummary[] = [];

  /** Records the summary, and answers with a fresh issue address. Never fails — the fake has no repo to refuse it. */
  async publishSummary(title: string, body: string): Promise<IssueUrl> {
    const url = issueUrl(
      `https://github.com/nadav-alon/side-projects-manager/issues/${this.summaries.length + 1}`,
    );
    this.summaries.push({ title, body, url });
    return url;
  }

  /** Puts a ticket carrying `READY_FOR_AGENT_LABEL` in `repo`'s backlog and returns it. */
  addEligibleTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    return this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
  }

  /**
   * Puts a ticket carrying `READY_FOR_HUMAN_LABEL` — never `READY_FOR_AGENT_LABEL`
   * — among `repo`'s open issues and returns it: a ticket the developer has not
   * triaged onto the loop, or has already handed back. Exists so a test can
   * prove such a ticket is never selected, even as its project's only ticket.
   */
  addIneligibleTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    return this.#add(repo, ticket, READY_FOR_HUMAN_LABEL);
  }

  /**
   * Puts a supertask — carrying `READY_FOR_AGENT_LABEL` and the supertask
   * label — in `repo`'s backlog and returns it. Exists so a test can prove
   * such a ticket is passed over even though it still carries
   * `READY_FOR_AGENT_LABEL`, at the loop's own seam rather than against a
   * query string.
   */
  addSupertask(repo: RepoSlug, ticket: TicketInput): Ticket {
    const supertask = this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
    this.addLabel(supertask, SUPERTASK_LABEL);
    return supertask;
  }

  /**
   * Puts a spec review ticket — carrying `READY_FOR_AGENT_LABEL` and the spec
   * review label — in `repo`'s backlog and returns it, the way a developer
   * opening one by hand would label it.
   */
  addSpecReviewTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    const specReview = this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
    this.addLabel(specReview, SPEC_REVIEW_LABEL);
    return specReview;
  }

  /**
   * Puts a blocked ticket — carrying `READY_FOR_AGENT_LABEL` with
   * `openBlockers` open tickets blocking it — in `repo`'s backlog and returns
   * it. Exists so a test can prove such a ticket is passed over even though it
   * still carries the label.
   */
  addBlockedTicket(
    repo: RepoSlug,
    ticket: Omit<TicketInput, "openBlockers">,
    openBlockers: number,
  ): Ticket {
    return this.#add(repo, { ...ticket, openBlockers }, READY_FOR_AGENT_LABEL);
  }

  /**
   * Puts `label` on `ticket`, the way the developer labels a ticket by hand —
   * a model label, say. Read on the next `listOpenIssues`, not before.
   */
  addLabel(ticket: Ticket, label: string): void {
    this.#find(ticket)?.labels.add(label);
  }

  /** Takes `label` off `ticket`, the way the developer unlabels one by hand. */
  removeLabel(ticket: Ticket, label: string): void {
    this.#find(ticket)?.labels.delete(label);
  }

  /**
   * Closes `ticket` out of band — the way an overlapping run's own success,
   * or a human on the tracker's own UI, might — without going through any of
   * the loop's own close methods. Exists so a test can arrange the race
   * `handBack` must leave alone: a ticket already closed by the time the loop
   * gets back to it.
   */
  closeOutOfBand(ticket: Ticket): void {
    this.#close(ticket);
  }

  /**
   * Whether `ticket` currently carries `label`, closed or not — the way a
   * label query against the real tracker would find it, even once
   * `listOpenIssues` has stopped listing the ticket at all.
   */
  carriesLabel(ticket: Ticket, label: string): boolean {
    return this.#find(ticket)?.labels.has(label) ?? false;
  }

  #find(ticket: Ticket): Stored | undefined {
    return (this.#issues.get(ticket.repo) ?? []).find(
      (candidate) => candidate.issue.number === ticket.number,
    );
  }

  #add(repo: RepoSlug, ticket: TicketInput, label: string): Ticket {
    const stored: StoredIssue = { repo, ...ticket };
    const issues = this.#issues.get(repo) ?? [];
    issues.push({ issue: stored, labels: new Set([label]) });
    this.#issues.set(repo, issues);
    return stored;
  }

  /**
   * Marks `repo`'s backlog as a truncated backlog: more open issues than the
   * loop reads in one morning. The issues listed stay exactly those added, so
   * a test arranges the ones read and says there were more.
   */
  truncateBacklog(repo: RepoSlug): void {
    this.#truncated.add(repo);
  }

  /**
   * An issue's eligibility, model label, size label and supertask status are
   * read from the labels it holds at the time of the call, through the same
   * `modelLabelOf`, `sizeLabelOf` and `carriesSupertaskLabel` the real tracker
   * uses, so a label changed between calls changes what the next call
   * returns. Issues are listed in the order they were added.
   */
  async listOpenIssues(repo: RepoSlug): Promise<OpenIssues> {
    const open = (this.#issues.get(repo) ?? []).filter((entry) => !entry.closed);
    const issues = open.map((entry) => {
      const { parent, openBlockerNumbers = [], ...ticket } = entry.issue;
      const modelLabel = modelLabelOf(entry.labels);
      const sizeLabel = sizeLabelOf(entry.labels);
      const supertask = carriesSupertaskLabel(entry.labels);
      const specReview = carriesSpecReviewLabel(entry.labels);
      return {
        ticket: {
          ...ticket,
          ...(modelLabel !== undefined && { modelLabel }),
          ...(sizeLabel !== undefined && { sizeLabel }),
          ...(supertask && { supertask }),
          ...(specReview && { specReview }),
        },
        eligible: carriesReadyForAgent(entry.labels),
        openBlockerNumbers,
        ...(parent !== undefined && { parent }),
      };
    });
    return {
      issues,
      truncated: this.#truncated.has(repo),
    };
  }

  /**
   * The review lands in the same backlog its parent came from, because a real
   * review ticket is born ready-for-agent and is eligible from that moment.
   *
   * Numbered above every ticket the repo has — eligible or not, the way the
   * real tracker never reuses a number — so a test can tell the review from
   * the ticket that earned it.
   */
  async createReviewTicket(
    ticket: Ticket,
    pullRequest: PullRequestUrl,
  ): Promise<Ticket> {
    const issues = this.#issues.get(ticket.repo) ?? [];
    const numbers = issues.map((entry) => entry.issue.number);
    const review = this.addEligibleTicket(ticket.repo, {
      number: issueNumber(Math.max(ticket.number, ...numbers) + 1),
      title: reviewTitle(ticket),
      pullRequest: { kind: "review", url: pullRequest },
    });

    this.reviewTickets.push({ parent: ticket, pullRequest, ticket: review });
    return review;
  }

  async handBack(ticket: Ticket, comment: string): Promise<HandBackOutcome> {
    const entry = this.#find(ticket);
    // As the real tracker: a ticket an overlapping run already closed is left
    // exactly as it is — no comment recorded, no label touched.
    if (entry?.closed === true) {
      return "already-closed";
    }

    this.handbacks.push({ ticket, comment });
    // Loses ready-for-agent and gains ready-for-human, exactly the relabel the
    // real tracker makes — not removed from the open issues, since the ticket is
    // still there for the developer to find. Tests assert no retry by
    // invoking the loop again and finding nothing to select.
    entry?.labels.delete(READY_FOR_AGENT_LABEL);
    entry?.labels.add(READY_FOR_HUMAN_LABEL);
    return "handed-back";
  }

  /** Records the comment. Touches no label, the way the real tracker's plain comment does. */
  async comment(ticket: Ticket, comment: string): Promise<void> {
    this.comments.push({ ticket, comment });
  }

  /**
   * Opens a discovered ticket carrying `NEEDS_TRIAGE_LABEL` and
   * `ENHANCEMENT_LABEL` — never `READY_FOR_AGENT_LABEL` — numbered above
   * every ticket the repo has, the way `createReviewTicket` numbers a
   * review. Asking for `discovery.blocking` adds `ticket`'s number to its own
   * open blockers, the same fact `openBlockers` reports from on the next
   * `listOpenIssues`.
   */
  async createDiscoveredTicket(
    ticket: Ticket,
    discovery: DiscoveredTicket,
  ): Promise<Ticket> {
    const issues = this.#issues.get(ticket.repo) ?? [];
    const numbers = issues.map((entry) => entry.issue.number);
    const discovered = this.#add(
      ticket.repo,
      {
        number: issueNumber(Math.max(ticket.number, ...numbers) + 1),
        title: discovery.title,
      },
      NEEDS_TRIAGE_LABEL,
    );
    this.addLabel(discovered, ENHANCEMENT_LABEL);

    const blocking = discovery.blocking === true;
    if (blocking) {
      const parent = this.#find(ticket);
      if (parent !== undefined) {
        parent.issue.openBlockers = (parent.issue.openBlockers ?? 0) + 1;
        parent.issue.openBlockerNumbers = [
          ...(parent.issue.openBlockerNumbers ?? []),
          discovered.number,
        ];
      }
    }

    this.discoveredTickets.push({
      parent: ticket,
      title: discovery.title,
      body: discoveredBody(ticket, discovery.body),
      blocking,
      ticket: discovered,
    });
    return discovered;
  }

  /**
   * Closes `ticket`, the way a real close drops it from the open issues — a
   * ticket a later iteration must not see again — and takes ready-for-agent
   * off it, the way the real tracker's own close does. The entry itself
   * stays, marked closed, rather than being discarded: `carriesLabel` can
   * still find it, the way a label query against the real tracker would
   * find a closed issue's labels.
   */
  async closeReviewTicket(
    ticket: ReviewTicket,
    comment?: string,
  ): Promise<void> {
    this.closedReviewTickets.push(ticket);
    if (comment !== undefined) {
      this.closedReviewTicketComments.push({ ticket, comment });
    }
    this.#close(ticket);
    this.#find(ticket)?.labels.delete(READY_FOR_AGENT_LABEL);
  }

  /** As `closeReviewTicket`, keeping the comment it closed with. */
  async closeApplyReviewTicket(
    ticket: ApplyReviewTicket,
    comment: string,
  ): Promise<void> {
    this.closedApplyReviewTickets.push({ ticket, comment });
    this.#close(ticket);
  }

  /** As `closeReviewTicket`, keeping the comment it closed with. */
  async closeRebaseTicket(
    ticket: RebaseTicket,
    comment: string,
  ): Promise<void> {
    this.closedRebaseTickets.push({ ticket, comment });
    this.#close(ticket);
  }

  #close(ticket: Ticket): void {
    const entry = this.#find(ticket);
    if (entry !== undefined) {
      entry.closed = true;
    }
  }
}
