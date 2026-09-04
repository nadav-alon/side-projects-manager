import type { IssueTracker, RepoSlug, Ticket } from "../ports/index.ts";

/**
 * An in-memory backlog per project. Everything put here is ready-for-agent —
 * the fake has no notion of an ineligible ticket, because the real port never
 * returns one.
 */
export class FakeIssueTracker implements IssueTracker {
  /** Every repo the loop asked about, in order. */
  readonly listedRepos: RepoSlug[] = [];
  readonly #backlogs = new Map<RepoSlug, Ticket[]>();

  /** Puts a ready-for-agent ticket in `repo`'s backlog and returns it. */
  addReadyTicket(repo: RepoSlug, ticket: Omit<Ticket, "repo">): Ticket {
    const stored: Ticket = { repo, ...ticket };
    const backlog = this.#backlogs.get(repo) ?? [];
    backlog.push(stored);
    this.#backlogs.set(repo, backlog);
    return stored;
  }

  async listReadyTickets(repo: RepoSlug): Promise<Ticket[]> {
    this.listedRepos.push(repo);
    return [...(this.#backlogs.get(repo) ?? [])];
  }
}
