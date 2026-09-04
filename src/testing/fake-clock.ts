import type { Clock } from "../ports/index.ts";

/** A clock frozen at a given instant. */
export class FakeClock implements Clock {
  readonly #now: Date;

  constructor(now: Date = new Date("2026-01-01T06:00:00.000Z")) {
    this.#now = now;
  }

  now(): Date {
    return new Date(this.#now);
  }
}
