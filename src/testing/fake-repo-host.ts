import type {
  ApplyReviewAnswers,
  ApplyReviewThread,
  Branch,
  Checkout,
  ChecksStatus,
  ClosingPullRequest,
  DraftPullRequestOpening,
  MergeStatus,
  Nits,
  OpenPullRequest,
  Proposal,
  PullRequestLabel,
  PullRequestState,
  PullRequestUrl,
  RepoHost,
  RepoSlug,
  ReviewFinding,
  Ticket,
  TicketGist,
  Visibility,
} from "../ports/index.ts";
import {
  APPLIED_REPLY_PREFIX,
  APPLY_REVIEW_MARKER,
  DECLINED_REPLY_PREFIX,
  checkout,
  pullRequestUrl,
  resolveNeedsRebase,
  summarizeApplyReviewThreads,
} from "../ports/index.ts";

/** One push the command made, in the order the fake received it. */
export interface FakePush {
  directory: Checkout;
  message: string;
  /** The paths committed, and nothing else in the checkout. */
  paths: string[];
}

/** One proposal the command made, in the order the fake received it. */
export interface FakeProposal extends FakePush {
  /** What the pull request says about the change. */
  body: string;
  /** The branch the scaffold was committed to, never the developer's own. */
  branch: Branch;
}

/** One draft pull request the loop opened, in the order the fake received it. */
export interface FakePullRequest {
  /** The project checkout the branch was pushed from. */
  directory: Checkout;
  /** The branch the run left its commits on. */
  branch: Branch;
  /** The ticket the pull request is opened against. */
  ticket: Ticket;
  /** The run's ticket gist, when it carried one. */
  gist?: TicketGist;
  /** The nits the run left, when it carried any. */
  nits?: Nits;
}

/** One branch thrown away, and the checkout it was thrown away from. */
export interface FakeDiscard {
  directory: Checkout;
  branch: Branch;
}

