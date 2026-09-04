import type { MorningRunPorts } from "../morning-run.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeIssueTracker } from "./fake-issue-tracker.ts";
import { FakeSandbox } from "./fake-sandbox.ts";
import { FakeStore } from "./fake-store.ts";
import { FakeUsageLedger } from "./fake-usage-ledger.ts";

/** The five fakes, typed concretely so tests can both inject and inspect them. */
export interface FakePorts extends MorningRunPorts {
  tracker: FakeIssueTracker;
  sandbox: FakeSandbox;
  ledger: FakeUsageLedger;
  clock: FakeClock;
  store: FakeStore;
}

/**
 * A whole world with nothing in it: no registered projects, no backlogs, no
 * usage. Tests arrange from here by putting things into the fakes.
 */
export function fakePorts(overrides: Partial<FakePorts> = {}): FakePorts {
  return {
    tracker: new FakeIssueTracker(),
    sandbox: new FakeSandbox(),
    ledger: new FakeUsageLedger(),
    clock: new FakeClock(),
    store: new FakeStore(),
    ...overrides,
  };
}
