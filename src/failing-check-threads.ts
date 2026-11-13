import { settledChecks } from "./settled-checks.ts";
import type { Clock, FailingCheck, PullRequestUrl, RepoHost } from "./ports/index.ts";

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
 * Waits for `pullRequest`'s checks to settle, then posts each failing one as
 * its own review thread, and returns how many it posted. Green, still-pending
 * or no checks post none. Safe to call again, as after an apply-review run or
 * a handed-back review: a check whose thread, naming the same run, is still
 * open is not posted a second time.
 */
export async function postFailingCheckThreads(
  repoHost: Pick<RepoHost, "readChecksStatus" | "readFailingChecks" | "postReviewThread" | "readOpenReviewThreadBodies">,
  clock: Clock,
  pullRequest: PullRequestUrl,
): Promise<number> {
  if ((await settledChecks(repoHost, clock, pullRequest)) !== "red") {
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
