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
   * `instructions` as the project's own agent instructions. Returns the paths
   * written, relative to `directory`.
   */
  install(directory: string, instructions: string): Promise<string[]>;
}
