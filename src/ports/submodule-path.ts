declare const submodulePathBrand: unique symbol;

/**
 * Where a submodule sits in its project, relative to the project checkout's
 * root — the `latex` that `git ls-files` names for a pinned submodule.
 *
 * Distinct from `Checkout`, the absolute directory the same strings are
 * interpolated beside: a submodule's path joined onto a checkout is a place,
 * and the compiler would otherwise let either stand in for the other. Values
 * enter through `submodulePath` or `isSubmodulePath`.
 */
export type SubmodulePath = string & { readonly [submodulePathBrand]: true };

/** Whether `value` is a path relative to a checkout's root, staying inside it. */
export function isSubmodulePath(value: string): value is SubmodulePath {
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.startsWith("-") &&
    !value.split("/").includes("..")
  );
}

/** Narrows `value` to a `SubmodulePath`, throwing if it is not one. */
export function submodulePath(value: string): SubmodulePath {
  if (!isSubmodulePath(value)) {
    throw new TypeError(
      `Not a submodule path: expected a path relative to the checkout's root, got ${value}`,
    );
  }
  return value;
}
