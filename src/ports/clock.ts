import type { Milliseconds } from "./milliseconds.ts";

/**
 * Time as an injected dependency.
 *
 * Rolling-window budget arithmetic and "when was this project last worked"
 * both read time, and both need to be assertable in tests, so nothing in the
 * loop calls `Date.now()` directly. Waiting is the same dependency: nothing
 * in the loop calls `setTimeout` directly either.
 */
export interface Clock {
  now(): Date;
  /** Resolves once `duration` has passed on this clock. */
  sleep(duration: Milliseconds): Promise<void>;
}
