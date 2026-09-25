#!/usr/bin/env node
import path from "node:path";

import { HALT_FILE, fileHalt } from "../adapters/file-halt.ts";
import { MANAGER_HOME } from "../adapters/manager-home.ts";
import { errorMessage } from "../error-message.ts";
import { RESUME_COMMAND } from "../halt.ts";

/**
 * Engages the halt (CONTEXT.md: Halt): every firing, hourly or manual, does
 * nothing until `resume` clears it. Idempotent — engaging an already-engaged
 * halt says so rather than pretending it just happened.
 *
 * Names the halt file's own path: `MANAGER_HOME` here can differ from a
 * firing's — an interactive shell and the cron line can disagree about
 * `SIDE_PROJECTS_MANAGER_HOME` — and a halt written where a firing never
 * looks would otherwise hold silently.
 */
async function main(): Promise<void> {
  const haltFile = path.join(MANAGER_HOME, HALT_FILE);
  const engaged = await fileHalt().engage();
  console.log(
    engaged
      ? `Halted: the loop will do nothing until you run \`${RESUME_COMMAND}\`. (${haltFile})`
      : `Already halted. (${haltFile})`,
  );
}

main().catch((error: unknown) => {
  console.error(`halt failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
