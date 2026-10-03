// Exits non-zero, naming each number and its files, when two files under
// `docs/adr/` share a four-digit prefix. CI runs it on the pull request's
// merge result, so a number merged since the branch was cut goes red.

import { readdirSync } from "node:fs";

import { adrCollisions, describeAdrCollisions } from "../src/adr-numbers.ts";

const lines = describeAdrCollisions(adrCollisions(readdirSync("docs/adr")));
for (const line of lines) {
  console.error(line);
}
process.exitCode = lines.length === 0 ? 0 : 1;
