import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TriggerLock } from "../trigger-guard.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const LOCK_DIRECTORY = ".trigger-locks";

/**
 * One empty file per claimed day, under the manager home.
 *
 * Creating the file *is* the claim: `wx` fails if it already exists, so two
 * triggers racing for the same day can't both believe they got there first —
 * the filesystem enforces the exclusion, not anything this process remembers.
 * Naming the file after the day, rather than keeping one lock file whose
 * contents are overwritten, means the claim is already durable the instant
 * it's made: nothing further needs writing once a trigger has decided to run,
 * so a run that fails afterwards has nothing left to lose.
 */
export function fileTriggerLock(home: string = MANAGER_HOME): TriggerLock {
  const directory = path.join(home, LOCK_DIRECTORY);

  return {
    async claim(day: string): Promise<boolean> {
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(path.join(directory, day), "", { flag: "wx" });
        return true;
      } catch (error) {
        if (isAlreadyClaimed(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function isAlreadyClaimed(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
