import type { Clock } from "../ports/index.ts";

/**
 * The instant the fakes are anchored to unless a test says otherwise: a
 * Thursday morning, so that neither window boundary sits on it.
 */
export const FROZEN_NOW = new Date("2026-01-01T06:00:00.000Z");

/** A clock frozen at a given instant. */
export class FakeClock implements Clock {
  readonly #now: Date;

  constructor(now: Date = FROZEN_NOW) {
    this.#now = now;
  }

  now(): Date {
    return new Date(this.#now);
  }
}
