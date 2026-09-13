import type {
  Branch,
  Checkout,
  DraftPullRequestOpening,
  Proposal,
  PullRequestUrl,
  RepoHost,
  RepoSlug,
  Ticket,
} from "../ports/index.ts";
import { checkout, pullRequestUrl } from "../ports/index.ts";

/** One push the command made, in the order the fake received it. */
export interface FakePush {
  directory: string;
  message: string;
  /** The paths committed, and nothing else in the checkout. */
  paths: string[];
}

/** One proposal the command made, in the order the fake received it. */
export interface FakeProposal extends FakePush {
  /** What the pull request says about the change. */
  body: string;
  /** The branch the scaffold was committed to, never the developer's own. */
  branch: string;
}

/** One draft pull request the loop opened, in the order the fake received it. */
export interface FakePullRequest {
  /** The project checkout the branch was pushed from. */
  directory: Checkout;
  /** The branch the run left its commits on. */
  branch: Branch;
  /** The ticket the pull request is opened against. */
  ticket: Ticket;
}

/** One branch thrown away, and the checkout it was thrown away from. */
export interface FakeDiscard {
  directory: Checkout;
  branch: Branch;
}

/**
 * GitHub and git in memory: a set of repos that exist, and a managed location
 * that is a path shape rather than a real directory.
 *
 * Tests arrange with `alreadyExists`, which is what a repo predating the
 * manager looks like, and inspect `created`, `clones`, `pushes`, `proposals`,
 * `pullRequests` and `discarded` to see what the command did to the outside
 * world.
 */
export class FakeRepoHost implements RepoHost {
  /** The managed location every clone lands under. */
  static readonly MANAGED_LOCATION = "/side-projects";
  /** The pull request a proposed scaffold waits in, unless a test says otherwise. */
  static readonly PROPOSED_PULL_REQUEST =
    "https://github.com/nadav-alon/pilot/pull/1";
  /** The pull request a run's work waits in, unless a test says otherwise. */
  static readonly RUN_PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/2",
  );

  readonly #existing = new Set<RepoSlug>();

  /** Repos created, in the order they were created. */
  readonly created: RepoSlug[] = [];
  /** Repos cloned, in the order they were cloned. */
  readonly clones: RepoSlug[] = [];
  /** What was committed and pushed to the checkout's own branch, in order. */
  readonly pushes: FakePush[] = [];
  /** What was proposed rather than pushed, in order. */
  readonly proposals: FakeProposal[] = [];
  /** The draft pull requests opened for runs, in order. */
  readonly pullRequests: FakePullRequest[] = [];
  /** Branches discarded, in order. */
  readonly discarded: FakeDiscard[] = [];
  /** Every `hasNewComment` check made, in order. */
  readonly commentChecks: { pullRequest: PullRequestUrl; since: Date }[] = [];

  /** What the next `hasNewComment` check finds. A comment posted, unless set. */
  newCommentPosted = true;

  /** What the next proposal comes to. A proposal that lands, unless set. */
  proposal: (branch: string) => Proposal = (branch) => ({
    kind: "proposed",
    branch,
    url: FakeRepoHost.PROPOSED_PULL_REQUEST,
  });

  /** What the next draft pull request comes to. One that opens, unless set. */
  draftPullRequest: () => Promise<DraftPullRequestOpening> = async () => ({
    kind: "opened",
    pullRequest: FakeRepoHost.RUN_PULL_REQUEST,
  });

  /** Marks `repo` as already on the host, as a project predating the manager. */
  alreadyExists(repo: RepoSlug): void {
    this.#existing.add(repo);
  }

  async exists(repo: RepoSlug): Promise<boolean> {
    return this.#existing.has(repo);
  }

  async create(repo: RepoSlug, _description: string): Promise<void> {
    this.created.push(repo);
    this.#existing.add(repo);
  }

  async clone(repo: RepoSlug): Promise<Checkout> {
    this.clones.push(repo);
    return checkout(`${FakeRepoHost.MANAGED_LOCATION}/${repo}`);
  }

  async commitAndPush(
    directory: string,
    message: string,
    paths: string[],
  ): Promise<void> {
    this.pushes.push({ directory, message, paths: [...paths] });
  }

  async commitAndPropose(
    directory: string,
    message: string,
    body: string,
    paths: string[],
    branch: string,
  ): Promise<Proposal> {
    this.proposals.push({
      directory,
      message,
      body,
      paths: [...paths],
      branch,
    });
    return this.proposal(branch);
  }

  async openDraftPullRequest(
    directory: Checkout,
    branch: Branch,
    ticket: Ticket,
  ): Promise<DraftPullRequestOpening> {
    this.pullRequests.push({ directory, branch, ticket });
    return this.draftPullRequest();
  }

  async discardBranch(directory: Checkout, branch: Branch): Promise<void> {
    this.discarded.push({ directory, branch });
  }

  async hasNewComment(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<boolean> {
    this.commentChecks.push({ pullRequest, since });
    return this.newCommentPosted;
  }
}
