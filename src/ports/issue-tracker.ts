import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";

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
  createReviewTicket(
    ticket: Ticket,
    pullRequest: PullRequestUrl,
  ): Promise<Ticket>;

  /**
   * Gives `ticket` back to the developer after a failed run: comments `comment`
   * on it, and moves it from ready-for-agent to ready-for-human.
   *
   * The comment and the relabel are one operation, because a ticket the loop
   * has stopped working on that nobody has been told about is the failure this
   * exists to prevent. Relabelling is also the whole of the no-retry rule: a
   * ticket without ready-for-agent is not eligible, so tomorrow's invocation
   * cannot select it and spend another morning on it.
   */
  handBack(ticket: Ticket, comment: string): Promise<void>;
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
