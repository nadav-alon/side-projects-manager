import { DEFAULT_BUDGET, repoSlug, tokenCount, type RepoSlug } from "../ports/index.ts";
import type { ProjectOutcome } from "../selection.ts";

/** A registered project, for tests that need one and don't care which. */
export const MANAGER: RepoSlug = repoSlug("nadav-alon/side-projects-manager");
/** A second registered project, for tests that need two. */
export const PILOT: RepoSlug = repoSlug("nadav-alon/pilot");

/** The most a week may have spent before `DEFAULT_BUDGET`'s reserve refuses. */
export const SPENDABLE_THIS_WEEK = tokenCount(
  DEFAULT_BUDGET.weeklyAllowance * (1 - DEFAULT_BUDGET.reserveFraction),
);

/** A day before `FROZEN_NOW`, and before the weekly window it opens. */
export const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");
/** Earlier still than `YESTERDAY`. */
export const LAST_WEEK = new Date("2025-12-20T06:00:00.000Z");

/**
 * A body shaped as an agent brief, per CONTEXT.md's "Ready discovery" — what
 * `isAgentBrief` requires of a ready discovery.
 */
export const AGENT_BRIEF_BODY = [
  "Current behavior: the retry loop hammers the API on every failure.",
  "Desired behavior: it should back off between attempts.",
  "Acceptance criteria: a failed call waits before its next attempt.",
  "Out of scope: a configurable backoff strategy.",
].join("\n\n");

/** What the verdicts say happened, without the timestamps a test didn't set. */
export function verdicts(projects: ProjectOutcome[]): [string, string][] {
  return projects.map((project) => [project.repo, project.verdict]);
}

/**
 * The regex a hand-back or summary comment's own transcript line must match:
 * `path`'s own characters escaped, so a `.` in it can't stand in for any
 * character the way an unescaped one would.
 */
export function endsWithTranscript(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Transcript: \`${escaped}\`\\.$`);
}
