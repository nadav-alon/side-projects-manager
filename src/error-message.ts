/**
 * What went wrong, as a sentence a person can read: an `Error`'s message, or
 * whatever was thrown, stringified. Anything can be thrown in JavaScript, and a
 * report that says `[object Object]` or nothing at all is worse than one that
 * says what it was given.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
