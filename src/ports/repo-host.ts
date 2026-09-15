import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import type { Ticket } from "./issue-tracker.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";

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
 * One finding a review posts, in the shape the reviewer is told to post it
 * (`reviewPromptFor` in `container-sandbox.ts`) and {@link RepoHost.hasReviewFindings}
 * checks a pull request for: an inline comment on the file and line it is
 * actually about, not the pull request's own issue-level comments. Declared
 * once, beside the port, so the reviewer's instructions and this check agree
 * on what a finding looks like rather than by coincidence.
 */
export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
}

/** One comment in an {@link ApplyReviewThread}: what it says, and when. */
export interface ApplyReviewComment {
  body: string;
  postedAt: Date;
}

/**
 * One thread's comments, oldest first: a review thread's, or a review's
 * non-empty body followed by the pull request comments that quote it — the
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
 * `unanswered` is the thread's standing state, whatever instant the caller
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

    const last = thread.comments.at(-1);
    if (!thread.resolved && (last === undefined || !isMarked(last.body))) {
      unanswered++;
    }
  }

  return { appliedSince: applied, declinedSince: declined, unanswered };
}

function isMarked(body: string): boolean {
  return body.trimEnd().endsWith(APPLY_REVIEW_MARKER);
}

/** What a marked reply decided, read from its first verdict line. */
function verdictOf(body: string): "applied" | "declined" | undefined {
  if (!isMarked(body)) {
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
  | { kind: "proposed"; branch: string; url: string }
  /**
   * The scaffold is committed and pushed to `branch`, but no pull request was
   * opened. Reported rather than thrown: the branch is on the host either way,
   * and a command that failed here did everything except the last step.
   */
  | { kind: "pushed"; branch: string; failure: string };

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
  /** Creates `repo` as a private repository. */
  create(repo: RepoSlug, description: string): Promise<void>;
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
   * Commits `paths` in the checkout at `directory` and pushes, setting
   * upstream. A checkout where none of them changed is left alone.
   *
   * Only the named paths: a checkout that already existed is the developer's,
   * and work they had in progress there is not this command's to commit.
   */
  commitAndPush(
    directory: string,
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
    directory: string,
    message: string,
    body: string,
    paths: string[],
    branch: string,
  ): Promise<Proposal>;
  /**
   * Pushes `branch` from the checkout at `directory` and opens a draft pull
   * request for it against `ticket`, answering with how far it got. Failures
   * resolve rather than reject, so a caller has one thing to read: which end
   * it came to, and so where the work is.
   *
   * Opened as a draft, and never merged: there is no verb here that merges a
   * pull request, because merging is the developer's and a port that could do
   * it is a port an unattended morning could use. The one promotion is
   * {@link markPullRequestReady}, which an apply-review ticket's run uses: the
   * developer asked for that review to be acted on, and marking the pull
   * request ready hands the result back to them for review, merging nothing.
   *
   * The branch is the agent's work, already committed and fetched back into
   * the checkout by the sandbox, so nothing is committed here.
   */
  openDraftPullRequest(
    directory: Checkout,
    branch: Branch,
    ticket: Ticket,
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
}
