declare const issueUrlBrand: unique symbol;

/**
 * The web address of an issue on the host: where the invocation's summary
 * lands once `publishSummary` succeeds, and what the journal names to say
 * where it went.
 *
 * Branded for the same reason `PullRequestUrl` is: a URL, a branch name and a
 * repo slug are all strings, and a record naming a pull request where it
 * promised a summary would send the developer nowhere useful. Values enter
 * through `issueUrl` or `isIssueUrl` — in practice from `gh issue create`'s
 * stdout, which is exactly the outside value a guard is for.
 */
export type IssueUrl = string & { readonly [issueUrlBrand]: true };

/**
 * Whether `value` is an issue's address: an `http(s)` URL whose path ends
 * `/issues/<number>`.
 *
 * The host is not checked, so a GitHub Enterprise instance is as acceptable
 * as github.com; the path is, because that is what separates an issue from
 * the repository, a pull request, or a branch.
 */
export function isIssueUrl(value: string): value is IssueUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  return /\/issues\/\d+$/.test(url.pathname);
}

/** Narrows `value` to an `IssueUrl`, throwing if it is not one. */
export function issueUrl(value: string): IssueUrl {
  if (!isIssueUrl(value)) {
    throw new TypeError(
      `Not an issue URL: expected one ending /issues/<number>, got ${value}`,
    );
  }
  return value;
}
