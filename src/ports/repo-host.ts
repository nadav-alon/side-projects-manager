import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import { isIssueNumber, type IssueNumber } from "./issue-number.ts";
import type { Ticket } from "./issue-tracker.ts";
import { milliseconds, type Milliseconds } from "./milliseconds.ts";
import type { Nits } from "./nits.ts";
import { pullRequestLabel, type PullRequestLabel } from "./pull-request-label.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TicketGist } from "./ticket-gist.ts";

/**
 * The marker every apply-review reply ends with (`.claude/skills/apply-pr-review/SKILL.md`),
 * so a later read can tell a reply came from that skill's pass rather than
 * from anyone else answering in the thread. Declared here, beside the port,
 * so the skill's instructions and this port's read agree on it rather than by
 * coincidence.
 */
export const APPLY_REVIEW_MARKER = "<!-- apply-pr-review -->";

/**
 * What an applied reply's verdict line starts with, before the commit it
 * landed in. A line, not the body: a reply to a review's body opens with a
 * quote of the passage it answers, and its verdict follows the quote.
 */
export const APPLIED_REPLY_PREFIX = "Applied in ";

/** What a declined reply's verdict line starts with, before the reason. */
export const DECLINED_REPLY_PREFIX = "Declined: ";

/**
 * The bare comment turbo mode posts on a pull request once its review ticket
 * closes, standing in for the developer typing `/apply-review` themselves.
 * `.github/workflows/apply-review.yml` matches a comment's trimmed body
 * against this exactly, so any marker or trailing note here would silently
 * stop the chain; a named constant beside the port is what keeps the
 * manager's spelling and the workflow's from drifting apart unnoticed. See
 * CONTEXT.md's "Turbo" and ADR 0006.
 */
export const APPLY_REVIEW_COMMENT = "/apply-review";

/**
 * The bare comment the conflict sweep posts on a turbo project's conflicting
 * pull request, standing in for the developer typing `/rebase` themselves.
 * `.github/workflows/scripts/rebase.sh` matches a comment's trimmed body
 * against this exactly, so any marker or trailing note here would silently
 * stop the chain — a named constant beside {@link APPLY_REVIEW_COMMENT}, for
 * the same reason that one is named rather than spelled inline, keeps the
 * manager's spelling and the workflow's from drifting apart unnoticed. See
 * `CONTEXT.md`'s "Conflict sweep" and ADR 0007.
 */
export const REBASE_COMMENT = "/rebase";

/**
 * The fixed heading a pull request body's nit section sits under. An
 * implementation run's own final output carries its section under this same
 * heading (`promptFor` in `container-sandbox.ts`), which {@link
 * RepoHost.openDraftPullRequest}'s `nits` argument is read off of; a review
 * run reads the heading back out of the pull request body itself
 * (`reviewPromptFor` in `container-sandbox.ts`). Declared here, beside the
 * port both ends read and write against, so the three can only ever agree
 * with each other.
 */
export const NIT_SECTION_HEADING = "## Nits";

/**
 * One finding a review posts, in the shape the reviewer is told to post it
 * (`reviewPromptFor` in `container-sandbox.ts`, via {@link reviewFindingTemplate})
 * and {@link RepoHost.hasReviewFindings} checks a pull request for: an inline
 * comment on the file and line it is actually about, not the pull request's
 * own issue-level comments. Declared once, beside the port, so the reviewer's
 * instructions and this check agree on what a finding looks like rather than
 * by coincidence.
 */
export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
}

/**
 * {@link ReviewFinding}'s own field names, in the order a finding is posted
 * and read back. `satisfies` ties each name to a real field of the interface,
 * so a field renamed there and not here fails to compile, rather than
 * drifting into a prompt nobody notices is stale.
 */
export const REVIEW_FINDING_FIELDS = [
  "path",
  "line",
  "body",
] as const satisfies readonly (keyof ReviewFinding)[];

/**
 * One {@link ReviewFinding}'s JSON shape, rendered from
 * {@link REVIEW_FINDING_FIELDS} with `<field>` standing in for its value.
 * What the review prompt shows the reviewing agent, so the prompt carries no
 * wording of the shape that isn't this declaration's.
 */
