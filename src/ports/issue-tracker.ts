import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";

/**
 * The triage label that makes a ticket eligible, as `docs/agents/triage-labels.md`
 * spells it. The one place the literal lives; every adapter reads it from here.
 */
export const READY_FOR_AGENT_LABEL = "ready-for-agent";

/** An issue in a project's own repo that the loop may work on. */
export interface Ticket {
  /** The project the ticket lives in. */
  repo: RepoSlug;
  number: number;
  title: string;
}

/**
 * Reads and writes the tickets the loop works from.
 *
 * The write path is declared as the loop comes to need it: comments,
 * relabelling and the summary are not here yet.
 */
export interface IssueTracker {
  /**
   * The project's backlog: its open issues carrying the ready-for-agent
   * label, which are the only tickets the loop may select. A project with an
   * empty backlog returns an empty list; that is a normal morning, not an
   * error.
   */
  listEligibleTickets(repo: RepoSlug): Promise<Ticket[]>;
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
  createReviewTicket(ticket: Ticket, pullRequest: PullRequestUrl): Promise<Ticket>;
}
