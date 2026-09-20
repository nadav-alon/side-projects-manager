import type {
  ScheduleRegistration,
  TriggerRegistration,
  TriggerRegistrations,
} from "../trigger-registrations.ts";

/** An in-memory `TriggerRegistrations`, answering whatever the test sets, defaulting to neither trigger registered. */
export class FakeTriggerRegistrations implements TriggerRegistrations {
  #schedule: ScheduleRegistration;
  #logonGuard: TriggerRegistration;

  constructor(
    registered: {
      schedule?: ScheduleRegistration;
      logonGuard?: TriggerRegistration;
    } = {},
  ) {
    this.#schedule = registered.schedule ?? { registered: false };
    this.#logonGuard = registered.logonGuard ?? { registered: false };
  }

  async schedule(): Promise<ScheduleRegistration> {
    return this.#schedule;
  }

  async logonGuard(): Promise<TriggerRegistration> {
    return this.#logonGuard;
  }
}
