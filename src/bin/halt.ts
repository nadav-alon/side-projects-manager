#!/usr/bin/env node
import { errorMessage } from "../error-message.ts";
import { engageHalt } from "../halt.ts";

/** Engages the halt (CONTEXT.md: Halt): every firing, hourly or manual, does nothing until `resume` clears it. */
async function main(): Promise<void> {
  console.log(await engageHalt());
}

main().catch((error: unknown) => {
  console.error(`halt failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
