/**
 * What a trigger needs to coordinate with every other trigger: exclusive
 * access to one invocation at a time, however long it runs.
 *
 * Not one of the loop's six ports (CONTEXT.md: Port) — the loop itself never
 * sees this. It exists only for whatever calls `morningLoop`, which is
 * exactly where the invocation lease belongs: the loop stays callable
 * directly, with no trigger-specific logic inside it.
 */
export interface InvocationLease {
  /**
   * Acquires the lease for the calling process. Returns `true` if nothing
   * else holds it, `false` if a live process already does. A lease left by a
   * process that is no longer alive is stale and is taken over rather than
   * refused, so a process killed mid-run does not stop the loop for good.
   */
  acquire(): Promise<boolean>;

  /** Releases the lease, so a later acquire can succeed. */
  release(): Promise<void>;
}

/**
 * Calls `invoke` only for whichever firing acquires `lease`; every other
 * firing while it is held is refused (CONTEXT.md: Invocation). Returns
 * whether this call was the one that invoked it.
 *
 * The lease is released once `invoke` settles, whether it resolves or
 * throws — a failed invocation must not leave every later firing believing
 * one is still running.
 */
export async function invokeExclusively(
  lease: InvocationLease,
  invoke: () => Promise<void>,
): Promise<boolean> {
  const acquired = await lease.acquire();
  if (!acquired) {
    return false;
  }
  try {
    await invoke();
  } finally {
    await lease.release();
  }
  return true;
}