export function reviewFindingTemplate(): string {
  return `{${REVIEW_FINDING_FIELDS.map((field) => `"${field}": <${field}>`).join(", ")}}`;
}

/** One comment in an {@link ApplyReviewThread}: what it says, and when. */
export interface ApplyReviewComment {
  body: string;
  postedAt: Date;
}

/**
 * One thread's comments, oldest first: a review thread's, or a review's
 * non-empty body followed by the pull request comments that speak to it — the
 * two kinds of thread the apply-pr-review skill answers.
 *
 * `resolved` threads are no longer open, so none of them is unanswered; but
 * the skill resolves a review thread as soon as it applies it, so their
 * marked replies still count.
 */
export interface ApplyReviewThread {
  resolved: boolean;
  comments: ApplyReviewComment[];
}

/**
 * What reading a pull request's apply-review pass comes to.
 *
 * The `…Since` counts are scoped to the read's instant, so a caller asking
 * what one run did is not handed counts an earlier pass already reported.
 * `unanswered` is the threads' standing state, whatever instant the caller
 * reads from: a thread a marked reply answered days ago is still answered,
 * and one a later, unmarked comment spoke in is unanswered again.
 */
export interface ApplyReviewAnswers {
  /** Applied replies posted since the read's instant. */
  appliedSince: number;
  /** Declined replies posted since the read's instant. */
  declinedSince: number;
  /** Open threads whose last comment is not a marked reply. */
  unanswered: number;
}

/**
 * Reads `threads` down to {@link ApplyReviewAnswers}, the one place that
 * interprets the marker and the two reply prefixes. Both the GitHub adapter
 * and the fake call this rather than each deciding for itself what a marked
 * reply says.
 */
export function summarizeApplyReviewThreads(
  threads: ApplyReviewThread[],
  since: Date,
): ApplyReviewAnswers {
  let applied = 0;
  let declined = 0;
  let unanswered = 0;

  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (comment.postedAt <= since) {
        continue;
      }
      const verdict = verdictOf(comment.body);
      if (verdict === "applied") {
        applied++;
      } else if (verdict === "declined") {
        declined++;
      }
    }

    if (thread.resolved) {
      continue;
    }
    const last = thread.comments.at(-1);
    if (last === undefined || !isMarkedReply(last.body)) {
      unanswered++;
    }
  }

  return {
    appliedSince: applied,
    declinedSince: declined,
    unanswered,
  };
}

/**
 * Whether `body` is a reply the apply-pr-review skill posted, wherever it
 * landed — a review thread's own comments, or a pull request's own comments
 * for a review body's pseudo-thread ({@link RepoHost.readApplyReviewAnswers}).
 * The one place both readers ask the question, so they agree on the answer
 * rather than by coincidence.
 */
export function isMarkedReply(body: string): boolean {
  return body.trimEnd().endsWith(APPLY_REVIEW_MARKER);
}

/** What a marked reply decided, read from its first verdict line. */
function verdictOf(body: string): "applied" | "declined" | undefined {
  if (!isMarkedReply(body)) {
    return undefined;
  }
  for (const line of body.split("\n")) {
    if (line.startsWith(APPLIED_REPLY_PREFIX)) {
      return "applied";
    }
    if (line.startsWith(DECLINED_REPLY_PREFIX)) {
      return "declined";
    }
  }
  return undefined;
}

/**
 * What a pull request's mergeability currently reads as. GitHub computes it
 * lazily: a pull request just opened, or just pushed to, answers `"unknown"`
 * until it has finished, and only `"conflicting"` or `"clean"` is a settled
 * answer.
 */
export type MergeStatus = "conflicting" | "clean" | "unknown";

/**
 * What a pull request's own checks read as, read once at whatever instant the
 * caller asks: `"red"` once any check has failed, `"pending"` while one is
 * still running and none has failed, `"green"` once every check that ran
 * passed — a pull request with no checks at all reads `"green"`, since there
 * is nothing to wait on.
 *
 * What the merge gate reads before merging: `gh pr merge` only refuses on a
 * red or pending check where the repo's branch protection requires it, so a
 * repo without that configured would otherwise merge a pull request whose
 * checks never passed.
 */
