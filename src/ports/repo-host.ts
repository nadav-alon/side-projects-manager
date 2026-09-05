import type { RepoSlug } from "./repo-slug.ts";

/**
 * How the new-project command reaches GitHub and git: creating a repo,
 * getting a checkout of it into the managed location, and publishing what was
 * scaffolded into it.
 *
 * The managed location is the adapter's business, not the caller's. `clone`
 * returns the checkout it produced, so nothing above this port has to know
 * where projects live on disk.
 */
export interface RepoHost {
  /** Whether `repo` already exists on the host. */
  exists(repo: RepoSlug): Promise<boolean>;
  /** Creates `repo` as a private repository. */
  create(repo: RepoSlug, description: string): Promise<void>;
  /**
   * Ensures a checkout of `repo` in the managed location, and returns it.
   * A clone already sitting there is reused rather than replaced, which is
   * what makes a missing clone self-healing and an existing one safe.
   */
  clone(repo: RepoSlug): Promise<string>;
  /**
   * Commits `paths` in the checkout at `directory` and pushes, setting
   * upstream. A checkout where none of them changed is left alone.
   *
   * Only the named paths: a checkout that already existed is the developer's,
   * and work they had in progress there is not this command's to commit.
   */
  commitAndPush(
    directory: string,
    message: string,
    paths: string[],
  ): Promise<void>;
}
