import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ApplyReviewAnswers,
  ApplyReviewComment,
  ApplyReviewThread,
  Branch,
  Checkout,
  ChecksStatus,
  ClosingIssue,
  ClosingPullRequest,
  DraftPullRequestOpening,
  IssueNumber,
  MergeStatus,
  Milliseconds,
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
  branch,
  checkout,
  CLOSING_PULL_REQUEST_LIMIT,
  closedTicketIn,
  isBranch,
  isIssueNumber,
  isMarkedReply,
  isPullRequestLabel,
  isPullRequestUrl,
  isRepoSlug,
  NEEDS_REBASE_LABEL,
  NIT_SECTION_HEADING,
  OPEN_PULL_REQUEST_LIMIT,
  pullRequestUrl,
  resolveNeedsRebase,
  summarizeApplyReviewThreads,
} from "../ports/index.ts";
import { errorMessage } from "../error-message.ts";
import { withCheckoutLock } from "./checkout-lock.ts";
import { expectField } from "./expect-field.ts";
import { MANAGED_LOCATION } from "./manager-home.ts";

const run = promisify(execFile);

/**
 * GitHub through `gh`, and the checkout through `git`, exactly as the harness
 * inside the sandbox reaches them (docs/agents/issue-tracker.md).
 *
 * Clones land under `location` at `owner/repo`, the same shape the project is
 * named by everywhere else. Derivable rather than remembered, which is what
 * makes a missing clone self-healing, and owner-qualified so that two people's
 * repos of the same name are two directories rather than one.
 *
 * `rebaseRetryWait` is {@link resolveNeedsRebase}'s wait between retries,
 * threaded through for tests that need `needsRebase` to run without a real
 * delay; production callers leave it at the real one.
 */
