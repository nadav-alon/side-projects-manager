import type { Clock } from "./ports/index.ts";

/**
 * What a trigger needs to coordinate with every other trigger: a way to claim
 * a calendar day, once, however many of them race for it.
 *
 * Not one of the loop's six ports (CONTEXT.md: Port) — the loop itself never
 * sees this. It exists only for whatever calls `morningRun`, which is exactly
 * where the once-per-day lock belongs: the loop stays callable directly, with
 * no trigger-specific logic inside it.
 */
export interface TriggerLock {
  /**
   * Claims `day` for the caller. Returns `true` the first time anything
   * claims a given day, `false` to every later caller the same day — whether
   * that caller is a second trigger racing the first, or the same trigger
   * asking again. Persisted, so the claim survives a reboot between the
   * asking and the next, and a run that fails after claiming it.
   */
  claim(day: string): Promise<boolean>;
}

/**
 * Runs `invoke` for the calendar day `clock` reports, but only for whichever
 * caller gets here first that day (CONTEXT.md: Invocation). Returns whether
 * this call was the one that ran it.
 *
 * The day is claimed before `invoke` runs, not after. A run that fails still
 * leaves the day claimed: the loop's own no-retry policy (CONTEXT.md: Hand
 * back) already decides what happens to a failed run, and a second trigger
 * re-invoking the same day because the first invocation didn't finish cleanly
 * would run straight past that policy rather than through it.
 */
export async function runOncePerDay(
  lock: TriggerLock,
  clock: Clock,
  invoke: () => Promise<void>,
): Promise<boolean> {
  const claimed = await lock.claim(dayOf(clock.now()));
  if (!claimed) {
    return false;
  }
  await invoke();
  return true;
}

/**
 * The calendar day `at` falls on, in the machine's local time — the same
 * timezone a developer's schedule and logon happen in, so a day boundary
 * lands where they'd expect it rather than at UTC midnight.
 */
function dayOf(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const date = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${date}`;
}
