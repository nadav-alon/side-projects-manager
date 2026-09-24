import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Halt } from "../halt.ts";
import { isErrorWithCode } from "./error-code.ts";
import { MANAGER_HOME } from "./manager-home.ts";

/** The halt file's name under the manager home, exported for a test that plants or reads one directly. */
export const HALT_FILE = "halt";

/**
 * One file under the manager home, whose mere presence engages the halt.
 * Nothing about its contents matters — unlike the invocation lease, nobody
 * needs to be told apart from anybody else here, only halted told apart from
 * not.
 *
 * Gitignored like `invocation.lease` and `trigger.log`: the registry and the
 * budget document are committed, per-project intent, but a halt is
 * machine-local and says nothing about any one project — a checkout on
 * another machine, or another clone of this one, is unaffected either way.
 */
export function fileHalt(home: string = MANAGER_HOME): Halt {
  const file = path.join(home, HALT_FILE);

  return {
    async engaged(): Promise<boolean> {
      try {
        await access(file);
        return true;
      } catch (error) {
        if (isErrorWithCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
    },

    async engage(): Promise<boolean> {
      try {
        await writeFile(file, "", { flag: "wx" });
        return true;
      } catch (error) {
        if (isErrorWithCode(error, "EEXIST")) {
          return false;
        }
        throw error;
      }
    },

    async clear(): Promise<boolean> {
      try {
        await rm(file);
        return true;
      } catch (error) {
        if (isErrorWithCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
    },
  };
}
