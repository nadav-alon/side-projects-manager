import { repoSlug, type RepoSlug } from "../ports/index.ts";
import type { ProjectOutcome } from "../selection.ts";

/** A registered project, for tests that need one and don't care which. */
export const MANAGER: RepoSlug = repoSlug("nadav-alon/side-projects-manager");
/** A second registered project, for tests that need two. */
export const PILOT: RepoSlug = repoSlug("nadav-alon/pilot");

/** A day before `FROZEN_NOW`, and before the weekly window it opens. */
export const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");
/** Earlier still than `YESTERDAY`. */
export const LAST_WEEK = new Date("2025-12-20T06:00:00.000Z");

/** What the verdicts say happened, without the timestamps a test didn't set. */
export function verdicts(projects: ProjectOutcome[]): [string, string][] {
  return projects.map((project) => [project.repo, project.verdict]);
}
