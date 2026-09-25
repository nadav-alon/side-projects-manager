#!/usr/bin/env node
import path from "node:path";

import { documentStore } from "../adapters/document-store.ts";
import { HALT_FILE, fileHalt } from "../adapters/file-halt.ts";
import { MANAGER_HOME } from "../adapters/manager-home.ts";
import { errorMessage } from "../error-message.ts";
import { RESUME_COMMAND } from "../halt.ts";
import { isClosedInvocation } from "../ports/index.ts";

/**
 * Ends the day run in flight and halts the loop (CONTEXT.md: Halt), replacing
 * finding a run's pid in `status` and signalling it by hand.
 *
 * Halts first, unconditionally, the same idempotent engage `halt` itself
 * performs: a developer reaching for `stop` wants the loop to stay quiet
 * afterwards, not just this one invocation ended.
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
  const inFlight = journal.records.some((record) => !isClosedInvocation(record));
  if (!inFlight) {
    console.log("No run was in progress.");
  }
}

main().catch((error: unknown) => {
  console.error(`stop failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
