import { localDay, type Clock, type Day } from "./ports/index.ts";

/**
 * What a trigger needs to coordinate with every other trigger: a way to claim
 * a calendar day, once, however many of them race for it.
 *
 * Not one of the loop's six ports (CONTEXT.md: Port) — the loop itself never
 * sees this. It exists only for whatever calls `morningLoop`, which is exactly
 * where the once-per-day lock belongs: the loop stays callable directly, with
 * no trigger-specific logic inside it.
 */
export interface TriggerLock {
  /**
   * Claims `day` for the trigger. Returns `true` the first time anything
   * claims a given day, `false` to every later trigger the same day —
   * whether that's a second trigger racing the first, or the same trigger
   * asking again. Persisted, so the claim survives a reboot between the
   * asking and the next, and an invocation that fails after claiming it.
   */
  claim(day: Day): Promise<boolean>;
}

/**
 * Calls `invoke` for the calendar day `clock` reports, but only for whichever
 * trigger gets here first that day (CONTEXT.md: Invocation). Returns whether
 * this call was the one that invoked it.
 *
 * The day is claimed before `invoke` is called, not after. An invocation that
 * fails still leaves the day claimed: the loop's own no-retry policy
 * (CONTEXT.md: Hand back) already decides what happens to a failed run, and a
 * second trigger re-invoking the same day because the first invocation didn't
 * finish cleanly would go straight past that policy rather than through it.
 */
export async function invokeOncePerDay(
  lock: TriggerLock,
  clock: Clock,
  invoke: () => Promise<void>,
): Promise<boolean> {
  const claimed = await lock.claim(localDay(clock.now()));
  if (!claimed) {
    return false;
  }
  await invoke();
  return true;
}
