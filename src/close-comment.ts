import type { Rebased } from "./iteration-outcome.ts";
import type { PullRequestResolution, PullRequestUrl } from "./ports/index.ts";
import { NEEDS_REBASE_LABEL } from "./ports/index.ts";

/**
 * What a pull request ticket is told when its own pull request is already
 * merged or closed by the time the loop looks: there is nothing left to
 * review, apply a review to, or rebase, so no run was started. Closed rather
 * than handed back, so the comment says that too, instead of pointing at
 * ready-for-agent the way a hand-back comment does for a ticket left
 * eligible.
 */
export function pullRequestResolvedComment(
  pullRequest: PullRequestUrl,
  resolution: PullRequestResolution,
): string {
  return [
    `The morning loop did not run this ticket: ${pullRequest} has already been ${pullRequestResolutionPhrase(resolution)}, so there is nothing left to do.`,
    `This ticket is closed rather than handed back: it will not come round again.`,
  ].join("\n\n");
}

/**
 * How a pull request resolution reads in a sentence: "merged" or "closed
 * without merging". Shared with `summary.ts`'s own line for the same fact,
 * so the two read the same way and can only drift on purpose.
 */
export function pullRequestResolutionPhrase(
  resolution: PullRequestResolution,
): string {
  return resolution === "merged" ? "merged" : "closed without merging";
}

/**
 * What an apply-review ticket is told as it closes: how many threads the run
 * applied and declined, or that none was left unanswered, and that the pull
 * request is now ready for review. Without counts it never claims no run
 * happened: an earlier run whose ticket was left open may have answered them.
 */
export function appliedReviewComment(
  pullRequest: PullRequestUrl,
  answers: { applied: number; declined: number } | undefined,
): string {
  const what =
    answers === undefined
      ? `The morning loop found no review thread on ${pullRequest} left unanswered, so there was nothing left to apply.`
      : `The morning loop applied the review on ${pullRequest}: ${answers.applied} applied, ${answers.declined} declined. Every thread has a reply saying which, and why.`;
  return [what, `${pullRequest} is marked ready for review.`].join("\n\n");
}

/**
 * What a rebase ticket is told as it closes: that its pull request no longer
 * conflicts with its base, or already sat on it so there was nothing to
 * rebase, that `needs-rebase` has come off it, and that its draft state was
 * left alone — a rebase promotes nothing, and `/rebase` may have been
 * commented on one already marked ready.
 */
export function rebasedComment(
  pullRequest: PullRequestUrl,
  rebased: Rebased,
): string {
  const what =
    rebased.rebase !== undefined
      ? `The morning loop rebased ${pullRequest}: the repo host reports it no longer conflicts with its base branch.`
      : `The morning loop found ${pullRequest} already sits on its base branch, so there was nothing to rebase.`;
  return [
    what,
    `It no longer carries ${NEEDS_REBASE_LABEL}.`,
    `Its draft state was left as it was.`,
  ].join("\n\n");
}
