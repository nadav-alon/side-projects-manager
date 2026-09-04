import type { IssueTracker, Ticket } from "../ports/index.ts";

/**
 * An in-memory backlog, keyed by `owner/repo`. Only tickets put here are
 * ready-for-agent — the fake has no notion of an ineligible ticket, because
 * the real port never returns one.
 */
export class FakeIssueTracker implements IssueTracker {
  readonly listedRepos: string[] = [];
  readonly #backlogs = new Map<string, Ticket[]>();

  constructor(backlogs: Record<string, Ticket[]> = {}) {
    for (const [repo, tickets] of Object.entries(backlogs)) {
      this.#backlogs.set(repo, tickets);
    }
  }

  /** Puts a ready-for-agent ticket in `repo`'s backlog and returns it. */
  addReadyTicket(repo: string, ticket: Omit<Ticket, "repo">): Ticket {
    const stored: Ticket = { repo, ...ticket };
    const backlog = this.#backlogs.get(repo) ?? [];
    backlog.push(stored);
    this.#backlogs.set(repo, backlog);
    return stored;
  }

  async listReadyTickets(repo: string): Promise<Ticket[]> {
    this.listedRepos.push(repo);
    return [...(this.#backlogs.get(repo) ?? [])];
  }
}
