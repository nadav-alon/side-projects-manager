import { errorMessage } from "./error-message.ts";
import type {
  MergeStatus,
  OpenIssues,
  PullRequestUrl,
  RepoHost,
  RepoSlug,
} from "./ports/index.ts";
import { NEEDS_REBASE_LABEL, pullRequestLabel } from "./ports/index.ts";

const NEEDS_REBASE = pullRequestLabel(NEEDS_REBASE_LABEL);

/**
 * The one thing each candidate pull request of a sweep does: reading its
 * mergeability, taking the label off, adding it, or posting `/rebase` —
 * `read`, `unlabel`, `label` and `comment` name the same four
 * {@link RepoHost} verbs the sweep calls, and `list` names
 * {@link RepoHost.listOpenPullRequests} itself, whose refusal ends the
 * project's sweep rather than being recorded per pull request. Per
 * `CONTEXT.md`'s "Conflict sweep".
 */
export type ConflictSweepAction = "list" | "read" | "label" | "unlabel" | "comment";

/**
 * One refusal a sweep met: which {@link ConflictSweepAction} it was trying,
 * and the error the repo host gave. `pullRequest` is absent only for a
 * refused `"list"`, which names no pull request to refuse on — the listing
 * itself is what was refused.
 */
export interface ConflictSweepRefusal {
  action: ConflictSweepAction;
  error: string;
  pullRequest?: PullRequestUrl;
}

/** One change a sweep made to a pull request. */
export interface ConflictSweepChange {
  pullRequest: PullRequestUrl;
  action: "labelled" | "unlabelled" | "commented";
}

/**
 * What sweeping one project came to: every pull request it changed, and
 * every refusal it met along the way. A pull request left untouched —
 * naming no closed ticket, still `"unknown"`, or already in the shape the
 * sweep would have put it — appears in neither list.
 */
export interface ConflictSweepOutcome {
  repo: RepoSlug;
  changes: ConflictSweepChange[];
  refusals: ConflictSweepRefusal[];
}

/**
 * A conflict sweep of one project (`CONTEXT.md`'s "Conflict sweep", ADR
 * 0007): every open pull request whose body names the ticket it closes is
 * asked once, through {@link RepoHost.readMergeStatus}, whether it conflicts
 * with its base branch — never retried, unlike a rebase ticket's own
 * {@link RepoHost.needsRebase}. A pull request naming no closed ticket is
 * never read, labelled or commented on.
 *
 * A conflicting pull request is labelled {@link NEEDS_REBASE_LABEL} unless it
 * already carries it. An `"unknown"` one is left exactly as it is, for the
 * next sweep.
 *
 * Best effort throughout: a refused read or label is recorded in the outcome
 * and the sweep carries on with the next pull request, never throwing. A
 * refused listing is the one exception — with no list, there is nothing left
 * to sweep — and ends the project's sweep on the spot.
 */
export async function conflictSweep(
  repoHost: RepoHost,
  repo: RepoSlug,
  turbo: boolean,
  openIssues: OpenIssues,
): Promise<ConflictSweepOutcome> {
  const changes: ConflictSweepChange[] = [];
  const refusals: ConflictSweepRefusal[] = [];

  let pullRequests;
  try {
    pullRequests = await repoHost.listOpenPullRequests(repo);
  } catch (error) {
    refusals.push({ action: "list", error: errorMessage(error) });
    return { repo, changes, refusals };
  }

  for (const pullRequest of pullRequests) {
    if (pullRequest.closes === undefined) {
      continue;
    }

    let status: MergeStatus;
    try {
      status = await repoHost.readMergeStatus(pullRequest.url);
    } catch (error) {
      refusals.push({
        action: "read",
        pullRequest: pullRequest.url,
        error: errorMessage(error),
      });
      continue;
    }

    if (status === "unknown") {
      continue;
    }

    const labelled = pullRequest.labels.includes(NEEDS_REBASE);

    if (status === "conflicting" && !labelled) {
      try {
        await repoHost.labelPullRequest(pullRequest.url, NEEDS_REBASE);
        changes.push({ pullRequest: pullRequest.url, action: "labelled" });
      } catch (error) {
        refusals.push({
          action: "label",
          pullRequest: pullRequest.url,
          error: errorMessage(error),
        });
      }
    }
  }

  return { repo, changes, refusals };
}
