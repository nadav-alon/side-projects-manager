import path from "node:path";

declare const checkoutBrand: unique symbol;

/**
 * An absolute path to a git checkout the manager owns: a project's clone in
 * the managed location, or the throwaway clone one run happens on.
 *
 * Branded, because the loop passes several unrelated strings around — a branch
 * name, a repo slug, a commit — and the directory is the one that gets written
 * into. Values enter through `checkout` or `isCheckout`.
 */
export type Checkout = string & { readonly [checkoutBrand]: true };

/**
 * Whether `value` is a usable checkout path: absolute, and already in the
 * shape `path.join` produces, so two spellings of one directory can never
 * read as two different checkouts.
 */
export function isCheckout(value: string): value is Checkout {
  if (value === "" || !path.isAbsolute(value)) {
    return false;
  }
  // `normalize` keeps a trailing separator, and `/projects/pilot/` is the same
  // directory as `/projects/pilot` — so it is refused here rather than left to
  // read as a second checkout.
  if (value.length > 1 && value.endsWith(path.sep)) {
    return false;
  }
  return path.normalize(value) === value;
}

/** Narrows `value` to a `Checkout`, throwing if it is not one. */
export function checkout(value: string): Checkout {
  if (!isCheckout(value)) {
    throw new TypeError(
      `Not a checkout: expected a normalised absolute path, got ${value}`,
    );
  }
  return value;
}
