import type { TriggerLock } from "../trigger-guard.ts";

/** An in-memory lock: every claimed day, kept for the life of the fake. */
export class FakeTriggerLock implements TriggerLock {
  readonly #claimed = new Set<string>();

  async claim(day: string): Promise<boolean> {
    if (this.#claimed.has(day)) {
      return false;
    }
    this.#claimed.add(day);
    return true;
  }
}
