import { errorMessage } from "./error-message.ts";
import type {
  ClosingPullRequest,
  IssueTracker,
  OpenIssue,
  OpenIssues,
  RepoHost,
  RepoSlug,
  SubIssue,
  Ticket,
} from "./ports/index.ts";
import { isSupertask } from "./ports/index.ts";

/** The two ports one sweep reads and writes through, narrowed to what it calls. */
export interface SpecReviewSweepPorts {
  tracker: Pick<IssueTracker, "listSubIssues" | "createSpecReviewTicket">;
  repoHost: Pick<RepoHost, "listPullRequestsClosingIssues">;
}

/** One supertask a sweep could not open a spec review for, and why. */
export interface SpecReviewSweepRefusal {
  supertask: Ticket;
  error: string;
}

/**
 * What sweeping one project came to: every spec review it opened, and every
 * refusal it met along the way. A supertask that still has an open sub-issue,
 * or that already carries one — the guard, per `CONTEXT.md`'s "Spec review
 * sweep" — appears in neither list, since neither is something to report.
 */
export interface SpecReviewSweepOutcome {
  repo: RepoSlug;
  opened: Ticket[];
  refusals: SpecReviewSweepRefusal[];
}

/**
 * A spec review sweep of one project (`CONTEXT.md`'s "Spec review sweep",
 * issue #516): every supertask `openIssues` lists is asked, cheaply and from
 * `openIssues` alone, whether it still has an open sub-issue — a supertask
 * that does is left alone, no read spent on it. One that does not is asked,
 * through {@link IssueTracker.listSubIssues}, for every sub-issue it has ever
 * had, open or closed: a supertask that has never had one is left alone too
 * — there is nothing yet for a review to be about — and one that already
 * carries a spec review among them, open or closed, is the guard firing: at
 * most once per supertask, ever, since a live count of open sub-issues alone
 * would fire again the very next morning the spec review it opened closed.
 *
 * A supertask that clears both checks gets its spec review: its body names
 * every sub-issue `listSubIssues` found, and — read once here, at exactly
 * this instant, through {@link RepoHost.listPullRequestsClosingIssues} — the
 * branch and state of whichever of them has a pull request still unmerged.
 *
 * Nested supertasks need nothing special: each is itself just another ticket
 * `openIssues` lists carrying the supertask label, asked and guarded the same
 * way, and a nested one still open still counts as an open sub-issue of
 * whatever it is nested under — so the outer supertask's own spec review
 * waits until the inner one, review included, is closed by hand.
 *
 * Best effort per supertask: a refused read or write is recorded in the
 * outcome and the sweep carries on to the next supertask, never throwing.
 */
export async function specReviewSweep(
  ports: SpecReviewSweepPorts,
  repo: RepoSlug,
  openIssues: OpenIssues,
): Promise<SpecReviewSweepOutcome> {
  const opened: Ticket[] = [];
  const refusals: SpecReviewSweepRefusal[] = [];
  // Read at most once per sweep, lazily: a sweep that opens nothing still
  // spends nothing, and every supertask that does need it this scan shares
  // the one `gh pr list`, per `CONTEXT.md`'s "Spec review sweep".
  let closingPullRequests: Promise<readonly ClosingPullRequest[]> | undefined;

  for (const { ticket: supertask } of openIssues.issues) {
    if (!isSupertask(supertask) || hasOpenSubIssue(supertask, openIssues.issues)) {
      continue;
    }

    try {
      // `openIssues` alone is only the cheap pre-filter above: a truncated
      // backlog or a sub-issue in another repo can leave it blind to one
      // still open, so `subIssues` — authoritative, per `CONTEXT.md`'s "Spec
      // review sweep" — is asked again before the guard trusts it.
      const subIssues = await ports.tracker.listSubIssues(supertask);
      if (
        subIssues.length === 0 ||
        subIssues.some(alreadySpecReviewed) ||
        subIssues.some((sub) => !sub.closed)
      ) {
        continue;
      }

      closingPullRequests ??= ports.repoHost.listPullRequestsClosingIssues(repo);
      const specReview = await ports.tracker.createSpecReviewTicket(
        supertask,
        specReviewBody(supertask, subIssues, await closingPullRequests),
      );
      opened.push(specReview);
    } catch (error) {
      refusals.push({ supertask, error: errorMessage(error) });
    }
  }

  return { repo, opened, refusals };
}

/**
 * Whether `ticket` has an open sub-issue among `issues` — of any kind,
 * unlike `selection.ts`'s own `hasNonPullRequestSubIssue`: a review, an
 * apply-review or a rebase ticket still open counts here exactly as an
 * implementation ticket would, per `CONTEXT.md`'s "Spec review sweep" — a
 * spec review is not pull-request-bound, so it counts toward its
 * supertask's sub-issues like any other.
 */
function hasOpenSubIssue(ticket: Ticket, issues: readonly OpenIssue[]): boolean {
  return issues.some((issue) => issue.parent === ticket.number);
}

/** Whether `sub` is a spec review already opened for its supertask — the guard itself. */
function alreadySpecReviewed(sub: SubIssue): boolean {
  return sub.ticket.specReview === true;
}

/**
 * The body a spec review is opened with: names `supertask`, then every one
 * of `subIssues` — all of them closed, or `specReviewSweep` would never have
 * reached here — and, for each whose pull request `closingPullRequests`
 * names as not merged, that pull request's own number, branch and state.
 * Silent about the rest, per `CONTEXT.md`'s "Spec review sweep": a sub-issue
 * closed with its pull request merged, or with none at all, reads as intent
 * rather than as a gap.
 */
function specReviewBody(
  supertask: Ticket,
  subIssues: readonly SubIssue[],
  closingPullRequests: readonly ClosingPullRequest[],
): string {
  return [
    `Reviews #${supertask.number}, now that every sub-issue has closed.`,
    "",
    "Sub-issues:",
    "Each pull request fact below was read once, from the repo host, the moment this ticket opened; a sub-issue named with none either merged or never had a pull request.",
    ...subIssues.map((sub) => subIssueLine(sub, closingPullRequests)),
  ].join("\n");
}

/** One `- #N` bullet `specReviewBody` names a sub-issue with, per its unmerged pull request if it has one. */
function subIssueLine(
  sub: SubIssue,
  closingPullRequests: readonly ClosingPullRequest[],
): string {
  const pullRequest = closingPullRequests.find((candidate) =>
    candidate.closesIssues.includes(sub.ticket.number),
  );
  if (pullRequest === undefined || pullRequest.state === "merged") {
    return `- #${sub.ticket.number}`;
  }
  return `- #${sub.ticket.number}: pull request #${pullRequest.number} on branch \`${pullRequest.branch}\`, ${pullRequest.state}`;
}
