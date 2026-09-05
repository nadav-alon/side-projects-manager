import path from "node:path";

/**
 * The manager's own checkout: the registry, the state document, and the
 * uniform harness files every project is scaffolded from. Not the managed
 * location, which is where projects are cloned to.
 *
 * Resolved from this file rather than the working directory, so the manager
 * finds its own files whatever it was started from, and overridable for a
 * second checkout or a test.
 */
export const MANAGER_HOME =
  process.env["SIDE_PROJECTS_MANAGER_HOME"] ||
  path.resolve(import.meta.dirname, "..", "..");

/**
 * The predictable place projects are cloned to. Clones the developer already
 * has elsewhere are never touched, so this is the only directory the manager
 * writes projects into.
 */
export const MANAGED_LOCATION =
  process.env["SIDE_PROJECTS_MANAGED_LOCATION"] ||
  path.join(homeDirectory(), "side-projects");

function homeDirectory(): string {
  // A machine with no home directory is not one the developer is sitting at;
  // falling back to the manager's own checkout keeps the path absolute.
  return process.env["HOME"] || MANAGER_HOME;
}