/** One {@link ReviewFinding} recorded against a pull request, and when. */
export interface FakeReviewFinding {
  finding: ReviewFinding;
  postedAt: Date;
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
  static readonly PROPOSED_PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/1",
  );
  /** The pull request a run's work waits in, unless a test says otherwise. */
  static readonly RUN_PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/pilot/pull/2",
  );

  readonly #existing = new Set<RepoSlug>();

  /** Repos created, in the order they were created. */
  readonly created: RepoSlug[] = [];
  /** Repos created public, in the order they were created. */
  readonly createdPublic: RepoSlug[] = [];
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
  /** Every `hasReviewFindings` check made, in order. */
  readonly findingChecks: { pullRequest: PullRequestUrl; since: Date }[] = [];
  /** Every `hasPostedReview` check made, in order. */
  readonly reviewChecks: { pullRequest: PullRequestUrl; since: Date }[] = [];

  /** Every pull request `markPullRequestReady` was called on, in order. */
  readonly readyMarked: PullRequestUrl[] = [];

  /** Every pull request `demoteClosingReference` was called on, with the ticket it named, in order. */
  readonly demoted: { pullRequest: PullRequestUrl; ticket: Ticket }[] = [];

  /** Every label added to a pull request, in the order `labelPullRequest` was called. */
  readonly labelled: { pullRequest: PullRequestUrl; label: PullRequestLabel }[] =
    [];

  /** Every comment posted to a pull request, in the order `postComment` was called. */
  readonly comments: { pullRequest: PullRequestUrl; body: string }[] = [];

  readonly #applyReviewThreads = new Map<PullRequestUrl, ApplyReviewThread[]>();
  readonly #reviewFindings = new Map<PullRequestUrl, FakeReviewFinding[]>();
  readonly #cleanReviews = new Map<PullRequestUrl, Date[]>();

  /** What the next proposal comes to. A proposal that lands, unless set. */
  proposal: (branch: Branch) => Proposal = (branch) => ({
    kind: "proposed",
    branch,
    url: FakeRepoHost.PROPOSED_PULL_REQUEST,
  });

  /** What the next draft pull request comes to. One that opens, unless set. */
  draftPullRequest: () => Promise<DraftPullRequestOpening> = async () => ({
    kind: "opened",
    pullRequest: FakeRepoHost.RUN_PULL_REQUEST,
  });

  /** What `readChangedPaths` answers, for any branch. None, unless a test says otherwise. */
  changedPaths: (branch: Branch) => string[] = () => [];

  /**
   * What `needsRebase` and `readMergeStatus` read for a pull request.
   * `needsRebase` calls it once per attempt, so a test can answer `"unknown"`
   * a bounded number of times before it settles; `readMergeStatus` calls it
   * exactly once, with no notion of attempts, so a function scripted to
   * settle after some number of calls will read as still unsettled to
   * `readMergeStatus` if `needsRebase` hasn't already called it that many
   * times. Clean, unless a test says otherwise.
   */
  mergeStatus: (pullRequest: PullRequestUrl) => MergeStatus = () => "clean";

  /** What `readChecksStatus` answers for a pull request. Green, unless a test says otherwise. */
  checksStatus: (pullRequest: PullRequestUrl) => ChecksStatus = () => "green";

  readonly #pullRequestStates = new Map<PullRequestUrl, PullRequestState>();

  /**
   * Sets what `pullRequestState` answers for `pullRequest`. Open, unless a
   * test says otherwise — the same default a pull request just opened would
   * read as.
   */
  setPullRequestState(pullRequest: PullRequestUrl, state: PullRequestState): void {
    this.#pullRequestStates.set(pullRequest, state);
  }

  readonly #openPullRequests = new Map<RepoSlug, OpenPullRequest[]>();

  /**
   * Sets what `listOpenPullRequests` answers for `repo`. None, unless a test
   * says otherwise.
   */
  setOpenPullRequests(repo: RepoSlug, pullRequests: OpenPullRequest[]): void {
    this.#openPullRequests.set(repo, pullRequests);
  }

  /** Marks `repo` as already on the host, as a project predating the manager. */
  alreadyExists(repo: RepoSlug): void {
    this.#existing.add(repo);
  }

  readonly #needsRebaseLabelled = new Set<PullRequestUrl>();

  /**
   * Marks `pullRequest` as carrying `needs-rebase`, as the `/rebase` workflow
   * would. Not carrying it, unless a test says otherwise — the same default a
   * pull request never labelled would read as.
   */
  labelNeedsRebase(pullRequest: PullRequestUrl): void {
    this.#needsRebaseLabelled.add(pullRequest);
  }

  /** Whether `pullRequest` currently carries `needs-rebase`. */
  hasNeedsRebaseLabel(pullRequest: PullRequestUrl): boolean {
    return this.#needsRebaseLabelled.has(pullRequest);
  }

  async exists(repo: RepoSlug): Promise<boolean> {
    return this.#existing.has(repo);
  }

  async create(
    repo: RepoSlug,
    _description: string,
    visibility: Visibility,
  ): Promise<void> {
    this.created.push(repo);
    if (visibility === "public") {
      this.createdPublic.push(repo);
    }
    this.#existing.add(repo);
  }

  async clone(repo: RepoSlug): Promise<Checkout> {
    this.clones.push(repo);
    return checkout(`${FakeRepoHost.MANAGED_LOCATION}/${repo}`);
  }

  async commitAndPush(
    directory: Checkout,
    message: string,
    paths: string[],
  ): Promise<void> {
    this.pushes.push({ directory, message, paths: [...paths] });
  }

  async commitAndPropose(
    directory: Checkout,
    message: string,
    body: string,
    paths: string[],
    branch: Branch,
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

  async readChangedPaths(_directory: Checkout, branch: Branch): Promise<string[]> {
    return this.changedPaths(branch);
  }

  async openDraftPullRequest(
    directory: Checkout,
    branch: Branch,
    ticket: Ticket,
    gist?: TicketGist,
    nits?: Nits,
  ): Promise<DraftPullRequestOpening> {
    this.pullRequests.push({
      directory,
      branch,
      ticket,
      ...(gist !== undefined && { gist }),
      ...(nits !== undefined && { nits }),
    });
    return this.draftPullRequest();
  }

  async discardBranch(directory: Checkout, branch: Branch): Promise<void> {
    this.discarded.push({ directory, branch });
  }

  /**
   * Records `finding` as posted to `pullRequest` at `postedAt`, as a
   * reviewing agent's inline review comment would land — what
   * `hasReviewFindings` answers from.
   */
  postReviewFinding(
    pullRequest: PullRequestUrl,
    finding: ReviewFinding,
    postedAt = new Date(),
  ): void {
    this.#findingsOn(pullRequest).push({ finding, postedAt });
  }

  async hasReviewFindings(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<boolean> {
    this.findingChecks.push({ pullRequest, since });
    return this.#findingsOn(pullRequest).some(
      (recorded) => recorded.postedAt > since,
    );
  }

  /**
   * Records a submitted review with no findings on `pullRequest` at
   * `postedAt`, as a reviewing agent that found nothing to flag would leave
   * one — what `hasPostedReview` answers from once `hasReviewFindings` alone
   * cannot tell it apart from a reviewer that posted nothing at all.
   */
  postCleanReview(pullRequest: PullRequestUrl, postedAt = new Date()): void {
    this.#cleanReviewsOn(pullRequest).push(postedAt);
  }

  async hasPostedReview(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<boolean> {
    this.reviewChecks.push({ pullRequest, since });
    return (
      this.#findingsOn(pullRequest).some((recorded) => recorded.postedAt > since) ||
      this.#cleanReviewsOn(pullRequest).some((postedAt) => postedAt > since)
    );
  }

  #findingsOn(pullRequest: PullRequestUrl): FakeReviewFinding[] {
    let findings = this.#reviewFindings.get(pullRequest);
    if (findings === undefined) {
      findings = [];
      this.#reviewFindings.set(pullRequest, findings);
    }
    return findings;
  }

  #cleanReviewsOn(pullRequest: PullRequestUrl): Date[] {
    let posted = this.#cleanReviews.get(pullRequest);
    if (posted === undefined) {
      posted = [];
      this.#cleanReviews.set(pullRequest, posted);
    }
    return posted;
  }

  /**
   * Opens a new, unanswered apply-review thread on `pullRequest`, returning
   * the index a test answers or comments on it by.
   */
  openApplyReviewThread(pullRequest: PullRequestUrl): number {
    const threads = this.#threadsOn(pullRequest);
    threads.push({ resolved: false, comments: [] });
    return threads.length - 1;
  }

  /**
   * Resolves thread `index` of `pullRequest`, as the skill does to a review
   * thread once it has applied it.
   */
  resolveApplyReviewThread(pullRequest: PullRequestUrl, index: number): void {
    this.#threadAt(pullRequest, index).resolved = true;
  }

  /**
   * Posts the marked reply an apply-review pass leaves on thread `index` of
   * `pullRequest`, deciding it applied or declined.
   */
  answerApplyReviewThread(
    pullRequest: PullRequestUrl,
    index: number,
    verdict: "applied" | "declined",
    detail: string,
    postedAt = new Date(),
  ): void {
    const prefix =
      verdict === "applied" ? APPLIED_REPLY_PREFIX : DECLINED_REPLY_PREFIX;
    this.commentOnApplyReviewThread(
      pullRequest,
      index,
      `${prefix}${detail}\n${APPLY_REVIEW_MARKER}`,
      postedAt,
    );
  }

  /**
   * Posts a plain, unmarked comment on thread `index` of `pullRequest` —
   * what reopens a thread an earlier marked reply had answered.
   */
  commentOnApplyReviewThread(
    pullRequest: PullRequestUrl,
    index: number,
    body: string,
    postedAt = new Date(),
  ): void {
    this.#threadAt(pullRequest, index).comments.push({ body, postedAt });
  }

  #threadAt(pullRequest: PullRequestUrl, index: number): ApplyReviewThread {
    const thread = this.#threadsOn(pullRequest)[index];
    if (thread === undefined) {
      throw new Error(`No apply-review thread ${index} open on ${pullRequest}.`);
    }
    return thread;
  }

  async readApplyReviewAnswers(
    pullRequest: PullRequestUrl,
    since: Date,
  ): Promise<ApplyReviewAnswers> {
    return summarizeApplyReviewThreads(this.#threadsOn(pullRequest), since);
  }

  async markPullRequestReady(pullRequest: PullRequestUrl): Promise<void> {
    this.readyMarked.push(pullRequest);
  }

  async demoteClosingReference(
    pullRequest: PullRequestUrl,
    ticket: Ticket,
  ): Promise<void> {
    this.demoted.push({ pullRequest, ticket });
  }

  async labelPullRequest(
    pullRequest: PullRequestUrl,
    label: PullRequestLabel,
  ): Promise<void> {
    this.labelled.push({ pullRequest, label });
  }

  async postComment(pullRequest: PullRequestUrl, body: string): Promise<void> {
    this.comments.push({ pullRequest, body });
  }

  async needsRebase(pullRequest: PullRequestUrl): Promise<boolean> {
    // No real wait between retries: a fake standing in for the host in
    // application tests should not make those tests slower than the host it
    // stands in for.
    return resolveNeedsRebase(
      pullRequest,
      async () => this.mergeStatus(pullRequest),
      async () => {},
    );
  }

  async readMergeStatus(pullRequest: PullRequestUrl): Promise<MergeStatus> {
    return this.mergeStatus(pullRequest);
  }

  async readChecksStatus(pullRequest: PullRequestUrl): Promise<ChecksStatus> {
    return this.checksStatus(pullRequest);
  }

  async removeNeedsRebaseLabel(pullRequest: PullRequestUrl): Promise<void> {
    this.#needsRebaseLabelled.delete(pullRequest);
  }

  async pullRequestState(pullRequest: PullRequestUrl): Promise<PullRequestState> {
    return this.#pullRequestStates.get(pullRequest) ?? "open";
  }

  async listOpenPullRequests(repo: RepoSlug): Promise<OpenPullRequest[]> {
    return this.#openPullRequests.get(repo) ?? [];
  }

  readonly #closingPullRequests = new Map<RepoSlug, ClosingPullRequest[]>();

  /**
   * Sets what `listPullRequestsClosingIssues` answers for `repo`. None,
   * unless a test says otherwise.
   */
  setPullRequestsClosingIssues(
    repo: RepoSlug,
    pullRequests: ClosingPullRequest[],
  ): void {
    this.#closingPullRequests.set(repo, pullRequests);
  }

  async listPullRequestsClosingIssues(
    repo: RepoSlug,
  ): Promise<ClosingPullRequest[]> {
    return this.#closingPullRequests.get(repo) ?? [];
  }

  /** Every pull request `mergePullRequest` was called on, in order. */
  readonly merged: PullRequestUrl[] = [];

  async mergePullRequest(pullRequest: PullRequestUrl): Promise<void> {
    this.merged.push(pullRequest);
  }

  #threadsOn(pullRequest: PullRequestUrl): ApplyReviewThread[] {
    let threads = this.#applyReviewThreads.get(pullRequest);
    if (threads === undefined) {
      threads = [];
      this.#applyReviewThreads.set(pullRequest, threads);
    }
    return threads;
  }
}
