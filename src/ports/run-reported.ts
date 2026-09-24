import type { Nits } from "./nits.ts";
import type { TicketGist } from "./ticket-gist.ts";

/**
 * What a finished run reported in its own output, for `RepoHost.openDraftPullRequest`
 * to carry into the draft pull request body: the ticket gist and the nits it
 * noticed, either absent. Bundled so a caller carrying one without the other
 * does not pass a placeholder `undefined` in the other's place.
 */
export interface RunReported {
  gist?: TicketGist;
  nits?: Nits;
}
