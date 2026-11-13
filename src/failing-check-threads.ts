import { waitOutPending } from "./settled-checks.ts";
import type { Clock, FailingCheck, PullRequestUrl, RepoHost } from "./ports/index.ts";

/**
 * The comment left on a pull request whose checks were still running when the
 * wait ended, so the review that follows is known to have gone without them.
 */
export const CHECKS_STILL_PENDING_NOTE =
  "Some checks were still running when the review began, so failing checks that finished later were not read as review threads.";

/**
 * A failing check as a review thread's body: its name, its error lines
 * quoted, and a link to its run when it has one.
 */
export function failingCheckThreadBody(check: FailingCheck): string {
  const lines = check.errorLines.length === 0 ? "" : `\n\n\`\`\`\n${check.errorLines.join("\n")}\n\`\`\``;
  const run = check.runUrl === undefined ? "" : `\n\nRun: ${check.runUrl}`;
  return `Failing check: ${check.name}${lines}${run}`;
}

/**
 * Waits until none of `pullRequest`'s checks is pending, within the same bound
 * as the merge gate's wait, then posts each failing check as its own review
 * thread, and returns how many it posted. `readChecksStatus` answers `red`
 * while other checks still run, so this waits on `readChecksPending` instead,
 * or a check failing later would go unposted.
 * Green or no checks post none. A wait that runs out with checks still pending
 * posts what has failed so far, and a comment on the pull request saying the
 * rest went unread. Safe to call again, as after an apply-review run or a
 * handed-back review, as far as threads go: a check whose thread, naming the
 * same run, is still open is not posted a second time. The note is not
 * de-duplicated, so each call that ends with checks still pending posts it
 * again.
 */
export async function postFailingCheckThreads(
  repoHost: Pick<
    RepoHost,
    "readChecksStatus" | "readChecksPending" | "readFailingChecks" | "postReviewThread" | "postComment" | "readOpenReviewThreadBodies"
  >,
  clock: Clock,
  pullRequest: PullRequestUrl,
): Promise<number> {
  const pending = await waitOutPending(
    () => repoHost.readChecksPending(pullRequest),
    (stillPending) => stillPending,
    clock,
  );
  if (pending) {
    await repoHost.postComment(pullRequest, CHECKS_STILL_PENDING_NOTE);
  }
  if ((await repoHost.readChecksStatus(pullRequest)) !== "red") {
    return 0;
  }
  const failing = await repoHost.readFailingChecks(pullRequest);
  const open = new Set(await repoHost.readOpenReviewThreadBodies(pullRequest));
  let posted = 0;
  for (const check of failing) {
    const body = failingCheckThreadBody(check);
    if (open.has(body)) {
      continue;
    }
    await repoHost.postReviewThread(pullRequest, body);
    posted++;
  }
  return posted;
}
