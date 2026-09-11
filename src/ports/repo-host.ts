import type { Branch } from "./branch.ts";
import type { Checkout } from "./checkout.ts";
import type { Ticket } from "./issue-tracker.ts";
import type { PullRequestUrl } from "./pull-request-url.ts";
import type { RepoSlug } from "./repo-slug.ts";

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
   * request for it against `ticket`, answering with the pull request's URL.
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
  ): Promise<PullRequestUrl>;
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
}
