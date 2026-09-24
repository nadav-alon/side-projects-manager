#!/usr/bin/env node
import { fileHalt } from "../adapters/file-halt.ts";
import { errorMessage } from "../error-message.ts";

/**
 * Clears the halt (CONTEXT.md: Halt): the next firing, hourly or manual, runs
 * normally again. Idempotent — clearing a halt that was never engaged says so
 * rather than pretending it just happened.
 */
async function main(): Promise<void> {
  const cleared = await fileHalt().clear();
  console.log(
    cleared
      ? "Resumed: the loop will run normally again."
      : "Wasn't halted.",
  );
}

main().catch((error: unknown) => {
  console.error(`resume failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
