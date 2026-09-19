/**
 * What one trigger's registration looks like on this machine, read from
 * whatever `scripts/install-triggers.sh` leaves behind: the crontab marker
 * for the hourly schedule, the delimited rc block a logon guard from an
 * older install may still leave behind.
 *
 * Not one of the loop's six ports (CONTEXT.md: Port) — the loop never sees
 * this, exactly like the invocation lease. It exists only for the status
 * command, which is also where "armed" (CONTEXT.md: Armed) is decided: this
 * carries only the raw facts, registered and where it points, and comparing
 * `managerHome` against the manager's own home is the status report's job,
 * not this port's or its adapter's.
 */
export interface TriggerRegistration {
  readonly registered: boolean;
  /** The manager home the registration points at. Present only when registered. */
  readonly managerHome?: string;
}

/** The schedule's registration, additionally carrying the minute it fires each hour. */
export interface ScheduleRegistration extends TriggerRegistration {
  /** The minute of every hour it fires, e.g. `"0"`. Present only when registered. */
  readonly minute?: string;
}

/** Where the status command reads whether the schedule and a logon guard are registered. */
export interface TriggerRegistrations {
  schedule(): Promise<ScheduleRegistration>;
  logonGuard(): Promise<TriggerRegistration>;
}
