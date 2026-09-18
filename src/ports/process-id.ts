declare const processIdBrand: unique symbol;

/**
 * The OS process carrying out one invocation. Branded so it is never
 * confused with a token count or any other number the loop passes around;
 * its actual use is as half an invocation record's identity, paired with
 * `openedAt` to find the record a later close should update.
 */
export type ProcessId = number & { readonly [processIdBrand]: true };

/** Whether `value` is a usable process id: a whole number above 0. */
export function isProcessId(value: number): value is ProcessId {
  return Number.isSafeInteger(value) && value > 0;
}

/** Narrows `value` to a `ProcessId`, throwing if it is not one. */
export function processId(value: number): ProcessId {
  if (!isProcessId(value)) {
    throw new TypeError(
      `Not a process id, expected a whole number above 0: ${value}`,
    );
  }
  return value;
}
