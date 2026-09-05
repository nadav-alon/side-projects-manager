#!/usr/bin/env node
import { documentStore } from "../adapters/document-store.ts";
import { ghIssueTracker } from "../adapters/gh-issue-tracker.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { stubSandbox, stubUsageLedger } from "../adapters/stub-ports.ts";
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
    tracker: ghIssueTracker(),
    sandbox: stubSandbox,
    ledger: stubUsageLedger,
    clock: systemClock,
    store: documentStore(),
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
