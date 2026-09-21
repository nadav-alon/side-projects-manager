import { errorMessage } from "./error-message.ts";
import type {
  MergeStatus,
  OpenIssues,
  PullRequestUrl,
  RepoHost,
  RepoSlug,
} from "./ports/index.ts";
import { NEEDS_REBASE, openRebaseTicketFor, REBASE_COMMENT } from "./ports/index.ts";

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
 * and the error the repo host gave. `pullRequest` names none only for a
 * refused `"list"`, which names no pull request to refuse on — the listing
 * itself is what was refused.
 */
export type ConflictSweepRefusal =
  | { action: "list"; error: string }
  | {
      action: Exclude<ConflictSweepAction, "list">;
      pullRequest: PullRequestUrl;
      error: string;
    };

/** One change a sweep made to a pull request. */
export interface ConflictSweepChange {
  pullRequest: PullRequestUrl;
  action: "labelled" | "unlabelled" | "commented";
}

/**
 * The past participle {@link ConflictSweepChange} names its action by, for
 * each {@link ConflictSweepAction} that ever succeeds into a change —
 * `"list"` and `"read"` never do. `satisfies` ties the two vocabularies
 * together, the way `REVIEW_FINDING_FIELDS` ties a field list to
 * `ReviewFinding`'s own names in `repo-host.ts`: renaming one here and not
 * there fails to compile, rather than drifting unnoticed.
 */
const CHANGED = {
  unlabel: "unlabelled",
  label: "labelled",
  comment: "commented",
} as const satisfies Record<
  Exclude<ConflictSweepAction, "list" | "read">,
  ConflictSweepChange["action"]
>;

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
 * A conflicting pull request is labelled {@link NEEDS_REBASE} unless it
 * already carries it. A clean one has the label taken off if it carries it,
 * whether or not a rebase ticket is still open for it — the label means not
 * mergeable now, and a ticket still open finds nothing to rebase and closes
 * itself. An `"unknown"` one is left exactly as it is, for the next sweep.
 *
 * In a turbo project, a conflicting pull request also gets {@link
 * REBASE_COMMENT} posted on it — even when labelling it was refused — unless
 * `openIssues` already holds an open rebase ticket bound to its url, whatever
 * that ticket's own labels: a rebase ticket handed back to the developer
 * still stops the sweep asking again. Every conflicting pull request gets
 * its own: there is no cap. A project that is not turbo never posts.
 *
 * Best effort throughout: a refused read, label, unlabel or comment is
 * recorded in the outcome and the sweep carries on with the next pull
 * request, never throwing. A refused listing is the one exception — with no
 * list, there is nothing left to sweep — and ends the project's sweep on the
 * spot.
 */
export async function conflictSweep(
  repoHost: RepoHost,
  repo: RepoSlug,
  turbo: boolean,
  openIssues: OpenIssues,
): Promise<ConflictSweepOutcome> {
  const changes: ConflictSweepChange[] = [];
  const refusals: ConflictSweepRefusal[] = [];

  /**
   * Runs `run`, recording a change on `pullRequest` under `CHANGED[action]`
   * if it succeeds and a refusal under `action` if it throws — the one shape
   * shared by every best-effort write below, so the pairing between a change
   * and its refusal can't drift between them.
   */
  async function attempt(
    action: keyof typeof CHANGED,
    pullRequest: PullRequestUrl,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
      changes.push({ pullRequest, action: CHANGED[action] });
    } catch (error) {
      refusals.push({ action, pullRequest, error: errorMessage(error) });
    }
  }

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

    if (status === "clean") {
      if (labelled) {
        await attempt("unlabel", pullRequest.url, () =>
          repoHost.removeNeedsRebaseLabel(pullRequest.url),
        );
      }
      continue;
    }

    if (!labelled) {
      await attempt("label", pullRequest.url, () =>
        repoHost.labelPullRequest(pullRequest.url, NEEDS_REBASE),
      );
    }

    if (turbo && !openRebaseTicketFor(openIssues, pullRequest.url)) {
      await attempt("comment", pullRequest.url, () =>
        repoHost.postComment(pullRequest.url, REBASE_COMMENT),
      );
    }
  }

  return { repo, changes, refusals };
}
