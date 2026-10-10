import { isRepoSlug } from "./repo-slug.ts";
import type { RepoSlug } from "./repo-slug.ts";

declare const remoteUrlBrand: unique symbol;

/**
 * The address of a git remote: what `git remote get-url` answers, and what an
 * apply-review run's clone pushes to.
 *
 * Branded, because a remote, a checkout path and a pull request URL are all
 * strings, and a clone whose `origin` was set to the wrong one pushes nowhere
 * the pull request can see. Values enter through `remoteUrl` or `isRemoteUrl`.
 */
export type RemoteUrl = string & { readonly [remoteUrlBrand]: true };

/** Git's scp-like SSH shorthand: `git@github.com:owner/repo.git`. */
const SCP_LIKE = /^[^\s@/:]+@[^\s/:]+:\S+$/;

/** The URL schemes git itself can fetch from and push to. */
const SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "file:"]);

/**
 * Whether `value` is an address git can reach a remote at: an absolute local
 * path, the scp-like SSH shorthand, or a URL in one of git's own schemes.
 * A relative path is refused, since it names nothing once the directory it was
 * relative to is not the one reading it; so is a value spanning more than one
 * line, which is output, not an address.
 */
export function isRemoteUrl(value: string): value is RemoteUrl {
  if (value === "" || /[\r\n]/.test(value)) {
    return false;
  }
  if (value.startsWith("/") || SCP_LIKE.test(value)) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return SCHEMES.has(url.protocol) && url.pathname.length > 1;
}

/** Narrows `value` to a `RemoteUrl`, throwing if git could not reach it. */
export function remoteUrl(value: string): RemoteUrl {
  if (!isRemoteUrl(value)) {
    throw new TypeError(`Not a git remote address: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The `owner/repo` a remote address ends with, over HTTPS, SSH or the `git@`
 * shorthand alike; `undefined` for a remote that is not a GitHub-shaped repo,
 * such as a local path.
 */
export function repoOfRemote(remote: RemoteUrl): RepoSlug | undefined {
  const candidate = /([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
  return candidate !== undefined && isRepoSlug(candidate)
    ? candidate
    : undefined;
}
