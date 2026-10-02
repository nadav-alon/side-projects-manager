#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { documentStore } from "../adapters/document-store.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { errorMessage } from "../error-message.ts";
import { grantTurboable, parseTicketReference } from "../grant.ts";

const execFileAsync = promisify(execFile);

/**
 * Grants `turboable` on `O/R#n` as the developer (ADR 0012): the label, and
 * the host-only record that lets the merge gate tell it from a run's.
 */
async function main(): Promise<void> {
  const [reference, ...rest] = process.argv.slice(2);
  if (reference === undefined || rest.length > 0) {
    throw new Error("Usage: npm run grant -- owner/repo#n");
  }
  const ticket = parseTicketReference(reference);
  console.log(
    await grantTurboable(
      { store: documentStore(), clock: systemClock },
      async (target, label) => {
        await execFileAsync("gh", [
          "issue",
          "edit",
          String(target.number),
          "--repo",
          target.repo,
          "--add-label",
          label,
        ]);
      },
      ticket,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(`grant failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
