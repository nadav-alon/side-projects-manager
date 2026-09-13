import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  Backlog,
  IssueTracker,
  PullRequestUrl,
  RepoSlug,
  ReviewTicket,
  Ticket,
  TicketPriority,
} from "../ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  isPullRequestUrl,
  isTicketPriority,
  modelLabelOf,
  reviewTitle,
} from "../ports/index.ts";
import type { SummaryTracker } from "../morning-run.ts";
import { errorMessage } from "../error-message.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const execFileAsync = promisify(execFile);

/** How many of a project's eligible tickets one morning reads. */
const BACKLOG_READ_LIMIT = 100;

/**
 * The tracker port backed by the `gh` CLI, per `docs/agents/issue-tracker.md`.
 * Talks to whichever repo it is asked about; the developer's own `gh` login
 * is what authorizes it.
 *
 * `publishSummary` is the one exception: it names no repo, because `gh`
 * resolves it the same way it resolves any call this adapter does not name
 * one for — from the checkout it is run in. That checkout is `home`, named
 * here rather than inherited from the working directory, because a trigger
 * chooses its own: cron runs from the developer's home directory, where `gh`
 * finds no repository at all and the summary is lost to an invocation that
 * otherwise worked. The manager reports on itself, so the checkout it reports
 * into is its own and is not the caller's to decide.
 */
