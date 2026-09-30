import type { ChecksStatus, Clock, Milliseconds, PullRequestUrl, RepoHost } from "./ports/index.ts";
import { milliseconds } from "./ports/index.ts";

/**
 * How long a merge gate keeps reading a pull request's checks once one
 * read says `pending`, counted from that first read, and how far apart the
 * reads are. The bound is not configurable per project.
 */
export const CHECKS_WAIT: Milliseconds = milliseconds(3 * 60 * 1000);
export const CHECKS_POLL_INTERVAL: Milliseconds = milliseconds(15 * 1000);

/**
 * `pullRequest`'s checks status, waiting out `pending`: a first read of
 * green or failing comes back at once, with no further read; a pending one
 * is read again every `CHECKS_POLL_INTERVAL` until it settles or
 * `CHECKS_WAIT` has passed since that first read, and then comes back
 * `pending`. A read that throws, first or later, throws from here.
 */
export async function settledChecks(
  repoHost: Pick<RepoHost, "readChecksStatus">,
  clock: Clock,
  pullRequest: PullRequestUrl,
): Promise<ChecksStatus> {
  let checks = await repoHost.readChecksStatus(pullRequest);
  if (checks !== "pending") {
    return checks;
  }
  const deadline = clock.now().getTime() + CHECKS_WAIT;
  while (checks === "pending" && clock.now().getTime() < deadline) {
    await clock.sleep(CHECKS_POLL_INTERVAL);
    checks = await repoHost.readChecksStatus(pullRequest);
  }
  return checks;
}
