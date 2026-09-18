import type {
  Budget,
  Day,
  InvocationClosing,
  InvocationRecord,
  Journal,
  ModelDefaults,
  OpenInvocation,
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
import {
  DEFAULT_BUDGET,
  JOURNAL_LIMIT,
  findInvocationRecord,
  workedTicket,
} from "../ports/index.ts";

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
  #announcedOn: Day | undefined = undefined;
  #journal: InvocationRecord[] = [];
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

  /** Records `day` as announced, as an earlier invocation's successful publish would have. */
  markAnnouncedOn(day: Day): void {
    this.#announcedOn = day;
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
      ...(this.#announcedOn !== undefined && {
        announcedOn: this.#announcedOn,
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
    this.#announcedOn = state.announcedOn;
  }

  async openInvocation(opened: OpenInvocation): Promise<OpenInvocation> {
    this.#journal.push({ openedAt: opened.openedAt, process: opened.process });
    this.#journal = this.#journal.slice(-JOURNAL_LIMIT);
    return { ...opened };
  }

  async closeInvocation(
    opened: OpenInvocation,
    closing: InvocationClosing,
  ): Promise<void> {
    const record = findInvocationRecord(this.#journal, opened);
    if (record === undefined) {
      throw new Error(
        `no invocation record opened at ${opened.openedAt.toISOString()} by process ${opened.process}`,
      );
    }
    if (record.closedAt !== undefined) {
      throw new Error(
        `the invocation record opened at ${opened.openedAt.toISOString()} by process ${opened.process} is already closed`,
      );
    }
    Object.assign(record, {
      closedAt: closing.closedAt,
      outcome: closing.outcome,
      projects: [...closing.projects],
      ...(closing.standDownReason !== undefined && {
        standDownReason: closing.standDownReason,
      }),
      ...(closing.summaryLocation !== undefined && {
        summaryLocation: closing.summaryLocation,
      }),
      ...(closing.summaryFailure !== undefined && {
        summaryFailure: { ...closing.summaryFailure },
      }),
      ...(closing.exitCode !== undefined && { exitCode: closing.exitCode }),
    });
  }

  async loadJournal(): Promise<Journal> {
    return {
      records: this.#journal.map((record) => ({
        ...record,
        ...(record.projects !== undefined && {
          projects: [...record.projects],
        }),
        ...(record.summaryFailure !== undefined && {
          summaryFailure: { ...record.summaryFailure },
        }),
      })),
    };
  }
}

/** A copy the loop cannot reach back into once saved or loaded. */
function copyWorkedToday({ day, tickets }: WorkedToday): WorkedToday {
  return { day, tickets: tickets.map(workedTicket) };
}