export function githubRepoHost(
  location: string = MANAGED_LOCATION,
  rebaseRetryWait?: (delay: Milliseconds) => Promise<void>,
): RepoHost {
  return {
    async exists(repo: RepoSlug): Promise<boolean> {
      try {
        await run("gh", ["repo", "view", repo, "--json", "name"]);
        return true;
      } catch (error) {
        if (isUnresolvable(error)) {
          return false;
        }
        throw error;
      }
    },

    async create(
      repo: RepoSlug,
      description: string,
      visibility: Visibility,
    ): Promise<void> {
      const options = description === "" ? [] : ["--description", description];
      await run("gh", ["repo", "create", repo, `--${visibility}`, ...options]);
    },

    async clone(repo: RepoSlug): Promise<Checkout> {
      const directory = checkout(path.join(location, repo));
      await mkdir(path.dirname(directory), { recursive: true });

      // Every step from here reads or writes the checkout, which the sandbox
      // may be branching from or fetching into for another run of this
      // project.
      return withCheckoutLock(directory, async () => {
        const origin = await originOf(directory);
        if (origin === undefined) {
          await run("gh", ["repo", "clone", repo, directory]);
          return directory;
        }

        // A checkout already there is reused, but only once it has proved it
        // is this project. Scaffolding into somebody else's clone would push
        // the harness to their remote and register this project against a
        // codebase that is not it.
        if (!isCloneOf(origin, repo)) {
          throw new Error(
            `${directory} is a checkout of ${origin}, not of ${repo}. Move it aside, or clone ${repo} somewhere else yourself.`,
          );
        }
        await catchUp(directory);
        return directory;
      });
    },

    // `hasChanges` is `git status --porcelain -- <paths>`, which is where the
    // port's "staged, unstaged or untracked" guarantee comes from — except a
    // gitignored untracked file, which `status` never reports.
    async hasUncommittedChanges(
      directory: Checkout,
      paths: readonly string[],
    ): Promise<boolean> {
      return hasChanges(directory, paths);
    },

    async commitAndPush(
      directory: Checkout,
      message: string,
      paths: string[],
    ): Promise<void> {
      if (paths.length === 0) {
        return;
      }

      // Asked before anything is committed: a detached HEAD can be committed
      // to and then not pushed, which would leave the scaffold stranded in a
      // checkout with nowhere to go.
      const branch = await currentBranch(directory);
      if (branch === undefined) {
        throw new Error(
          `${directory} is not on a branch, so the harness has nowhere to land. Check out a branch and run this again.`,
        );
      }

      await run("git", ["-C", directory, "add", "--", ...paths]);

      // Nothing staged means the checkout already had these files as they
      // stand, which is what re-scaffolding an up-to-date project looks like.
      const { stdout } = await run("git", [
        "-C",
        directory,
        "diff",
        "--cached",
        "--name-only",
        "--",
        ...paths,
      ]);
      if (stdout.trim() === "") {
        return;
      }

      // `--only`: a checkout that already existed may have the developer's own
      // staged work in it, and this commit is not the place for it.
      await run("git", [
        "-C",
        directory,
        "commit",
        "--only",
        "--message",
        message,
        "--",
        ...paths,
      ]);

      // Upstream is set only when the branch has none, which is the case for a
      // repo created moments ago. A branch of the developer's that already
      // tracks something keeps tracking it.
      const upstream = (await hasUpstream(directory)) ? [] : ["--set-upstream"];
      await run("git", ["-C", directory, "push", ...upstream, "origin", branch]);
    },

    async commitAndPropose(
      directory: Checkout,
      message: string,
      body: string,
      paths: string[],
      branch: Branch,
    ): Promise<Proposal> {
      if (paths.length === 0 || !(await hasChanges(directory, paths))) {
        return { kind: "unchanged" };
      }

      // Where to put the developer back. Asked before anything moves, because
      // afterwards the checkout is on the branch this command made.
      const found = await currentBranch(directory);

      await switchTo(directory, branch);
      try {
        // Staged first, because a path git has never seen cannot be named to
        // `commit --only`.
        await run("git", ["-C", directory, "add", "--", ...paths]);

        // `--only`: the checkout is the developer's, and work they had in
        // progress there is not this command's to commit.
        await run("git", [
          "-C",
          directory,
          "commit",
          "--only",
          "--message",
          message,
          "--",
          ...paths,
        ]);
        // `--force-with-lease`: a previous call may have already pushed this
        // branch from a base that has since moved, or from before `switchTo`
        // rebuilt it — the remote is a still-open proposal to update, not
        // history to preserve.
        await run("git", [
          "-C",
          directory,
          "push",
          "--force-with-lease",
          "--set-upstream",
          "origin",
          branch,
        ]);
      } finally {
        // Whatever happened, the developer gets their checkout back as they
        // left it. A branch switch carries their own uncommitted work across.
        await returnTo(directory, found);
      }

      let opened: string;
      try {
        const { stdout } = await run(
          "gh",
          [
            "pr",
            "create",
            "--draft",
            "--head",
            branch,
            "--title",
            message,
            "--body",
            body,
          ],
          { cwd: directory },
        );
        opened = stdout;
      } catch (error) {
        // The branch is on the host by now. A repo with pull requests turned
        // off, or a base branch nobody can open against, is a reason to say so
        // rather than to lose the push that already happened.
        return { kind: "pushed", branch, failure: commandFailureMessage(error) };
      }

      const result = pullRequestFrom(opened, "");
      return "url" in result
        ? { kind: "proposed", branch, url: result.url }
        : { kind: "pushed", branch, failure: result.failure };
    },

    async readChangedPaths(directory: Checkout, branch: Branch): Promise<string[]> {
      const base = await currentBranch(directory);
      if (base === undefined) {
        throw new Error(
          `${directory} is not on a branch, so there is no base to diff ${branch} against.`,
        );
      }
      // Three dots, not two: diffed against the merge base rather than the
      // base branch's own tip, so a base that has moved on since the run
      // branched never shows up as part of the run's own diff.
      const { stdout } = await run("git", [
        "-C",
        directory,
        "diff",
        "--name-only",
        `${base}...${branch}`,
      ]);
      return stdout.split("\n").filter((line) => line !== "");
    },

    async openDraftPullRequest(
      directory: Checkout,
      branch: Branch,
      ticket: Ticket,
      gist?: TicketGist,
      nits?: Nits,
    ): Promise<DraftPullRequestOpening> {
      // Only the git steps hold the checkout's lock. Opening the pull request
      // is a conversation with GitHub alone, and waiting on it would hold up
      // every other run of this project for no reason.
      let base: Branch;
      try {
        base = await withCheckoutLock(directory, async () => {
          // What the run branched from: the sandbox clones this checkout at its
          // HEAD, so the branch it is on is the base the commits actually sit
          // on. Asked rather than left to `gh`, which would open against the
          // remote's default branch and put every commit between the two in
          // the diff.
          const onBranch = await currentBranch(directory);
          if (onBranch === undefined) {
            // A detached HEAD has no branch to name, and carrying on without
            // `--base` would hand `gh` the default branch — the very diff the
            // flag is here to avoid. Refused before the push, so a checkout in
            // this state costs nothing on the host.
            throw new Error(
              `${directory} is not on a branch, so there is no base to open a pull request against. Check out a branch and run this again.`,
            );
          }

          // By name, not by checking it out, and without upstream tracking: the
          // branch came back from the sandbox as a ref in this checkout, and the
          // developer's own checkout is never moved or reconfigured to push it.
          try {
            await run("git", ["-C", directory, "push", "origin", branch]);
          } catch (error) {
            // Most likely a branch of this name already on the host from an
            // earlier morning, which a checkout that has since been re-cloned
            // cannot see. Said plainly, because the raw push output does not.
            throw new Error(
              `Could not push ${branch} to ${ticket.repo}: ${commandFailureMessage(error)}`,
            );
          }
          return onBranch;
        });
      } catch (error) {
        // Everything that can fail in here fails before or at the push, so
        // the branch is still only in the checkout.
        return { kind: "unpushed", failure: commandFailureMessage(error) };
      }

      let opened: string;
      try {
        const { stdout } = await run(
          "gh",
          [
            "pr",
            "create",
            // Named rather than inferred: `gh` reads the base repo from the
            // remotes, preferring `upstream`, and only `origin` was ever
            // checked to be this project.
            "--repo",
            ticket.repo,
            "--draft",
            "--head",
            branch,
            "--base",
            base,
            "--title",
            ticket.title,
            "--body",
            pullRequestBody(ticket, gist, nits),
          ],
          { cwd: directory },
        );
        opened = stdout;
      } catch (error) {
        // The commits are on the host either way, so a morning whose pull
        // request could not be opened still produced work the developer can
        // find. The base is named, because a base the host does not have is
        // the likeliest reason `gh` refused, and it is not visible from
        // anything else in this message.
        return {
          kind: "pushed",
          failure: `could not open a pull request against ${base}: ${commandFailureMessage(error)}`,
        };
      }

      const result = pullRequestFrom(opened, ` against ${base}`);
      return "url" in result
        ? { kind: "opened", pullRequest: result.url }
        : { kind: "pushed", failure: result.failure };
    },

    async discardBranch(directory: Checkout, branch: Branch): Promise<void> {
      await withCheckoutLock(directory, async () => {
        // Asked first, because `git branch -D` treats a branch that is not
        // there as an error, and a run whose agent committed nothing never
        // fetched one back — which is the commonest way to arrive here.
        if (!(await hasBranch(directory, branch))) {
          return;
        }
        // `-D` rather than `-d`: the branch was never merged anywhere, which
        // is the whole reason it is being thrown away.
        await run("git", ["-C", directory, "branch", "-D", branch]);
      });
    },

    async hasReviewFindings(
      pullRequest: PullRequestUrl,
      since: Date,
    ): Promise<boolean> {
      // Inline comments — one per finding, on the line it is actually about —
      // not the pull request's own issue-level comments: that is the shape
      // `reviewPromptFor` asks the reviewing agent to post in. `--paginate`,
      // since a long-lived pull request can carry more than one page of
      // comments — without it only the oldest page is ever read.
      const { owner, repo, number } = pullRequestParts(pullRequest);
      const { stdout } = await run("gh", [
        "api",
        `repos/${owner}/${repo}/pulls/${number}/comments`,
        "--paginate",
        "--slurp",
      ]);

      return reviewFindingsIn(stdout, pullRequest).some(
        (finding) => finding.postedAt > since,
      );
    },

    async hasPostedReview(
      pullRequest: PullRequestUrl,
      since: Date,
    ): Promise<boolean> {
      // `--paginate`, for the same reason as `hasReviewFindings`: a long-lived
      // pull request's earlier reviews would otherwise push a later one past
      // the first page and out of sight.
      const { owner, repo, number } = pullRequestParts(pullRequest);
      const { stdout } = await run("gh", [
        "api",
        `repos/${owner}/${repo}/pulls/${number}/reviews`,
        "--paginate",
        "--slurp",
      ]);

      return reviewsPostedIn(stdout, pullRequest).some(
        (postedAt) => postedAt > since,
      );
    },

    async readApplyReviewAnswers(
      pullRequest: PullRequestUrl,
      since: Date,
    ): Promise<ApplyReviewAnswers> {
      const { owner, repo, number } = pullRequestParts(pullRequest);
      const { stdout } = await run("gh", [
        "api",
        "graphql",
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `pr=${number}`,
        "-f",
        `query=${APPLY_REVIEW_ANSWERS_QUERY}`,
      ]);

      return summarizeApplyReviewThreads(
        applyReviewThreadsFrom(parseApplyReviewAnswers(stdout, pullRequest)),
        since,
      );
    },

    async markPullRequestReady(pullRequest: PullRequestUrl): Promise<void> {
      // Asked first, so a pull request already out of draft is left alone by
      // this check rather than by however `gh pr ready` chooses to answer it.
      const { stdout } = await run("gh", [
        "pr",
        "view",
        pullRequest,
        "--json",
        "isDraft",
        "--jq",
        ".isDraft",
      ]);
      if (stdout.trim() !== "true") {
        return;
      }
      await run("gh", ["pr", "ready", pullRequest]);
    },

    async demoteClosingReference(
      pullRequest: PullRequestUrl,
      ticket: Ticket,
    ): Promise<void> {
      // Read back first, so a body already demoted is left alone rather than
      // rewritten on `gh pr edit`'s own say-so.
      const { stdout } = await run("gh", ["pr", "view", pullRequest, "--json", "body"]);
      const where = `gh pr view ${pullRequest}`;
      const payload = jsonIn(stdout, where);
      const body = expectField(objectAt(payload, where).body, "string", "body", where);
      const closing = closingLine(ticket);
      const partOf = partOfLine(ticket);
      if (body.includes(partOf)) {
        return;
      }
      if (!body.includes(closing)) {
        throw new Error(
          `${where}: body carries neither ${JSON.stringify(closing)} nor ${JSON.stringify(partOf)}.`,
        );
      }
      await run("gh", ["pr", "edit", pullRequest, "--body", body.replace(closing, partOf)]);
    },

    async postComment(pullRequest: PullRequestUrl, body: string): Promise<void> {
      await run("gh", ["pr", "comment", pullRequest, "--body", body]);
    },

    async labelPullRequest(
      pullRequest: PullRequestUrl,
      label: PullRequestLabel,
    ): Promise<void> {
      // Named by the pull request's own URL, not the cwd: `clone`'s managed
      // location may hold a different repo, or none, by the time this runs.
      const { owner, repo } = pullRequestParts(pullRequest);
      try {
        await run("gh", ["label", "create", label, "--repo", `${owner}/${repo}`]);
      } catch (error) {
        // Best effort, but only for the one refusal the ticket scoped this
        // to: a label already there is not a reason to fail a call whose
        // real work is the add below. Anything else — an expired token, a
        // network drop — surfaces here rather than as a confusing failure
        // on the add.
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }
      await run("gh", ["pr", "edit", pullRequest, "--add-label", label]);
    },

    async needsRebase(pullRequest: PullRequestUrl): Promise<boolean> {
      return resolveNeedsRebase(
        pullRequest,
        () => mergeStatusOf(pullRequest),
        rebaseRetryWait,
      );
    },

    async readMergeStatus(pullRequest: PullRequestUrl): Promise<MergeStatus> {
      return mergeStatusOf(pullRequest);
    },

    async readChecksStatus(pullRequest: PullRequestUrl): Promise<ChecksStatus> {
      const { stdout } = await run("gh", [
        "pr",
        "view",
        pullRequest,
        "--json",
        "statusCheckRollup",
        "--jq",
        ".statusCheckRollup",
      ]);
      return checksStatusFrom(stdout);
    },

    async removeNeedsRebaseLabel(pullRequest: PullRequestUrl): Promise<void> {
      // Checked first, so a pull request that never carried the label — one
      // opened before the workflow labelled it, or in a project whose
      // workflow predates it — is left alone by this check rather than by
      // however `gh pr edit --remove-label` chooses to answer a label that
      // may not even exist on the repo yet.
      const { stdout } = await run("gh", [
        "pr",
        "view",
        pullRequest,
        "--json",
        "labels",
        "--jq",
        ".labels[].name",
      ]);
      const labels = stdout.split("\n").map((line) => line.trim());
      if (!labels.includes(NEEDS_REBASE_LABEL)) {
        return;
      }
      await run("gh", [
        "pr",
        "edit",
        pullRequest,
        "--remove-label",
        NEEDS_REBASE_LABEL,
      ]);
    },

    async pullRequestState(
      pullRequest: PullRequestUrl,
    ): Promise<PullRequestState> {
      const { stdout } = await run("gh", [
        "pr",
        "view",
        pullRequest,
        "--json",
        "state",
        "--jq",
        ".state",
      ]);
      return pullRequestStateFrom(
        stdout.trim(),
        `gh pr view ${pullRequest}`,
      );
    },

    async listOpenPullRequests(repo: RepoSlug): Promise<OpenPullRequest[]> {
      const { stdout } = await run("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "url,body,labels",
        "--limit",
        String(OPEN_PULL_REQUEST_LIMIT),
      ]);
      return openPullRequestsFrom(stdout, repo);
    },

    async openPullRequestOn(
      repo: RepoSlug,
      branch: Branch,
    ): Promise<OpenPullRequest | undefined> {
      const { stdout } = await run("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--head",
        branch,
        "--json",
        "url,body,labels",
        "--limit",
        "1",
      ]);
      return openPullRequestsFrom(stdout, repo)[0];
    },

    async listPullRequestsClosingIssues(
      repo: RepoSlug,
    ): Promise<ClosingPullRequest[]> {
      const { stdout } = await run("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--json",
        "number,state,headRefName,closingIssuesReferences",
        "--limit",
        String(CLOSING_PULL_REQUEST_LIMIT),
      ]);
      return closingPullRequestsFrom(stdout, repo);
    },

    async mergePullRequest(pullRequest: PullRequestUrl): Promise<void> {
      // Asked first: `gh pr merge --delete-branch` exits 0 on a pull request
      // that is already merged, deleting the branch without ever raising —
      // the one refusal the ticket names that would otherwise slip through
      // silently.
      const { stdout } = await run("gh", [
        "pr",
        "view",
        pullRequest,
        "--json",
        "state",
        "--jq",
        ".state",
      ]);
      if (stdout.trim() === "MERGED") {
        throw new Error(`Could not merge ${pullRequest}: already merged`);
      }
      // `--repo` (from the pull request's own URL, not the cwd, as
      // `labelPullRequest` above) keeps `--delete-branch` off whatever local
      // checkout the process happens to be running in: without it, gh also
      // deletes a same-named local branch, switching off it first if it's
      // checked out.
      const { owner, repo } = pullRequestParts(pullRequest);
      try {
        await run("gh", [
          "pr",
          "merge",
          pullRequest,
          "--merge",
          "--delete-branch",
          "--repo",
          `${owner}/${repo}`,
        ]);
      } catch (error) {
        throw new Error(
          `Could not merge ${pullRequest}: ${commandFailureMessage(error)}`,
        );
      }
    },
  };
}

