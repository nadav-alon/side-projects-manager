import { errorMessage } from "./error-message.ts";
import type { IssueTracker, RepoHost, RepoSlug, Ticket } from "./ports/index.ts";
import { UX_SCRIPT_TICKET_TITLE } from "./ports/index.ts";

/** The npm script a UX review launches the app with. */
const UX_SCRIPT = "ux";

/** The verbs a sweep calls, narrowed to what it needs. */
export interface UxScriptSweepPorts {
  tracker: Pick<IssueTracker, "listOpenIssues" | "createUxScriptTicket">;
  repoHost: Pick<RepoHost, "hasNpmScript">;
}

/** What a ux-script sweep of one project came to. */
export interface UxScriptSweepOutcome {
  repo: RepoSlug;
  result:
    | { kind: "filed"; ticket: Ticket }
    | { kind: "unchanged" }
    | { kind: "refused"; error: string };
}

/**
 * A ux-script sweep of one `ui: true` project: files the ticket asking for
 * its `ux` npm script when its default branch's `package.json` has none, and
 * no such ticket is open already (found by {@link UX_SCRIPT_TICKET_TITLE}
 * among the open issues). A closed one does not count: if the script is still
 * missing, it is asked for again.
 *
 * Never throws: a refused read or write is answered as `refused`, so one
 * project's trouble never stops the next.
 */
export async function uxScriptSweep(
  ports: UxScriptSweepPorts,
  repo: RepoSlug,
): Promise<UxScriptSweepOutcome> {
  try {
    if (await ports.repoHost.hasNpmScript(repo, UX_SCRIPT)) {
      return { repo, result: { kind: "unchanged" } };
    }
    const { issues } = await ports.tracker.listOpenIssues(repo);
    if (issues.some(({ ticket }) => ticket.title === UX_SCRIPT_TICKET_TITLE)) {
      return { repo, result: { kind: "unchanged" } };
    }
    return { repo, result: { kind: "filed", ticket: await ports.tracker.createUxScriptTicket(repo) } };
  } catch (error) {
    return { repo, result: { kind: "refused", error: errorMessage(error) } };
  }
}
