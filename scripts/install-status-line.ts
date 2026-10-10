// Points `statusLine` in a Claude settings file at this checkout's status line
// script, leaving every other setting alone. Idempotent: a second run rewrites
// the same value. The refresh interval (seconds) keeps the journal read no more
// than once a minute.
//
// Usage: node scripts/install-status-line.ts [settings.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REFRESH_INTERVAL_SECONDS = 60;

const settingsFile =
  process.argv[2] ?? path.join(os.homedir(), ".claude", "settings.json");
const script = path.resolve(import.meta.dirname, "status-line.ts");

let settings: Record<string, unknown> = {};
try {
  settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new Error(`${settingsFile} will not parse; leaving it alone.`, { cause: error });
  }
}

settings["statusLine"] = {
  type: "command",
  command: `node ${JSON.stringify(script)}`,
  refreshInterval: REFRESH_INTERVAL_SECONDS,
};

mkdirSync(path.dirname(settingsFile), { recursive: true });
writeFileSync(settingsFile, `${JSON.stringify(settings, undefined, 2)}\n`);
