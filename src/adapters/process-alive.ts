import type { ProcessId } from "../ports/index.ts";

/**
 * Whether `pid` names a process still running. Shared by the invocation
 * lease, which uses it to decide whether a lease file is stale, and the
 * status command, which uses it to tell an invocation record still running
 * apart from one that died without closing.
 *
 * Pid reuse after a reboot is accepted as negligible, the same as the
 * invocation lease already accepts of its own holder's pid.
 */
export function isProcessAlive(pid: ProcessId): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorWithCode(error, "ESRCH")) {
      return false;
    }
    if (isErrorWithCode(error, "EPERM")) {
      return true;
    }
    throw error;
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
