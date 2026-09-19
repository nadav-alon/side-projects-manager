declare const exitCodeBrand: unique symbol;

/**
 * The status a process exited with, in the single-byte range every OS
 * reports it in. Branded so it is never confused with a token count or any
 * other plain number a journal record carries; its actual use is what the
 * guarded trigger's invocation record carries when the loop's own process
 * left none of its own.
 */
export type ExitCode = number & { readonly [exitCodeBrand]: true };

/** Whether `value` is a usable exit code: a whole number from 0 to 255. */
export function isExitCode(value: number): value is ExitCode {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

/** Narrows `value` to an `ExitCode`, throwing if it is not one. */
export function exitCode(value: number): ExitCode {
  if (!isExitCode(value)) {
    throw new TypeError(
      `Not an exit code, expected a whole number from 0 to 255: ${value}`,
    );
  }
  return value;
}
