import type { RepoSlug } from "./repo-slug.ts";

/** A project the developer has registered with the manager. */
export interface RegisteredProject {
  repo: RepoSlug;
}

/**
 * Reads the developer's registry and the machine-written state alongside it.
 *
 * The documents themselves, and the pause/priority/last-worked fields they
 * carry, are #3. The skeleton needs only the list of registered projects.
 */
export interface Store {
  loadProjects(): Promise<RegisteredProject[]>;
}
