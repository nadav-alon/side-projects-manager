// Exits non-zero, naming each number and its files, when two files under
// `docs/adr/` share a four-digit prefix. CI runs it on the pull request's
// merge result, so a number merged since the branch was cut goes red.

import { readdirSync } from "node:fs";
import path from "node:path";

import { CHECKOUT_ROOT } from "../src/adapters/sandbox-image.ts";
import { adrCollisions, describeAdrCollisions } from "../src/adr-numbers.ts";

const adrDir = process.argv[2] ?? path.join(CHECKOUT_ROOT, "docs", "adr");
const lines = describeAdrCollisions(adrCollisions(readdirSync(adrDir)));
for (const line of lines) {
  console.error(line);
}
process.exitCode = lines.length === 0 ? 0 : 1;
