import type {
  Budget,
  Day,
  ModelDefaults,
  Priority,
  ProjectState,
  RegisteredProject,
  RepoSlug,
  RunCost,
  State,
  Store,
  WorkedTicket,
  WorkedToday,
} from "../ports/index.ts";
import { DEFAULT_BUDGET, workedTicket } from "../ports/index.ts";

/** What the developer may say about a project when registering it. */
export interface Registration {
  paused?: boolean;
  priority?: Priority;
}

/**
 * The two documents in memory. Both start empty: nothing registered, nothing
 * ever worked.
 *
 * Tests arrange the registry with `register` and the state with `markWorked`
 * and `markWorkedOn`, which is what the developer's editor and a past
 * invocation respectively would have left behind.
 */
export class FakeStore implements Store {
  #registry: RegisteredProject[] = [];
  #state = new Map<RepoSlug, ProjectState>();
  #workedToday: WorkedToday | undefined = undefined;
  /** What the developer declared they are willing to spend. */
  budget: Budget = DEFAULT_BUDGET;
  /** The model the developer named for each kind of ticket; none by default. */
  modelDefaults: ModelDefaults = {};

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

  /**
   * Records `tickets` as worked on `day`, as an earlier invocation that day
   * would have — replacing whatever day was recorded before.
   */
  markWorkedOn(day: Day, ...tickets: WorkedTicket[]): void {
    this.#workedToday = { day, tickets: [...tickets] };
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

  async loadModelDefaults(): Promise<ModelDefaults> {
    return { ...this.modelDefaults };
  }

  async loadState(): Promise<State> {
    return {
      projects: new Map(
        [...this.#state].map(([repo, state]) => [
          repo,
          { ...state, runs: [...state.runs] },
        ]),
      ),
      ...(this.#workedToday !== undefined && {
        workedToday: copyWorkedToday(this.#workedToday),
      }),
    };
  }

  async saveState(state: State): Promise<void> {
    this.#state = new Map(
      [...state.projects].map(([repo, project]) => [
        repo,
        { ...project, runs: [...project.runs] },
      ]),
    );
    this.#workedToday =
      state.workedToday === undefined
        ? undefined
        : copyWorkedToday(state.workedToday);
  }
}

/** A copy the loop cannot reach back into once saved or loaded. */
function copyWorkedToday({ day, tickets }: WorkedToday): WorkedToday {
  return { day, tickets: tickets.map(workedTicket) };
}
