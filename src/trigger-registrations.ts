import type { CronStep } from "./ports/index.ts";

/**
 * What one trigger's registration looks like on this machine, read from
 * whatever `scripts/install-triggers.sh` leaves behind: the crontab marker
 * for the schedule, the delimited rc block a logon guard from an
 * older install may still leave behind.
 *
 * Not one of the loop's six ports (CONTEXT.md: Port) — the loop never sees
 * this, exactly like the invocation lease. It exists only for the status
 * command, which is also where "armed" (CONTEXT.md: Armed) is decided: this
 * carries only the raw facts, registered and where it points, and comparing
 * `managerHome` against the manager's own home is the status report's job,
 * not this port's or its adapter's.
 */
export type TriggerRegistration =
  | { readonly registered: false }
  | { readonly registered: true; readonly managerHome: string };

/** The schedule's registration, additionally carrying the minutes between its firings when registered. */
export type ScheduleRegistration =
  | { readonly registered: false }
  | { readonly registered: true; readonly managerHome: string; readonly step: CronStep };

/** Where the status command reads whether the schedule and a logon guard are registered. */
export interface TriggerRegistrations {
  schedule(): Promise<ScheduleRegistration>;
  logonGuard(): Promise<TriggerRegistration>;
}