export function ghIssueTracker(
  home: string = MANAGER_HOME,
): IssueTracker & SummaryTracker {
  return {
    async publishSummary(title: string, body: string): Promise<void> {
      await execFileAsync(
        "gh",
        ["issue", "create", "--title", title, "--body", body],
        { cwd: home },
      );
    },

    async listEligibleTickets(repo: RepoSlug): Promise<Backlog> {
      const { stdout } = await execFileAsync("gh", [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--label",
        READY_FOR_AGENT_LABEL,
        // One past what is read, so a backlog of exactly that many is told
        // apart from a longer one. `gh` answers newest first, so the one
        // dropped is the oldest.
        "--limit",
        String(BACKLOG_READ_LIMIT + 1),
        "--json",
        "number,title,body,subIssuesSummary,blockedBy,labels",
      ]);

      const issues = parseIssues(stdout, repo);
      const truncated = issues.length > BACKLOG_READ_LIMIT;
      const tickets = issues.slice(0, BACKLOG_READ_LIMIT).map(
        ({ body, subIssuesSummary, blockedBy, labels, ...issue }) => {
          const pullRequest = pullRequestReviewed(body);
          const openSubIssues =
            subIssuesSummary.total - subIssuesSummary.completed;
          const openBlockers = blockedBy.filter(
            (blocker) => blocker.state === "OPEN",
          ).length;
          const modelLabel = modelLabelOf(labels);
          const priority = ticketPriorityIn(labels);
          return {
            repo,
            ...issue,
            ...(openSubIssues > 0 && { openSubIssues }),
            ...(openBlockers > 0 && { openBlockers }),
            ...(pullRequest !== undefined && { pullRequest }),
            ...(modelLabel !== undefined && { modelLabel }),
            ...(priority !== undefined && { priority }),
          };
        },
      );
      return { tickets, truncated };
    },

    async closeReviewTicket(ticket: ReviewTicket): Promise<void> {
      await execFileAsync("gh", [
        "issue",
        "close",
        "--repo",
        ticket.repo,
        String(ticket.number),
      ]);
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
        pullRequest,
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
 * The line `reviewBody` writes, read back on a later morning's fresh process.
 * Matched per line rather than against the whole body: `linkToParent`'s
 * fallback prepends `Part of #N.` ahead of it where sub-issues are
 * unavailable, so the review sentence is not always the entire body.
 */
const REVIEW_BODY = /^Review (\S+), the draft pull request opened for #\d+\.$/m;

/**
 * The pull request a review ticket's body names, or undefined where `body`
 * isn't one this adapter wrote — which is what makes a fresh `listEligibleTickets`
 * able to tell a review ticket from an implementation ticket at all: the
 * association `createReviewTicket` returned in the same process is gone by the
 * next morning, and the body is the only place it survives.
 */
function pullRequestReviewed(body: string): PullRequestUrl | undefined {
  const url = REVIEW_BODY.exec(body)?.[1];
  return url !== undefined && isPullRequestUrl(url) ? url : undefined;
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

/**
 * A label naming one ticket priority level: `priority:1`, `priority:2` or
 * `priority:3`. Matched without regard to case, as GitHub matches label names,
 * so `Priority:2` is the same label rather than one silently ignored.
 */
const TICKET_PRIORITY_LABEL = /^priority:([123])$/i;

/**
 * The ticket priority `labels` carry: the smallest level named, since a ticket
 * labelled with several counts as its most urgent. Any other `priority:` label
 * is ignored rather than refused — it is the developer's typo, and a ticket
 * that fails to list would cost the whole project its morning.
 */
function ticketPriorityIn(labels: string[]): TicketPriority | undefined {
  const levels = labels
    .map((label) => Number(TICKET_PRIORITY_LABEL.exec(label)?.[1]))
    .filter(isTicketPriority);
  return levels.length > 0
    ? levels.reduce((smallest, level) => (level < smallest ? level : smallest))
    : undefined;
}

/** How many of an issue's sub-issues are open, as `subIssuesSummary` reports it. */
interface RawSubIssuesSummary {
  total: number;
  completed: number;
}

/**
 * One issue as `gh issue list --json number,title,body,subIssuesSummary,blockedBy,labels`
 * reports it, with each label reduced to its name.
 */
interface RawIssue {
  number: number;
  title: string;
  body: string;
  subIssuesSummary: RawSubIssuesSummary;
  blockedBy: RawBlocker[];
  labels: string[];
}

/** One ticket blocking an issue, as `blockedBy.nodes` reports it. */
interface RawBlocker {
  state: string;
}

/**
 * `gh --json number,title,body,subIssuesSummary,blockedBy,labels`: a JSON
 * array of `{ number, title, body, subIssuesSummary, blockedBy, labels }`.
 */
function parseIssues(stdout: string, repo: RepoSlug): RawIssue[] {
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
    const { number, title, body, subIssuesSummary, blockedBy, labels } =
      issue as Record<string, unknown>;
    return {
      number: expectField(number, "number", "number", at),
      title: expectField(title, "string", "title", at),
      body: expectField(body, "string", "body", at),
      subIssuesSummary: parseSubIssuesSummary(subIssuesSummary, at),
      blockedBy: parseBlockedBy(blockedBy, at),
      labels: parseLabels(labels, at),
    };
  });
}

/**
 * `labels` as `gh` reports it: `[{ id, name, description, color }]`. Only each
 * label's name is kept, since the name is all a label says to the loop.
 */
function parseLabels(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${at}: "labels" must be an array.`);
  }
  return value.map((label) => {
    if (typeof label !== "object" || label === null) {
      throw new Error(`${at}: "labels" must hold objects.`);
    }
    const { name } = label as Record<string, unknown>;
    return expectField(name, "string", "labels.name", at);
  });
}

/**
 * `blockedBy` as `gh` reports it: `{ nodes: [{ number, state, … }], totalCount }`.
 * Only each blocker's state is kept, since whether it is still open is all
 * selection asks of it.
 */
function parseBlockedBy(value: unknown, at: string): RawBlocker[] {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${at}: "blockedBy" must be an object.`);
  }
  const { nodes } = value as Record<string, unknown>;
  if (!Array.isArray(nodes)) {
    throw new Error(`${at}: "blockedBy.nodes" must be an array.`);
  }
  return nodes.map((node) => {
    if (typeof node !== "object" || node === null) {
      throw new Error(`${at}: "blockedBy.nodes" must hold objects.`);
    }
    const { state } = node as Record<string, unknown>;
    return { state: expectField(state, "string", "blockedBy.nodes.state", at) };
  });
}

function parseSubIssuesSummary(
  value: unknown,
  at: string,
): RawSubIssuesSummary {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${at}: "subIssuesSummary" must be an object.`);
  }
  const { total, completed } = value as Record<string, unknown>;
  return {
    total: expectField(total, "number", "subIssuesSummary.total", at),
    completed: expectField(
      completed,
      "number",
      "subIssuesSummary.completed",
      at,
    ),
  };
}

interface FieldTypes {
  number: number;
  string: string;
}

/** `value`, if it is of `type`; otherwise an error naming `field` at `at`. */
function expectField<T extends keyof FieldTypes>(
  value: unknown,
  type: T,
  field: string,
  at: string,
): FieldTypes[T] {
  if (typeof value !== type) {
    throw new Error(`${at}: "${field}" must be a ${type}.`);
  }
  return value as FieldTypes[T];
}
