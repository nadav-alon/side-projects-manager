// The part of `project-switcher/hooks/switcher.ts` that its `locations.ts` needs, which this mod carries a
// copy of, since a mod can only import from its own folder.

declare const absolutePathBrand: unique symbol

/** An absolute filesystem path; values enter through `absolutePath` or `isAbsolutePath`. */
export type AbsolutePath = string & { readonly [absolutePathBrand]: true }

export function isAbsolutePath(value: string): value is AbsolutePath {
  return value.startsWith('/')
}

/** Narrows `value` to an `AbsolutePath`, throwing if it is not one. */
export function absolutePath(value: string): AbsolutePath {
  if (!isAbsolutePath(value)) throw new TypeError(`Not an absolute path: ${JSON.stringify(value)}`)
  return value
}

/** `relative` under `base`, however many trailing slashes `base` has. */
export function joinPath(base: AbsolutePath, relative: string): AbsolutePath {
  return absolutePath(`${base.replace(/\/+$/, '')}/${relative}`)
}
