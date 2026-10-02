#!/usr/bin/env node
import path from "node:path";

import { HALT_FILE, fileHalt } from "../adapters/file-halt.ts";
import { MANAGER_HOME } from "../adapters/manager-home.ts";
import { errorMessage } from "../error-message.ts";

/**
 * Clears the halt (CONTEXT.md: Halt): the next firing, scheduled or manual, runs
 * normally again. Idempotent — clearing a halt that was never engaged says so
 * rather than pretending it just happened.
 *
 * Names the halt file's own path — see `bin/halt.ts` on why `MANAGER_HOME`
 * here can differ from a firing's.
 */
async function main(): Promise<void> {
  const haltFile = path.join(MANAGER_HOME, HALT_FILE);
  const cleared = await fileHalt().clear();
  console.log(
    cleared
      ? `Resumed: the loop will run normally again. (${haltFile})`
      : `Wasn't halted. (${haltFile})`,
  );
}

main().catch((error: unknown) => {
  console.error(`resume failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
