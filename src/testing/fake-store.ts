import type {
  Budget,
  Priority,
  ProjectState,
  RegisteredProject,
  RepoSlug,
  RunCost,
  State,
  Store,
} from "../ports/index.ts";
import { DEFAULT_BUDGET } from "../ports/index.ts";

/** What the developer may say about a project when registering it. */
export interface Registration {
  paused?: boolean;
  priority?: Priority;
}

/**
 * The two documents in memory. Both start empty: nothing registered, nothing
 * ever worked.
 *
 * Tests arrange the registry with `register` and the state with `markWorked`,
 * which is what the developer's editor and a past invocation respectively
 * would have left behind.
 */
export class FakeStore implements Store {
  #registry: RegisteredProject[] = [];
  #state = new Map<RepoSlug, ProjectState>();
  /** What the developer declared they are willing to spend. */
  budget: Budget = DEFAULT_BUDGET;

  /** Registers a project, as the developer hand-editing the registry would. */
  register(repo: RepoSlug, registration: Registration = {}): void {
    this.#registry.push({
      repo,
      paused: registration.paused ?? false,
      ...(registration.priority !== undefined && {
        priority: registration.priority,
      }),
    });
  }

  /** Records a project as worked, as a past invocation would have. */
  markWorked(repo: RepoSlug, lastWorkedAt: Date, ...runs: RunCost[]): void {
    const existing = this.#state.get(repo);
    this.#state.set(repo, {
      lastWorkedAt,
      runs: [...(existing?.runs ?? []), ...runs],
    });
  }

  async loadRegistry(): Promise<RegisteredProject[]> {
    return this.#registry.map((project) => ({ ...project }));
  }

  async saveRegistry(projects: RegisteredProject[]): Promise<void> {
    this.#registry = projects.map((project) => ({ ...project }));
  }

  async loadBudget(): Promise<Budget> {
    return { ...this.budget };
  }

  async loadState(): Promise<State> {
    return new Map(
      [...this.#state].map(([repo, state]) => [
        repo,
        { ...state, runs: [...state.runs] },
      ]),
    );
  }

  async saveState(state: State): Promise<void> {
    this.#state = new Map(
      [...state].map(([repo, project]) => [
        repo,
        { ...project, runs: [...project.runs] },
      ]),
    );
  }
}
