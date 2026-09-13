#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

import { fileTriggerLock } from "../adapters/file-trigger-lock.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { runOncePerDay } from "../trigger-guard.ts";

// `morning-run.ts` in this checkout, `morning-run.js` once built — matching
// this file's own extension rather than hardcoding one means the build's
// `.ts` → `.js` rewrite (`tsconfig.build.json`) doesn't have to know this
// path exists, since it only rewrites import specifiers, not runtime strings.
const LOOP_ENTRY_POINT = path.join(
  import.meta.dirname,
  `morning-run${path.extname(import.meta.filename)}`,
);

/**
 * What both the daily schedule and the logon guard call (`scripts/install-triggers.sh`):
 * whichever gets here first for a calendar day runs `morning-run.ts`, and the
 * other is a no-op. `morning-run.ts` itself stays the direct, unguarded entry
 * point — nothing here changes what a manual invocation does.
 *
 * Spawns `morning-run.ts` as its own process rather than importing its
 * `main`, so its own exit-code and error-reporting policy applies unchanged:
 * this script's only job is deciding whether that process runs at all.
 */
async function main(): Promise<void> {
  const invoked = await runOncePerDay(
    fileTriggerLock(),
    systemClock,
    invokeLoop,
  );
  if (!invoked) {
    console.log("morning-run already ran today; nothing to do.");
  }
}

function invokeLoop(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LOOP_ENTRY_POINT], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      // The child already reported its own failure; passing its exit code
      // through is all this wrapper owes whoever is watching it run.
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error(
    `morning-run trigger failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
