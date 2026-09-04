/**
 * Time as an injected dependency.
 *
 * Rolling-window budget arithmetic and "when was this project last worked"
 * both read time, and both need to be assertable in tests, so nothing in the
 * loop calls `Date.now()` directly.
 */
export interface Clock {
  now(): Date;
}
