import type { RepoSlug } from "./repo-slug.ts";

/** A project the developer has registered with the manager. */
export interface RegisteredProject {
  repo: RepoSlug;
}

/**
 * Reads the developer's registry and the machine-written state alongside it.
 *
 * TODO[#3]: the documents themselves, and the paused, priority and
 * last-worked fields they carry.
 */
export interface Store {
  loadProjects(): Promise<RegisteredProject[]>;
}
