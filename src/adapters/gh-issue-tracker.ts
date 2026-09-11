import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  IssueTracker,
  PullRequestUrl,
  RepoSlug,
  Ticket,
} from "../ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  reviewTitle,
} from "../ports/index.ts";
import { errorMessage } from "../error-message.ts";

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
      pullRequest: PullRequestUrl,
    ): Promise<Ticket> {
      const title = reviewTitle(ticket);
      await ensureLabel(ticket.repo, READY_FOR_AGENT_LABEL);

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
        reviewBody(ticket, pullRequest),
      ]);

      const review: Ticket = {
        repo: ticket.repo,
        number: issueNumberIn(stdout, ticket.repo),
        title,
      };

      try {
        await linkToParent(review, ticket, pullRequest);
      } catch (error) {
        // The review exists and is eligible, so the morning's work is not lost
        // — but it is floating free of the ticket that earned it, and nothing
        // else will notice that. The pull request is named because it is the
        // thing the morning was for, and this error is where the developer
        // finds out about it.
        throw new Error(
          `Opened #${review.number} in ${review.repo} to review ${pullRequest}, the draft pull request for #${ticket.number}, but could not link it to #${ticket.number}: ${errorMessage(error)}`,
        );
      }
      return review;
    },

    async handBack(ticket: Ticket, comment: string): Promise<void> {
      const issue = [String(ticket.number), "--repo", ticket.repo];

      // Three calls in the order they degrade best, because `gh` gives no way
      // to do them as one and any of them can be the one that fails.
      //
      // The comment goes first: it needs nothing to exist beforehand, and a
      // developer who reads why the morning stopped is served even if the
      // labels then go wrong. Losing ready-for-agent comes next, since that
      // alone is what stops the ticket being selected tomorrow and every
      // morning after. Gaining ready-for-human comes last, because it is the
      // only one that needs a label to exist — and by then the ticket is
      // commented on and out of the queue, which is the part that matters.
      await execFileAsync("gh", [
        "issue",
        "comment",
        ...issue,
        "--body",
        comment,
      ]);
      await execFileAsync("gh", [
        "issue",
        "edit",
        ...issue,
        "--remove-label",
        READY_FOR_AGENT_LABEL,
      ]);
      // Nothing else in the manager creates ready-for-human, and a project
      // that has never used it by hand would refuse the edit below — leaving
      // the ticket out of the queue and in no other, which is exactly the
      // ticket nobody is told about.
      await ensureLabel(ticket.repo, READY_FOR_HUMAN_LABEL);
      try {
        await execFileAsync("gh", [
          "issue",
          "edit",
          ...issue,
          "--add-label",
          READY_FOR_HUMAN_LABEL,
        ]);
      } catch (error) {
        // Warned about rather than raised, now that the label exists and only
        // something unforeseen can refuse it. By this point the ticket is
        // commented on and no longer eligible, which is the whole of the
        // guarantee; a caller told this failed would report that the ticket
        // was not handed back, and the developer would put ready-for-agent
        // back on a ticket that is meant to stay off it.
        console.warn(
          `${ticket.repo}#${ticket.number} is out of the queue but not labelled ${READY_FOR_HUMAN_LABEL}: ${errorMessage(error)}`,
        );
      }
    },
  };
}

/**
 * What each label the manager applies itself says about itself, as
 * `docs/agents/triage-labels.md` describes it.
 */
const LABEL_DESCRIPTIONS = {
  [READY_FOR_AGENT_LABEL]: "Fully specified, ready for an AFK agent",
  [READY_FOR_HUMAN_LABEL]: "Requires human implementation",
} as const;

/**
 * Creates `label` where the project has none, because `gh issue create
 * --label` and `gh issue edit --add-label` both refuse outright against a
 * label that does not exist — and a project can pass selection without either,
 * since `gh issue list --label` tolerates a missing one.
 *
 * Best effort: the answer that matters is whether the label exists afterwards,
 * and a project that already has one — every project the developer triages by
 * hand — answers here with a failure that means it is already there. A refusal
 * for any other reason surfaces a moment later, from the call that actually
 * needs the label.
 */
