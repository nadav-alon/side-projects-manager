#!/usr/bin/env node
import { systemClock } from "../adapters/system-clock.ts";
import {
  stubIssueTracker,
  stubSandbox,
  stubStore,
  stubUsageLedger,
} from "../adapters/stub-ports.ts";
import { morningRun } from "../morning-run.ts";

/**
 * The trigger side of the loop: the composition root, and nothing else. The
 * schedule, the logon guard and any future cloud trigger (#15) are callers of
 * `morningRun`, exactly like this one.
 */
async function main(): Promise<number> {
  const report = await morningRun({
    tracker: stubIssueTracker,
    sandbox: stubSandbox,
    ledger: stubUsageLedger,
    clock: systemClock,
    store: stubStore,
  });

  console.log(report.message);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A failed morning reports what happened; it never greets the developer
    // with a stack trace.
    console.error(
      `morning-run failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  },
);
