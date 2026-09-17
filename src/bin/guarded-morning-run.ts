#!/usr/bin/env node
import path from "node:path";

import { fileInvocationLease } from "../adapters/file-invocation-lease.ts";
import { invokeExclusively } from "../trigger-guard.ts";
import { runShielded } from "./shielded-child.ts";

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
 * whichever firing acquires the invocation lease runs `morning-run.ts`, and
 * every other firing — however long that one takes — is a no-op.
 * `morning-run.ts` itself stays the direct, unguarded entry point — nothing
 * here changes what a manual invocation does.
 *
 * Spawns `morning-run.ts` as its own process rather than importing its
 * `main`, so its own exit-code and error-reporting policy applies unchanged:
 * this script's only job is deciding whether that process runs at all.
 */
async function main(): Promise<void> {
  const invoked = await invokeExclusively(fileInvocationLease(), invokeLoop);
  if (!invoked) {
    console.log("an invocation is already running; nothing to do.");
  }
}

async function invokeLoop(): Promise<void> {
  // Shielded, so a Ctrl+C reaches the loop once, passed on from here, rather
  // than once from the terminal and again from this wrapper — which it would
  // read as the second interrupt that stops a morning at once.
  const code = await runShielded([LOOP_ENTRY_POINT]);
  // The child already reported its own failure; passing its exit code
  // through is all this wrapper owes whoever is watching it run.
  process.exitCode = code ?? 1;
}

main().catch((error: unknown) => {
  console.error(
    `morning-run trigger failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
