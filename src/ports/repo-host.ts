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

/** What an applied reply's body starts with, before the commit it landed in. */
export const APPLIED_REPLY_PREFIX = "Applied in ";

/** What a declined reply's body starts with, before the reason. */
export const DECLINED_REPLY_PREFIX = "Declined: ";

/** One comment in an {@link ApplyReviewThread}: what it says, and when. */
export interface ApplyReviewComment {
  body: string;
  postedAt: Date;
}

/**
 * One thread's comments, oldest first: an unresolved review thread's, or a
 * review's non-empty body followed by whatever the pull request's own
 * comments said after it — the two kinds of thread the apply-pr-review skill
 * answers.
 */
export interface ApplyReviewThread {
  comments: ApplyReviewComment[];
}

/**
 * What reading a pull request's apply-review pass comes to.
 *
 * `applied` and `declined` count the marked replies posted since the read's
 * instant, so a caller asking what one run did is not handed counts an
 * earlier pass already reported. `unanswered` is not scoped to that instant:
 * a thread a marked reply answered days ago is still answered today, and a
 * thread a later, unmarked comment spoke in after the marked reply is
 * unanswered again, whatever instant the caller reads from.
 */
export interface ApplyReviewAnswers {
  applied: number;
  declined: number;
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
    const last = thread.comments.at(-1);
    if (last === undefined || !last.body.endsWith(APPLY_REVIEW_MARKER)) {
      unanswered++;
      continue;
    }
    if (last.postedAt <= since) {
      continue;
    }
    if (last.body.startsWith(APPLIED_REPLY_PREFIX)) {
      applied++;
    } else if (last.body.startsWith(DECLINED_REPLY_PREFIX)) {
      declined++;
    }
  }

  return { applied, declined, unanswered };
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
   * Draft, and only ever draft: there is no verb here that promotes a pull
   * request or merges one, because promoting and merging are the developer's
   * and a port that could do them is a port an unattended morning could use.
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
   * Whether `pullRequest` has a comment posted after `since`.
   *
   * What backs closing a review ticket: a reviewing agent that ran without
   * error still may have failed its own last step — posting the aggregated
   * report — and a ticket closed on process success alone would tell the
   * developer a review happened when nothing was ever written down. This is
   * the one check that confirms the finding actually reached the pull request.
   */
  hasNewComment(pullRequest: PullRequestUrl, since: Date): Promise<boolean>;
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