export type ChecksStatus = "green" | "pending" | "red";

/**
 * Whether a pull request is still open, merged, or closed without merging —
 * settled the instant it is asked, unlike {@link MergeStatus}, which GitHub
 * computes lazily.
 */
export type PullRequestState = "open" | "merged" | "closed";

/**
 * How a pull request settled, once it no longer reads `"open"`: `{@link
 * PullRequestState}` with that case excluded, named so a pull request ticket
 * whose own pull request already settled has one word for it rather than an
 * `Exclude` spelled out anew at each site that needs it.
 */
export type PullRequestResolution = Exclude<PullRequestState, "open">;

/**
 * GitHub's nine closing keywords — `close(s|d)`, `fix(es|ed)`, `resolve(s|d)`
 * — case-insensitive, starting at a word boundary, with an optional colon
 * before the `#`. Translated from the ERE `.github/workflows/scripts/rebase.sh`'s
 * `closing_number` matches with `grep` (`CLOSING_KEYWORD`) — the copy that
 * reads a single pull request's body — so this and that reader agree on
 * every body. `[^\S\n]` rather than `\s`, to mirror `grep`'s `[[:space:]]`
 * without also pairing a keyword on one line with a `#N` on the next: `grep`
 * processes a body one line at a time and can't either, but within a line it
 * matches more than plain spaces and tabs, including `\r`, `\f` and `\v`.
 *
 * `rebase.sh` also feeds `CLOSING_KEYWORD` to `jq`'s `test()` against a
 * whole body at once (its "implementation ticket" branch), where a keyword
 * on one line *can* pair with a `#N` on the next — this function does not
 * reproduce that second, non-line-oriented copy. Both are the same shell
 * literal kept in sync by hand, with nothing that re-checks the two shell
 * uses or this translation against each other; a future edit to any one of
 * the three needs to be carried to the other two by whoever makes it.
 */
