import type { RegisteredProject, Store } from "../ports/index.ts";

/** An in-memory registry. Empty by default: nothing configured. */
export class FakeStore implements Store {
  readonly #projects: RegisteredProject[];

  constructor(projects: RegisteredProject[] = []) {
    this.#projects = [...projects];
  }

  /** Registers a project by `owner/repo` slug. */
  register(slug: string): void {
    this.#projects.push({ slug });
  }

  async loadProjects(): Promise<RegisteredProject[]> {
    return this.#projects.map((project) => ({ ...project }));
  }
}
