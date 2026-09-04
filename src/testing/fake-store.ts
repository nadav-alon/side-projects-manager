import type { RegisteredProject, RepoSlug, Store } from "../ports/index.ts";

/** An in-memory registry. Empty by default: nothing configured. */
export class FakeStore implements Store {
  readonly #projects: RegisteredProject[] = [];

  /** Registers a project, as the developer hand-editing the registry would. */
  register(repo: RepoSlug): void {
    this.#projects.push({ repo });
  }

  async loadProjects(): Promise<RegisteredProject[]> {
    return this.#projects.map((project) => ({ ...project }));
  }
}
