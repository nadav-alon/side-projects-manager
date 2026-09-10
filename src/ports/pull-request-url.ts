declare const pullRequestUrlBrand: unique symbol;

/**
 * The web address of a pull request on the host: where a run's work waits for
 * the developer, and the one thing the morning hands them to click.
 *
 * Branded, because a URL, a branch name and a repo slug are all strings, and a
 * report that named a branch where it promised a pull request would read as
 * work the developer cannot find. Values enter through `pullRequestUrl` or
 * `isPullRequestUrl` — in practice from `gh pr create`'s output, which is
 * exactly the outside value a guard is for.
 */
export type PullRequestUrl = string & { readonly [pullRequestUrlBrand]: true };

/**
 * Whether `value` is a pull request's address: an `http(s)` URL whose path
 * ends `/pull/<number>`.
 *
 * The host is not checked, so a GitHub Enterprise instance is as acceptable
 * as github.com; the path is, because that is what separates a pull request
 * from the repository, the issue, or the branch it was opened from.
 */
export function isPullRequestUrl(value: string): value is PullRequestUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  return /\/pull\/\d+$/.test(url.pathname);
}

/** Narrows `value` to a `PullRequestUrl`, throwing if it is not one. */
export function pullRequestUrl(value: string): PullRequestUrl {
  if (!isPullRequestUrl(value)) {
    throw new TypeError(
      `Not a pull request URL: expected one ending /pull/<number>, got ${value}`,
    );
  }
  return value;
}
