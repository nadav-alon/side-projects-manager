import type { Day } from "../ports/index.ts";
import type { TriggerLock } from "../trigger-guard.ts";

/** An in-memory lock: every claimed day, kept for the life of the fake. */
export class FakeTriggerLock implements TriggerLock {
  readonly #claimed = new Set<Day>();

  async claim(day: Day): Promise<boolean> {
    if (this.#claimed.has(day)) {
      return false;
    }
    this.#claimed.add(day);
    return true;
  }
}
