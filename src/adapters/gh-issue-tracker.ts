import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ApplyReviewTicket,
  Discovery,
  HandBackOutcome,
  IssueNumber,
  IssueTracker,
  IssueUrl,
  OpenIssues,
  PullRequestBinding,
  PullRequestUrl,
  RebaseTicket,
  RepoSlug,
  ReviewTicket,
  SubIssue,
  Ticket,
  TicketPriority,
} from "../ports/index.ts";
import {
  ENHANCEMENT_LABEL,
  NEEDS_TRIAGE_LABEL,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  SPEC_REVIEW_LABEL,
  SPEC_REVIEW_SIZE_LABEL,
  carriesReadyForAgent,
  carriesSpecReviewLabel,
  carriesSupertaskLabel,
  discoveredBody,
  isIssueNumber,
  isIssueUrl,
  isPullRequestUrl,
  isTicketPriority,
  modelLabelOf,
  reviewTitle,
  sizeLabelOf,
  specReviewTitle,
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
    async publishSummary(title: string, body: string): Promise<IssueUrl> {
      const { stdout } = await execFileAsync(
        "gh",
        ["issue", "create", "--title", title, "--body", body],
        { cwd: home },
      );
      return issueUrlIn(stdout);
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
        "number,title,body,blockedBy,parent,labels",
      ]);

      const listed = parseIssues(stdout, repo);
      const truncated = listed.length > OPEN_ISSUE_READ_LIMIT;
      const issues = listed.slice(0, OPEN_ISSUE_READ_LIMIT).map(
        ({ body, blockedBy, parent, labels, ...issue }) => {
          const stillBlocking = blockedBy.filter(
            (blocker) => blocker.state === "OPEN",
          );
          const openBlockers = stillBlocking.length;
          const openBlockerNumbers = stillBlocking
            .filter((blocker) => isInRepo(blocker.url, repo))
            .map((blocker) => blocker.number);
          return {
            ticket: {
              repo,
              ...issue,
              ...labelDerivedTicketFields(body, labels),
              ...(openBlockers > 0 && { openBlockers }),
            },
            eligible: carriesReadyForAgent(labels),
            openBlockerNumbers,
            ...(parent !== null &&
              isInRepo(parent.url, repo) && { parent: parent.number }),
          };
        },
      );
      return { issues, truncated };
    },

    async closeReviewTicket(
      ticket: ReviewTicket,
      comment?: string,
    ): Promise<void> {
      const args = issueArgs(ticket);

      // Close first, because closed is what makes a review un-selectable —
      // unlike `handBack`, where losing the label is what stops reselection.
      // The label removal comes after for what it alone protects: a query for
      // closed reviews, and a reopen, which would otherwise carry the ticket
      // back into the queue.
      await execFileAsync("gh", [
        "issue",
        "close",
        ...args,
        ...(comment === undefined ? [] : ["--comment", comment]),
      ]);
      try {
        await execFileAsync("gh", [
          "issue",
          "edit",
          ...args,
          "--remove-label",
          READY_FOR_AGENT_LABEL,
        ]);
      } catch (error) {
        // Warned about rather than raised, the way handBack's own trailing
        // label edit is (below): the close already succeeded, so a caller
        // told this failed would report the ticket as not closed, sending the
        // developer to close a review that is already done — and never
        // naming the actual fault, a closed ticket still carrying
        // ready-for-agent.
        console.warn(
          `${ticket.repo}#${ticket.number} is closed but still labelled ${READY_FOR_AGENT_LABEL}: ${errorMessage(error)}`,
        );
      }
    },

    async closeApplyReviewTicket(
      ticket: ApplyReviewTicket,
      comment: string,
    ): Promise<void> {
      await closeWithComment(ticket, comment);
    },

    async closeRebaseTicket(
      ticket: RebaseTicket,
      comment: string,
    ): Promise<void> {
      await closeWithComment(ticket, comment);
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
        await linkToParent(review, ticket, reviewBody(ticket, pullRequest));
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

    async createSpecReviewTicket(ticket: Ticket, body: string): Promise<Ticket> {
      const title = specReviewTitle(ticket);
      await ensureLabel(ticket.repo, READY_FOR_AGENT_LABEL);
      await ensureLabel(ticket.repo, SPEC_REVIEW_LABEL);
      await ensureLabel(ticket.repo, SPEC_REVIEW_SIZE_LABEL);

      const { stdout } = await execFileAsync("gh", [
        "issue",
        "create",
        "--repo",
        ticket.repo,
        "--title",
        title,
        // Born carrying every label a selectable spec review needs, per
        // `CONTEXT.md`'s "Spec review sweep" — applied at creation, the same
        // as `createReviewTicket`'s own review, so there is no instant in
        // which it exists and is not yet eligible.
        "--label",
        READY_FOR_AGENT_LABEL,
        "--label",
        SPEC_REVIEW_LABEL,
        "--label",
        SPEC_REVIEW_SIZE_LABEL,
        "--body",
        body,
      ]);

      const specReview: Ticket = {
        repo: ticket.repo,
        number: issueNumberIn(stdout, ticket.repo),
        title,
        specReview: true,
      };

      try {
        await linkToParent(specReview, ticket, body);
      } catch (error) {
        // As `createReviewTicket`: the spec review exists and is eligible, so
        // the morning's work is not lost — but it is floating free of the
        // supertask it reviews, and this error is where the developer finds
        // out about it.
        throw new Error(
          `Opened #${specReview.number} in ${specReview.repo} as a spec review for #${ticket.number}, but could not link it to #${ticket.number}: ${errorMessage(error)}`,
        );
      }
      return specReview;
    },

    async listSubIssues(ticket: Ticket): Promise<SubIssue[]> {
      // `--paginate`, so a supertask with more sub-issues than fit in one
      // page is read whole rather than truncated to the first — the guard
      // this feeds is the whole feature, per `CONTEXT.md`'s "Spec review
      // sweep". Filtered with `--jq` one page at a time, which is why
      // `subIssuesIn` reads newline-delimited JSON rather than one array.
      const { stdout } = await execFileAsync("gh", [
        "api",
        `repos/${ticket.repo}/issues/${ticket.number}/sub_issues`,
        "--paginate",
        "--jq",
        ".[] | {number, title, body, state, labels: [.labels[].name]}",
      ]);
      return subIssuesIn(stdout, ticket);
    },

    async handBack(ticket: Ticket, comment: string): Promise<HandBackOutcome> {
      const args = issueArgs(ticket);

      // Checked first, and before any write: a ticket an overlapping run
      // already closed is not this run's to comment on or relabel, and a
      // ready-for-human added after the fact would put a closed ticket back
      // in front of the developer for work that is already done.
      if (await isClosed(ticket)) {
        return "already-closed";
      }

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
      await postComment(ticket, comment);
      await execFileAsync("gh", [
        "issue",
        "edit",
        ...args,
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
          ...args,
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
      return "handed-back";
    },

    async comment(ticket: Ticket, comment: string): Promise<void> {
      await postComment(ticket, comment);
    },

    async createDiscoveredTicket(
      ticket: Ticket,
      discovery: Discovery,
    ): Promise<Ticket> {
      await ensureLabel(ticket.repo, NEEDS_TRIAGE_LABEL);
      await ensureLabel(ticket.repo, ENHANCEMENT_LABEL);

      const { stdout } = await execFileAsync("gh", [
        "issue",
        "create",
        "--repo",
        ticket.repo,
        "--title",
        discovery.title,
        "--label",
        NEEDS_TRIAGE_LABEL,
        "--label",
        ENHANCEMENT_LABEL,
        "--body",
        discoveredBody(ticket, discovery.body),
      ]);

      const discovered: Ticket = {
        repo: ticket.repo,
        number: issueNumberIn(stdout, ticket.repo),
        title: discovery.title,
      };

      if (discovery.blocking === true) {
        try {
          await blockOn(ticket, discovered);
        } catch (error) {
          // The discovery is not lost — it exists and is triageable — but
          // nobody was told to wait on it, which is the whole point of
          // asking for the edge. Named here because this is the only place
          // the developer learns the created issue and the refused edge
          // both.
          throw new Error(
            `Opened #${discovered.number} in ${discovered.repo} but could not block #${ticket.number} by it: ${errorMessage(error)}`,
          );
        }
      }

      return discovered;
    },
  };
}

/**
 * Posts `comment` on `ticket`, the shape `handBack`'s own first call and
 * `comment` share.
 */
async function postComment(ticket: Ticket, comment: string): Promise<void> {
  await execFileAsync("gh", [
    "issue",
    "comment",
    ...issueArgs(ticket),
    "--body",
    comment,
  ]);
}

/**
 * Adds a native `blocked_by` edge so `ticket` is blocked by `blocker`, keyed
 * on `blocker`'s database id — what the endpoint takes, never its `#number`
 * or node id, per `docs/agents/issue-tracker.md`.
 */
async function blockOn(ticket: Ticket, blocker: Ticket): Promise<void> {
  const id = await issueIdOf(blocker);
  await execFileAsync("gh", [
    "api",
    "--method",
    "POST",
    `repos/${ticket.repo}/issues/${ticket.number}/dependencies/blocked_by`,
    "-F",
    `issue_id=${id}`,
  ]);
}

/**
 * Closes an issue with a comment, the shape `closeApplyReviewTicket` and
 * `closeRebaseTicket` share — the ticket kind is theirs to keep apart, since
 * each answers to its own port method, but the `gh` call underneath is
 * identical.
 */
async function closeWithComment(
  ticket: Ticket,
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
}

/**
 * What each label the manager applies itself says about itself, as
 * `docs/agents/triage-labels.md` describes it.
 */
const LABEL_DESCRIPTIONS = {
  [READY_FOR_AGENT_LABEL]: "Fully specified, ready for an AFK agent",
  [READY_FOR_HUMAN_LABEL]: "Requires human implementation",
  [NEEDS_TRIAGE_LABEL]: "Maintainer needs to evaluate this issue",
  [ENHANCEMENT_LABEL]: "New feature or request",
  [SPEC_REVIEW_LABEL]:
    "Reviews the repo against a supertask's body; reports, never commits.",
  [SPEC_REVIEW_SIZE_LABEL]: "Larger than M, smaller than XL",
} as const;

/**
 * The `gh` argv fragment that names `ticket` to a subcommand: the number and
 * the repo it lives in, both of which every per-ticket call needs since `gh`
 * does not infer a repo from a bare number.
 */
function issueArgs(ticket: Ticket): string[] {
  return [String(ticket.number), "--repo", ticket.repo];
}

/**
 * Whether `ticket` is closed on the tracker right now.
 *
 * A read that fails outright — a rate limit, a network blip — says nothing
 * about the ticket, so it is treated as open: `handBack`'s three writes below
 * are the ones this check must not add a new way to refuse an open ticket's
 * hand-back on. A read that succeeds is narrowed to the two states `gh`
 * reports, or thrown on naming the offending value, since a value neither
 * open nor closed is not something this can safely default either way.
 */
async function isClosed(ticket: Ticket): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", [
      "issue",
      "view",
      ...issueArgs(ticket),
      "--json",
      "state",
      "--jq",
      ".state",
    ]));
  } catch {
    return false;
  }

  const state = stdout.trim();
  switch (state) {
    case "OPEN":
      return false;
    case "CLOSED":
      return true;
    default:
      throw new Error(
        `gh issue view ${ticket.repo}#${ticket.number}: "state" was neither OPEN nor CLOSED: ${JSON.stringify(state)}`,
      );
  }
}

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
 * The line the `/rebase` workflow writes — never this adapter, and never by
 * hand — read back the same way `REVIEW_BODY` and `APPLY_REVIEW_BODY` are:
 * matched per line, so it survives beside a `Part of #N.` line or any other
 * the body carries.
 *
 * TODO[#295]: the workflow itself.
 */
const REBASE_BODY =
  /^Rebase (\S+), the draft pull request opened for #\d+\.$/m;

/**
 * The pull request an issue's body binds it to, and which of the three bound
 * kinds, or undefined where `body` carries none of the three lines — which is
 * what makes a fresh `listOpenIssues` able to tell a review, an apply-review
 * or a rebase ticket from an implementation ticket, and the three apart from
 * each other: the association `createReviewTicket` returned in the same
 * process is gone by the next morning, and the body is the only place it
 * survives.
 *
 * A well-formed review line wins over the other two, and a well-formed
 * apply-review line wins over a rebase line: a body carrying more than one
 * reads as the earliest kind checked. A line with a malformed URL binds
 * nothing, so a well-formed line of another kind beside it still binds the
 * body.
 */
function pullRequestBoundIn(body: string): PullRequestBinding | undefined {
  return (
    bindingMatching(REVIEW_BODY, "review", body) ??
    bindingMatching(APPLY_REVIEW_BODY, "apply-review", body) ??
    bindingMatching(REBASE_BODY, "rebase", body)
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
 * Hangs `child` off `parent` as a sub-issue, the relationship GitHub shows in
 * its own UI — the review a review ticket earns, or the spec review a
 * supertask earns.
 *
 * Where sub-issues are unavailable — an older GitHub Enterprise, a token
 * without the scope — the relationship goes into `child`'s own body instead,
 * per `docs/agents/issue-tracker.md`: `body`, the one `child` was created
 * with, prefixed with a `Part of #N.` reference. Only where they are
 * unavailable: a refusal, a rate limit or a dropped connection is a tracker
 * that has sub-issues and could not be asked, and writing the reference into
 * the body would answer it by quietly downgrading the relationship forever.
 *
 * Only `child`'s own body: the parent is a ticket the developer wrote and
 * this is not the place to edit it.
 */
async function linkToParent(
  child: Ticket,
  parent: Ticket,
  body: string,
): Promise<void> {
  const id = await issueIdOf(child);

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
      ...issueArgs(child),
      "--body",
      `Part of #${parent.number}.\n\n${body}`,
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

/**
 * `gh issue create`'s new issue URL, read out of `stdout` rather than
 * required to be the whole of it: a wrapper's banner or a `gh` notice ahead
 * of it must not turn a create that succeeded into one this reports as
 * failed.
 */
function issueUrlIn(stdout: string): IssueUrl {
  const trimmed = stdout.trim();
  const match = /\S*\/issues\/\d+$/.exec(trimmed);
  const url = match?.[0];
  if (url === undefined || !isIssueUrl(url)) {
    throw new Error(
      `gh issue create: expected the new issue's URL, got: ${trimmed}`,
    );
  }
  return url;
}

/** `gh issue create --repo`'s new issue, as its number rather than its URL. */
function issueNumberIn(stdout: string, repo: RepoSlug): IssueNumber {
  let url: IssueUrl;
  try {
    url = issueUrlIn(stdout);
  } catch {
    throw new Error(
      `gh issue create --repo ${repo}: expected the new issue's URL, got: ${stdout.trim()}`,
    );
  }
  const number = Number(/\/issues\/(\d+)$/.exec(url)![1]);
  if (!isIssueNumber(number)) {
    throw new Error(
      `gh issue create --repo ${repo}: the new issue's URL named a number that is not a positive integer: ${url}`,
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

/**
 * The ticket fields `listOpenIssues` and `subIssuesIn` both read the same way
 * from an issue's own body and labels: whether it is bound to a pull request,
 * its model, priority and size labels, and whether it carries the supertask
 * or spec review label. The one place both readers build them, so a
 * label-derived fact added to only one of them can't happen.
 *
 * `specReview` is only meaningful where `pullRequest` is absent —
 * `ticketKind` always prefers the pull request binding's own kind — but read
 * unconditionally, the same way `supertask` is: the tracker reports the
 * fact, and it is `ticketKind`'s job to weigh it.
 */
function labelDerivedTicketFields(
  body: string,
  labels: string[],
): Pick<
  Ticket,
  "pullRequest" | "modelLabel" | "priority" | "sizeLabel" | "supertask" | "specReview"
> {
  const pullRequest = pullRequestBoundIn(body);
  const modelLabel = modelLabelOf(labels);
  const priority = priorityLabelIn(labels);
  const sizeLabel = sizeLabelOf(labels);
  const supertask = carriesSupertaskLabel(labels);
  const specReview = carriesSpecReviewLabel(labels);
  return {
    ...(supertask && { supertask }),
    ...(specReview && { specReview }),
    ...(pullRequest !== undefined && { pullRequest }),
    ...(modelLabel !== undefined && { modelLabel }),
    ...(priority !== undefined && { priority }),
    ...(sizeLabel !== undefined && { sizeLabel }),
  };
}

/**
 * One sub-issue as `gh api repos/<repo>/issues/<n>/sub_issues --paginate
 * --jq '.[] | {number, title, body, state, labels: [.labels[].name]}'`
 * reports it, one per line — the REST API's own issue shape, unlike
 * `RawIssue`'s GraphQL one, so `state` reads lowercase `open` or `closed`
 * rather than `OPEN` or `CLOSED`.
 */
interface RawSubIssue {
  number: IssueNumber;
  title: string;
  body: string;
  state: string;
  labels: string[];
}

/**
 * `gh api .../sub_issues --paginate --jq '.[] | {...}'`: newline-delimited
 * JSON, one `{ number, title, body, state, labels }` per sub-issue of
 * `parent` — open or closed alike, per `CONTEXT.md`'s "Spec review sweep" —
 * across every page `--paginate` reads, so a supertask with more sub-issues
 * than fit on one page is read whole.
 */
function subIssuesIn(stdout: string, parent: Ticket): SubIssue[] {
  const where = `gh api repos/${parent.repo}/issues/${parent.number}/sub_issues --paginate`;
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    const at = `${where}: sub-issue ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(`${at}: did not return JSON: ${errorMessage(error)}`);
    }
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${at}: expected an object.`);
    }
    const { number, title, body, state, labels } = raw as Record<string, unknown>;
    const issue: RawSubIssue = {
      number: expectIssueNumber(number, "number", at),
      title: expectField(title, "string", "title", at),
      body: expectField(body, "string", "body", at),
      state: expectField(state, "string", "state", at),
      labels: parseLabelNames(labels, at),
    };
    return {
      ticket: {
        repo: parent.repo,
        number: issue.number,
        title: issue.title,
        ...labelDerivedTicketFields(issue.body, issue.labels),
      },
      closed: subIssueClosed(issue.state, at),
    };
  });
}

/**
 * `state`, as the REST API answers it for a sub-issue: `"open"` or
 * `"closed"`, lowercase unlike `isClosed`'s GraphQL read of the same fact.
 * Thrown on naming the offending value, same as `isClosed`: a state neither
 * open nor closed is not something this can safely default either way.
 */
function subIssueClosed(state: string, at: string): boolean {
  switch (state) {
    case "open":
      return false;
    case "closed":
      return true;
    default:
      throw new Error(
        `${at}: "state" was neither "open" nor "closed": ${JSON.stringify(state)}`,
      );
  }
}

/**
 * One issue as `gh issue list --json number,title,body,blockedBy,parent,labels`
 * reports it, with each label reduced to its name.
 */
interface RawIssue {
  number: IssueNumber;
  title: string;
  body: string;
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
 * `gh --json number,title,body,blockedBy,parent,labels`: a JSON array of
 * `{ number, title, body, blockedBy, parent, labels }`.
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
    const { number, title, body, blockedBy, parent, labels } =
      issue as Record<string, unknown>;
    return {
      number: expectIssueNumber(number, "number", at),
      title: expectField(title, "string", "title", at),
      body: expectField(body, "string", "body", at),
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
 * `labels` as `subIssuesIn`'s own `--jq` filter reduces it to: `[name, …]`,
 * already just the names — unlike `parseLabels`, which reads them out of
 * `gh issue list`'s own label objects.
 */
function parseLabelNames(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${at}: "labels" must be an array.`);
  }
  return value.map((label, index) =>
    expectField(label, "string", `labels[${index}]`, at),
  );
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

/**
 * `value`, as the issue number `field` names it at `at`: a positive integer.
 * `gh` itself would never return anything else, but a tracker that did must
 * be refused loudly rather than handed on as a `Ticket`.
 */
function expectIssueNumber(
  value: unknown,
  field: string,
  at: string,
): IssueNumber {
  const number = expectField(value, "number", field, at);
  if (!isIssueNumber(number)) {
    throw new Error(
      `${at}: "${field}" must be a positive integer, got ${number}.`,
    );
  }
  return number;
}
