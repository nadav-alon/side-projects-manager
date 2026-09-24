#!/usr/bin/env node
import { documentStore } from "../adapters/document-store.ts";
import { CHECKOUT_ROOT } from "../adapters/manager-home.ts";
import { isProcessAlive } from "../adapters/process-alive.ts";
import { readTranscriptTail } from "../adapters/container-sandbox.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { systemTriggerRegistrations } from "../adapters/system-trigger-registrations.ts";
import { sessionLogUsageLedger } from "../adapters/usage-ledger/session-log-usage-ledger.ts";
import { budgetStatus, runsRecorded } from "../budget-gate.ts";
import { errorMessage } from "../error-message.ts";
import { hasAnnouncedOn, isClosedInvocation, localDay } from "../ports/index.ts";
import {
  RECENT_STEPS_SHOWN,
  statusReport,
  type StatusJournal,
  type StatusRecord,
  type StatusRun,
} from "../status-report.ts";

/**
 * "Is the loop alive?", without reading source: reads the journal, the state
 * document and the budget document, and prints what `statusReport` makes of
 * them — the budget lines through the same `budgetStatus` arithmetic the
 * gate itself consults, read from `sessionLogUsageLedger` rather than the
 * network.
 *
 * Read-only, like the report it prints — it never claims a day, never opens
 * or closes a record, and makes no network call.
 */
async function main(): Promise<void> {
  const store = documentStore();
  const triggers = systemTriggerRegistrations();
  const [journal, state, budget, schedule, logonGuard] = await Promise.all([
    store.loadJournal(),
    store.loadState(),
    store.loadBudget(),
    triggers.schedule(),
    triggers.logonGuard(),
  ]);
  const now = systemClock.now();
  const windows = await sessionLogUsageLedger.read(now, budget.observedResetAt);

  const resolved: StatusJournal = {
    records: await Promise.all(
      journal.records.map(async (record): Promise<StatusRecord> => {
        if (isClosedInvocation(record)) {
          return record;
        }
        const runs: StatusRun[] = await Promise.all(
          (record.runs ?? []).map(async (run) => ({
            run,
            steps: await readTranscriptTail(run.transcriptDirectory, RECENT_STEPS_SHOWN),
          })),
        );
        return {
          openedAt: record.openedAt,
          process: record.process,
          alive: isProcessAlive(record.process),
          runs,
        };
      }),
    ),
  };
  const todayClaimed = hasAnnouncedOn(state.announcedOn, localDay(now));

  for (const line of statusReport(
    resolved,
    todayClaimed,
    now,
    { schedule, logonGuard, managerHome: CHECKOUT_ROOT },
    budgetStatus(windows, budget, runsRecorded(state.projects)),
  )) {
    console.log(line);
  }
}

main().catch((error: unknown) => {
  console.error(`status failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
