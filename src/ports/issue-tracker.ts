import type { RepoSlug } from "./repo-slug.ts";

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
 * The real implementation wraps the `gh` CLI (#4). Only the read path the
 * skeleton needs is declared here; writing back to the tracker — comments,
 * relabelling, review tickets, the summary — arrives with the tickets that
 * own those behaviours.
 */
export interface IssueTracker {
  /**
   * The project's backlog: its open issues carrying the ready-for-agent
   * label, which are the only tickets the loop may select. A project with an
   * empty backlog returns an empty list; that is a normal morning, not an
   * error.
   */
  listEligibleTickets(repo: RepoSlug): Promise<Ticket[]>;
}
