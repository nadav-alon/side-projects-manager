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
  install(directory: string, instructions: string): Promise<Scaffold>;
}