/**
 * `gh pr list` computes every open pull request's mergeability in one
 * background pass and answers `UNKNOWN` for all of them until it catches up —
 * asked for a project with 14 open pull requests, all 14 came back `UNKNOWN`.
 * Asking `gh pr view` for one pull request gets GitHub's settled answer, or an
 * honest `UNKNOWN` while that pull request's own computation is still
 * running, so this reads one pull request at a time rather than the list.
 *
 * Reads `mergeable` only, not `mergeStateStatus`: this answers #298's
 * question, conflicts, not #293's broader one of whether a branch merely
 * behind its base also counts. A pull request that is `MERGEABLE` but
 * `BEHIND` answers `false` here.
 */
async function mergeStatusOf(pullRequest: PullRequestUrl): Promise<MergeStatus> {
  const { stdout } = await run("gh", [
    "pr",
    "view",
    pullRequest,
    "--json",
    "mergeable",
    "--jq",
    ".mergeable",
  ]);
  switch (stdout.trim()) {
    case "CONFLICTING":
      return "conflicting";
    case "MERGEABLE":
      return "clean";
    default:
      return "unknown";
  }
}

/** One check as GitHub's `statusCheckRollup` reports it: a check run or a legacy status context. */
interface RawCheck {
  status?: string;
  conclusion?: string | null;
  state?: string;
}

