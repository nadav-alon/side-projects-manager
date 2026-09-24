#!/usr/bin/env node
import { fileHalt } from "../adapters/file-halt.ts";
import { errorMessage } from "../error-message.ts";

/**
 * Lifts the halt (CONTEXT.md: Halt): the next firing, hourly or manual, runs
 * normally again. Idempotent — lifting a halt that was never engaged says so
 * rather than pretending it just happened.
 */
async function main(): Promise<void> {
  const lifted = await fileHalt().lift();
  console.log(
    lifted
      ? "Resumed: the loop will run normally again."
      : "Wasn't halted.",
  );
}

main().catch((error: unknown) => {
  console.error(`resume failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
