import type { Day, InvocationClosing, OpenInvocation } from "./ports/index.ts";
import { localDay } from "./ports/index.ts";

/**
 * An invocation record still in flight, as the status command reads it:
 * whether the process that opened it is still alive, the one concession to
 * liveness in a journal that is otherwise all domain state.
 */
export interface OpenStatusRecord extends OpenInvocation {
  alive: boolean;
}

/** An invocation record that has closed, as the status command reads it. */
export interface ClosedStatusRecord extends OpenInvocation, InvocationClosing {}

/**
 * One invocation record as the status command reads it: either still in
 * flight, with `alive` resolved, or closed, with no `alive` to ask about.
 */
export type StatusRecord = OpenStatusRecord | ClosedStatusRecord;

/** The journal as the status command reads it, oldest record first. */
export interface StatusJournal {
  records: StatusRecord[];
}

/**
 * The status command's whole report: whether today has been claimed and
 * what came of it, what the most recent invocation came to, and a short
 * history of the ones before it.
 *
 * A pure function of the journal, whether today has already been announced,
 * and the instant it is asked at — tested directly rather than by capturing
 * a real run's stdout. Nothing here reads the clock or a live process
 * itself: `now` is the caller's clock reading, and a record's `alive` is
 * already resolved onto it by the caller.
 */
export function statusReport(
  journal: StatusJournal,
  todayClaimed: boolean,
  now: Date,
): string[] {
  const { records } = journal;
  if (records.length === 0) {
    return ["No invocation has ever run on this machine."];
  }

  const today = localDay(now);
  const latest = records[records.length - 1]!;

  return [
    claimLine(records, today, todayClaimed),
    mostRecentLine(latest),
    ...inFlightCallouts(records),
    ...consecutiveFailureCallout(records),
    ...historyLines(records),
  ];
}

/** The most recent record, if any, opened on `day`. */
function openedOn(
  records: readonly StatusRecord[],
  day: Day,
): StatusRecord | undefined {
  return records.findLast((record) => localDay(record.openedAt) === day);
}

/**
 * Today is claimed when a summary has already been announced today, i.e.
 * `state.announcedOn === localDay(now)` — the rule the caller applies and
 * `todayClaimed` carries. When it has not, this names why — nothing has run
 * yet, today's invocation is still going, it failed before it could finish,
 * or it finished without ever announcing, which is the one case worth
 * calling out by name: the summary never published.
 */
function claimLine(
  records: readonly StatusRecord[],
  today: Day,
  todayClaimed: boolean,
): string {
  if (todayClaimed) {
    return `Today (${today}) is claimed.`;
  }
  const record = openedOn(records, today);
  if (record === undefined) {
    return `Today (${today}) has not been claimed yet: the loop has not run today.`;
  }
  if (!isClosed(record)) {
    return `Today (${today}) has not been claimed yet: today's invocation is still in flight — see below.`;
  }
  if (record.outcome === "invocation-failed") {
    return `Today (${today}) has not been claimed: today's invocation failed before it could finish. Check trigger.log for what it last did, then re-run the loop by hand.`;
  }
  return `Today (${today}) has not been claimed: today's invocation finished but its summary never published. Check the tracker is reachable and re-run the loop by hand.`;
}

function mostRecentLine(latest: StatusRecord): string {
  return `Most recent invocation: opened ${describeAt(latest.openedAt)} — ${describeRecord(latest)}.`;
}

/** Every record still in flight, named as still running or died. */
function inFlightCallouts(records: readonly StatusRecord[]): string[] {
  return records
    .filter((record): record is OpenStatusRecord => !isClosed(record))
    .map((record) =>
      record.alive
        ? `In flight: the invocation opened ${describeAt(record.openedAt)} by process ${record.process} is still running. Watch trigger.log, or check on process ${record.process} — and kill it if it's wedged.`
        : `In flight: the invocation opened ${describeAt(record.openedAt)} by process ${record.process} has died without closing its record. Check trigger.log for what it last did, then re-run the loop by hand.`,
    );
}

/**
 * A callout naming a run of consecutive invocation failures, if the most
 * recent two or more are all one. A record still running breaks the streak
 * — the pattern is not yet settled — but a record that died without closing
 * counts toward it: that is a failure too, just one that never got to write
 * its outcome.
 */
function consecutiveFailureCallout(records: readonly StatusRecord[]): string[] {
  let streak = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (!isClosed(record)) {
      if (record.alive) {
        break;
      }
      streak += 1;
      continue;
    }
    if (record.outcome !== "invocation-failed") {
      break;
    }
    streak += 1;
  }
  if (streak < 2) {
    return [];
  }
  return [
    `${streak} invocations in a row have failed before finishing. Check trigger.log and fix the setup before it costs another morning.`,
  ];
}

/** Every record but the most recent, newest first. */
function historyLines(records: readonly StatusRecord[]): string[] {
  const rest = records.slice(0, -1).reverse();
  if (rest.length === 0) {
    return [];
  }
  return [
    "History:",
    ...rest.map(
      (record) => `- ${describeAt(record.openedAt)} — ${describeRecord(record)}`,
    ),
  ];
}

function isClosed(record: StatusRecord): record is ClosedStatusRecord {
  return "closedAt" in record;
}

/** One record, however it stands: in flight, or what it came to once closed. */
function describeRecord(record: StatusRecord): string {
  if (!isClosed(record)) {
    return record.alive === true ? "still running" : "died without closing";
  }
  switch (record.outcome) {
    case "dry-queue":
      return "a dry queue";
    case "invocation-failed":
      return "the invocation failed before it could finish";
    case "stood-down":
      return record.standDownReason === undefined
        ? "stood down"
        : `stood down: ${record.standDownReason}`;
    case "work-selected":
      return record.projects.length === 0
        ? "worked something"
        : `worked ${record.projects.map((project) => `${project.repo} (${project.tokensUsed} tokens)`).join(", ")}`;
  }
}

/** `at`'s local day and time to the minute, the same grain the summary's own title carries. */
function describeAt(at: Date): string {
  const hours = `${at.getHours()}`.padStart(2, "0");
  const minutes = `${at.getMinutes()}`.padStart(2, "0");
  return `${localDay(at)} ${hours}:${minutes}`;
}
