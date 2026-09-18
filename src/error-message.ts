/**
 * What went wrong, as a sentence a person can read: an `Error`'s message, or
 * whatever was thrown, stringified. Anything can be thrown in JavaScript, and a
 * report that says `[object Object]` or nothing at all is worse than one that
 * says what it was given.
 *
 * `sandbox:verify` (package.json) bind-mounts this file alone into the sandbox
 * image, without the rest of `src/`, for `scripts/verify-harness.ts` to import.
 * That only works while this file imports nothing itself — an import added
 * here fails module resolution inside the container instead of at this line.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
