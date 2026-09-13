#!/usr/bin/env node
import { containerSandbox } from "../adapters/container-sandbox.ts";
import { documentStore } from "../adapters/document-store.ts";
import { ghIssueTracker } from "../adapters/gh-issue-tracker.ts";
import { githubRepoHost } from "../adapters/github-repo-host.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { sessionLogUsageLedger } from "../adapters/usage-ledger/session-log-usage-ledger.ts";
import { morningLoop } from "../morning-run.ts";

/**
 * The trigger side of the loop: the composition root, and nothing else. Every
 * trigger is a caller of `morningLoop`, exactly like this one — including
 * `guarded-morning-run.ts`, which is what the daily schedule and the logon
 * guard actually call; this file stays the direct, unguarded entry point.
 */
async function main(): Promise<void> {
  const report = await morningLoop({
    tracker: ghIssueTracker(),
    repoHost: githubRepoHost(),
    sandbox: containerSandbox(),
    ledger: sessionLogUsageLedger,
    clock: systemClock,
    store: documentStore(),
  });

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
    report.iterations.some(
      (iteration) =>
        "failure" in iteration && iteration.failure.kind === "infrastructure",
    );
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // A failed morning reports what happened; it never greets the developer
  // with a stack trace.
  console.error(
    `morning-run failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
