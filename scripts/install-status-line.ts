// Points `statusLine` in a Claude settings file at this checkout's status line
// script, leaving every other setting alone. Idempotent: a second run rewrites
// the same value. The refresh interval (seconds) re-runs the line once a minute
// even when no event does; the script caches the loop's part for a minute.
//
// Usage: node scripts/install-status-line.ts [settings.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isErrorWithCode } from "../src/adapters/error-code.ts";

const REFRESH_INTERVAL_SECONDS = 60;

const settingsFile =
  process.argv[2] ?? path.join(os.homedir(), ".claude", "settings.json");
const script = path.resolve(import.meta.dirname, "status-line.ts");

let settings: Record<string, unknown> = {};
try {
  const parsed: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${settingsFile} does not hold a JSON object; leaving it alone.`);
  }
  settings = Object.fromEntries(Object.entries(parsed));
} catch (error) {
  if (!isErrorWithCode(error, "ENOENT")) {
    throw new Error(`${settingsFile} will not parse as a settings object; leaving it alone.`, { cause: error });
  }
}

settings["statusLine"] = {
  type: "command",
  command: `node ${JSON.stringify(script)}`,
  refreshInterval: REFRESH_INTERVAL_SECONDS,
};

mkdirSync(path.dirname(settingsFile), { recursive: true });
writeFileSync(settingsFile, `${JSON.stringify(settings, undefined, 2)}\n`);
