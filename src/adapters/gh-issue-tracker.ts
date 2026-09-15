import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ApplyReviewTicket,
  IssueNumber,
  IssueTracker,
  OpenIssues,
  PullRequestBinding,
  PullRequestUrl,
  RepoSlug,
  ReviewTicket,
  Ticket,
  TicketPriority,
} from "../ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  carriesReadyForAgent,
  discountPullRequestTickets,
  isIssueNumber,
  isPullRequestUrl,
  isTicketPriority,
  modelLabelOf,
  reviewTitle,
} from "../ports/index.ts";
import type { SummaryTracker } from "../morning-run.ts";
import { errorMessage } from "../error-message.ts";
import { expectField } from "./expect-field.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const execFileAsync = promisify(execFile);

/**
 * How many of a project's open issues one morning reads. Counts every open
 * issue, not only eligible tickets, since ticket priority reaches a ticket
 * through issues that are not themselves eligible — so it is larger than a
 * cap on eligible tickets alone would need to be.
 */
const OPEN_ISSUE_READ_LIMIT = 300;

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

    async listOpenIssues(repo: RepoSlug): Promise<OpenIssues> {
      const { stdout } = await execFileAsync("gh", [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        // One past what is read, so exactly that many open issues is told
        // apart from more. `gh` answers newest first, so the one dropped is
        // the oldest.
        "--limit",
        String(OPEN_ISSUE_READ_LIMIT + 1),
        "--json",
        "number,title,body,subIssuesSummary,blockedBy,parent,labels",
      ]);

      const listed = parseIssues(stdout, repo);
      const truncated = listed.length > OPEN_ISSUE_READ_LIMIT;
      const issues = listed.slice(0, OPEN_ISSUE_READ_LIMIT).map(
        ({ body, subIssuesSummary, blockedBy, parent, labels, ...issue }) => {
          const pullRequest = pullRequestBoundIn(body);
          const openSubIssues =
            subIssuesSummary.total - subIssuesSummary.completed;
          const stillBlocking = blockedBy.filter(
            (blocker) => blocker.state === "OPEN",
          );
          const openBlockers = stillBlocking.length;
          const openBlockerNumbers = stillBlocking
            .filter((blocker) => isInRepo(blocker.url, repo))
            .map((blocker) => blocker.number);
          const modelLabel = modelLabelOf(labels);
          const priority = priorityLabelIn(labels);
          return {
            ticket: {
              repo,
              ...issue,
              ...(openSubIssues > 0 && { openSubIssues }),
              ...(openBlockers > 0 && { openBlockers }),
              ...(pullRequest !== undefined && { pullRequest }),
              ...(modelLabel !== undefined && { modelLabel }),
              ...(priority !== undefined && { priority }),
            },
            eligible: carriesReadyForAgent(labels),
            openBlockerNumbers,
            ...(parent !== null &&
              isInRepo(parent.url, repo) && { parent: parent.number }),
          };
        },
      );
      return { issues: discountPullRequestTickets(issues), truncated };
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

    async closeApplyReviewTicket(
      ticket: ApplyReviewTicket,
      comment: string,
    ): Promise<void> {
      await execFileAsync("gh", [
        "issue",
        "close",
        "--repo",
        ticket.repo,
        String(ticket.number),
        "--comment",
        comment,
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
        pullRequest: { kind: "review", url: pullRequest },
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
 * The line the apply-review workflow writes — never this adapter, and never
 * by hand — read back the same way `REVIEW_BODY` is: matched per line, so it
 * survives beside a `Part of #N.` line or any other the body carries.
 */
const APPLY_REVIEW_BODY =
  /^Apply the review on (\S+), the draft pull request opened for #\d+\.$/m;

/**
 * The pull request an issue's body binds it to, and which of the two bound
 * kinds, or undefined where `body` carries neither line — which is what makes
 * a fresh `listOpenIssues` able to tell a review or an apply-review ticket
 * from an implementation ticket, and the two apart from each other: the
 * association `createReviewTicket` returned in the same process is gone by
 * the next morning, and the body is the only place it survives.
 *
 * A well-formed review line wins: a body carrying both lines reads as a
 * review. A review line with a malformed URL binds nothing, so a well-formed
 * apply-review line beside it still binds the body as an apply-review.
 */
function pullRequestBoundIn(body: string): PullRequestBinding | undefined {
  return (
    bindingMatching(REVIEW_BODY, "review", body) ??
    bindingMatching(APPLY_REVIEW_BODY, "apply-review", body)
  );
}

/**
 * A `kind` binding to the pull request `pattern` captures in `body`, only
 * where the capture is a well-formed pull request URL: a line that matches
 * with a malformed URL is undefined, the same as no line at all.
 */
function bindingMatching(
  pattern: RegExp,
  kind: PullRequestBinding["kind"],
  body: string,
): PullRequestBinding | undefined {
  const url = pattern.exec(body)?.[1];
  return url !== undefined && isPullRequestUrl(url)
    ? { kind, url }
    : undefined;
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
function issueNumberIn(stdout: string, repo: RepoSlug): IssueNumber {
  const url = stdout.trim();
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
  if (!isIssueNumber(number)) {
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
 * The level the priority labels among `labels` name: the smallest, since an
 * issue labelled with several counts as its most urgent. Any other `priority:`
 * label is ignored rather than refused — it is the developer's typo, and an
 * issue that fails to list would cost the whole project its morning.
 */
function priorityLabelIn(labels: string[]): TicketPriority | undefined {
  const levels = labels
    .map((label) => Number(TICKET_PRIORITY_LABEL.exec(label)?.[1]))
    .filter(isTicketPriority);
  return levels.length > 0
    ? levels.reduce((smallest, level) => (level < smallest ? level : smallest))
    : undefined;
}

/**
 * Whether the issue at `url` lives in `repo`. Read from the URL, since that is
 * the one place `gh` names a linked issue's repo; owner and repo names are
 * matched without regard to case, as GitHub matches them.
 */
function isInRepo(url: string, repo: RepoSlug): boolean {
  const [owner, name] = new URL(url).pathname.split("/").filter(Boolean);
  return `${owner}/${name}`.toLowerCase() === repo.toLowerCase();
}

/** How many of an issue's sub-issues are open, as `subIssuesSummary` reports it. */
interface RawSubIssuesSummary {
  total: number;
  completed: number;
}

/**
 * One issue as `gh issue list --json number,title,body,subIssuesSummary,blockedBy,parent,labels`
 * reports it, with each label reduced to its name.
 */
interface RawIssue {
  number: IssueNumber;
  title: string;
  body: string;
  subIssuesSummary: RawSubIssuesSummary;
  blockedBy: RawBlocker[];
  parent: RawLinkedIssue | null;
  labels: string[];
}

/**
 * Another issue one is linked to — its parent, or one blocking it — as `gh`
 * reports it: `{ id, number, state, title, url }`, of which the number and
 * the URL naming its repo are kept.
 */
interface RawLinkedIssue {
  number: IssueNumber;
  url: string;
}

/** One issue blocking another, as `blockedBy.nodes` reports it. */
interface RawBlocker extends RawLinkedIssue {
  state: string;
}

/**
 * `gh --json number,title,body,subIssuesSummary,blockedBy,parent,labels`: a
 * JSON array of `{ number, title, body, subIssuesSummary, blockedBy, parent, labels }`.
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
    const { number, title, body, subIssuesSummary, blockedBy, parent, labels } =
      issue as Record<string, unknown>;
    return {
      number: expectIssueNumber(number, "number", at),
      title: expectField(title, "string", "title", at),
      body: expectField(body, "string", "body", at),
      subIssuesSummary: parseSubIssuesSummary(subIssuesSummary, at),
      blockedBy: parseBlockedBy(blockedBy, at),
      parent: parseParent(parent, at),
      labels: parseLabels(labels, at),
    };
  });
}

/** `parent` as `gh` reports it: the linked issue, or `null` for none. */
function parseParent(value: unknown, at: string): RawLinkedIssue | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    throw new Error(`${at}: "parent" must be an object or null.`);
  }
  const { number, url } = value as Record<string, unknown>;
  return {
    number: expectIssueNumber(number, "parent.number", at),
    url: expectField(url, "string", "parent.url", at),
  };
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
 * `blockedBy` as `gh` reports it: `{ nodes: [{ number, state, url, … }], totalCount }`.
 * Each blocker's number, state and URL are kept: whether it is still open,
 * and which issue in which repo it is.
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
    const { number, state, url } = node as Record<string, unknown>;
    return {
      number: expectIssueNumber(number, "blockedBy.nodes.number", at),
      state: expectField(state, "string", "blockedBy.nodes.state", at),
      url: expectField(url, "string", "blockedBy.nodes.url", at),
    };
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

/**
 * `value`, as the issue number `field` names it at `at`: a positive integer,
 * per `docs/agents/coding-standards.md`'s "Brand your primitives" — `gh`
 * itself would never return anything else, but a tracker that did must be
 * refused loudly rather than handed on as a `Ticket`.
 */
function expectIssueNumber(value: unknown, field: string, at: string): IssueNumber {
  const number = expectField(value, "number", field, at);
  if (!isIssueNumber(number)) {
    throw new Error(`${at}: "${field}" must be a positive integer, got ${number}.`);
  }
  return number;
}
