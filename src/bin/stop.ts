#!/usr/bin/env node
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { documentStore } from "../adapters/document-store.ts";
import { isErrorWithCode } from "../adapters/error-code.ts";
import { HALT_FILE, fileHalt } from "../adapters/file-halt.ts";
import { MANAGER_HOME } from "../adapters/manager-home.ts";
import { errorMessage } from "../error-message.ts";
import { RESUME_COMMAND } from "../halt.ts";
import {
  isClosedInvocation,
  milliseconds,
  type InvocationRecord,
  type Milliseconds,
  type ProcessId,
} from "../ports/index.ts";

/**
 * Whether `pid` is a process this developer can signal. Unlike
 * `isProcessAlive` (`src/adapters/process-alive.ts`), `EPERM` counts as not
 * ours rather than alive: the lease and `status` accept a wrong guess there
 * as negligible, costing at most a skipped firing, but signalling a pid that
 * has been reused by a stranger's process is a real hazard `stop` must not
 * risk.
 */
function isOwnedProcess(pid: ProcessId): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorWithCode(error, "ESRCH") || isErrorWithCode(error, "EPERM")) {
      return false;
    }
    throw error;
  }
}

/**
 * Every record still in flight (CONTEXT.md: In flight) whose process is
 * still alive and this developer's own — found through the journal rather
 * than `ps`, the same way `status` already reads it, and never a record
 * whose process is already gone or belongs to someone else.
 */
function liveInFlightProcesses(
  records: readonly InvocationRecord[],
): ProcessId[] {
  return records
    .filter((record) => !isClosedInvocation(record))
    .map((record) => record.process)
    .filter((pid) => isOwnedProcess(pid));
}

/**
 * The gap `signalStop` leaves between its two `--now` signals. Real, rather
 * than none: two SIGINTs sent back to back are not guaranteed two
 * deliveries, only one process the kernel is free to coalesce into a single
 * pending signal if the first hasn't been handled yet — the same reason the
 * loop's own second-interrupt test waits for the first to be seen before
 * sending the next.
 */
const SECOND_SIGNAL_DELAY: Milliseconds = milliseconds(100);

/**
 * Sends `pid` one `SIGINT`, treating the process having already exited
 * (`ESRCH`) as a stop that already happened rather than a failure: a
 * process gone between `liveInFlightProcesses` and this call, or between
 * this call's own two signals under `--now`, has been stopped either way.
 */
function signalOnce(pid: ProcessId): void {
  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    if (!isErrorWithCode(error, "ESRCH")) {
      throw error;
    }
  }
}

/**
 * Signals `pid` the stop `stopOnInterrupt` (`src/bin/morning-run.ts`) already
 * handles: once for a graceful stop, twice for `now` — a second Ctrl+C's
 * abandon, sent `SECOND_SIGNAL_DELAY` after the first.
 */
async function signalStop(pid: ProcessId, now: boolean): Promise<void> {
  signalOnce(pid);
  if (now) {
    await sleep(SECOND_SIGNAL_DELAY);
    signalOnce(pid);
  }
}

/**
 * Ends the invocation in flight and halts the loop (CONTEXT.md: Halt).
 *
 * Halts first, unconditionally, the same idempotent engage `halt` itself
 * performs: a developer reaching for `stop` wants the loop to stay quiet
 * afterwards, not just this one invocation ended. Then signals whichever
 * invocation the journal shows still in flight and alive the same stop
 * `stopOnInterrupt` (`src/bin/morning-run.ts`) already handles: a stand
 * down (CONTEXT.md: Stand down) — nothing further starts, runs in progress
 * finish, and the summary publishes — unless `--now` is given, which
 * abandons them instead, the same as a second Ctrl+C.
 */
async function main(): Promise<void> {
  const now = process.argv.slice(2).includes("--now");
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

  await Promise.all(live.map((pid) => signalStop(pid, now)));
  console.log(
    now
      ? "Stopping now: whatever was in progress is being abandoned."
      : "Stopping: nothing further will start. Runs in progress will finish and the summary will publish.",
  );
}

main().catch((error: unknown) => {
  console.error(`stop failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
