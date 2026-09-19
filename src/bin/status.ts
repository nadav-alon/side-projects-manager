#!/usr/bin/env node
import { documentStore } from "../adapters/document-store.ts";
import { isProcessAlive } from "../adapters/process-alive.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { errorMessage } from "../error-message.ts";
import { isClosedInvocation, localDay } from "../ports/index.ts";
import { statusReport, type StatusJournal, type StatusRecord } from "../status-report.ts";

/**
 * "Is the loop alive?", without reading source: reads the journal and the
 * state document and prints what `statusReport` makes of them.
 *
 * Read-only, like the report it prints — it never claims a day, never opens
 * or closes a record, and makes no network call.
 */
async function main(): Promise<void> {
  const store = documentStore();
  const [journal, state] = await Promise.all([
    store.loadJournal(),
    store.loadState(),
  ]);
  const now = systemClock.now();

  const resolved: StatusJournal = {
    records: journal.records.map(
      (record): StatusRecord =>
        isClosedInvocation(record)
          ? record
          : { openedAt: record.openedAt, process: record.process, alive: isProcessAlive(record.process) },
    ),
  };
  const todayClaimed = state.announcedOn === localDay(now);

  for (const line of statusReport(resolved, todayClaimed, now)) {
    console.log(line);
  }
}

main().catch((error: unknown) => {
  console.error(`status failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
