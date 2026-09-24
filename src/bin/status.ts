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
import {
  hasAnnouncedOn,
  isClosedInvocation,
  localDay,
  localTimeOfSecond,
  type Milliseconds,
} from "../ports/index.ts";
import {
  RECENT_STEPS_SHOWN,
  statusReport,
  type StatusJournal,
  type StatusRecord,
  type StatusRun,
} from "../status-report.ts";
import { parseWatchArg, watchStatus, type WatchFrame } from "../status-watch.ts";

/** Hides the cursor while watching, so a redraw every few seconds doesn't leave it flickering mid-line. */
const HIDE_CURSOR = "\x1b[?25l";
/** Restores the cursor `HIDE_CURSOR` hid — on every exit from watch mode, interrupted or not. */
const SHOW_CURSOR = "\x1b[?25h";
/** Clears the screen and homes the cursor ahead of a redraw. */
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/**
 * "Is the loop alive?", without reading source: reads the journal, the state
 * document and the budget document, and returns what `statusReport` makes of
 * them — the budget lines through the same `budgetStatus` arithmetic the
 * gate itself consults, read from `sessionLogUsageLedger` rather than the
 * network — plus whether any record is still open, the one thing beyond the
 * report's own lines that watch mode needs to know when to stop by itself.
 *
 * Read-only, like the report it builds — it never claims a day, never opens
 * or closes a record, and makes no network call.
 */
async function collectReport(): Promise<WatchFrame> {
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

  return {
    lines: statusReport(
      resolved,
      todayClaimed,
      now,
      { schedule, logonGuard, managerHome: CHECKOUT_ROOT },
      budgetStatus(windows, budget, runsRecorded(state.projects)),
    ),
    inFlight: journal.records.some((record) => !isClosedInvocation(record)),
  };
}

/** The real wait between redraws: a plain timer, cut short the moment `signal` aborts. */
function realSleep(interval: Milliseconds, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, interval);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Clears the screen, stamps the current time, and prints `lines` — one redraw. */
function displayFrame(lines: readonly string[]): void {
  const now = systemClock.now();
  process.stdout.write(CLEAR_SCREEN);
  console.log(`Updated ${localDay(now)} ${localTimeOfSecond(now)}`);
  for (const line of lines) {
    console.log(line);
  }
}

async function main(): Promise<void> {
  const watch = parseWatchArg(process.argv.slice(2));
  if (watch.kind === "invalid") {
    console.error(watch.message);
    process.exitCode = 1;
    return;
  }

  if (watch.kind === "disabled") {
    const { lines } = await collectReport();
    for (const line of lines) {
      console.log(line);
    }
    return;
  }

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.stdout.write(HIDE_CURSOR);
  try {
    await watchStatus(
      { render: collectReport, sleep: realSleep, display: displayFrame },
      watch.interval,
      controller.signal,
    );
  } finally {
    process.stdout.write(SHOW_CURSOR);
  }
}

main().catch((error: unknown) => {
  console.error(`status failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
