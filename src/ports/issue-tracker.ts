import type { RepoSlug } from "./repo-slug.ts";

/** A ticket the loop may work on: an issue carrying the ready-for-agent label. */
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
 * relabelling, review sub-issues, the daily summary — arrives with the
 * tickets that own those behaviours.
 */
export interface IssueTracker {
  /**
   * Open issues in `repo` carrying the ready-for-agent label. A project with
   * an empty backlog returns an empty list; that is a normal morning, not an
   * error.
   */
  listReadyTickets(repo: RepoSlug): Promise<Ticket[]>;
}
