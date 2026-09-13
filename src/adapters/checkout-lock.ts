import type { Checkout } from "../ports/index.ts";

/**
 * The end of each checkout's line: the last piece of work to ask for its lock.
 * Never rejecting, so work that fails delays the work behind it rather than
 * cancelling it. A checkout whose line has emptied has no entry.
 */
const lastInLine = new Map<Checkout, Promise<void>>();

/**
 * Does `work` once nothing else holds the lock for `checkout`, and holds it
 * until `work` settles, however it settles.
 *
 * A project's checkout is shared by everything working that project: the
 * sandbox chooses branch names from it, clones from it and fetches branches
 * back into it, and the repo host brings it up to date and pushes from it.
 * Git's own ref and index locks make two of those at once fail rather than
 * wait, so an adapter touching the checkout takes this lock around the git
 * steps that do — and only around those, never around an agent's work, which
 * happens in a clone of its own.
 *
 * Process-wide, because the adapters that share a checkout are separate
 * objects. Two separate invocations of the manager are not covered — the
 * once-per-day lock is what stops those overlapping. Serializes callers per
 * checkout and does nothing else: work on different checkouts never waits on
 * each other.
 */
export async function withCheckoutLock<T>(
  checkout: Checkout,
  work: () => Promise<T>,
): Promise<T> {
  const ahead = lastInLine.get(checkout) ?? Promise.resolve();
  const result = ahead.then(work);
  const last = result.then(
    () => undefined,
    () => undefined,
  );
  lastInLine.set(checkout, last);

  try {
    return await result;
  } finally {
    // Only the last in line clears the entry; work that has lined up behind
    // since owns it now.
    if (lastInLine.get(checkout) === last) {
      lastInLine.delete(checkout);
    }
  }
}