const CLOSING_KEYWORD =
  /(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[^\S\n]*:?[^\S\n]*#(\d+)/i;

/**
 * The ticket `body` closes: the number from the first `Closes`, `Fixes` or
 * `Resolves` — any of GitHub's nine closing keywords, see
 * {@link CLOSING_KEYWORD} — or undefined when `body` names none. Also
 * undefined for a match on `#0`, since {@link isIssueNumber} rejects it as no
 * tracker could have produced it — indistinguishable here from a body naming
 * no closing keyword at all, which is the more common way to reach this
 * same answer.
 *
 * What {@link RepoHost.listOpenPullRequests} reads a pull request's closed
 * ticket with, the same way `.github/workflows/scripts/rebase.sh` reads it
 * in shell, so a sweep built on the former never picks a pull request the
 * latter would refuse.
 */
export function closedTicketIn(body: string): IssueNumber | undefined {
  const match = CLOSING_KEYWORD.exec(body);
  if (match === null) {
    return undefined;
  }
  const number = Number(match[1]);
  return isIssueNumber(number) ? number : undefined;
}

/**
 * One open pull request, as {@link RepoHost.listOpenPullRequests} lists it:
 * its own url, the labels it carries, and the ticket its body closes — see
 * {@link closedTicketIn} — absent when its body names none.
 */
export interface OpenPullRequest {
  url: PullRequestUrl;
  labels: PullRequestLabel[];
  closes?: IssueNumber;
}

/**
 * One issue a {@link ClosingPullRequest} closes, in whichever repo it lives:
 * a pull request can close an issue in another repo, and GitHub's own
 * `closingIssuesReferences` names that repo on every issue it lists, so
 * matching a sub-issue to the pull request that closes it (`subIssueLine`,
 * `spec-review-sweep.ts`) never has to assume it shares the pull request's
 * own repo.
 */
export type ClosingIssue = Pick<Ticket, "repo" | "number">;

/**
 * One pull request of any state, as {@link RepoHost.listPullRequestsClosingIssues}
 * lists it: its own number, its state, its own branch, and the issues its
 * body closes — every one of them, since a pull request can close more than
 * one.
 *
 * What a spec review sweep (`spec-review-sweep.ts`) reads once, at the
 * instant a supertask's sub-issues all close, per `CONTEXT.md`'s "Spec review
 * sweep": exact branches, exact merged state and exact issue linkage,
 * without a read per sub-issue and without a new failure mode for a
 * sub-issue that never had a pull request.
 */
export interface ClosingPullRequest {
  number: IssueNumber;
  state: PullRequestState;
  branch: Branch;
  closesIssues: readonly ClosingIssue[];
}

/**
 * How many pull requests {@link RepoHost.listPullRequestsClosingIssues} reads,
 * any state, newest first. `.github/workflows/scripts/rebase.sh` reads up to
 * 500 in the same place; this asks the same width for the same reason — a
 * repo busy enough to exceed it is not one a single `gh pr list` was ever
 * going to cover completely.
 */
export const CLOSING_PULL_REQUEST_LIMIT = 500;

/**
 * How many of a repo's open pull requests {@link RepoHost.listOpenPullRequests}
 * reads: the newest this many, by the repo host's own ordering, when a repo
 * has more open at once. `rebase.sh` reads up to 500 in the same place; this
 * is the conflict sweep's own limit, not a promise to see every pull request
 * the workflow would. A repo with more than this many open truncates
 * silently, unlike `OPEN_ISSUE_READ_LIMIT` in `gh-issue-tracker.ts`, which
 * reports when it truncates: that read feeds ticket selection, where a
 * hidden ticket is a ticket nobody can pick, while the sweep is best effort
 * (CONTEXT.md's "Conflict sweep") and a pull request left short one pass is
 * caught by the next.
 */
export const OPEN_PULL_REQUEST_LIMIT = 100;

/**
 * How many times total {@link resolveNeedsRebase} calls `read` — the first
 * try plus every retry after an `"unknown"` — before it gives up. Bounded
 * rather than unbounded, so a pull request whose mergeability never finishes
 * computing fails loudly instead of hanging the caller.
 */
export const REBASE_STATUS_ATTEMPTS = 5;

/**
 * How long {@link resolveNeedsRebase}, and the conflict sweep's re-reads, wait
 * before a retry. GitHub computes
 * mergeability lazily (see the module comment on {@link MergeStatus}), so a
 * retry issued in the same instant as the read before it gets back the same
 * unsettled answer; the wait is what gives GitHub's computation time to
 * finish before the next `read`.
 */
export const REBASE_STATUS_RETRY_DELAY: Milliseconds = milliseconds(2000);

/**
 * The real-time wait {@link resolveNeedsRebase} and the conflict sweep use
 * unless handed another.
 */
export function realDelay(delay: Milliseconds): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Thrown by {@link resolveNeedsRebase} when `read` never settles past
 * `"unknown"` within {@link REBASE_STATUS_ATTEMPTS} tries.
 *
 * Carries `pullRequest` and `lastStatus` because the caller has nothing else
 * to say why: a rebase ticket that cannot get a settled answer needs both to
 * report back to the developer.
 */
export class MergeabilityUnknown extends Error {
  override name = "MergeabilityUnknown";
  readonly pullRequest: PullRequestUrl;
  readonly lastStatus: MergeStatus;

  constructor(pullRequest: PullRequestUrl, lastStatus: MergeStatus) {
    super(
      `${pullRequest}: still "${lastStatus}" after ${REBASE_STATUS_ATTEMPTS} tries. GitHub never finished computing mergeability.`,
    );
    this.pullRequest = pullRequest;
    this.lastStatus = lastStatus;
  }
}

/**
 * The label the `/rebase` workflow adds to the pull request it opens a
 * rebase ticket for (`.github/workflows/scripts/rebase.sh`, `AGENTS.md`), so
 * that pull request reads as not mergeable without touching its draft state.
 * Declared here, beside {@link RepoHost.removeNeedsRebaseLabel}, the one
 * place that ever takes it back off, so the two agree on the label's name
 * rather than by coincidence. The script that adds the label
 * (`.github/workflows/scripts/rebase.sh`) and `agent-instructions.ts` still
 * spell it as their own literal.
 */
export const NEEDS_REBASE_LABEL = "needs-rebase";

/**
 * {@link NEEDS_REBASE_LABEL}, branded once so the conflict sweep and its
 * test don't each construct their own `PullRequestLabel` from the same
 * string, the way {@link REVIEWED_LABEL} and {@link APPLIED_REVIEW_LABEL}
 * are branded once beside the type they're labels of.
 */
export const NEEDS_REBASE = pullRequestLabel(NEEDS_REBASE_LABEL);

/**
 * Whether a pull request needs a rebase, read repeatedly through `read` until
 * it settles.
 *
 * `read` is called again on `"unknown"`, up to {@link REBASE_STATUS_ATTEMPTS}
 * times in total, waiting `wait` between one read and the next so a retry is
 * not just the same question asked before GitHub could have answered it
 * differently. An `"unknown"` that never settles throws
 * {@link MergeabilityUnknown} rather than resolving: mistaking it for `false`
 * would close a rebase ticket on a branch that still conflicts.
 *
 * `wait` defaults to a real delay; callers that need the retry loop to run
 * instantly — a port test proving the counting, or a fake standing in for the
 * host — hand it one that doesn't.
 */
export async function resolveNeedsRebase(
  pullRequest: PullRequestUrl,
  read: () => Promise<MergeStatus>,
  wait: (delay: Milliseconds) => Promise<void> = realDelay,
): Promise<boolean> {
  let last: MergeStatus = "unknown";
  for (let attempt = 0; attempt < REBASE_STATUS_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await wait(REBASE_STATUS_RETRY_DELAY);
    }
    last = await read();
    if (last !== "unknown") {
      return last === "conflicting";
    }
  }
  throw new MergeabilityUnknown(pullRequest, last);
}

