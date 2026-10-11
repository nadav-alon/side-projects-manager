#!/usr/bin/env node
import { documentStore } from "../adapters/document-store.ts";
import { ghIssueTracker } from "../adapters/gh-issue-tracker.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { errorMessage } from "../error-message.ts";
import { LIVE_WRITE_LABEL, TURBOABLE_LABEL } from "../ports/index.ts";
import { grantLiveWrite, grantTurboable, parseGrantLabel, parseTicketReference } from "../grant.ts";

/**
 * Grants `turboable` (the default) or `live-write` on `O/R#n` as the
 * developer (ADR 0012): the label, and the host-only record that lets the
 * gate tell it from a run's.
 */
async function main(): Promise<void> {
  const [reference, label = TURBOABLE_LABEL, ...rest] = process.argv.slice(2);
  if (reference === undefined || rest.length > 0) {
    throw new Error("Usage: npm run grant -- owner/repo#n [turboable|live-write]");
  }
  const ticket = parseTicketReference(reference);
  const grant = parseGrantLabel(label) === LIVE_WRITE_LABEL ? grantLiveWrite : grantTurboable;
  console.log(await grant({ store: documentStore(), clock: systemClock }, ghIssueTracker(), ticket));
}

main().catch((error: unknown) => {
  console.error(`grant failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
