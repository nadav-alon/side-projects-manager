declare const branchNameBrand: unique symbol

/** A git branch name as `git` prints it, without the `refs/heads/` prefix. */
export type BranchName = string & { readonly [branchNameBrand]: true }

/** The guard: a non-empty name with no whitespace, control characters or ref-forbidden characters. */
export function isBranchName(value: string): value is BranchName {
  return value !== '' && !/[\s\x00-\x1f\x7f~^:?*[\\]/.test(value) && !value.startsWith('refs/')
}

/** The constructor: narrows, or throws naming the offending value. */
export function branchName(value: string): BranchName {
  if (!isBranchName(value)) throw new Error(`Not a BranchName: ${JSON.stringify(value)}`)
  return value
}
