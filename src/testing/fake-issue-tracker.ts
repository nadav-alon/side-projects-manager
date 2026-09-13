import type {
  IssueTracker,
  PullRequestUrl,
  RepoSlug,
  ReviewTicket,
  Ticket,
} from "../ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
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
 * A ticket as a test hands it to the fake. No `modelLabel`: the fake reads
 * that from the labels a ticket holds, the way the real tracker does.
 */
type TicketInput = Omit<Ticket, "repo" | "modelLabel">;

/** A ticket as the fake holds it: the ticket itself, and the labels it carries. */
interface Stored {
  ticket: Ticket;
  labels: Set<string>;
}

/**
 * An in-memory backlog per project, modelling the real tracker's own notion
 * of eligibility: a ticket is listed only while it carries
 * `READY_FOR_AGENT_LABEL`, the way `gh issue list --label` filters for the
 * real one.
 *
 * Tests that care which repos were asked about spy on `listEligibleTickets`
 * with `t.mock.method`; the fake does not record calls itself.
 */
export class FakeIssueTracker implements IssueTracker, SummaryTracker {
  readonly #backlogs = new Map<RepoSlug, Stored[]>();

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
   * — in `repo`'s backlog and returns it: a ticket the developer has not
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
   * a model label, say. Read on the next `listEligibleTickets`, not before.
   */
  addLabel(ticket: Ticket, label: string): void {
    this.#find(ticket)?.labels.add(label);
  }

  /** Takes `label` off `ticket`, the way the developer unlabels one by hand. */
  removeLabel(ticket: Ticket, label: string): void {
    this.#find(ticket)?.labels.delete(label);
  }

  #find(ticket: Ticket): Stored | undefined {
    return (this.#backlogs.get(ticket.repo) ?? []).find(
      (candidate) => candidate.ticket.number === ticket.number,
    );
  }

  #add(repo: RepoSlug, ticket: TicketInput, label: string): Ticket {
    // Dropped at runtime too: a wider `Ticket` still type-checks as the input,
    // and a stored `modelLabel` would outlive the labels it claims to read.
    const { modelLabel: _ignored, ...fields } = ticket as Omit<Ticket, "repo">;
    const stored: Ticket = { repo, ...fields };
    const backlog = this.#backlogs.get(repo) ?? [];
    backlog.push({ ticket: stored, labels: new Set([label]) });
    this.#backlogs.set(repo, backlog);
    return stored;
  }

  /**
   * A ticket's model label is read from the labels it holds at the time of
   * the call, through the same `modelLabelOf` the real tracker uses, so a
   * label changed between calls changes what the next call returns.
   */
  async listEligibleTickets(repo: RepoSlug): Promise<Ticket[]> {
    return (this.#backlogs.get(repo) ?? [])
      .filter((entry) => entry.labels.has(READY_FOR_AGENT_LABEL))
      .map((entry) => {
        const modelLabel = modelLabelOf(entry.labels);
        return modelLabel === undefined
          ? entry.ticket
          : { ...entry.ticket, modelLabel };
      });
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
    const backlog = this.#backlogs.get(ticket.repo) ?? [];
    const numbers = backlog.map((entry) => entry.ticket.number);
    const review = this.addEligibleTicket(ticket.repo, {
      number: Math.max(ticket.number, ...numbers) + 1,
      title: reviewTitle(ticket),
      pullRequest,
    });

    this.reviewTickets.push({ parent: ticket, pullRequest, ticket: review });
    return review;
  }

  async handBack(ticket: Ticket, comment: string): Promise<void> {
    this.handbacks.push({ ticket, comment });
    // Loses ready-for-agent and gains ready-for-human, exactly the relabel the
    // real tracker makes — not removed from the backlog, since the ticket is
    // still there for the developer to find. Tests assert no retry by
    // invoking the loop again and finding nothing to select.
    const entry = this.#find(ticket);
    entry?.labels.delete(READY_FOR_AGENT_LABEL);
    entry?.labels.add(READY_FOR_HUMAN_LABEL);
  }

  /**
   * Closes `ticket`, the way a real close removes it from the backlog: a
   * ticket a later iteration must not see again.
   */
  async closeReviewTicket(ticket: ReviewTicket): Promise<void> {
    this.closedReviewTickets.push(ticket);
    const backlog = this.#backlogs.get(ticket.repo) ?? [];
    this.#backlogs.set(
      ticket.repo,
      backlog.filter((entry) => entry.ticket.number !== ticket.number),
    );
  }
}