/** {@link RawCheck} conclusions and states that read a check as {@link ChecksStatus}'s `"red"`. */
const RED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const RED_STATES = new Set(["ERROR", "FAILURE"]);

/**
 * `stdout`, `.statusCheckRollup`'s own JSON, read down to {@link ChecksStatus}:
 * a check run (`status`/`conclusion`) or a legacy status context (`state`),
 * mixed freely since a pull request may carry either kind. Red beats pending,
 * which beats green, and no checks at all reads green — there is nothing to
 * wait on.
 */
function checksStatusFrom(stdout: string): ChecksStatus {
  const checks = JSON.parse(stdout) as RawCheck[];
  let pending = false;
  for (const check of checks) {
    if (check.state !== undefined) {
      if (RED_STATES.has(check.state)) {
        return "red";
      }
      pending ||= check.state !== "SUCCESS";
      continue;
    }
    if (check.status !== "COMPLETED") {
      pending = true;
      continue;
    }
    if (check.conclusion !== undefined && check.conclusion !== null && RED_CONCLUSIONS.has(check.conclusion)) {
      return "red";
    }
  }
  return pending ? "pending" : "green";
}

/**
 * Every open thread the apply-pr-review skill answers: an unresolved review
 * thread's own comments, a review's non-empty body, and the pull request's
 * own comments — where a review body's reply lands, per the skill.
 */
const APPLY_REVIEW_ANSWERS_QUERY = `
query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){
  reviewThreads(first:100){nodes{isResolved comments(first:50){nodes{body createdAt}}}}
  reviews(first:100){nodes{body submittedAt}}
  comments(first:100){nodes{body createdAt}}
}}}`;

/** One comment as {@link APPLY_REVIEW_ANSWERS_QUERY} asks for it. */
interface RawComment {
  body: string;
  createdAt: string;
}

/** One review thread as {@link APPLY_REVIEW_ANSWERS_QUERY} asks for it. */
interface RawReviewThread {
  isResolved: boolean;
  comments: RawComment[];
}

/** One review as {@link APPLY_REVIEW_ANSWERS_QUERY} asks for it. */
interface RawReview {
  body: string;
  submittedAt: string | null;
}

