declare const branchBrand: unique symbol

/** A git branch name as `git` prints it, without the `refs/heads/` prefix. Mirrors `Branch` in `src/ports/branch.ts`, which a mod cannot import. */
export type Branch = string & { readonly [branchBrand]: true }

/** The characters git refuses in a ref, plus whitespace, which it splits on. */
const FORBIDDEN = /[\s~^:?*[\\]/

/** Whether every character is one git will store in a ref name. */
function printable(value: string): boolean {
  return [...value].every(character => {
    const code = character.codePointAt(0) ?? 0
    return code > 0x1f && code !== 0x7f
  })
}

/**
 * Whether `value` is a name `git branch` would accept; the same guard as `isBranch` in `src/ports/branch.ts`.
 * Stricter than git in one place: a leading `-` is rejected, because a name that reads as an option is a name no command can be handed.
 */
export function isBranch(value: string): value is Branch {
  if (value === '' || value === '@' || value.startsWith('-')) return false
  if (FORBIDDEN.test(value) || !printable(value)) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** Narrows `value` to a `Branch`, throwing if git would not accept it. */
export function branch(value: string): Branch {
  if (!isBranch(value)) throw new TypeError(`Not a branch name git would accept: ${value}`)
  return value
}
