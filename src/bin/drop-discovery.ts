#!/usr/bin/env node
import { documentStore } from "../adapters/document-store.ts";
import { dropDiscoveryOf } from "../drop-discovery.ts";
import { errorMessage } from "../error-message.ts";
import { parseTicketReference } from "../grant.ts";

/**
 * Drops every recorded discovery against `O/R#n` from the loop pane, leaving
 * the ticket itself as it is.
 */
async function main(): Promise<void> {
  const [reference, ...rest] = process.argv.slice(2);
  if (reference === undefined || rest.length > 0) {
    throw new Error("Usage: npm run drop-discovery -- owner/repo#n");
  }
  console.log(await dropDiscoveryOf(documentStore(), parseTicketReference(reference)));
}

main().catch((error: unknown) => {
  console.error(`drop-discovery failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
