import type { Checkout } from "./checkout.ts";

/**
 * The files every project gets, byte for byte, at the paths the agent
 * instructions point at.
 *
 * These are the manager's own copies: the manager is a registered project like
 * any other, so improving the conventions it works under improves the ones
 * every project it scaffolds works under, from one source rather than a
 * drifting copy in each project. Nothing listed here may name the manager, or a project would
 * arrive carrying a reference back to it.
 *
 * Declared here, beside the port, rather than only in the adapter that copies
 * them: the loop reads this same list to catch a run's diff touching one of
 * them before it becomes a project-local pull request (see `morning-run.ts`'s
 * `handOver`), and a second copy of the list would drift from this one
 * unnoticed.
 */
export const UNIFORM_FILES = [
  "docs/agents/coding-standards.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/ticket-scope.md",
  "docs/agents/triage-labels.md",
  "docs/agents/domain.md",
  ".github/workflows/apply-review.yml",
  ".github/workflows/rebase.yml",
] as const;

/** What one scaffolding put into a checkout. */
export interface Scaffold {
  /** Every path written, relative to the checkout, in the order written. */
  paths: string[];
  /**
   * The paths that replaced a file the project already had.
   *
   * Only uniform files can appear here — the instructions file is never
   * overwritten. A project that predates the harness is adopted through a pull
   * request, and this is what that request has to say out loud: a diff shows
   * that a file changed, but not that the change was this command overwriting
   * something the project wrote for itself.
   */
  overwritten: string[];
}

/**
 * Scaffolds the harness into one project checkout.
 *
 * Two kinds of file go in, and the difference between them is the point. The
 * uniform files are copied verbatim, so every project reads the same
 * conventions and an improvement to them reaches every project the same way.
 * The agent instructions are generated for that one project and written
 * alongside them, so a project describes itself rather than inheriting a
 * description of whoever scaffolded it.
 */
export interface Harness {
  /**
   * Installs the uniform files into the checkout at `directory` and writes
   * `instructions` as the project's own agent instructions.
   */
  install(directory: Checkout, instructions: string): Promise<Scaffold>;
}
