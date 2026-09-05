import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UsageLedger, UsageWindows } from "../../ports/index.ts";
import { parseUsageWindows } from "./parse-usage-windows.ts";

/** Matches the weekly window in parse-usage-windows.ts: nothing older can affect either window. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where Claude Code keeps session logs: one directory per project, one
 * `.jsonl` file per session. Consumption is global to the developer, not to
 * one project, so every project's logs are read.
 */
function logsDirectory(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "projects");
}

/**
 * A missing directory means no logs yet, an empty history rather than a
 * failure. Any other error (permissions, a bad `CLAUDE_CONFIG_DIR`, disk
 * trouble) is real and must not be swallowed into a false "no usage" that
 * would let the budget gate authorize work against a reserve already spent.
 */
async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * A file that disappears between being listed and being read lost a race
 * with one of the developer's other, concurrently running sessions — not a
 * failure the whole invocation should crash on.
 */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readLogFiles(
  directory: string,
  cutoff: Date,
): Promise<string[]> {
  const projectDirs = await listDirectory(directory);

  const perProject = await Promise.all(
    projectDirs.map(async (projectDir) => {
      const projectPath = join(directory, projectDir);
      const entries = await listDirectory(projectPath);

      const files = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".jsonl"))
          .map(async (entry) => {
            const filePath = join(projectPath, entry);
            // a file untouched since before the cutoff can't hold an entry
            // newer than its own last write, so it can't affect either
            // window; skipping it avoids parsing a developer's entire
            // history on every invocation. Any trouble stat-ing it just
            // means reading it instead, not skipping it.
            const stats = await stat(filePath).catch(() => undefined);
            if (stats !== undefined && stats.mtime < cutoff) {
              return undefined;
            }
            return readIfPresent(filePath);
          }),
      );

      return files.filter((file): file is string => file !== undefined);
    }),
  );

  return perProject.flat();
}

/** Reads rolling window totals from the local Claude Code session logs. */
export const sessionLogUsageLedger: UsageLedger = {
  read: async (now: Date): Promise<UsageWindows> => {
    const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
    const logFiles = await readLogFiles(logsDirectory(), cutoff);
    return parseUsageWindows(logFiles, now);
  },
};
