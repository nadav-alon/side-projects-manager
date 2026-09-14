import type {
  Milliseconds,
  TokenCount,
  UsageWindow,
  UsageWindows,
} from "../../ports/index.ts";
import { milliseconds, tokenCount } from "../../ports/index.ts";

const FIVE_HOURS_MS = milliseconds(5 * 60 * 60 * 1000);
const WEEK_MS = milliseconds(7 * 24 * 60 * 60 * 1000);

/** One assistant log line with usage, reduced to what a window needs. */
interface UsageLogEntry {
  timestamp: Date;
  tokensUsed: TokenCount;
}

/**
 * Parses Claude Code session log files into the window totals the budget
 * gate reads.
 *
 * Each element of `logFiles` is the full text of one `.jsonl` session log.
 * Lines that aren't a well-formed assistant message carrying usage — other
 * message types, truncated JSON, a usage object missing its token counts —
 * are skipped rather than aborting the parse.
 *
 * `observedReset` is a 5-hour boundary the developer saw, and it corrects the
 * 5-hour window only. The weekly window needs no such help: it opens on
 * Sunday, which is a rule rather than an inference.
 */
export function parseUsageWindows(
  logFiles: readonly string[],
  now: Date,
  observedReset?: Date,
): UsageWindows {
  const entries = logFiles
    .flatMap((content) => content.split("\n"))
    .map(parseLogLine)
    .filter((entry): entry is UsageLogEntry => entry !== undefined);

  return {
    fiveHour: fiveHourWindow(entries, now, observedReset),
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
function sumTokenFields(usage: Record<string, unknown>): TokenCount | undefined {
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }
  const cacheCreation = usage.cache_creation_input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  return tokenCount(
    input +
      output +
      (typeof cacheCreation === "number" ? cacheCreation : 0) +
      (typeof cacheRead === "number" ? cacheRead : 0),
  );
}

/**
 * The 5-hour window, opened by the first message of the current block: a run
 * of entries none of which is 5 hours past the one that opened it. A gap of
 * 5 hours or more starts a new block at the entry that follows the gap.
 *
 * That inference reads only the messages this machine logged, so a developer
 * who has seen the true boundary can hand it over as `observedReset`, and it
 * is believed ahead of the logs. Which boundary they saw decides what it
 * settles:
 *
 * A reset still to come is the block now open, stated outright: the provider
 * says this block ends then, so it began 5 hours before then, and there is
 * nothing left to infer.
 *
 * A reset already past says only that every block before it has ended. The
 * block now open began with some message after it, which the logs may well
 * hold, so the entries before that instant are dropped and the inference runs
 * on what remains. This is the case that repairs a window straddling a reset
 * the ledger never saw, and it is why a stale instant is harmless rather than
 * wrong — an old boundary discards blocks that ended long ago and changes
 * nothing else.
 *
 * Staleness is harmless in that one direction only. A reset more than 5 hours
 * ahead is refused rather than believed: see `refuseAResetTooFarAhead`.
 */
function fiveHourWindow(
  entries: readonly UsageLogEntry[],
  now: Date,
  observedReset?: Date,
): UsageWindow {
  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  refuseAResetTooFarAhead(observedReset, now);

  if (observedReset !== undefined && observedReset.getTime() > now.getTime()) {
    return activeWindow(
      new Date(observedReset.getTime() - FIVE_HOURS_MS),
      FIVE_HOURS_MS,
      sorted,
      now,
    );
  }

  const since =
    observedReset === undefined
      ? sorted
      : sorted.filter(
          (entry) => entry.timestamp.getTime() >= observedReset.getTime(),
        );

  let blockOpen: Date | undefined;
  for (const entry of since) {
    if (
      blockOpen === undefined ||
      entry.timestamp.getTime() - blockOpen.getTime() >= FIVE_HOURS_MS
    ) {
      blockOpen = entry.timestamp;
    }
  }

  return activeWindow(blockOpen, FIVE_HOURS_MS, since, now);
}

/**
 * Refuses an observed reset more than 5 hours ahead of `now`, because the
 * block ending then has not opened yet: there is no such block now open for it
 * to state.
 *
 * A wrong one is believed absolutely and costs far more than the inference it
 * replaced. The window it states opens in the future, so the ledger's entries
 * all fall before it and so do the mornings' own run costs — the 5-hour gate
 * reports an empty window and waves every run through, silently, every
 * morning, with the budget wizard carrying the bad instant across re-runs. A
 * date typo is all it takes.
 *
 * Throwing rather than falling back to the inference is how the budget
 * document treats every other unusable value, and for the same reason: a
 * setting the developer believes they made and the loop quietly disregarded is
 * the failure this gate exists to prevent. The developer reads this instant
 * off a display that only ever shows the block they are in, so a value this
 * tool refuses is one they did not mean to write.
 */
function refuseAResetTooFarAhead(
  observedReset: Date | undefined,
  now: Date,
): void {
  if (
    observedReset === undefined ||
    observedReset.getTime() - now.getTime() <= FIVE_HOURS_MS
  ) {
    return;
  }
  throw new Error(
    `"observedResetAt" is ${observedReset.toISOString()}, more than 5 hours ` +
      `after ${now.toISOString()}: the 5-hour block that resets then has not ` +
      `opened yet, so it cannot be the one now open`,
  );
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
  durationMs: Milliseconds,
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
