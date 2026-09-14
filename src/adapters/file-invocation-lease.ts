import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { InvocationLease } from "../trigger-guard.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const LEASE_FILE = "invocation.lease";

/**
 * One file under the manager home, holding the pid of whichever process
 * currently holds the lease.
 *
 * Creating the file *is* the acquire: `wx` fails if it already exists, so two
 * firings racing for it can't both believe they got there first — the
 * filesystem enforces the exclusion, not anything this process remembers. A
 * file whose pid is no longer alive is stale: it is removed and creation
 * retried, so whichever firing's retry wins the race is the one that gets it —
 * the same `wx` guarantee, not a second mechanism.
 */
export function fileInvocationLease(
  home: string = MANAGER_HOME,
): InvocationLease {
  const file = path.join(home, LEASE_FILE);

  return {
    async acquire(): Promise<boolean> {
      if (await create(file)) {
        return true;
      }
      if (await heldByLiveProcess(file)) {
        return false;
      }
      await removeStale(file);
      return create(file);
    },

    async release(): Promise<void> {
      await rm(file, { force: true });
    },
  };
}

async function create(file: string): Promise<boolean> {
  try {
    await writeFile(file, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      return false;
    }
    throw error;
  }
}

async function heldByLiveProcess(file: string): Promise<boolean> {
  const pid = await readPid(file);
  return pid !== undefined && isAlive(pid);
}

async function removeStale(file: string): Promise<void> {
  try {
    await rm(file);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt(await readFile(file, "utf8"), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Whether `pid` names a process still running — pid reuse after a reboot is accepted as negligible. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorWithCode(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isNoSuchProcess(error: unknown): boolean {
  return isErrorWithCode(error, "ESRCH");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