/** The pull request {@link APPLY_REVIEW_ANSWERS_QUERY} answers with, unwrapped from its connections. */
interface RawApplyReviewPullRequest {
  reviewThreads: RawReviewThread[];
  reviews: RawReview[];
  comments: RawComment[];
}

/**
 * `gh api graphql` with {@link APPLY_REVIEW_ANSWERS_QUERY}:
 * `{ data: { repository: { pullRequest: { reviewThreads, reviews, comments } } } }`,
 * each a `{ nodes }` connection. Checked here, so a `gh` error payload or a
 * schema that drifted says which field went missing.
 */
function parseApplyReviewAnswers(
  stdout: string,
  pullRequest: PullRequestUrl,
): RawApplyReviewPullRequest {
  const where = `gh api graphql for ${pullRequest}`;

  const response = jsonIn(stdout, where);

  const data = objectField(response, "data", where);
  const repository = objectField(data, "repository", where);
  const found = objectField(repository, "pullRequest", where);

  return {
    reviewThreads: nodesField(found, "reviewThreads", where).map(
      (thread, index) => {
        const at = `${where}: review thread ${index + 1}`;
        return {
          isResolved: expectField(
            objectAt(thread, at).isResolved,
            "boolean",
            "isResolved",
            at,
          ),
          comments: nodesField(thread, "comments", at).map((comment, i) =>
            parseComment(comment, `${at}: comment ${i + 1}`),
          ),
        };
      },
    ),
    reviews: nodesField(found, "reviews", where).map((review, index) => {
      const at = `${where}: review ${index + 1}`;
      const { body, submittedAt } = objectAt(review, at);
      return {
        body: expectField(body, "string", "body", at),
        submittedAt:
          submittedAt === null
            ? null
            : expectField(submittedAt, "string", "submittedAt", at),
      };
    }),
    comments: nodesField(found, "comments", where).map((comment, index) =>
      parseComment(comment, `${where}: comment ${index + 1}`),
    ),
  };
}

function parseComment(value: unknown, at: string): RawComment {
  const { body, createdAt } = objectAt(value, at);
  return {
    body: expectField(body, "string", "body", at),
    createdAt: expectField(createdAt, "string", "createdAt", at),
  };
}

function objectAt(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${at}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function objectField(
  value: unknown,
  field: string,
  at: string,
): Record<string, unknown> {
  const inner = objectAt(value, at)[field];
  if (typeof inner !== "object" || inner === null) {
    throw new Error(`${at}: "${field}" must be an object.`);
  }
  return inner as Record<string, unknown>;
}

/** The `nodes` of the `{ nodes }` connection at `field`. */
function nodesField(value: unknown, field: string, at: string): unknown[] {
  const nodes = objectField(value, field, at).nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`${at}: "${field}.nodes" must be an array.`);
  }
  return nodes;
}

function commentsFrom(nodes: RawComment[]): ApplyReviewComment[] {
  return nodes.map((comment) => ({
    body: comment.body,
    postedAt: new Date(comment.createdAt),
  }));
}

/**
 * The threads {@link APPLY_REVIEW_ANSWERS_QUERY} found, in the shape
 * {@link summarizeApplyReviewThreads} reads.
 *
 * A review's own thread has no comments of its own on GitHub — its reply is
 * posted as one of the pull request's comments (`gh pr comment`, per the
 * skill) — so each review body's thread is built from the pull request's
 * comments, taken in posting order, each joining only reviews submitted
 * before it:
 *
 * - A marked reply answers the oldest review still awaiting a reply. With
 *   none awaiting, it joins the newest review, so its verdict still counts.
 *   The skill is free to abridge, reword or reflow the quote a reply opens
 *   with, so nothing here reads that quote: one marked reply answers one
 *   review body, whatever it quotes.
 * - Any other comment joins each review it opens quoting, so a reviewer
 *   quoting a review body to ask again reopens that review's thread.
 */
function applyReviewThreadsFrom(
  pullRequest: RawApplyReviewPullRequest,
): ApplyReviewThread[] {
  const threads: ApplyReviewThread[] = [];

  for (const thread of pullRequest.reviewThreads) {
    threads.push({
      resolved: thread.isResolved,
      comments: commentsFrom(thread.comments),
    });
  }

  const reviews = pullRequest.reviews
    .flatMap((review) => {
      if (review.body.trim() === "" || review.submittedAt === null) {
        return [];
      }
      const submittedAt = new Date(review.submittedAt);
      return [
        {
          body: review.body,
          submittedAt,
          comments: [{ body: review.body, postedAt: submittedAt }],
        },
      ];
    })
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());

  const comments = commentsFrom(pullRequest.comments).sort(
    (a, b) => a.postedAt.getTime() - b.postedAt.getTime(),
  );

  for (const comment of comments) {
    const earlier = reviews.filter(
      (review) => review.submittedAt < comment.postedAt,
    );
    if (isMarkedReply(comment.body)) {
      const answered =
        earlier.find((review) => awaitsReply(review.comments)) ??
        earlier.at(-1);
      answered?.comments.push(comment);
    } else {
      for (const review of earlier) {
        if (opensQuoting(comment.body, review.body)) {
          review.comments.push(comment);
        }
      }
    }
  }

  for (const review of reviews) {
    threads.push({ resolved: false, comments: review.comments });
  }

  return threads;
}

/** Whether a thread's last comment is anything but a marked reply. */
function awaitsReply(comments: ApplyReviewComment[]): boolean {
  const last = comments.at(-1);
  return last === undefined || !isMarkedReply(last.body);
}

/**
 * Whether `comment` opens with a quote of a passage from `review`: how a
 * comment that is not a marked reply names the review body it speaks to. A
 * comment quoting nothing — a status comment, someone chiming in — belongs to
 * no review's thread.
 */
