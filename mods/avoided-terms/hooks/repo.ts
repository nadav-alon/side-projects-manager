declare const repoSlugBrand: unique symbol

/** A repo as `owner/repo`, in the case it was written in; values enter through `repoSlug` or `isRepoSlug`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }

const repoSlugPattern = /^[\w.-]+\/[\w.-]+$/

export function isRepoSlug(value: string): value is RepoSlug {
  return repoSlugPattern.test(value)
}

/** Narrows `value` to a `RepoSlug`, throwing if it is not shaped like one. */
export function repoSlug(value: string): RepoSlug {
  if (!isRepoSlug(value)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return value
}

/** Whether two repos are the same: GitHub names are case-insensitive. */
export function sameRepo(a: RepoSlug, b: RepoSlug): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The repo a `--repo` or `GH_REPO` value names: `OWNER/REPO`, with a host (and its scheme) in front or not; null when it is none. */
export function optionalRepo(value: string): RepoSlug | null {
  const parts = value.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')
  const slug = (parts.length === 3 ? parts.slice(1) : parts).join('/')
  return isRepoSlug(slug) ? slug : null
}

/** The repo an issue or pull request URL names; null when the argument is not one. */
export function urlRepo(arg: string): RepoSlug | null {
  const slug = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/\d+(?:[/?#].*)?$/.exec(arg)?.[1]
  return slug !== undefined && isRepoSlug(slug) ? slug : null
}
