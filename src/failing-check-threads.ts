import { settledChecks } from "./settled-checks.ts";
import type { Clock, FailingCheck, PullRequestUrl, RepoHost } from "./ports/index.ts";

/**
 * A failing check as a review thread's body: its name, its error lines
 * quoted, and a link to its run.
 */
export function failingCheckThreadBody(check: FailingCheck): string {
  const lines = check.errorLines.length === 0 ? "" : `\n\n\`\`\`\n${check.errorLines.join("\n")}\n\`\`\``;
  return `Failing check: ${check.name}${lines}\n\nRun: ${check.runUrl}`;
}

/**
 * Waits for `pullRequest`'s checks to settle, then posts each failing one as
 * its own review thread, and returns how many it posted. Green, still-pending
 * or no checks post none. Safe to call again after an apply-review run: it
 * posts whatever fails at that moment.
 */
export async function postFailingCheckThreads(
  repoHost: Pick<RepoHost, "readChecksStatus" | "readFailingChecks" | "postReviewThread">,
  clock: Clock,
  pullRequest: PullRequestUrl,
): Promise<number> {
  if ((await settledChecks(repoHost, clock, pullRequest)) !== "red") {
    return 0;
  }
  const failing = await repoHost.readFailingChecks(pullRequest);
  for (const check of failing) {
    await repoHost.postReviewThread(pullRequest, failingCheckThreadBody(check));
  }
  return failing.length;
}
