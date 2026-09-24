#!/usr/bin/env node
import { fileHalt } from "../adapters/file-halt.ts";
import { errorMessage } from "../error-message.ts";

/**
 * Engages the halt (CONTEXT.md: Halt): every firing, hourly or manual, does
 * nothing until `resume` clears it. Idempotent — engaging an already-engaged
 * halt says so rather than pretending it just happened.
 */
async function main(): Promise<void> {
  const engaged = await fileHalt().engage();
  console.log(
    engaged
      ? "Halted: the loop will do nothing until you run `npm run resume`."
      : "Already halted.",
  );
}

main().catch((error: unknown) => {
  console.error(`halt failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
