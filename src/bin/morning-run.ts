#!/usr/bin/env node
import { systemClock } from "../adapters/system-clock.ts";
import { stubIssueTracker, stubSandbox, stubStore } from "../adapters/stub-ports.ts";
import { sessionLogUsageLedger } from "../adapters/usage-ledger/session-log-usage-ledger.ts";
import { morningRun } from "../morning-run.ts";

/**
 * The trigger side of the loop: the composition root, and nothing else. Every
 * trigger is a caller of `morningRun`, exactly like this one.
 *
 * TODO[#15]: the daily schedule, the first-logon guard, and the once-per-day
 * lock that stops the two double-firing.
 */
async function main(): Promise<void> {
  const report = await morningRun({
    tracker: stubIssueTracker,
    sandbox: stubSandbox,
    ledger: sessionLogUsageLedger,
    clock: systemClock,
    store: stubStore,
  });

  console.log(report.message);
}

main().catch((error: unknown) => {
  // A failed morning reports what happened; it never greets the developer
  // with a stack trace.
  console.error(
    `morning-run failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
