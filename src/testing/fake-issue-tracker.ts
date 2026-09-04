import type { IssueTracker, RepoSlug, Ticket } from "../ports/index.ts";

/**
 * An in-memory backlog per project. Everything put here is eligible — the
 * fake has no notion of an ineligible ticket, because the real port never
 * returns one.
 *
 * Tests that care which repos were asked about spy on `listEligibleTickets`
 * with `t.mock.method`; the fake does not record calls itself.
 */
export class FakeIssueTracker implements IssueTracker {
  readonly #backlogs = new Map<RepoSlug, Ticket[]>();

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
}
