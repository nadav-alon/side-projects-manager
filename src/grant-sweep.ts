import { errorMessage } from "./error-message.ts";
import type { InvocationState } from "./invocation-state.ts";
import type { IssueTracker, RepoSlug } from "./ports/index.ts";
import { ticketKey } from "./ports/index.ts";

/**
 * Prunes the grant records whose ticket has closed (ADR 0012): the merge gate
 * uses a record up when it fires, but a ticket closed without ever reaching
 * the gate would otherwise keep its record for good. Returns the tickets
 * pruned, as `repo#number`.
 *
 * A ticket is closed when its repo's open issues no longer list it. A repo
 * whose open issues cannot be read, or were read truncated — so an absence
 * proves nothing — keeps its records until a sweep that can tell. Never
 * throws: a failed read or save is reported on the console and the record
 * stays for the next sweep.
 */
export async function grantSweep(
  tracker: Pick<IssueTracker, "listOpenIssues">,
  state: Pick<InvocationState, "grants" | "consumeGrant">,
): Promise<string[]> {
  const pruned: string[] = [];
  const grants = await state.grants().catch(() => []);
  const repos = [...new Set(grants.map((grant) => grant.repo))];
  for (const repo of repos) {
    const open = await openNumbers(tracker, repo);
    if (open === undefined) {
      continue;
    }
    for (const grant of grants.filter((candidate) => candidate.repo === repo)) {
      if (open.has(grant.number)) {
        continue;
      }
      try {
        await state.consumeGrant(grant);
        pruned.push(ticketKey(grant));
      } catch (error: unknown) {
        console.warn(`Could not prune the grant record for ${ticketKey(grant)}: ${errorMessage(error)}`);
      }
    }
  }
  return pruned;
}

async function openNumbers(
  tracker: Pick<IssueTracker, "listOpenIssues">,
  repo: RepoSlug,
): Promise<Set<number> | undefined> {
  try {
    const open = await tracker.listOpenIssues(repo);
    return open.truncated ? undefined : new Set(open.issues.map((issue) => issue.ticket.number));
  } catch (error: unknown) {
    console.warn(`Could not read ${repo}'s open issues to prune grant records: ${errorMessage(error)}`);
    return undefined;
  }
}
