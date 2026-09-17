import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { InvocationLease } from "../trigger-guard.ts";
import { MANAGER_HOME } from "./manager-home.ts";
import { isProcessAlive } from "./process-alive.ts";

/** The lease file's name under the manager home, exported for tests that plant one directly. */
export const LEASE_FILE = "invocation.lease";
const TAKEOVER_FILE = "invocation.lease.takeover";

/**
 * One file under the manager home, holding the pid of whichever process
 * currently holds the lease.
 *
 * Deciding whether `file` is free — created fresh, held by a live process, or
 * stale and there for the taking — and acting on that decision is not one
 * atomic step: taking over a stale file, in particular, means removing it and
 * creating it again. So every `acquire` first creates a second file, `wx`,
 * and only the firing that gets it decides and acts; every other firing
 * refuses this round rather than act on a decision that might no longer hold
 * by the time its own turn comes. Deciding and acting inside that one lock,
 * for every acquire and not only the stale-takeover case, is what keeps a
 * slow firing's plain "does it exist yet" check from landing in the middle of
 * a faster firing's takeover and clobbering its brand-new, live lease.
 *
 * The lock file's own critical section never outlives one `acquire` call —
 * unlike the lease itself, it is never held for the loop's run — so a crash
 * inside it is left unrecovered rather than given the same stale-takeover
 * treatment: recovering a lock that guards recovering a lock has no bottom.
 */
export function fileInvocationLease(
  home: string = MANAGER_HOME,
): InvocationLease {
  const file = path.join(home, LEASE_FILE);
  const takeoverFile = path.join(home, TAKEOVER_FILE);

  return {
    async acquire(): Promise<boolean> {
      if (!(await create(takeoverFile))) {
        return false;
      }
      try {
        if (await create(file)) {
          return true;
        }
        if (await heldByLiveProcess(file)) {
          return false;
        }
        await removeStale(file);
        return await create(file);
      } finally {
        await removeStale(takeoverFile);
      }
    },

    async release(): Promise<void> {
      const holder = await readPid(file);
      if (holder === process.pid) {
        await removeStale(file);
      }
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
  return pid !== undefined && isProcessAlive(pid);
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

async function readPid(file: string): Promise<Pid | undefined> {
  try {
    const parsed = Number.parseInt(await readFile(file, "utf8"), 10);
    return isPid(parsed) ? parsed : undefined;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

declare const pidBrand: unique symbol;

/**
 * A process id read back from a lease file: a positive integer, so a file
 * truncated to `0` or a negative number by a crash mid-write cannot read as
 * every process's own process group and be reported alive forever.
 */
type Pid = number & { readonly [pidBrand]: true };

/** The guard, for a pid parsed from a lease file. */
function isPid(value: number): value is Pid {
  return Number.isInteger(value) && value > 0;
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorWithCode(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
