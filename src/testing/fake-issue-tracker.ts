import type {
  IssueTracker,
  OpenIssue,
  OpenIssues,
  PullRequestUrl,
  RepoSlug,
  ReviewTicket,
  Ticket,
} from "../ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  carriesReadyForAgent,
  discountPullRequestSubIssues,
  modelLabelOf,
  reviewTitle,
} from "../ports/index.ts";
import type { SummaryTracker } from "../morning-run.ts";

/** One summary issue the fake was asked to publish, in the order asked. */
export interface FakeSummary {
  title: string;
  body: string;
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

/**
 * An open issue as the fake holds it: its ticket facts and its links, flat,
 * without what the fake works out on each listing — no `eligible` or
 * `modelLabel`, which come from the labels it carries — and
 * `openBlockerNumbers` optional, since most tests give none.
 */
type StoredIssue = Omit<Ticket, "modelLabel"> &
  Partial<Pick<OpenIssue, "parent" | "openBlockerNumbers">>;

/**
 * A ticket as a test hands it to the fake. No `modelLabel`, not even on a
 * wider `Ticket`: the fake reads that from the labels a ticket holds, the way
 * the real tracker does.
 */
type TicketInput = Omit<StoredIssue, "repo"> & { modelLabel?: never };

/** One entry the fake holds: the open issue, and the labels it carries. */
interface Stored {
  issue: StoredIssue;
  labels: Set<string>;
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

  /** The review tickets closed, in the order they were closed. */
  readonly closedReviewTickets: ReviewTicket[] = [];

  /** The summary issues published, in the order they were published. */
  readonly summaries: FakeSummary[] = [];

  /** Records the summary. Never fails — the fake has no repo to refuse it. */
  async publishSummary(title: string, body: string): Promise<void> {
    this.summaries.push({ title, body });
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
   * Puts a broken-out ticket — carrying `READY_FOR_AGENT_LABEL` with
   * `openSubIssues` open sub-issues of its own — in `repo`'s backlog and
   * returns it. Exists so a test can prove such a ticket is passed over even
   * though it still carries the label, at the loop's own seam rather than
   * against a query string.
   */
  addBrokenOutTicket(
    repo: RepoSlug,
    ticket: Omit<TicketInput, "openSubIssues">,
    openSubIssues: number,
  ): Ticket {
    return this.#add(repo, { ...ticket, openSubIssues }, READY_FOR_AGENT_LABEL);
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
   * An issue's eligibility and model label are read from the labels it holds
   * at the time of the call, through the same `modelLabelOf` the real tracker
   * uses, so a label changed between calls changes what the next call
   * returns. Issues are listed in the order they were added.
   */
  async listOpenIssues(repo: RepoSlug): Promise<OpenIssues> {
    const issues = (this.#issues.get(repo) ?? []).map((entry) => {
      const { parent, openBlockerNumbers = [], ...ticket } = entry.issue;
      const modelLabel = modelLabelOf(entry.labels);
      return {
        ticket: { ...ticket, ...(modelLabel !== undefined && { modelLabel }) },
        eligible: carriesReadyForAgent(entry.labels),
        openBlockerNumbers,
        ...(parent !== undefined && { parent }),
      };
    });
    return {
      issues: discountPullRequestSubIssues(issues),
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
      number: Math.max(ticket.number, ...numbers) + 1,
      title: reviewTitle(ticket),
      pullRequest: { kind: "review", url: pullRequest },
    });

    this.reviewTickets.push({ parent: ticket, pullRequest, ticket: review });
    return review;
  }

  async handBack(ticket: Ticket, comment: string): Promise<void> {
    this.handbacks.push({ ticket, comment });
    // Loses ready-for-agent and gains ready-for-human, exactly the relabel the
    // real tracker makes — not removed from the open issues, since the ticket is
    // still there for the developer to find. Tests assert no retry by
    // invoking the loop again and finding nothing to select.
    const entry = this.#find(ticket);
    entry?.labels.delete(READY_FOR_AGENT_LABEL);
    entry?.labels.add(READY_FOR_HUMAN_LABEL);
  }

  /**
   * Closes `ticket`, the way a real close removes it from the open issues: a
   * ticket a later iteration must not see again.
   */
  async closeReviewTicket(ticket: ReviewTicket): Promise<void> {
    this.closedReviewTickets.push(ticket);
    const issues = this.#issues.get(ticket.repo) ?? [];
    this.#issues.set(
      ticket.repo,
      issues.filter((entry) => entry.issue.number !== ticket.number),
    );
  }
}
