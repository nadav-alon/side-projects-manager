import type { BudgetStatus, WindowStatus } from "./budget-gate.ts";
import { RESUME_COMMAND } from "./halt.ts";
import type {
  Day,
  InvocationClosing,
  OpenInvocation,
  RunInProgress,
  Milliseconds,
  RunProgress,
  TokenCount,
} from "./ports/index.ts";
import { localDay, localTimeOfMinute, milliseconds } from "./ports/index.ts";
import type { TranscriptStep } from "./transcript-steps.ts";
import type {
  ScheduleRegistration,
  TriggerRegistration,
} from "./trigger-registrations.ts";

/**
 * One run an in-flight invocation has going, as `status` reads it: what the
 * manager itself recorded when it started the run, and its agent's own
 * recent steps, already read off its transcript by the caller — `undefined`
 * when that transcript could not be read yet, per `readTranscriptTail`'s own
 * contract.
 */
export interface StatusRun {
  run: RunInProgress;
  steps: TranscriptStep[] | undefined;
}

/**
 * An invocation record still in flight, as the status command reads it:
 * whether the process that opened it is still alive, the one concession to
 * liveness in a journal that is otherwise all domain state, and every run it
 * has going right now.
 */
export interface OpenStatusRecord extends OpenInvocation {
  alive: boolean;
  runs: StatusRun[];
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
 * What the status command found registered for the schedule and a
 * logon guard, and this checkout's own root to compare them against.
 *
 * `managerHome` must be the checkout root the installer itself resolves
 * (`CHECKOUT_ROOT`), not the overridable `MANAGER_HOME` — the installer never
 * honours that override when it writes the cron line or rc block.
 */
export interface StatusTriggers {
  schedule: ScheduleRegistration;
  logonGuard: TriggerRegistration;
  managerHome: string;
}

/**
 * The two standalone facts about right now that `statusReport` can't derive
 * from the journal, the trigger registrations or the budget: whether today
 * has already been claimed, and whether the loop is halted. Grouped so a
 * call site names each rather than reading as two bare positional booleans.
 */
export interface StatusFacts {
  todayClaimed: boolean;
  halted: boolean;
}

/**
 * The status command's whole report: whether the triggers are armed, whether
 * today has been claimed and what came of it, what the most recent
 * invocation came to, and a short history of the ones before it.
 *
 * A pure function of the journal, the trigger registrations, `facts`, and the
 * instant it is asked at. Nothing here reads the clock, a live process, the
 * crontab or the rc files itself: `now` is the caller's clock reading, a
 * record's `alive` is already resolved onto it by the caller, and `triggers`
 * is already read back by the caller too. Comparing a registration's
 * `managerHome` against `triggers.managerHome` — deciding armed (CONTEXT.md:
 * Armed) — happens here, not in the adapter that read the registration.
 *
 * `budget` is the gate's own arithmetic (`budgetStatus`), already resolved by
 * the caller over the ledger, the state document and `budget.json` — nothing
 * here recomputes it, so a change to the gate's arithmetic changes what these
 * lines print without this file naming it twice.
 */
export function statusReport(
  journal: StatusJournal,
  facts: StatusFacts,
  now: Date,
  triggers: StatusTriggers,
  budget: BudgetStatus,
): string[] {
  const { todayClaimed, halted } = facts;
  const { managerHome } = triggers;
  const haltLines = haltCallout(halted);
  const triggerLines = [
    scheduleLine(triggers.schedule, managerHome),
    logonGuardLine(triggers.logonGuard, managerHome),
  ];
  const budgetLines = [
    windowLine("Five-hour window", budget.fiveHour),
    windowLine("Weekly window", budget.weekly),
  ];

  const { records } = journal;
  if (records.length === 0) {
    return [
      ...haltLines,
      ...triggerLines,
      ...budgetLines,
      "No invocation has ever run on this machine.",
    ];
  }

  const today = localDay(now);
  const latest = records[records.length - 1]!;

  return [
    ...haltLines,
    ...triggerLines,
    ...budgetLines,
    claimLine(records, today, todayClaimed),
    mostRecentLine(latest),
    ...inFlightCallouts(records, now),
    ...consecutiveFailureCallout(records),
    ...historyLines(records),
  ];
}

/**
 * Named first, ahead of every other line, when the loop is halted
 * (CONTEXT.md: Halt) — silent otherwise, the same restraint
 * `consecutiveFailureCallout` and `inFlightCallouts` already use for a fact
 * only worth a line when it's true.
 */
function haltCallout(halted: boolean): string[] {
  return halted
    ? [`Halted: the loop does nothing until \`${RESUME_COMMAND}\`.`]
    : [];
}

/**
 * One window's whole status line: what it has consumed against its
 * allowance, the loop's share of that against the developer's, when it
 * resets, and whether its reserve is already reached — CONTEXT.md's "Reserve".
 *
 * Reserve reached always means the gate refuses: `refusal` stands down on
 * consumption alone before it ever charges an estimate. Room in the reserve
 * does not carry the same certainty the other way, since the gate also
 * charges a run estimate this line does not — CONTEXT.md's "Budget gate"
 * keeps that refusal apart from a window already spent, so this line does
 * not claim it for a case it cannot see.
 */
function windowLine(label: string, status: WindowStatus): string {
  const reserve = status.reserveReached
    ? "The reserve is already reached: the gate would refuse a run now."
    : "The reserve has room.";
  return (
    `${label}: ${tokens(status.tokensUsed)} of ${tokens(status.allowance)} tokens ` +
    `(${percentOf(status.tokensUsed, status.allowance)}) — loop spent ${tokens(status.loopSpent)}, ` +
    `developer spent ${tokens(status.developerSpent)}. Resets ${describeAt(status.resetsAt)}. ` +
    reserve
  );
}

function tokens(count: TokenCount): string {
  return count.toLocaleString("en-US");
}

/** `used` as a share of `allowance`, to one decimal place — `0%` for a window declaring no allowance at all. */
function percentOf(used: TokenCount, allowance: TokenCount): string {
  return allowance === 0 ? "0%" : `${((used / allowance) * 100).toFixed(1)}%`;
}

const INSTALLER_COMMAND = "npm run triggers:install";

/**
 * Whether `registration` is armed (CONTEXT.md: Armed): registered, and still
 * pointing at `managerHome`. Registration alone is not enough — a stale path
 * is registered but not armed.
 */
function isArmed(registration: TriggerRegistration, managerHome: string): boolean {
  return registration.registered && registration.managerHome === managerHome;
}

function scheduleLine(schedule: ScheduleRegistration, managerHome: string): string {
  if (!schedule.registered) {
    return `Schedule: not registered. Run \`${INSTALLER_COMMAND}\` to arm it.`;
  }
  if (!isArmed(schedule, managerHome)) {
    return `Schedule: registered, but pointing at ${schedule.managerHome} rather than this manager home (${managerHome}). Run \`${INSTALLER_COMMAND}\` to re-arm it.`;
  }
  return `Schedule: armed, firing every ${schedule.step === "1" ? "minute" : `${schedule.step} minutes`}.`;
}

function logonGuardLine(guard: TriggerRegistration, managerHome: string): string {
  if (!guard.registered) {
    return "Logon guard: not registered — the schedule alone already covers a machine left off overnight.";
  }
  if (!isArmed(guard, managerHome)) {
    return `Logon guard: still registered from an older install, and pointing at ${guard.managerHome} rather than this manager home (${managerHome}). Run \`${INSTALLER_COMMAND}\` to remove it.`;
  }
  return `Logon guard: still registered from an older install, though the schedule already covers what it was for. Run \`${INSTALLER_COMMAND}\` to remove it.`;
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

/**
 * Every record still in flight, named as still running or died, followed by
 * each run it has going right now and its agent's own recent steps —
 * CONTEXT.md's "Run in progress". A record with no runs going adds nothing
 * past its own callout line.
 */
function inFlightCallouts(records: readonly StatusRecord[], now: Date): string[] {
  return records
    .filter((record): record is OpenStatusRecord => !isClosed(record))
    .flatMap((record) => [
      record.alive
        ? `In flight: the invocation opened ${describeAt(record.openedAt)} by process ${record.process} is still running. Watch trigger.log, or run \`npm run stop\` if it's wedged.`
        : `In flight: the invocation opened ${describeAt(record.openedAt)} by process ${record.process} has died without closing its record. Check trigger.log for what it last did, then re-run the loop by hand.`,
      ...record.runs.flatMap((run) => runLines(run, now, record.alive)),
    ]);
}

/**
 * How many of a run's own recent steps `status` shows, oldest first — what
 * `bin/status.ts` reads its own transcript tail down to, so the two agree on
 * one number rather than each guessing the other's.
 */
export const RECENT_STEPS_SHOWN = 10;

/**
 * One run's own line — its kind, target and how long it has been running —
 * followed by its agent's recent steps, oldest first, or a line saying its
 * transcript could not be read yet when `steps` is `undefined`: not started,
 * or already cleaned up.
 *
 * `alive` is the record's own, not the run's: a run still on a record whose
 * process has died is not in progress the way the ticket means it, so its
 * line says it was running when the invocation died rather than claiming it
 * still is.
 */
function runLines({ run, steps }: StatusRun, now: Date, alive: boolean): string[] {
  const pullRequest = run.pullRequest === undefined ? "" : ` (${run.pullRequest})`;
  const target = `${run.kind} ${run.repo} #${run.number}${pullRequest}`;
  const header = alive
    ? `  Running: ${target}, started ${localTimeOfMinute(run.startedAt)}, running for ${elapsedSince(run.startedAt, now)}.`
    : `  Was running when the invocation died: ${target}, started ${localTimeOfMinute(run.startedAt)}, had been running for ${elapsedSince(run.startedAt, now)}.`;
  const progress = progressLines(run.progress, now, alive);
  if (steps === undefined) {
    return [header, ...progress, "    Transcript not readable yet."];
  }
  if (steps.length === 0) {
    return [header, ...progress, "    No steps yet."];
  }
  return [
    header,
    ...progress,
    ...steps.map((step) => `    ${localTimeOfMinute(step.at)} ${step.line}`),
  ];
}

/**
 * How long a running run's stream may stay silent before `status` says so —
 * the hang a developer would stop by hand.
 */
const QUIET_AFTER: Milliseconds = milliseconds(10 * 60_000);

/**
 * What a run's journaled progress says: tool calls so far, the last tool and
 * when, and — for a run whose invocation is alive — that the stream has gone
 * quiet once its last event is older than `QUIET_AFTER`. A run with
 * no progress on record, one written before progress was kept, says it is
 * unknown rather than that nothing has happened.
 */
function progressLines(progress: RunProgress | undefined, now: Date, alive: boolean): string[] {
  if (progress === undefined) {
    return ["    Progress unknown."];
  }
  const { toolCalls, lastTool, lastEventAt } = progress;
  const calls = `${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"}`;
  const last =
    lastTool === undefined ? "" : `, last ${lastTool.name} at ${localTimeOfMinute(lastTool.at)}`;
  const quietMinutes = minutesBetween(lastEventAt, now);
  return [
    `    Progress: ${calls}${last}.`,
    ...(alive && quietMinutes * 60_000 >= QUIET_AFTER
      ? [`    No events for ${quietMinutes} minutes.`]
      : []),
  ];
}

/** Whole minutes from `from` to `now`, never negative. */
function minutesBetween(from: Date, now: Date): number {
  return Math.floor(Math.max(0, now.getTime() - from.getTime()) / 60_000);
}

/** How long `startedAt` has been running, as of `now` — minutes, or hours and minutes past the first hour. */
function elapsedSince(startedAt: Date, now: Date): string {
  const totalMinutes = minutesBetween(startedAt, now);
  if (totalMinutes < 1) {
    return "under a minute";
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
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

/** The most recent `HISTORY_LIMIT` records before the latest, newest first — enough to see a pattern, not the whole journal. */
const HISTORY_LIMIT = 5;

function historyLines(records: readonly StatusRecord[]): string[] {
  const rest = records.slice(0, -1).reverse();
  if (rest.length === 0) {
    return [];
  }
  const shown = rest.slice(0, HISTORY_LIMIT);
  const omitted = rest.length - shown.length;
  return [
    "History:",
    ...shown.map(
      (record) => `- ${describeAt(record.openedAt)} — ${describeRecord(record)}`,
    ),
    ...(omitted > 0 ? [`… and ${omitted} earlier`] : []),
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
    case "never-reported":
      return record.exitCode === undefined
        ? "never reported"
        : `never reported (exit code ${record.exitCode})`;
  }
}

/** `at`'s local day and time to the minute, the same grain the summary's own title carries. */
function describeAt(at: Date): string {
  return `${localDay(at)} ${localTimeOfMinute(at)}`;
}
