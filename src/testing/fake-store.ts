import type {
  Branch,
  Budget,
  Day,
  InvocationClosing,
  InvocationRecord,
  IssueNumber,
  Journal,
  KeptSummaryPath,
  ModelDefaults,
  OpenInvocation,
  Priority,
  ReadOnlyMount,
  ProjectState,
  RegisteredProject,
  RepoSlug,
  RunCost,
  RunInProgress,
  RunProgress,
  GrantRecord,
  RunSpan,
  Salvage,
  State,
  Store,
  WorkedTicket,
  WorkedToday,
} from "../ports/index.ts";
import {
  DEFAULT_BUDGET,
  JOURNAL_LIMIT,
  KEPT_SUMMARY_LIMIT,
  findInvocationRecord,
  keptSummaryPath,
  recordGrant,
  recordRunSpanEnded,
  recordRunSpanStarted,
  recordStopShortSalvage,
  ticketKey,
  workedTicket,
} from "../ports/index.ts";
import { summaryFileName } from "../summary.ts";

/** What the developer may say about a project when registering it. */
export interface Registration {
  paused?: boolean;
  turbo?: boolean;
  priority?: Priority;
  manager?: true;
  mounts?: ReadOnlyMount[];
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
  #salvages: Salvage[] | undefined = undefined;
  #runSpans: RunSpan[] | undefined = undefined;
  #grants: GrantRecord[] | undefined = undefined;
  #journal: InvocationRecord[] = [];
  #keptSummaries: { at: KeptSummaryPath; body: string }[] = [];
  /** What the developer declared they are willing to spend. */
  budget: Budget = DEFAULT_BUDGET;
  /** The model the developer named for each kind of ticket; none by default. */
  modelDefaults: ModelDefaults = {};

  /** Every summary kept so far, oldest first, as `keepSummary` recorded it. */
  get keptSummaries(): readonly { at: KeptSummaryPath; body: string }[] {
    return this.#keptSummaries;
  }

  /** Registers a project, as the developer hand-editing the registry would. */
  register(repo: RepoSlug, registration: Registration = {}): void {
    this.#registry.push({
      repo,
      paused: registration.paused ?? false,
      turbo: registration.turbo ?? false,
      ...(registration.priority !== undefined && {
        priority: registration.priority,
      }),
      ...(registration.manager === true && { manager: true }),
      ...(registration.mounts !== undefined && { mounts: registration.mounts }),
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

  /**
   * Records `ticket`'s branch as already salvaged, as an earlier invocation's
   * limit refusal or post-start infrastructure failure would have left it —
   * replacing whatever salvage record `ticket` already carried.
   */
  markSalvaged(ticket: WorkedTicket, branch: Branch, stopShorts: number): void {
    this.#salvages = recordStopShortSalvage(this.#salvages, ticket, branch).map(
      (salvage) =>
        ticketKey(salvage) === ticketKey(ticket) ? { ...salvage, stopShorts } : salvage,
    );
  }

  /**
   * Records `ticket`'s own run span, as an earlier invocation's run would
   * have left it — replacing whatever span `ticket` already carried.
   * `openedBy` names the invocation that opened it, when a test needs the
   * merge gate to tell this span apart from one a dead invocation left open;
   * absent, as a real span predating that field would be.
   */
  markRunSpan(
    ticket: WorkedTicket,
    startedAt: Date,
    endedAt?: Date,
    openedBy?: OpenInvocation,
  ): void {
    const started = recordRunSpanStarted(this.#runSpans, ticket, startedAt, openedBy);
    this.#runSpans =
      endedAt === undefined ? started : recordRunSpanEnded(started, ticket, endedAt);
  }

  /** Records `ticket`'s grant at `grantedAt`, as the `grant` command would have left it. */
  markGranted(ticket: WorkedTicket, grantedAt: Date): void {
    this.#grants = recordGrant(this.#grants, ticket, grantedAt);
  }

  /** The grant records now standing, whoever left them. */
  grants(): GrantRecord[] {
    return (this.#grants ?? []).map((grant) => ({ ...grant }));
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
      ...(this.#salvages !== undefined && {
        salvages: this.#salvages.map((salvage) => ({ ...salvage })),
      }),
      ...(this.#runSpans !== undefined && {
        runSpans: this.#runSpans.map((span) => ({ ...span })),
      }),
      ...(this.#grants !== undefined && {
        grants: this.#grants.map((grant) => ({ ...grant })),
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
    this.#salvages = state.salvages?.map((salvage) => ({ ...salvage }));
    this.#runSpans = state.runSpans?.map((span) => ({ ...span }));
    this.#grants = state.grants?.map((grant) => ({ ...grant }));
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
    delete record.runs;
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
        ...(record.runs !== undefined && { runs: [...record.runs] }),
        ...(record.projects !== undefined && {
          projects: [...record.projects],
        }),
        ...(record.summaryFailure !== undefined && {
          summaryFailure: { ...record.summaryFailure },
        }),
      })),
    };
  }

  async recordRunStarted(
    opened: OpenInvocation,
    run: RunInProgress,
  ): Promise<void> {
    const record = findInvocationRecord(this.#journal, opened);
    if (record === undefined) {
      throw new Error(
        `no invocation record opened at ${opened.openedAt.toISOString()} by process ${opened.process}`,
      );
    }
    record.runs = [...(record.runs ?? []), run];
  }

  async recordRunProgress(
    opened: OpenInvocation,
    repo: RepoSlug,
    number: IssueNumber,
    progress: RunProgress,
  ): Promise<void> {
    const record = findInvocationRecord(this.#journal, opened);
    const run = record?.runs?.find((candidate) => candidate.repo === repo && candidate.number === number);
    if (run !== undefined) {
      run.progress = progress;
    }
  }

  async recordRunEnded(
    opened: OpenInvocation,
    repo: RepoSlug,
    number: IssueNumber,
  ): Promise<void> {
    const record = findInvocationRecord(this.#journal, opened);
    if (record === undefined || record.runs === undefined) {
      return;
    }
    record.runs = record.runs.filter(
      (run) => run.repo !== repo || run.number !== number,
    );
  }

  async keepSummary(startedAt: Date, body: string): Promise<KeptSummaryPath> {
    const at = keptSummaryPath(`/fake-manager-home/${summaryFileName(startedAt)}`);
    this.#keptSummaries = [...this.#keptSummaries, { at, body }].slice(
      -KEPT_SUMMARY_LIMIT,
    );
    return at;
  }
}

/** A copy the loop cannot reach back into once saved or loaded. */
function copyWorkedToday({ day, tickets }: WorkedToday): WorkedToday {
  return { day, tickets: tickets.map(workedTicket) };
}
