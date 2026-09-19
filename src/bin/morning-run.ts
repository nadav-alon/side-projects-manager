#!/usr/bin/env node
import { containerSandbox } from "../adapters/container-sandbox.ts";
import { documentStore } from "../adapters/document-store.ts";
import { fileInvocationLease } from "../adapters/file-invocation-lease.ts";
import { ghIssueTracker } from "../adapters/gh-issue-tracker.ts";
import { githubRepoHost } from "../adapters/github-repo-host.ts";
import {
  CHECKOUT_ROOT,
  readImageLabels,
  staleImageWarning,
} from "../adapters/sandbox-image.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { sessionLogUsageLedger } from "../adapters/usage-ledger/session-log-usage-ledger.ts";
import { errorMessage } from "../error-message.ts";
import { failedOnInfrastructure } from "../iteration-outcome.ts";
import { invocationClosing, neverReportedClosing } from "../journal-record.ts";
import { morningLoop } from "../morning-run.ts";
import {
  exitCode,
  processId,
  type InvocationClosing,
  type Journal,
  type OpenInvocation,
  type Store,
} from "../ports/index.ts";
import { invokeExclusively } from "../trigger-guard.ts";
import { STOP_SIGNALS, onShieldGone, runShielded } from "./shielded-child.ts";

/**
 * Set on the process that actually runs the loop, so the command knows it is
 * that process rather than the one shielding it.
 */
const LOOP_PROCESS = "SIDE_PROJECTS_MANAGER_LOOP_PROCESS";

/** Exit code of a process ended by SIGINT, as a shell reports it. */
const INTERRUPTED = 130;

// This file again, as the loop process.
//
// Overridable so a test can point it at a script that never touches the
// journal, standing in for the one case that matters here: a loop entry
// point that has gone missing from under the trigger that spawns it, which
// is exactly what a moved manager home produces since the triggers hardcode
// an absolute path to the checkout.
const LOOP_ENTRY_POINT =
  process.env["SIDE_PROJECTS_MANAGER_LOOP_ENTRY_POINT"] ||
  import.meta.filename;

/**
 * The trigger side of the loop: the composition root, and nothing else. Every
 * trigger — the hourly schedule and a developer running `npm run morning-run`
 * by hand — calls this file directly, and the invocation lease here
 * (`../trigger-guard.ts`) is what stops two of them overlapping: whichever
 * acquires it runs the loop, and every other firing, however long that one
 * takes, is a no-op that says an invocation is already running. `morningLoop`
 * itself carries none of this — it stays callable with no lease at all.
 *
 * Runs the loop in a child shielded from the terminal's Ctrl+C (see
 * `runShielded`), so an interrupt can stop the morning without killing what it
 * has in progress.
 *
 * Recording the invocation happens here, around the loop, rather than inside
 * it: `morningLoop` stays a pure function of its ports, and this is the one
 * place that already has both the store and the finished report.
 */
async function main(): Promise<void> {
  if (process.env[LOOP_PROCESS] === undefined) {
    const invoked = await invokeExclusively(fileInvocationLease(), invokeLoop);
    if (!invoked) {
      console.log("an invocation is already running.");
    }
    return;
  }

  // Printing is for whoever is watching, and a closed terminal is nobody: a
  // failed write must not crash a morning that still has runs to finish and a
  // summary to publish.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {});
  }

  // Before the loop rather than inside a run: a stale image fails every run it
  // starts, and whoever is watching should hear why before the first one.
  const staleImage = await staleImageWarning(
    CHECKOUT_ROOT,
    await readImageLabels(),
  );
  if (staleImage !== undefined) {
    console.log(staleImage);
  }

  const store = documentStore();
  const opened = await openJournalRecord(store, systemClock.now());

  const report = await morningLoop(
    {
      tracker: ghIssueTracker(),
      repoHost: githubRepoHost(),
      sandbox: containerSandbox(),
      ledger: sessionLogUsageLedger,
      clock: systemClock,
      store,
    },
    { stop: stopOnInterrupt() },
  );

  console.log(report.message);
  await closeJournalRecord(
    store,
    opened,
    invocationClosing(report, systemClock.now()),
  );

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
 * Runs the loop itself in a shielded child, once the lease is held: so a
 * Ctrl+C reaches the loop once, passed on from `stopOnInterrupt`, rather than
 * once from the terminal's whole foreground group and again from here.
 */
