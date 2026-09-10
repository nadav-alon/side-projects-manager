import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { IssueTracker, RepoSlug, Ticket } from "../ports/index.ts";
import { READY_FOR_AGENT_LABEL } from "../ports/index.ts";

const execFileAsync = promisify(execFile);

/**
 * The tracker port backed by the `gh` CLI, per `docs/agents/issue-tracker.md`.
 * Talks to whichever repo it is asked about; the developer's own `gh` login
 * is what authorizes it.
 *
 * TODO[#25]: `gh issue list` caps results at 30 by default with no override
 * here, so a backlog past that size is silently truncated.
 */
export function ghIssueTracker(): IssueTracker {
  return {
    async listEligibleTickets(repo: RepoSlug): Promise<Ticket[]> {
      const { stdout } = await execFileAsync("gh", [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--label",
        READY_FOR_AGENT_LABEL,
        "--json",
        "number,title",
      ]);

      return parseIssues(stdout, repo).map((issue) => ({ repo, ...issue }));
    },

    async createReviewTicket(
      ticket: Ticket,
      pullRequest: string,
    ): Promise<Ticket> {
      const title = reviewTitle(ticket);
      const body = reviewBody(ticket, pullRequest);

      const { stdout } = await execFileAsync("gh", [
        "issue",
        "create",
        "--repo",
        ticket.repo,
        "--title",
        title,
        // The one label the manager applies itself. Applied at creation rather
        // than after, so there is no instant in which the review exists and is
        // not yet eligible.
        "--label",
        READY_FOR_AGENT_LABEL,
        "--body",
        body,
      ]);

      const review: Ticket = {
        repo: ticket.repo,
        number: issueNumberIn(stdout, ticket.repo),
        title,
      };
      await linkToParent(review, ticket, body);
      return review;
    },
  };
}

/**
 * The title a review ticket carries. Says what it is and which ticket earned
 * it, because a backlog is read as a list of titles and selection has to be
 * able to tell a review from an implementation.
 */
function reviewTitle(ticket: Ticket): string {
  return `Review the draft pull request for #${ticket.number}`;
}

/**
 * What the review ticket asks for. The pull request is named as a URL rather
 * than a number: it is the one thing the reviewing run cannot work out for
 * itself, and the ticket is the only place it is written down.
 */
function reviewBody(ticket: Ticket, pullRequest: string): string {
  return [
    `Review ${pullRequest}, the draft pull request opened for #${ticket.number}.`,
    "",
    "Queued by the morning loop when the pull request was opened, so that",
    "reviewing it is a run of its own rather than a continuation of the one",
    "that wrote the code.",
  ].join("\n");
}

/**
 * Hangs `review` off `parent` as a sub-issue, the relationship GitHub shows in
 * its own UI.
 *
 * Where sub-issues are unavailable — an older GitHub Enterprise, a token
 * without the scope — the relationship goes into the review's own body
 * instead, per `docs/agents/issue-tracker.md`. Only the review's body: the
 * parent is a ticket the developer wrote and this is not the place to edit it.
 */
async function linkToParent(
  review: Ticket,
  parent: Ticket,
  body: string,
): Promise<void> {
  try {
    await execFileAsync("gh", [
      "api",
      "--method",
      "POST",
      `repos/${parent.repo}/issues/${parent.number}/sub_issues`,
      "-F",
      `sub_issue_id=${await issueId(review)}`,
    ]);
  } catch (nativeFailure) {
    try {
      await execFileAsync("gh", [
        "issue",
        "edit",
        String(review.number),
        "--repo",
        review.repo,
        "--body",
        `Part of #${parent.number}.\n\n${body}`,
      ]);
    } catch (error) {
      // The review exists and is eligible, so the morning's work is not lost
      // — but it is floating free of the ticket that earned it, and nothing
      // else will notice that.
      throw new Error(
        `Opened #${review.number} in ${review.repo} to review the pull request for #${parent.number}, but could not link it to #${parent.number}: ${errorMessage(nativeFailure)}, then ${errorMessage(error)}.`,
      );
    }
  }
}

/**
 * An issue's database id, which is what the sub-issues endpoint takes — not
 * the `#number` it is known by, and not its node id.
 */
async function issueId(ticket: Ticket): Promise<number> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${ticket.repo}/issues/${ticket.number}`,
    "--jq",
    ".id",
  ]);

  const id = Number(stdout.trim());
  if (!Number.isInteger(id)) {
    throw new Error(
      `gh api repos/${ticket.repo}/issues/${ticket.number}: "id" was not a number: ${stdout.trim()}`,
    );
  }
  return id;
}

/** `gh issue create` answers with the new issue's URL, and nothing else. */
function issueNumberIn(stdout: string, repo: RepoSlug): number {
  const url = stdout.trim();
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) {
    throw new Error(
      `gh issue create --repo ${repo}: expected the new issue's URL, got: ${url}`,
    );
  }
  return number;
}

/** `gh --json number,title`: a JSON array of `{ number, title }`. */
function parseIssues(
  stdout: string,
  repo: RepoSlug,
): Omit<Ticket, "repo">[] {
  const where = `gh issue list --repo ${repo}`;

  let issues: unknown;
  try {
    issues = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${where}: did not return JSON: ${errorMessage(error)}`);
  }
  if (!Array.isArray(issues)) {
    throw new Error(`${where}: expected a JSON array of issues.`);
  }

  return issues.map((issue, index) => {
    const at = `${where}: issue ${index + 1}`;
    if (typeof issue !== "object" || issue === null) {
      throw new Error(`${at}: expected an object.`);
    }
    const { number, title } = issue as Record<string, unknown>;
    if (typeof number !== "number") {
      throw new Error(`${at}: "number" must be a number.`);
    }
    if (typeof title !== "string") {
      throw new Error(`${at}: "title" must be a string.`);
    }
    return { number, title };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
