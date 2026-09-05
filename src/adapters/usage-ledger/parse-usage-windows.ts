import type { UsageWindow, UsageWindows } from "../../ports/index.ts";
import { tokenCount } from "../../ports/index.ts";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One assistant log line with usage, reduced to what a window needs. */
interface UsageLogEntry {
  timestamp: Date;
  tokensUsed: number;
}

/**
 * Parses Claude Code session log files into the rolling window totals the
 * budget gate reads.
 *
 * Each element of `logFiles` is the full text of one `.jsonl` session log.
 * Lines that aren't a well-formed assistant message carrying usage — other
 * message types, truncated JSON, a usage object missing its token counts —
 * are skipped rather than aborting the parse. An entry timestamped after
 * `now` is also skipped: the ledger reports what happened up to `now`, not
 * what a clock-skewed or malformed future timestamp claims.
 */
export function parseUsageWindows(
  logFiles: readonly string[],
  now: Date,
): UsageWindows {
  const entries = logFiles
    .flatMap((content) => content.split("\n"))
    .map(parseLogLine)
    .filter((entry): entry is UsageLogEntry => entry !== undefined)
    .filter((entry) => entry.timestamp.getTime() <= now.getTime());

  return {
    fiveHour: fiveHourWindow(entries, now),
    weekly: weeklyWindow(entries, now),
  };
}

function parseLogLine(line: string): UsageLogEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "assistant") {
    return undefined;
  }

  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp === undefined) {
    return undefined;
  }

  const message = record.message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }

  const tokensUsed = sumTokenFields(usage as Record<string, unknown>);
  if (tokensUsed === undefined) {
    return undefined;
  }

  return { timestamp, tokensUsed };
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
}

/** Aggregates input, output, and both cache token fields. Missing cache fields count as zero. */
function sumTokenFields(usage: Record<string, unknown>): number | undefined {
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }
  const cacheCreation = usage.cache_creation_input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  return (
    input +
    output +
    (typeof cacheCreation === "number" ? cacheCreation : 0) +
    (typeof cacheRead === "number" ? cacheRead : 0)
  );
}

/**
 * The 5-hour window, opened by the first message of the current block: a run
 * of entries none of which is 5 hours past the one that opened it. A gap of
 * 5 hours or more starts a new block at the entry that follows the gap.
 */
function fiveHourWindow(
  entries: readonly UsageLogEntry[],
  now: Date,
): UsageWindow {
  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  let blockOpen: Date | undefined;
  for (const entry of sorted) {
    if (
      blockOpen === undefined ||
      entry.timestamp.getTime() - blockOpen.getTime() >= FIVE_HOURS_MS
    ) {
      blockOpen = entry.timestamp;
    }
  }

  return activeWindow(blockOpen, FIVE_HOURS_MS, sorted, now);
}

/** The weekly window, which opens on Sunday (UTC). */
function weeklyWindow(
  entries: readonly UsageLogEntry[],
  now: Date,
): UsageWindow {
  return activeWindow(mostRecentSunday(now), WEEK_MS, entries, now);
}

/**
 * A window opened at `openedAt` and lasting `durationMs`, summing `entries`
 * at or after `openedAt`. If that window has already reset relative to `now`
 * — or never opened at all, i.e. `openedAt` is undefined — nothing has
 * reopened it yet, so a fresh, empty window starting at `now` is reported
 * rather than a stale, already-expired one.
 */
function activeWindow(
  openedAt: Date | undefined,
  durationMs: number,
  entries: readonly UsageLogEntry[],
  now: Date,
): UsageWindow {
  if (openedAt !== undefined) {
    const resetsAt = new Date(openedAt.getTime() + durationMs);
    if (resetsAt.getTime() > now.getTime()) {
      const tokensUsed = entries
        .filter((entry) => entry.timestamp.getTime() >= openedAt.getTime())
        .reduce((sum, entry) => sum + entry.tokensUsed, 0);
      return { openedAt, resetsAt, tokensUsed: tokenCount(tokensUsed) };
    }
  }

  return {
    openedAt: now,
    resetsAt: new Date(now.getTime() + durationMs),
    tokensUsed: tokenCount(0),
  };
}

function mostRecentSunday(now: Date): Date {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return new Date(midnight.getTime() - now.getUTCDay() * 24 * 60 * 60 * 1000);
}
