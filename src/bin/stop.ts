#!/usr/bin/env node
import path from "node:path";

import { documentStore } from "../adapters/document-store.ts";
import { HALT_FILE, fileHalt } from "../adapters/file-halt.ts";
import { MANAGER_HOME } from "../adapters/manager-home.ts";
import { isProcessAlive } from "../adapters/process-alive.ts";
import { errorMessage } from "../error-message.ts";
import { RESUME_COMMAND } from "../halt.ts";
import {
  isClosedInvocation,
  type InvocationRecord,
  type ProcessId,
} from "../ports/index.ts";

/**
 * Every record still in flight (CONTEXT.md: In flight) whose process is
 * still alive — found through the journal rather than `ps`, the same way
 * `status` already reads it, and never a record whose process is already
 * gone.
 */
function liveInFlightProcesses(
  records: readonly InvocationRecord[],
): ProcessId[] {
  return records
    .filter((record) => !isClosedInvocation(record))
    .map((record) => record.process)
    .filter((pid) => isProcessAlive(pid));
}

/**
 * Ends the day run in flight and halts the loop (CONTEXT.md: Halt), replacing
 * finding a run's pid in `status` and signalling it by hand.
 *
 * Halts first, unconditionally, the same idempotent engage `halt` itself
 * performs: a developer reaching for `stop` wants the loop to stay quiet
 * afterwards, not just this one invocation ended. Then signals whichever
 * invocation the journal shows still in flight and alive the same stop
 * `stopOnInterrupt` (`src/bin/morning-run.ts`) already handles: nothing
 * further starts, runs in progress finish, and the summary publishes.
 */
async function main(): Promise<void> {
  const haltFile = path.join(MANAGER_HOME, HALT_FILE);
  const engaged = await fileHalt().engage();
  console.log(
    engaged
      ? `Halted: the loop will do nothing until you run \`${RESUME_COMMAND}\`. (${haltFile})`
      : `Already halted. (${haltFile})`,
  );

  const journal = await documentStore().loadJournal();
  const live = liveInFlightProcesses(journal.records);
  if (live.length === 0) {
    console.log("No run was in progress.");
    return;
  }

  for (const pid of live) {
    process.kill(pid, "SIGINT");
  }
  console.log(
    "Stopping: nothing further will start. Runs in progress will finish and the summary will publish.",
  );
}

main().catch((error: unknown) => {
  console.error(`stop failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