function opensQuoting(comment: string, review: string): boolean {
  const quoted: string[] = [];
  for (const line of comment.split("\n")) {
    if (!line.startsWith(">")) {
      break;
    }
    const text = line.replace(/^>\s?/, "").trim();
    if (text !== "") {
      quoted.push(text);
    }
  }
  return quoted.length > 0 && quoted.every((text) => review.includes(text));
}

/**
 * What `gh pr create`'s stdout came to: the pull request it opened, or the
 * sentence to report when it did not.
 *
 * `gh` answering with something that is not a pull request URL is a
 * different failure from `gh` refusing outright, and reporting it as the
 * second would say a pull request was refused that may well exist. `detail`
 * names what the pull request would have been opened against, for the one
 * caller that has a base to name.
 */
export function pullRequestFrom(
  stdout: string,
  detail: string,
): { url: PullRequestUrl } | { failure: string } {
  const answer = stdout.trim();
  if (isPullRequestUrl(answer)) {
    return { url: answer };
  }
  return {
    failure: `gh answered "${answer}" rather than a pull request URL, so a pull request${detail} may have been opened all the same`,
  };
}

/**
 * What the pull request says. With a gist, it opens with that sentence — what
 * the ticket asked for, in the implementing agent's own words — followed by a
 * blank line and the closing reference and draft note; without one, it is
 * just the closing reference and draft note. With nits, it closes with a
 * blank line and {@link NIT_SECTION_HEADING}, followed by the run's own list
 * — the section `reviewPromptFor` reads back to turn each nit into a review
 * finding of its own.
 *
 * The closing reference is what links the two in GitHub's own UI. It closes
 * nothing by itself — the pull request is a draft, and only a merge acts on
 * it. It stays on its own line either way: a reviewing agent finds the
 * ticket by reading for it.
 */
function pullRequestBody(ticket: Ticket, gist?: TicketGist, nits?: Nits): string {
  const body = [
    closingLine(ticket),
    "",
    "Implemented by the morning loop, in a sandbox, from the ticket above.",
    "It opens as a draft; the manager marks it ready once an apply-review pass on it finishes. Merging it is yours, unless its ticket is turboable, when the manager may merge it itself.",
  ].join("\n");
  const withGist = gist === undefined ? body : [gist, "", body].join("\n");
  return nits === undefined
    ? withGist
    : [withGist, "", NIT_SECTION_HEADING, nits].join("\n");
}

/** The line {@link pullRequestBody} opens with, naming `ticket` as what the pull request closes. */
function closingLine(ticket: Ticket): string {
  return `Closes #${ticket.number}.`;
}

/**
 * What {@link closingLine} is rewritten to by {@link
 * RepoHost.demoteClosingReference}: none of GitHub's nine closing keywords,
 * so merging the pull request leaves `ticket` open.
 */
function partOfLine(ticket: Ticket): string {
  return `Part of #${ticket.number}.`;
}

/** Whether `directory` has a local branch named `of`. */
async function hasBranch(directory: Checkout, of: Branch): Promise<boolean> {
  try {
    await run("git", [
      "-C",
      directory,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${of}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Whether any of `paths` differs from what the checkout has committed. */
async function hasChanges(
  directory: Checkout,
  paths: readonly string[],
): Promise<boolean> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "status",
    "--porcelain",
    "--",
    ...paths,
  ]);
  return stdout.trim() !== "";
}

/**
 * Puts the checkout on `branch`, rebuilding it from the current `HEAD` rather
 * than reusing whatever a previous run left it pointing at.
 *
 * Re-running the command while a proposal is still open updates that
 * proposal rather than failing, which is what makes re-scaffolding after a
 * convention changes the same command as scaffolding the first time. `-B`
 * resets an existing local `branch` in place instead of failing the way `-b`
 * does, and never touches the working tree — the checkout was already on the
 * commit `branch` is being pointed at — so it succeeds regardless of
 * uncommitted changes sitting on top of it.
 */
async function switchTo(directory: Checkout, branch: Branch): Promise<void> {
  await run("git", ["-C", directory, "checkout", "-B", branch]);
}

/**
 * Returns the checkout to where it was found.
 *
 * `checkout` covers a branch with commits on it and, as `-`, a detached HEAD.
 * It cannot reach a branch that has none — an empty repo, whose HEAD points at
 * a branch that does not exist yet — so HEAD is pointed back by hand rather
 * than leaving the developer standing on the branch this command made.
 */
async function returnTo(
  directory: Checkout,
  branch: Branch | undefined,
): Promise<void> {
  try {
    await run("git", ["-C", directory, "checkout", branch ?? "-"]);
  } catch (error) {
    if (branch === undefined) {
      throw error;
    }
    await run("git", [
      "-C",
      directory,
      "symbolic-ref",
      "HEAD",
      `refs/heads/${branch}`,
    ]);
  }
}

/**
 * What `gh` or `git` said, preferring its stderr over the exit-code message
 * `errorMessage` alone would give: `execFile` throws an error whose `message`
 * is its own "Command failed" summary, and the useful sentence is what the
 * process wrote to its error stream instead.
 */
function commandFailureMessage(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr).trim()
      : "";
  return stderr !== "" ? stderr : errorMessage(error);
}

/**
 * The origin of the checkout whose root is exactly `directory`, or undefined
 * if there is no checkout there.
 *
 * The root has to match, because git answers questions about the nearest
 * enclosing repository: a plain directory inside one would otherwise look like
 * a checkout, and be committed and pushed into its parent.
 */
async function originOf(directory: string): Promise<string | undefined> {
  let toplevel: string;
  try {
    const { stdout } = await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--show-toplevel",
    ]);
    toplevel = stdout.trim();
  } catch {
    return undefined;
  }

  if (!(await isSamePath(toplevel, directory))) {
    return undefined;
  }

  try {
    const { stdout } = await run("git", [
      "-C",
      directory,
      "remote",
      "get-url",
      "origin",
    ]);
    return stdout.trim();
  } catch {
    // A checkout with no origin is not this project's, whatever else it is.
    return "";
  }
}

