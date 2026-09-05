import type { Priority } from "./priority.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TokenCount } from "./token-count.ts";

/**
 * One project as the developer registered it. The registry is hand-edited, so
 * everything here is intent: which projects exist, which are paused, which one
 * has the mornings.
 */
export interface RegisteredProject {
  repo: RepoSlug;
  /** Registered but never considered. */
  paused: boolean;
  /** Overrides least-recently-worked ordering. Absent for most projects. */
  priority?: Priority;
}

/** What one run cost, kept so the reserve can be calibrated against real spend. */
export interface RunCost {
  /** When the run finished. */
  at: Date;
  tokensUsed: TokenCount;
}

/** What the machine has recorded about one project. */
export interface ProjectState {
  /**
   * When an iteration last worked this project. Absent means never worked,
   * which is what a project registered this morning looks like.
   */
  lastWorkedAt?: Date;
  /** Every run made against this project, oldest first. */
  runs: RunCost[];
}

/**
 * The machine-written state, by project. A project with no entry has never
 * been worked; that is not an error, and neither is a state document that
 * does not exist yet.
 */
export type State = ReadonlyMap<RepoSlug, ProjectState>;

/**
 * Reads the developer's registry and reads and writes the state document
 * alongside it.
 *
 * The two are separate documents with separate methods because they have
 * different authors: the developer writes the registry and the loop never
 * touches it, while the loop writes the state and the developer never has to.
 */
export interface Store {
  /** Every registered project, in the order the registry lists them. */
  loadRegistry(): Promise<RegisteredProject[]>;
  /** The state in force. Empty when nothing has been worked yet. */
  loadState(): Promise<State>;
  /** Replaces the state document with `state`. */
  saveState(state: State): Promise<void>;
}
