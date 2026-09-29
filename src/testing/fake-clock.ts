import type { Clock, Milliseconds } from "../ports/index.ts";

/**
 * The instant the fakes are anchored to unless a test says otherwise: a
 * Thursday morning, so that neither window boundary sits on it.
 */
export const FROZEN_NOW = new Date("2026-01-01T06:00:00.000Z");

/**
 * A clock frozen at a given instant: it moves only when something sleeps on
 * it, by exactly that long and without waiting.
 */
export class FakeClock implements Clock {
  #now: Date;

  constructor(now: Date = FROZEN_NOW) {
    this.#now = now;
  }

  now(): Date {
    return new Date(this.#now);
  }

  async sleep(duration: Milliseconds): Promise<void> {
    this.#now = new Date(this.#now.getTime() + duration);
  }
}