async function isSamePath(one: string, other: string): Promise<boolean> {
  try {
    return (await realpath(one)) === (await realpath(other));
  } catch {
    return false;
  }
}

/**
 * Whether a remote URL names `repo`. Compares the `owner/repo` the URL ends
 * with, so the same project over HTTPS, SSH and the `git@` shorthand is the
 * same project.
 */
function isCloneOf(url: string, repo: RepoSlug): boolean {
  const segments = url
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter((segment) => segment !== "");

  return segments.slice(-2).join("/").toLowerCase() === repo.toLowerCase();
}

/**
 * `stdout` parsed as JSON, naming `where` when it isn't valid JSON at all: a
 * malformed response is a `gh` failure, not a repo host with nothing to say.
 * Shared by every caller that reads a `gh` invocation's stdout down to a
 * typed shape of its own.
 */
function jsonIn(stdout: string, where: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${where}: did not return JSON: ${errorMessage(error)}`);
  }
}

/**
 * The raw items across every page `stdout` — a `gh api --paginate --slurp`
 * call — carries: one JSON array per page, wrapped by `--slurp` into an outer
 * array, flattened here into the one list a caller reads. Throws naming
 * `where` when `stdout` isn't that shape at all: a malformed response is a
 * `gh` failure, not a repo host with zero items.
 */
function paginatedArrayIn(stdout: string, where: string): unknown[] {
  const payload = jsonIn(stdout, where);
  if (!Array.isArray(payload) || !payload.every(Array.isArray)) {
    throw new Error(`${where}: expected paginated arrays.`);
  }
  return payload.flat();
}

/**
 * The {@link ReviewFinding}s `stdout` — every page of `gh api
 * pulls/.../comments` — carries, each beside when it was posted. Read against
 * the declared shape and no other: a raw comment missing `path`, `line` or
 * `body` is not a finding in that shape, and is left out rather than counted,
 * which is what keeps this from also counting the aggregated report the
 * reviewer was told never to post as one comment.
 */
function reviewFindingsIn(
  stdout: string,
  pullRequest: PullRequestUrl,
): { finding: ReviewFinding; postedAt: Date }[] {
  const where = `gh api pulls comments for ${pullRequest}`;

  const findings: { finding: ReviewFinding; postedAt: Date }[] = [];
  for (const raw of paginatedArrayIn(stdout, where)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const { path, line, body, created_at } = raw as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      typeof line !== "number" ||
      typeof body !== "string" ||
      typeof created_at !== "string"
    ) {
      continue;
    }
    findings.push({ finding: { path, line, body }, postedAt: new Date(created_at) });
  }
  return findings;
}

/**
 * When each submitted review across every page of `stdout` — `gh api
 * pulls/.../reviews` — landed. A pending review, never submitted, carries no
 * `submitted_at` and is left out: it is not on the pull request for anyone to
 * read. A `DISMISSED` review is left out too: dismissing it is GitHub's own
 * way of saying it no longer stands. This still can't tell the agent's own
 * review apart from one a human or another bot submits on the same pull
 * request while the run is going — every review here posts under the same
 * credential the agent runs on — so a third party's review submitted mid-run
 * can still read as this run's own.
 */
function reviewsPostedIn(stdout: string, pullRequest: PullRequestUrl): Date[] {
  const where = `gh api pulls reviews for ${pullRequest}`;

  const postedAt: Date[] = [];
  for (const raw of paginatedArrayIn(stdout, where)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const { submitted_at, state } = raw as Record<string, unknown>;
    if (typeof submitted_at !== "string" || state === "DISMISSED") {
      continue;
    }
    postedAt.push(new Date(submitted_at));
  }
  return postedAt;
}

/**
 * The {@link OpenPullRequest}s `stdout` — `gh pr list --json url,body,labels`
 * — carries for `repo`. Read against the declared shape: a malformed entry
 * throws naming which one and why, rather than silently reporting fewer open
 * pull requests than the repo actually has.
 */
function openPullRequestsFrom(
  stdout: string,
  repo: RepoSlug,
): OpenPullRequest[] {
  const where = `gh pr list for ${repo}`;

  const payload = jsonIn(stdout, where);
  if (!Array.isArray(payload)) {
    throw new Error(`${where}: expected an array.`);
  }

  return payload.map((raw, index) => {
    const at = `${where}: pull request ${index + 1}`;
    const { url, body, labels } = objectAt(raw, at);
    const closes = closedTicketIn(expectField(body, "string", "body", at));
    const pullRequest: OpenPullRequest = {
      url: pullRequestUrl(expectField(url, "string", "url", at)),
      labels: labelsIn(labels, at),
    };
    return closes === undefined ? pullRequest : { ...pullRequest, closes };
  });
}

/**
 * `state`, as `gh pr view`'s or `gh pr list`'s own `state` field answers it:
 * `OPEN`, `MERGED` or `CLOSED`. Shared by `pullRequestState` and
 * `closingPullRequestsFrom`, the two readers of a pull request's state, so a
 * value neither reader recognises is refused the same way by both.
 */
function pullRequestStateFrom(state: string, where: string): PullRequestState {
  switch (state) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      throw new Error(
        `${where}: "state" was none of OPEN, MERGED or CLOSED: ${JSON.stringify(state)}`,
      );
  }
}

/**
 * `gh pr list --state all --json number,state,headRefName,closingIssuesReferences`:
 * a JSON array of `{ number, state, headRefName, closingIssuesReferences }`,
 * one entry per pull request of `repo`, any state. What a spec review sweep
 * reads a supertask's closed sub-issues' pull requests with — see {@link
 * ClosingPullRequest}.
 */
function closingPullRequestsFrom(
  stdout: string,
  repo: RepoSlug,
): ClosingPullRequest[] {
  const where = `gh pr list --state all for ${repo}`;

  const payload = jsonIn(stdout, where);
  if (!Array.isArray(payload)) {
    throw new Error(`${where}: expected an array.`);
  }

  return payload.map((raw, index) => {
    const at = `${where}: pull request ${index + 1}`;
    const { number, state, headRefName, closingIssuesReferences } = objectAt(
      raw,
      at,
    );
    return {
      number: closingIssueNumber(number, "number", at),
      state: pullRequestStateFrom(
        expectField(state, "string", "state", at),
        at,
      ),
      branch: closingBranch(
        expectField(headRefName, "string", "headRefName", at),
        at,
      ),
      closesIssues: closingIssuesIn(closingIssuesReferences, at),
    };
  });
}

/** `value`, as the issue number `field` names it at `at`: a positive integer. */
function closingIssueNumber(
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

/** `value`, as the branch name git would accept, or thrown naming the offending value. */
function closingBranch(value: string, at: string): Branch {
  if (!isBranch(value)) {
    throw new Error(`${at}: "headRefName" is not a branch name git would accept: ${value}`);
  }
  return branch(value);
}

/**
 * `closingIssuesReferences` as `gh pr list` answers it: an array of issue
 * objects, each kept as its own repo and number — a pull request can close an
 * issue in another repo, and `repository` is how GitHub names which one on
 * every entry here, unlike `number` alone.
 */
function closingIssuesIn(value: unknown, at: string): ClosingIssue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${at}: "closingIssuesReferences" must be an array.`);
  }
  return value.map((entry) => {
    const issue = objectAt(entry, at);
    return {
      repo: closingIssueRepo(issue, at),
      number: closingIssueNumber(issue.number, "closingIssuesReferences.number", at),
    };
  });
}

