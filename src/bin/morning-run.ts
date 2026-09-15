#!/usr/bin/env node
import { containerSandbox } from "../adapters/container-sandbox.ts";
import { documentStore } from "../adapters/document-store.ts";
import { ghIssueTracker } from "../adapters/gh-issue-tracker.ts";
import { githubRepoHost } from "../adapters/github-repo-host.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { sessionLogUsageLedger } from "../adapters/usage-ledger/session-log-usage-ledger.ts";
import { failedOnInfrastructure } from "../iteration-outcome.ts";
import { morningLoop } from "../morning-run.ts";
import { STOP_SIGNALS, runShielded } from "./shielded-child.ts";

/**
 * Set on the process that actually runs the loop, so the command knows it is
 * that process rather than the one shielding it.
 */
const LOOP_PROCESS = "SIDE_PROJECTS_MANAGER_LOOP_PROCESS";

/** Exit code of a process ended by SIGINT, as a shell reports it. */
const INTERRUPTED = 130;

/**
 * The trigger side of the loop: the composition root, and nothing else. Every
 * trigger is a caller of `morningLoop`, exactly like this one — including
 * `guarded-morning-run.ts`, which is what the daily schedule and the logon
 * guard actually call; this file stays the direct, unguarded entry point.
 *
 * Runs the loop in a child shielded from the terminal's Ctrl+C (see
 * `runShielded`), so an interrupt can stop the morning without killing what it
 * has in progress.
 */
async function main(): Promise<void> {
  if (process.env[LOOP_PROCESS] === undefined) {
    const code = await runShielded([import.meta.filename], {
      ...process.env,
      [LOOP_PROCESS]: "1",
    });
    process.exitCode = code ?? 1;
    return;
  }

  const report = await morningLoop(
    {
      tracker: ghIssueTracker(),
      repoHost: githubRepoHost(),
      sandbox: containerSandbox(),
      ledger: sessionLogUsageLedger,
      clock: systemClock,
      store: documentStore(),
    },
    { stop: stopOnInterrupt() },
  );

  console.log(report.message);

  // A broken setup exits non-zero even though it reported cleanly: whatever
  // triggers the loop reads a morning by its exit code, and a sandbox that is
  // permanently broken but reports success every day is one nobody is told
  // about. An agent that gave up exits zero, because the ticket has been
  // handed back and that is the failure policy working — a trigger that
  // retried a non-zero morning would otherwise run straight into the no-retry
  // rule. An invocation that never finished — a registry that would not
  // parse, say — is reported the same way as a broken sandbox: cleanly, and
  // non-zero.
  const failed =
    report.outcome === "invocation-failed" ||
    report.iterations.some(failedOnInfrastructure);
  if (failed) {
    process.exitCode = 1;
  }
}

/**
 * Aborted by the first stop signal, so the loop starts nothing further but
 * finishes what it has in progress and publishes its summary. A second stop
 * signal is the developer unwilling to wait: the morning ends at once, as an
 * unshielded Ctrl+C would have ended it.
 */
function stopOnInterrupt(): AbortSignal {
  const controller = new AbortController();
  const onStop = (): void => {
    if (!controller.signal.aborted) {
      console.log(
        "Stopping: nothing further will start. Runs in progress will finish and the summary will publish. Interrupt again to stop now, losing them.",
      );
      controller.abort();
      return;
    }
    for (const signal of STOP_SIGNALS) {
      process.off(signal, onStop);
    }
    // The whole group, as Ctrl+C would have signalled it unshielded: each
    // docker client passes SIGINT on to its container, which is the only
    // thing that stops an agent mid-run.
    try {
      process.kill(-process.pid, "SIGINT");
    } catch {
      // No group of its own — the variable set by hand, say. Ending this
      // process is still what was asked for.
    }
    process.exit(INTERRUPTED);
  };
  for (const signal of STOP_SIGNALS) {
    process.on(signal, onStop);
  }
  return controller.signal;
}

main().catch((error: unknown) => {
  // A failed morning reports what happened; it never greets the developer
  // with a stack trace.
  console.error(
    `morning-run failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
