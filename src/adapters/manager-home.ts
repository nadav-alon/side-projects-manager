import path from "node:path";

/**
 * This checkout's own root, resolved from this file rather than the working
 * directory, so the manager finds its own files whatever it was started
 * from — the same way `install-triggers.sh` resolves `REPO_DIR` from its own
 * location. Unlike `MANAGER_HOME`, this is never overridden by
 * `SIDE_PROJECTS_MANAGER_HOME`: it is what the installer's cron line and rc
 * block actually point at, so it is what a trigger registration must be
 * compared against to decide whether it is armed (CONTEXT.md: Armed).
 */
export const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * The manager's own checkout: the registry, the state document, and the
 * uniform harness files every project is scaffolded from. Not the managed
 * location, which is where projects are cloned to.
 *
 * Overridable for a second checkout or a test — which is why this, unlike
 * `CHECKOUT_ROOT`, is the wrong value to compare a trigger registration
 * against: the installer never honours this override when it writes the
 * cron line or rc block.
 */
export const MANAGER_HOME =
  process.env["SIDE_PROJECTS_MANAGER_HOME"] || CHECKOUT_ROOT;

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