/**
 * The repo `closingIssuesReferences` names a closing issue with: `owner/repo`,
 * built from its own `repository: { name, owner: { login } }` — the shape
 * `gh pr list` answers with, distinct from `repository_url`'s URL shape
 * `gh-issue-tracker.ts` parses.
 */
function closingIssueRepo(issue: Record<string, unknown>, at: string): RepoSlug {
  const repository = objectField(issue, "repository", at);
  const owner = objectField(repository, "owner", at);
  const login = expectField(owner.login, "string", "owner.login", at);
  const name = expectField(repository.name, "string", "repository.name", at);
  const slug = `${login}/${name}`;
  if (!isRepoSlug(slug)) {
    throw new Error(
      `${at}: "repository" did not name a repo slug: ${JSON.stringify(slug)}`,
    );
  }
  return slug;
}

/**
 * The label names `gh pr list`'s own `labels` field carries, filtered to
 * those shaped like a {@link PullRequestLabel} — GitHub's label rules are
 * looser than the ones this repo's own labelling verbs enforce, and a name
 * this repo could never itself apply is left out rather than reported.
 *
 * A missing or non-string `name` is not that: it is `gh` answering outside
 * its declared shape, so it throws the way the rest of a malformed entry does
 * (see {@link openPullRequestsFrom}), rather than being silently filtered out
 * alongside a genuine label this repo just can't apply.
 */
function labelsIn(value: unknown, at: string): PullRequestLabel[] {
  if (!Array.isArray(value)) {
    throw new Error(`${at}: "labels" must be an array.`);
  }
  return value.flatMap((label) => {
    const name = expectField(
      objectAt(label, at).name,
      "string",
      "labels.name",
      at,
    );
    return isPullRequestLabel(name) ? [name] : [];
  });
}

/** The owner, repo and number a pull request's own URL names. */
function pullRequestParts(
  url: PullRequestUrl,
): { owner: string; repo: string; number: string } {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  const [, owner, repo, number] = match ?? [];
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(`${url} does not look like a GitHub pull request URL.`);
  }
  return { owner, repo, number };
}

/**
 * Fast-forwards the branch the checkout is on to what its remote has.
 *
 * A reused clone is otherwise frozen at whenever it was made: the sandbox
 * clones it at its HEAD, so every run would start from that day's code and
 * open a pull request that fights everything merged since.
 *
 * Fast-forward only. A branch with commits its remote lacks, or uncommitted
 * work the incoming changes would overwrite, is refused rather than rebased,
 * merged or reset — none of those are this adapter's to decide, and running on
 * the stale code instead is the failure this exists to stop. Uncommitted work
 * the update does not touch is carried across. A branch with no upstream (a
 * detached HEAD, an empty repo) has nothing to catch up to and is left alone.
 */
async function catchUp(directory: Checkout): Promise<void> {
  try {
    await run("git", ["-C", directory, "fetch", "--quiet", "origin"]);
    if (!(await hasUpstream(directory))) {
      return;
    }
    await run("git", [
      "-C",
      directory,
      "merge",
      "--ff-only",
      "--quiet",
      "@{upstream}",
    ]);
  } catch (error) {
    throw new Error(
      `${directory} cannot be brought up to date with its remote: ${commandFailureMessage(error)}. Bring it level with its upstream by hand, then run this again.`,
    );
  }
}

/** The branch the checkout is on, or undefined on a detached HEAD. */
async function currentBranch(
  directory: Checkout,
): Promise<Branch | undefined> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "branch",
    "--show-current",
  ]);
  const name = stdout.trim();
  if (name === "") {
    return undefined;
  }
  if (!isBranch(name)) {
    throw new TypeError(
      `git answered a branch name this adapter cannot use: ${name}`,
    );
  }
  return name;
}

async function hasUpstream(directory: Checkout): Promise<boolean> {
  try {
    await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `gh` failed because it could not resolve the repository.
 *
 * GitHub answers a repo that is not there and a private repo the credential
 * cannot see with the same message, deliberately, so this cannot tell them
 * apart. Callers say both in the one sentence rather than asserting the first.
 */
function isUnresolvable(error: unknown): boolean {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
  return /could not resolve to a repository|HTTP 404/i.test(stderr);
}

/** Whether `gh label create` failed because the label is already there. */
function isAlreadyExists(error: unknown): boolean {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
  return /already exists/i.test(stderr);
}
