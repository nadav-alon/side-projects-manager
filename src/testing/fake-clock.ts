import type { Clock } from "../ports/index.ts";

/** A clock frozen at a given instant, advanced explicitly by the test. */
export class FakeClock implements Clock {
  #now: Date;

  constructor(now: Date = new Date("2026-01-01T06:00:00.000Z")) {
    this.#now = now;
  }

  now(): Date {
    return new Date(this.#now);
  }

  advanceBy(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
  }
}