async function ensureLabel(
  repo: RepoSlug,
  label: keyof typeof LABEL_DESCRIPTIONS,
): Promise<void> {
  await execFileAsync("gh", [
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--description",
    LABEL_DESCRIPTIONS[label],
  ]).catch(() => undefined);
}

/**
 * What the review ticket asks for. The pull request is named as a URL rather
 * than a number: it is the one thing the reviewing run cannot work out for
 * itself, and the ticket is the only place it is written down.
 */
function reviewBody(ticket: Ticket, pullRequest: PullRequestUrl): string {
  return `Review ${pullRequest}, the draft pull request opened for #${ticket.number}.`;
}

/**
 * Hangs `review` off `parent` as a sub-issue, the relationship GitHub shows in
 * its own UI.
 *
 * Where sub-issues are unavailable — an older GitHub Enterprise, a token
 * without the scope — the relationship goes into the review's own body
 * instead, per `docs/agents/issue-tracker.md`. Only where they are unavailable:
 * a refusal, a rate limit or a dropped connection is a tracker that has
 * sub-issues and could not be asked, and writing the reference into the body
 * would answer it by quietly downgrading the relationship forever.
 *
 * Only the review's body: the parent is a ticket the developer wrote and this
 * is not the place to edit it.
 */
async function linkToParent(
  review: Ticket,
  parent: Ticket,
  pullRequest: PullRequestUrl,
): Promise<void> {
  const id = await issueIdOf(review);

  try {
    await execFileAsync("gh", [
      "api",
      "--method",
      "POST",
      `repos/${parent.repo}/issues/${parent.number}/sub_issues`,
      "-F",
      `sub_issue_id=${id}`,
    ]);
  } catch (error) {
    if (!subIssuesUnavailable(error)) {
      throw error;
    }
    await execFileAsync("gh", [
      "issue",
      "edit",
      String(review.number),
      "--repo",
      review.repo,
      "--body",
      `Part of #${parent.number}.\n\n${reviewBody(parent, pullRequest)}`,
    ]);
  }
}

/**
 * Whether a failed sub-issues POST says the endpoint isn't there, which is how
 * a tracker without sub-issues answers: 404 where it was never served, 410
 * where it once was. Anything else — 403, 422, a rate limit, a socket — is a
 * tracker that has them and did not answer.
 */
function subIssuesUnavailable(error: unknown): boolean {
  return /\(HTTP (?:404|410)\)/.test(errorMessage(error));
}

declare const issueIdBrand: unique symbol;

/**
 * An issue's database id, which is what the sub-issues endpoint takes — not
 * the `#number` it is known by, and not its node id. Branded because both are
 * numbers and only one of them is this: handed the wrong one, the endpoint
 * links whatever issue happens to hold that id.
 */
type IssueId = number & { readonly [issueIdBrand]: true };

/** The guard, for the id as the tracker answers with it. */
function isIssueId(value: number): value is IssueId {
  // Positive, because `Number("")` is `0` and `0` is an integer: an empty
  // answer would otherwise be POSTed as an id and refused, reaching the
  // developer as a tracker without sub-issues rather than as the empty answer
  // it was.
  return Number.isInteger(value) && value > 0;
}

/** The constructor: narrows, or throws naming the offending value. */
function issueId(value: number): IssueId {
  if (!isIssueId(value)) {
    throw new Error(`${value} is not an issue id.`);
  }
  return value;
}

/** Asks the tracker for `ticket`'s database id. */
async function issueIdOf(ticket: Ticket): Promise<IssueId> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${ticket.repo}/issues/${ticket.number}`,
    "--jq",
    ".id",
  ]);

  const answer = stdout.trim();
  try {
    return issueId(Number(answer));
  } catch {
    // Named rather than rethrown: what the developer needs is which call
    // answered with what, and `Number("")` is `0` rather than the nothing it
    // came from.
    throw new Error(
      `gh api repos/${ticket.repo}/issues/${ticket.number}: "id" was not an issue id: ${JSON.stringify(answer)}`,
    );
  }
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