/**
 * What proposing the scaffold to a project that predates the manager came to.
 *
 * A proposal has three ends and the command reports all of them, because the
 * developer's next move differs in each: nothing to do, a request to review,
 * or a branch waiting for a request somebody has to open by hand.
 */
export type Proposal =
  /** The checkout already had the scaffold as it stands. Nothing was pushed. */
  | { kind: "unchanged" }
  /** The scaffold is on `branch`, and `url` is the draft pull request for it. */
  | { kind: "proposed"; branch: Branch; url: PullRequestUrl }
  /**
   * The scaffold is on `branch`, but no pull request is known to be open for
   * it. One may exist all the same, when `gh` answered with something that is
   * not a pull request URL; `failure` says which. Reported rather than
   * thrown: the branch is on the host either way, and a command that failed
   * here did everything except the last step.
   */
  | { kind: "pushed"; branch: Branch; failure: string };

/**
 * What opening a finished run's draft pull request came to.
 *
 * Every end says whether the branch reached the host, because that is where
 * the developer goes looking for the work: the pull request, the branch on the
 * host, or the checkout the branch never left.
 */
export type DraftPullRequestOpening =
  /** The branch is on the host, and `pullRequest` is the draft for it. */
  | { kind: "opened"; pullRequest: PullRequestUrl }
  /**
   * The branch is on the host, but no pull request is known to be open for
   * it. One may exist all the same, when `gh` answered with something that is
   * not a pull request URL; `failure` says which.
   */
  | { kind: "pushed"; failure: string }
  /** The branch never reached the host: it is only in the checkout. */
  | { kind: "unpushed"; failure: string };

/**
 * Whether a repo {@link RepoHost.create} makes is world-readable or not. A
 * named union rather than a bare `boolean`, so a call site reads `"public"`
 * or `"private"` rather than a `true` or `false` that says nothing without
 * the signature open beside it.
 */
export type Visibility = "public" | "private";

/**
 * How the manager reaches GitHub and git: creating a repo, getting a checkout
 * of it into the managed location, publishing what the new-project command
 * scaffolded into it, and handing a completed run's work to the developer.
 *
 * The managed location is the adapter's business, not the caller's. `clone`
 * returns the checkout it produced, so nothing above this port has to know
 * where projects live on disk.
 *
 * Publishing is two verbs rather than one with a flag, because a repo created
 * moments ago and a repo with ten years of history deserve different
 * treatment, and which one the caller means should be legible at the call
 * site: `commitAndPush` writes to the branch the checkout is on, and
 * `commitAndPropose` puts the change somewhere the developer has to say yes
 * to.
 */
