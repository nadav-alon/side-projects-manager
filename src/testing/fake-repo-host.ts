import type { RepoHost, RepoSlug } from "../ports/index.ts";

/** One push the command made, in the order the fake received it. */
export interface FakePush {
  directory: string;
  message: string;
  /** The paths committed, and nothing else in the checkout. */
  paths: string[];
}

/**
 * GitHub and git in memory: a set of repos that exist, and a managed location
 * that is a path shape rather than a real directory.
 *
 * Tests arrange with `alreadyExists`, which is what a repo predating the
 * manager looks like, and inspect `created`, `clones` and `pushes` to see what
 * the command did to the outside world.
 */
export class FakeRepoHost implements RepoHost {
  /** The managed location every clone lands under. */
  static readonly MANAGED_LOCATION = "/side-projects";

  readonly #existing = new Set<RepoSlug>();

  /** Repos created, in the order they were created. */
  readonly created: RepoSlug[] = [];
  /** Repos cloned, in the order they were cloned. */
  readonly clones: RepoSlug[] = [];
  /** What was committed and pushed, in order. */
  readonly pushes: FakePush[] = [];

  /** Marks `repo` as already on the host, as a project predating the manager. */
  alreadyExists(repo: RepoSlug): void {
    this.#existing.add(repo);
  }

  async exists(repo: RepoSlug): Promise<boolean> {
    return this.#existing.has(repo);
  }

  async create(repo: RepoSlug, _description: string): Promise<void> {
    this.created.push(repo);
    this.#existing.add(repo);
  }

  async clone(repo: RepoSlug): Promise<string> {
    this.clones.push(repo);
    return `${FakeRepoHost.MANAGED_LOCATION}/${repo}`;
  }

  async commitAndPush(
    directory: string,
    message: string,
    paths: string[],
  ): Promise<void> {
    this.pushes.push({ directory, message, paths: [...paths] });
  }
}
