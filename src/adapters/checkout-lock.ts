import type { Checkout } from "../ports/index.ts";

/**
 * The tail of each checkout's queue: the last task to ask for its lock. Never
 * rejecting, so a task that fails delays the one behind it rather than
 * cancelling it. A checkout whose queue has drained has no entry.
 */
const tails = new Map<Checkout, Promise<void>>();

/**
 * Runs `task` once no other task holds the lock for `project`, and holds it
 * until `task` settles, however it settles.
 *
 * A project's checkout is shared by everything working that project: the
 * sandbox chooses branch names from it, clones from it and fetches branches
 * back into it, and the repo host brings it up to date and pushes from it.
 * Git's own ref and index locks make two of those at once fail rather than
 * wait, so an adapter touching the checkout takes this lock around the git
 * steps that do — and only around those, never around an agent's work, which
 * happens in a clone of its own.
 *
 * TODO[#121]: take it in the repo host.
 *
 * Process-wide, because the adapters that share a checkout are separate
 * objects. Two separate invocations of the manager are not covered — the
 * once-per-day lock is what stops those overlapping. Serializes callers per
 * checkout and does nothing else: tasks on different checkouts never wait on
 * each other.
 */
export async function withCheckoutLock<T>(
  project: Checkout,
  task: () => Promise<T>,
): Promise<T> {
  const ahead = tails.get(project) ?? Promise.resolve();
  const result = ahead.then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(project, tail);

  try {
    return await result;
  } finally {
    // Only the last task in line clears the entry; one that has been queued
    // behind since owns it now.
    if (tails.get(project) === tail) {
      tails.delete(project);
    }
  }
}
