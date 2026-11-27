import { errorMessage } from "./error-message.ts";
import { packagePins } from "./package-pins.ts";
import type { IssueTracker, ReleaseTag, RepoHost, RepoSlug, Ticket } from "./ports/index.ts";
import {
  bumpTicketBody,
  bumpTicketTitle,
  isBumpTicketFor,
  isOlderTag,
  repoName,
  repoOwner,
} from "./ports/index.ts";

/** The verbs a package bump sweep calls. */
export interface PackageBumpSweepPorts {
  repoHost: Pick<RepoHost, "readLatestRelease" | "readFile">;
  tracker: Pick<IssueTracker, "listOpenIssues" | "createBumpTicket" | "rewriteTicket">;
}

/** The bump ticket the sweep opened in a project pinning an older release. */
export interface PackageBumpOpened {
  kind: "opened";
  ticket: Ticket;
}

/**
 * The project's open bump ticket asked for an earlier release than the
 * package's latest, so the sweep retitled and rewrote it to ask for the
 * latest rather than opening a second.
 */
export interface PackageBumpUpdated {
  kind: "updated";
  ticket: Ticket;
}

/** A read or a write the host or tracker refused the sweep for this package and project. */
export interface PackageBumpRefusal {
  kind: "refused";
  error: string;
}

/** What one package's release came to for one project pinning an older one. */
export type PackageBumpResult = PackageBumpOpened | PackageBumpUpdated | PackageBumpRefusal;

/**
 * One package's release, one project's pin of it, and what the sweep did.
 * `publisher` is the registered project that publishes the release and
 * `project` the one pinning it.
 */
export interface PackageBumpOutcome {
  publisher: RepoSlug;
  project: RepoSlug;
  result: PackageBumpResult;
}

/** The manifest a project pins its packages in. */
const MANIFEST = "package.json";

/**
 * A package bump sweep over `projects` (`CONTEXT.md`'s "Package bump sweep"):
 * for each project that has published a release, every other project whose
 * `package.json` pins `github:<owner>/<package>#v…` at an earlier tag gets a
 * bump ticket asking to move to the latest release.
 *
 * Only a bump is reported: a project already on the latest release, one not
 * pinning the package, and one whose open bump ticket already asks for the
 * latest release yield no outcome. A project with an open bump ticket for the
 * package that names an earlier release has that ticket rewritten instead of
 * a second one opened. The open ticket is found among the newest open issues
 * the tracker lists, so where it truncated the backlog and none was found, one
 * may be hidden: that is a `refused` outcome, never a second ticket.
 *
 * Two limits remain. An open bump ticket is recognised by its title
 * (`isBumpTicketFor`), so one a developer retitled is not found and a second
 * is opened. And a project that already pins the latest release (bumped by
 * hand) yields no outcome, so its open bump ticket is left open, asking for a
 * bump already made.
 *
 * Never throws: a read or a write refused for one package and project is a
 * `refused` outcome, and the sweep carries on, so one project's trouble never
 * stops the next.
 */
export async function packageBumpSweep(
  ports: PackageBumpSweepPorts,
  projects: readonly RepoSlug[],
): Promise<PackageBumpOutcome[]> {
  const outcomes: PackageBumpOutcome[] = [];
  const manifests = new Map<RepoSlug, Promise<string | undefined>>();
  const manifestOf = (project: RepoSlug) => {
    let manifest = manifests.get(project);
    if (manifest === undefined) {
      manifest = ports.repoHost.readFile(project, MANIFEST);
      manifests.set(project, manifest);
    }
    return manifest;
  };

  for (const published of projects) {
    let latest: ReleaseTag | undefined;
    try {
      latest = await ports.repoHost.readLatestRelease(published);
    } catch (error) {
      // No project's pin was involved, so the publisher stands as the
      // project the refusal is filed against.
      outcomes.push(refused(published, published, error));
      continue;
    }
    if (latest === undefined) {
      continue;
    }
    for (const project of projects) {
      if (project === published) {
        continue;
      }
      try {
        const result = await bumpIn(ports, await manifestOf(project), published, project, latest);
        if (result !== undefined) {
          outcomes.push({ publisher: published, project, result });
        }
      } catch (error) {
        outcomes.push(refused(published, project, error));
      }
    }
  }
  return outcomes;
}

/** What `project` needs for `published`'s `latest` release, done; `undefined` where it needs nothing. */
async function bumpIn(
  ports: PackageBumpSweepPorts,
  manifest: string | undefined,
  published: RepoSlug,
  project: RepoSlug,
  latest: ReleaseTag,
): Promise<PackageBumpResult | undefined> {
  if (manifest === undefined) {
    return undefined;
  }
  const pkg = repoName(published);
  const pinned = packagePins(manifest, repoOwner(published)).find((pin) => pin.package === pkg)?.tag;
  if (pinned === undefined || !isOlderTag(pinned, latest)) {
    return undefined;
  }

  const title = bumpTicketTitle(pkg, latest);
  const body = bumpTicketBody(pkg, latest, pinned);
  const { issues, truncated } = await ports.tracker.listOpenIssues(project);
  const open = issues.find((issue) => isBumpTicketFor(issue.ticket, pkg))?.ticket;
  if (open === undefined) {
    if (truncated) {
      return {
        kind: "refused",
        error: `${project}'s open issues were truncated, so an open bump ticket for ${pkg} may be hidden; not opening a second`,
      };
    }
    return { kind: "opened", ticket: await ports.tracker.createBumpTicket(project, title, body) };
  }
  if (open.title === title) {
    return undefined;
  }
  await ports.tracker.rewriteTicket(open, title, body);
  return { kind: "updated", ticket: { ...open, title } };
}

/** The outcome of a read or write refused for `published`'s release and `project`. */
function refused(published: RepoSlug, project: RepoSlug, error: unknown): PackageBumpOutcome {
  return { publisher: published, project, result: { kind: "refused", error: errorMessage(error) } };
}
