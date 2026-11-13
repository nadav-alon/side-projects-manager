import type { IssueNumber } from "./issue-number.ts";
import type { DiscoveryKind } from "./discovery.ts";
import type { RepoSlug } from "./repo-slug.ts";

/**
 * A discovery the manager filed, as the manager home keeps it while it still
 * waits on the developer — CONTEXT.md's "Recorded discovery". `repo` and
 * `number` name the ticket the discovery was filed against, the one the
 * developer finds the discovery on.
 */
export interface RecordedDiscovery {
  repo: RepoSlug;
  number: IssueNumber;
  kind: DiscoveryKind;
  title: string;
  /** When the manager filed it. */
  filedAt: Date;
}
