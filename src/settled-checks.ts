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
 * `read`'s answer, waiting out `isPending`: a first read that is not pending
 * comes back at once, with no further read; a pending one is read again every
 * `CHECKS_POLL_INTERVAL` until it settles or `CHECKS_WAIT` has passed since
 * that first read, and then comes back as last read. A read that throws,
 * first or later, throws from here.
 */
export async function waitOutPending<T>(
  read: () => Promise<T>,
  isPending: (answer: T) => boolean,
  clock: Clock,
): Promise<T> {
  let answer = await read();
  if (!isPending(answer)) {
    return answer;
  }
  const deadline = clock.now().getTime() + CHECKS_WAIT;
  while (isPending(answer) && clock.now().getTime() < deadline) {
    await clock.sleep(CHECKS_POLL_INTERVAL);
    answer = await read();
  }
  return answer;
}

/**
 * `pullRequest`'s checks status, waiting out `pending` as {@link
 * waitOutPending} does, and then `pending` if it has not settled.
 */
export function settledChecks(
  repoHost: Pick<RepoHost, "readChecksStatus">,
  clock: Clock,
  pullRequest: PullRequestUrl,
): Promise<ChecksStatus> {
  return waitOutPending(() => repoHost.readChecksStatus(pullRequest), (checks) => checks === "pending", clock);
}