async function invokeLoop(): Promise<void> {
  const store = documentStore();
  // Noted before the child even exists, so a record it opens the instant it
  // starts still counts as its own — the comparison below is `>=`.
  const openedAt = systemClock.now();
  // `runShielded` rejects rather than resolving when the process could not
  // even be spawned — the purest case of the loop never having started, so
  // it is read the same as any other failure to report: exit code 1, and a
  // record saying so.
  const exit = await runShielded([LOOP_ENTRY_POINT], {
    ...process.env,
    [LOOP_PROCESS]: "1",
  }).then(
    // The child already reported its own failure; passing its exit code
    // through is all this wrapper owes whoever is watching it run.
    (code) => code ?? 1,
    () => 1,
  );
  await recordIfNeverReported(store, openedAt, exit);
  process.exitCode = exit;
}

/**
 * Appends a closed record saying the invocation never reported, carrying
 * `exit`, when the loop's process left no record of its own opened at or
 * after `openedAt`. The loop records everything that happens once it is
 * running; this is the one thing it cannot record for itself — never having
 * started at all.
 *
 * Reads the journal back rather than being told by the child, which stays
 * uncoupled from the process that spawned it: it is given no identity and no
 * argument beyond its own entry point.
 *
 * Never throws: a journal that cannot be read or written is said on stderr,
 * the same policy the loop follows around its own recording, so observability
 * here is never what fails an invocation that has already finished.
 */
async function recordIfNeverReported(
  store: Store,
  openedAt: Date,
  exit: number,
): Promise<void> {
  const journal = await readJournal(store);
  if (journal === undefined) {
    return;
  }
  const reported = journal.records.some(
    (record) => record.openedAt.getTime() >= openedAt.getTime(),
  );
  if (reported) {
    return;
  }
  const opened = await openJournalRecord(store, openedAt);
  await closeJournalRecord(
    store,
    opened,
    neverReportedClosing(systemClock.now(), exitCode(exit)),
  );
}

/**
 * The journal as it stands, or `undefined` when it could not be read — said
 * on stderr and nothing more, the same policy as opening and closing a
 * record, so a journal nobody can read is never what fails an invocation.
 */
async function readJournal(store: Store): Promise<Journal | undefined> {
  try {
    return await store.loadJournal();
  } catch (error: unknown) {
    console.error(
      `morning-run: the journal could not be read: ${errorMessage(error)}`,
    );
    return undefined;
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
  // Its shield killed outright, nobody is left to interrupt a second time:
  // stop as the first interrupt would, and let what is in progress finish.
  onShieldGone(() => {
    if (!controller.signal.aborted) {
      onStop();
    }
  });
  return controller.signal;
}

/**
 * Opens the invocation's journal record, naming this process and `openedAt`,
 * the instant it started. `undefined` when the journal could not be written —
 * said on stderr and nothing more, since observability must never be the thing
 * that fails a morning, and an invocation with no handle simply closes nothing.
 */
async function openJournalRecord(
  store: Store,
  openedAt: Date,
): Promise<OpenInvocation | undefined> {
  try {
    return await store.openInvocation({
      openedAt,
      process: processId(process.pid),
    });
  } catch (error: unknown) {
    console.error(
      `morning-run: the journal could not be opened: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/** Closes `opened` with `closing`, the same silent-on-stderr policy as opening. */
async function closeJournalRecord(
  store: Store,
  opened: OpenInvocation | undefined,
  closing: InvocationClosing,
): Promise<void> {
  if (opened === undefined) {
    return;
  }
  try {
    await store.closeInvocation(opened, closing);
  } catch (error: unknown) {
    console.error(
      `morning-run: the journal could not be closed: ${errorMessage(error)}`,
    );
  }
}

main().catch((error: unknown) => {
  // A failed morning reports what happened; it never greets the developer
  // with a stack trace.
  console.error(`morning-run failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
