import type {
  IssueTracker,
  PullRequestUrl,
  RepoSlug,
  ReviewTicket,
  Ticket,
} from "../ports/index.ts";
import { reviewTitle } from "../ports/index.ts";
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
 * An in-memory backlog per project. Everything put here is eligible — the
 * fake has no notion of an ineligible ticket, because the real port never
 * returns one.
 *
 * Tests that care which repos were asked about spy on `listEligibleTickets`
 * with `t.mock.method`; the fake does not record calls itself.
 */
export class FakeIssueTracker implements IssueTracker, SummaryTracker {
  readonly #backlogs = new Map<RepoSlug, Ticket[]>();

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

  /** Puts an eligible ticket in `repo`'s backlog and returns it. */
  addEligibleTicket(repo: RepoSlug, ticket: Omit<Ticket, "repo">): Ticket {
    const stored: Ticket = { repo, ...ticket };
    const backlog = this.#backlogs.get(repo) ?? [];
    backlog.push(stored);
    this.#backlogs.set(repo, backlog);
    return stored;
  }

  async listEligibleTickets(repo: RepoSlug): Promise<Ticket[]> {
    return [...(this.#backlogs.get(repo) ?? [])];
  }

  /**
   * The review lands in the same backlog its parent came from, because a real
   * review ticket is born ready-for-agent and is eligible from that moment.
   *
   * Numbered above every ticket the repo has, the way a tracker numbers a new
   * issue, so a test can tell the review from the ticket that earned it.
   */
  async createReviewTicket(
    ticket: Ticket,
    pullRequest: PullRequestUrl,
  ): Promise<Ticket> {
    const backlog = this.#backlogs.get(ticket.repo) ?? [];
    const numbers = backlog.map((eligible) => eligible.number);
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
    // Losing ready-for-agent is losing eligibility, so a handed-back ticket
    // leaves the backlog here exactly as it leaves the real one. Tests assert
    // no retry by invoking the loop again and finding nothing to select.
    const backlog = this.#backlogs.get(ticket.repo) ?? [];
    this.#backlogs.set(
      ticket.repo,
      backlog.filter((eligible) => eligible.number !== ticket.number),
    );
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
      backlog.filter((eligible) => eligible.number !== ticket.number),
    );
  }
}