export interface RepoHost {
  /** Whether `repo` already exists on the host. */
  exists(repo: RepoSlug): Promise<boolean>;
  /** Creates `repo`, with the given {@link Visibility}. */
  create(
    repo: RepoSlug,
    description: string,
    visibility: Visibility,
  ): Promise<void>;
  /**
   * Ensures a checkout of `repo` in the managed location, and returns it.
   * A clone already sitting there is reused rather than replaced, which is
   * what makes a missing clone self-healing and an existing one safe.
   *
   * A reused clone is first fast-forwarded to what its remote has, so work
   * started from it starts from current code. One that cannot be — its branch
   * has moved apart from the remote — rejects rather than being handed back
   * stale.
   */
  clone(repo: RepoSlug): Promise<Checkout>;
  /**
   * Whether any of `paths` in the checkout at `directory` differs from what
   * it has committed — staged, unstaged or untracked.
   */
  hasUncommittedChanges(
    directory: Checkout,
    paths: readonly string[],
  ): Promise<boolean>;
  /**
   * Commits `paths` in the checkout at `directory` and pushes, setting
   * upstream. A checkout where none of them changed is left alone.
   *
   * Only the named paths: a checkout that already existed is the developer's,
   * and work they had in progress there is not this command's to commit.
   */
  commitAndPush(
    directory: Checkout,
    message: string,
    paths: string[],
  ): Promise<void>;
  /**
   * Commits `paths` onto `branch` in the checkout at `directory`, pushes it,
   * and opens a draft pull request describing the change with `body`.
   *
   * For a repo that predates the manager: nothing this command scaffolds lands
   * on a branch the developer already had without them merging it. The
   * checkout is left on the branch it was found on, whatever the outcome.
   */
  commitAndPropose(
    directory: Checkout,
    message: string,
    body: string,
    paths: string[],
    branch: Branch,
  ): Promise<Proposal>;
  /**
   * The paths `branch` changed relative to the branch `directory` is
   * currently on — the base a pull request for it would open against, per
   * {@link openDraftPullRequest}'s own doc comment: the sandbox clones the
   * checkout at its HEAD, so the branch it is on is the base the commits
   * actually sit on.
   *
   * Read before opening a pull request, so a run whose diff touches a file
   * the manager keeps uniform across every project (`UNIFORM_FILES`) can be
   * caught first, rather than becoming a project-local copy nobody notices
   * drifted.
   */
  readChangedPaths(directory: Checkout, branch: Branch): Promise<string[]>;
  /**
   * Pushes `branch` from the checkout at `directory` and opens a draft pull
   * request for it against `ticket`, answering with how far it got. Failures
   * resolve rather than reject, so a caller has one thing to read: which end
   * it came to, and so where the work is.
   *
   * Opened as a draft, and never merged by this call. The one promotion here
   * is {@link markPullRequestReady}, which an apply-review ticket's run uses:
   * the developer asked for that review to be acted on, and marking the pull
   * request ready hands the result back to them for review, merging nothing.
   * {@link mergePullRequest} is the port's only verb that merges a pull
   * request; nothing here reaches for it.
   *
   * The branch is the agent's work, already committed and fetched back into
   * the checkout by the sandbox, so nothing is committed here.
   *
   * `gist`, when the run produced one, opens the body with it — one sentence
   * saying what the ticket asked for, so the developer knows what they are
   * looking at without opening the ticket. Absent, the body is the closing
   * reference and the draft note alone.
   *
   * `nits`, when the run left any, renders under {@link NIT_SECTION_HEADING}
   * so the review run `reviewPromptFor` sends against this pull request finds
   * them there. Absent, the body carries no such section.
   */
  openDraftPullRequest(
    directory: Checkout,
    branch: Branch,
    ticket: Ticket,
    gist?: TicketGist,
    nits?: Nits,
  ): Promise<DraftPullRequestOpening>;
  /**
   * Deletes `branch` from the checkout at `directory`, whatever it points at.
   *
   * What a failed run's work is thrown away with. Unconditional, because the
   * branch being discarded is one the sandbox made moments ago and the caller
   * has already decided is not worth keeping; and forgiving of a branch that
   * is not there, because a run whose agent committed nothing never left one.
   *
   * Local only: the sandbox never pushes, so a discarded branch has never
   * been anywhere the developer could have seen it.
   */
  discardBranch(directory: Checkout, branch: Branch): Promise<void>;
  /**
   * Whether `pullRequest` carries a {@link ReviewFinding} posted after
   * `since`.
   *
   * What backs closing a review ticket: a reviewing agent that ran without
   * error still may have failed its own last step — posting the aggregated
   * report — and a ticket closed on process success alone would tell the
   * developer a review happened when nothing was ever written down. This is
   * the one check that confirms a finding, in the shape the reviewer is told
   * to post it, actually reached the pull request.
   */
  hasReviewFindings(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<boolean>;
  /**
   * Whether `pullRequest` carries a submitted pull request review posted
   * after `since`, with or without a {@link ReviewFinding} on it.
   *
   * What backs closing a review ticket whose reviewer found nothing to flag:
   * {@link hasReviewFindings} alone cannot tell a clean review — one
   * genuinely submitted with no findings — apart from a reviewing agent that
   * failed its own last step and posted nothing at all, since both leave zero
   * inline comments. This checks the review itself, the object `gh api
   * .../pulls/<number>/reviews` returns, which a submission with no findings
   * still creates.
   */
  hasPostedReview(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<boolean>;
  /**
   * Reads `pullRequest`'s apply-review pass since `since`: see
   * {@link ApplyReviewAnswers}.
   */
  readApplyReviewAnswers(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<ApplyReviewAnswers>;
  /**
   * Marks `pullRequest` ready for review.
   *
   * A pull request that is not a draft is left exactly as it was, not an
   * error: apply-review calls this once a run finishes, whether or not the
   * pull request was still a draft by then.
   */
  markPullRequestReady(pullRequest: PullRequestUrl): Promise<void>;
  /**
   * Rewrites `pullRequest`'s own closing reference for `ticket` from `Closes
   * #N.` to `Part of #N.`, so merging the pull request no longer closes the
   * ticket. What `finishApplyReview` (`morning-run.ts`) calls once an
   * apply-review run leaves a `Blocked on:` still open — a prerequisite
   * discovery that named an already-ticketed, still-open issue, per
   * CONTEXT.md's "Discovery" — since the criterion behind it is not met, and
   * `ticket` has to stay open until whatever blocks it clears.
   *
   * A pull request whose body already carries `Part of #N.` is left alone —
   * an earlier pass already demoted it. Anything else — a closing line
   * `gh`'s own normalizing changed, or a body edited by hand since — throws
   * rather than returning quietly: silently carrying on as if this succeeded
   * is exactly how a pull request closes `ticket` unnoticed, the failure mode
   * this call exists to prevent.
   */
  demoteClosingReference(pullRequest: PullRequestUrl, ticket: Ticket): Promise<void>;
  /**
   * Posts `body` as a comment on `pullRequest`.
   *
   * Kept as narrow as the write verbs above it: turbo mode (CONTEXT.md's
   * "Turbo", ADR 0006) and the conflict sweep (CONTEXT.md's "Conflict
   * sweep", ADR 0007) are its only two callers, posting {@link
   * APPLY_REVIEW_COMMENT} once a review ticket closes or {@link
   * REBASE_COMMENT} on a turbo project's conflicting pull request, each
   * standing in for the developer typing it themselves. Nothing here reads a
   * comment back — see `container-sandbox.ts`'s note by the reviewer's own
   * prompt for why that stays true regardless.
   */
  postComment(pullRequest: PullRequestUrl, body: string): Promise<void>;
  /**
   * Adds `label` to `pullRequest`, creating it in the pull request's own repo
   * first if the repo doesn't have it yet — best effort, so a project never
   * labelled by hand still works: a "the label already exists" refusal is not
   * an error, and neither is adding a label `pullRequest` already carries.
   *
   * Adds only. There is no verb here that removes a label, the way
   * {@link markPullRequestReady} is the only one that promotes a pull request:
   * labelling says something happened to it, not that anything merged.
   */
  labelPullRequest(
    pullRequest: PullRequestUrl,
    label: PullRequestLabel,
  ): Promise<void>;
  /**
   * Whether `pullRequest`'s branch needs a rebase onto its base branch.
   *
   * What a rebase ticket's run reads back rather than takes on its own say-so:
   * see {@link resolveNeedsRebase} for how an unsettled `"unknown"` is handled.
   */
  needsRebase(pullRequest: PullRequestUrl): Promise<boolean>;
  /**
   * Reads `pullRequest`'s mergeability once: no retry, no wait, and
   * `"unknown"` is returned exactly as read, never thrown.
   *
   * What the conflict sweep asks with before every selection (CONTEXT.md's
   * "Conflict sweep", ADR 0007) — unlike `needsRebase`, whose {@link
   * resolveNeedsRebase} retries an unsettled read until it gives up, the
   * retrying is the sweep's to do, and bounded there: retrying every open
   * pull request of every project before every selection without limit would
   * stall selection itself.
   */
  readMergeStatus(pullRequest: PullRequestUrl): Promise<MergeStatus>;
  /**
   * Reads `pullRequest`'s own checks once: see {@link ChecksStatus}.
   *
   * What the merge gate reads before merging, since {@link mergePullRequest}
   * itself does not reliably refuse on a red or pending check — see {@link
   * ChecksStatus}.
   */
  readChecksStatus(pullRequest: PullRequestUrl): Promise<ChecksStatus>;
  /**
   * Removes {@link NEEDS_REBASE_LABEL} from `pullRequest`, once a rebase
   * ticket closes because it no longer needs one.
   *
   * A pull request not carrying the label is left exactly as it was, not an
   * error: one opened before the `/rebase` workflow started labelling pull
   * requests, or in a project whose workflow predates it, never carried it to
   * begin with. Draft state is never touched here — removing the label is the
   * whole signal that the pull request no longer needs a rebase, not a
   * promotion out of draft.
   */
  removeNeedsRebaseLabel(pullRequest: PullRequestUrl): Promise<void>;
  /**
   * Whether `pullRequest` is still open, merged, or closed without merging.
   *
   * What a pull request ticket's run checks before it does anything else: a
   * pull request already merged or closed has nothing left to review, apply a
   * review to, or rebase, and its branch is commonly gone with it — a run
   * started on it would only fail on checkout, the same way, every morning
   * after.
   */
  pullRequestState(pullRequest: PullRequestUrl): Promise<PullRequestState>;
  /**
   * Lists `repo`'s open pull requests — draft and ready alike — up to
   * {@link OPEN_PULL_REQUEST_LIMIT}, newest first: each one's url, labels,
   * and the ticket its body closes (see {@link closedTicketIn}).
   *
   * What the conflict sweep asks every project with, before every selection:
   * the same closing-keyword definition `.github/workflows/scripts/rebase.sh`
   * uses, so the sweep never picks a pull request the workflow would refuse.
   */
  listOpenPullRequests(repo: RepoSlug): Promise<OpenPullRequest[]>;
  /**
   * Lists `repo`'s pull requests of any state — open, merged or closed
   * without merging — up to {@link CLOSING_PULL_REQUEST_LIMIT}, newest first:
   * each one's state, its own branch, and the issues its body closes.
   *
   * What a spec review sweep asks with, once per supertask whose sub-issues
   * have all just closed, per `CONTEXT.md`'s "Spec review sweep": unlike
   * {@link listOpenPullRequests}, which only ever sees pull requests still
   * open, this is the one read that reaches a merged or closed one — exactly
   * the ones a closed sub-issue's own pull request now is.
   */
  listPullRequestsClosingIssues(repo: RepoSlug): Promise<ClosingPullRequest[]>;
  /**
   * Merges `pullRequest` with a merge commit, and deletes its branch.
   *
   * A merge the host refuses — conflicting, already merged, or checks failing
   * where the repo's branch protection requires them green — is raised as an
   * error naming the pull request, never swallowed: a caller gating on this
   * succeeding needs to tell a real refusal apart from anything else that
   * could go wrong. A repo with no such branch protection merges a pull
   * request whatever its checks read as: see {@link ChecksStatus}, which the
   * merge gate reads first for that reason.
   */
  mergePullRequest(pullRequest: PullRequestUrl): Promise<void>;
}
