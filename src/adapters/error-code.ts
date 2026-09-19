/** Whether `error` is a Node.js system error carrying `code`. */
export function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
