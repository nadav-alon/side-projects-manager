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
 * Only the read path is declared. Writing back — comments, relabelling,
 * review tickets, the summary — is declared by the code that needs it.
 *
 * TODO[#4]: back this with the `gh` CLI.
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
