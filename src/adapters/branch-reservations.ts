import type { Branch, Checkout } from "../ports/index.ts";

/**
 * The branch names each checkout has handed to a run still in progress. A
 * checkout none of whose names are reserved has no entry.
 */
const branchesInProgress = new Map<Checkout, Set<Branch>>();

/**
 * Holds `name` for a run on `checkout` until `unreserveBranch` hands it back.
 *
 * A run's branch reaches the checkout only when it is fetched back, so until
 * then the checkout cannot say the name is taken, and a second run of the same
 * ticket would be handed it too. Process-wide, like the checkout lock names are
 * chosen and reserved under, because two sandboxes can share a checkout.
 */
export function reserveBranch(checkout: Checkout, name: Branch): void {
  const reserved = branchesInProgress.get(checkout) ?? new Set<Branch>();
  branchesInProgress.set(checkout, reserved.add(name));
}

/** Whether a run in progress on `checkout` holds `name`. */
export function isBranchReserved(checkout: Checkout, name: Branch): boolean {
  return branchesInProgress.get(checkout)?.has(name) ?? false;
}

/** Hands `name` back once the run it was reserved for has ended. */
export function unreserveBranch(checkout: Checkout, name: Branch): void {
  const reserved = branchesInProgress.get(checkout);
  reserved?.delete(name);
  if (reserved?.size === 0) {
    branchesInProgress.delete(checkout);
  }
}
