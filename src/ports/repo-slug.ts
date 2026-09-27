declare const repoSlugBrand: unique symbol;

/**
 * A GitHub repository, as `owner/repo`. The one name projects go by, in the
 * registry and on tickets alike.
 *
 * Branded, so an arbitrary string cannot stand in for one. Values enter
 * through `repoSlug` or `isRepoSlug`, which are the only places the shape is
 * checked.
 */
export type RepoSlug = string & { readonly [repoSlugBrand]: true };

/** GitHub owners: alphanumerics and single interior hyphens, up to 39 chars. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** GitHub repo names: alphanumerics, dot, hyphen, underscore; not `.` or `..`. */
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** Whether `value` is shaped like `owner/repo`. */
export function isRepoSlug(value: string): value is RepoSlug {
  const parts = value.split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [owner, repo] = parts;
  return (
    owner !== undefined &&
    repo !== undefined &&
    OWNER.test(owner) &&
    REPO.test(repo)
  );
}

/**
 * The `repo` half of `owner/repo`: what the project is called day to day, and
 * the directory it is cloned into.
 */
export function repoName(repo: RepoSlug): string {
  return repo.slice(repo.indexOf("/") + 1);
}

/** Narrows `value` to a `RepoSlug`, throwing if it is not shaped like one. */
export function repoSlug(value: string): RepoSlug {
  if (!isRepoSlug(value)) {
    throw new TypeError(
      `Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Whether `a` and `b` name the same repo, matched without regard to case, as GitHub matches owner and repo names. */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
